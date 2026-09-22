import { env } from '../../config/env';
import { getStripe } from '../../lib/stripe';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { isUniqueViolation } from '../../lib/isUniqueViolation';
import { Currency, Payment } from '../../models';
import { quotePurchase, type PriceQuote } from './pricing.service';

/**
 * Every platform price is quoted in Indian paise, and Stripe's smallest-unit
 * convention for INR is also paise — so `amount_paise` passes straight through
 * as `unit_amount` with no conversion. Verified against the live test account
 * before this code was written.
 */
const STRIPE_CURRENCY = 'inr';

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface CheckoutSessionResult {
  /** True when an existing payment was returned instead of a new one created. */
  replayed: boolean;
  payload: {
    payment_id: number;
    stripe_session_id: string | null;
    checkout_url: string;
    credits: number;
    amount_paise: number;
  };
}

export function readIdempotencyKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('Idempotency-Key must be a non-empty string.', [
      { field: 'Idempotency-Key', message: 'Header present but empty.' },
    ]);
  }

  const key = raw.trim();
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError('Idempotency-Key is too long.', [
      {
        field: 'Idempotency-Key',
        message: `Must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    ]);
  }
  // Format is deliberately not validated beyond length — the key is an opaque
  // client token, exactly as it is in Stripe's own API.
  return key;
}

/**
 * How long after its payment row was created a session-less purchase may still
 * be resumed by calling Stripe again.
 *
 * Stripe keeps an idempotency key for at least 24 hours; inside that window a
 * repeated `sessions.create` with the same key returns the session the first
 * call created, if it created one. Outside it, Stripe would happily make a
 * SECOND payable session for the same payment row. An hour of margin keeps
 * every resume comfortably inside the guarantee.
 */
const RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * The Stripe idempotency key for a payment's Checkout Session.
 *
 * Derived from payments.id, so every attempt to open a session for one payment
 * — the original request and any resume — collapses onto one Stripe session.
 */
function stripeIdempotencyKeyFor(paymentId: number): string {
  return `checkout-session-payment-${paymentId}`;
}

/**
 * Stripe's answer when another request with the same idempotency key is still
 * in flight (or, in principle, reused the key with different parameters — which
 * cannot happen here, since every parameter is derived from the frozen row).
 */
function isStripeIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { type, statusCode } = error as { type?: unknown; statusCode?: unknown };
  return type === 'StripeIdempotencyError' || statusCode === 409;
}

/**
 * Creates the Stripe Checkout Session for a payment row and backfills it.
 *
 * Safe to call more than once for the same payment: the Stripe idempotency key
 * is derived from payments.id and every parameter from the frozen row, so a
 * repeat inside Stripe's window returns the ORIGINAL session instead of opening
 * a second payable one. That is what lets a request whose Stripe call failed —
 * or whose response was lost after Stripe had already created the session — be
 * finished by a retry rather than wedging its Idempotency-Key forever.
 */
async function openCheckoutSession(
  payment: Payment,
  currencyName: string,
): Promise<{ id: string; url: string }> {
  // metadata.payment_id is the DURABLE ANCHOR. It is written atomically with
  // the session's existence, so it cannot drift from it and cannot be missing
  // from any event about this session. The stripe_session_id column, backfilled
  // below, is only a convenience index — and the webhook heals it if this
  // backfill fails or has not committed by the time the event arrives.
  //
  // If this call throws, the pending row stays without a checkout URL. That is
  // harmless: no grant can ever depend on it, it can never become 'paid'
  // without a verified webhook, and a retry with the same Idempotency-Key
  // resumes it here. DESIGN.md records the periodic sweeper for rows nobody
  // retries as an explicit out-of-scope decision rather than an oversight.
  const paymentReference = { payment_id: String(payment.id) };

  const session = await getStripe().checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: STRIPE_CURRENCY,
            product_data: { name: `${payment.credits} ${currencyName}` },
            unit_amount: payment.amountPaise,
          },
          quantity: 1,
        },
      ],
      metadata: paymentReference,
      // Also stamped onto the PaymentIntent so events that key on pi_ rather than
      // cs_ — refunds and disputes — can find this payment too. Not used by this
      // build, but it costs one line now and cannot be added retroactively to
      // sessions that already exist.
      payment_intent_data: { metadata: paymentReference },
      success_url: `${env.frontendUrl}/wallet?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.frontendUrl}/wallet?checkout=cancelled`,
    },
    { idempotencyKey: stripeIdempotencyKeyFor(payment.id) },
  );

  // A failure to backfill is NOT fatal to the request. The session exists and
  // is payable, and the webhook's tier-2 lookup will find the payment by
  // metadata.payment_id and heal this column during the grant. Failing the
  // request would be worse: the caller would see an error for a session that
  // is live and will charge them.
  if (session.url === null) {
    throw new Error(`Stripe returned session ${session.id} without a checkout URL.`);
  }

  try {
    // checkoutUrl is written in the same update: it is what lets an idempotent
    // replay be answered from our own database, and its presence is also the
    // signal that this request finished — a caller that finds it still NULL
    // resumes through this function instead.
    await payment.update({ stripeSessionId: session.id, checkoutUrl: session.url });
  } catch (error) {
    console.error(
      `[payments] failed to backfill stripe_session_id for payment ${payment.id}; ` +
        'the webhook will heal it via metadata.payment_id.',
      error,
    );
  }

  return { id: session.id, url: session.url };
}

/**
 * Answers a repeat request with the payment the first one created.
 *
 * A key reused with DIFFERENT parameters is refused rather than papered over.
 * Returning the original silently would charge for something the caller did
 * not just ask for; this is almost always a client bug (a key generated once
 * and reused forever) and it should be loud. Stripe behaves the same way.
 *
 * A payment with no checkout URL yet is RESUMED: either its request is still
 * mid-flight with Stripe, or its Stripe call failed. Both are answered by
 * calling Stripe again with the payment's own idempotency key — a finished
 * first call yields the same session, a still-running one yields Stripe's
 * in-progress conflict, and a failed one is simply completed now.
 */
async function replayExistingPayment(
  existing: Payment,
  quote: PriceQuote,
): Promise<CheckoutSessionResult> {
  const matchesOriginalRequest =
    existing.currencyId === quote.currency.id &&
    existing.credits === quote.credits &&
    existing.amountPaise === quote.amountPaise;

  if (!matchesOriginalRequest) {
    throw new ConflictError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different purchase. ' +
        'Generate a new key for a new purchase.',
    );
  }

  if (existing.checkoutUrl !== null) {
    return {
      replayed: true,
      payload: {
        payment_id: existing.id,
        stripe_session_id: existing.stripeSessionId,
        checkout_url: existing.checkoutUrl,
        credits: existing.credits,
        amount_paise: existing.amountPaise,
      },
    };
  }

  // Only a pending payment inside Stripe's idempotency window may be resumed.
  // Anything else could make Stripe open a second payable session for a row
  // that has already been paid for, or whose first session may still be paid.
  const withinWindow = Date.now() - existing.createdAt.getTime() < RESUME_WINDOW_MS;
  if (existing.status !== 'pending' || !withinWindow) {
    throw new ConflictError(
      'CHECKOUT_NOT_RESUMABLE',
      'The purchase started with this Idempotency-Key can no longer be resumed. ' +
        'Generate a new key to start a new purchase.',
    );
  }

  let session: { id: string; url: string };
  try {
    // The currency is the one the original request named — matchesOriginalRequest
    // compared currency ids above — so the product name, like every other
    // parameter, is identical to the first call's.
    session = await openCheckoutSession(existing, quote.currency.name);
  } catch (error) {
    if (isStripeIdempotencyConflict(error)) {
      throw new ConflictError(
        'IDEMPOTENT_REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }
    throw error;
  }

  return {
    replayed: true,
    payload: {
      payment_id: existing.id,
      stripe_session_id: session.id,
      checkout_url: session.url,
      credits: existing.credits,
      amount_paise: existing.amountPaise,
    },
  };
}

export async function createCheckoutSession(
  userId: number,
  body: unknown,
  rawIdempotencyKey?: unknown,
): Promise<CheckoutSessionResult> {
  const quote = await quotePurchase(body);
  const idempotencyKey = readIdempotencyKey(rawIdempotencyKey);

  // Fast path. Scoped by userId as well as the key — a key is unique per user,
  // never globally, so one caller's key can never surface another's payment.
  if (idempotencyKey !== null) {
    const existing = await Payment.findOne({ where: { userId, idempotencyKey } });
    if (existing !== null) return replayExistingPayment(existing, quote);
  }

  // ── 1. THE LOCAL RECORD, BEFORE THE MONEY-MOVING OBJECT ─────────────────
  //
  // This ordering is the single most important line in the payment flow.
  //
  // If the Stripe session were created first and this insert then failed, a
  // customer could be charged for a session with no local row to account for
  // it. The webhook would arrive, find nothing, and — per our own contract —
  // return 200 so Stripe stops retrying. That converts a transient database
  // error into permanent, silent loss of the customer's money.
  //
  // Inserting first makes every failure land on the harmless side: an insert
  // failure means no Stripe call ever happened and nothing was charged.
  //
  // stripeSessionId is deliberately NULL here — the session does not exist yet.
  // That is why the column is nullable-unique in the migration.
  let payment: Payment;
  try {
    payment = await Payment.create({
      userId,
      currencyId: quote.currency.id,
      planId: quote.plan?.id ?? null,
      purchaseKind: quote.purchaseKind,
      credits: quote.credits,
      amountPaise: quote.amountPaise,
      status: 'pending',
      idempotencyKey,
    });
  } catch (error) {
    // A concurrent request with the same key won the unique index between our
    // fast-path read above and this insert. The index is the guarantee; the
    // read was only an optimisation. Losing the race is a normal outcome, so
    // resolve to whatever the winner created.
    if (isUniqueViolation(error, 'uq_payments_user_idempotency_key') && idempotencyKey !== null) {
      const winner = await Payment.findOne({ where: { userId, idempotencyKey } });
      if (winner !== null) return replayExistingPayment(winner, quote);
    }
    throw error;
  }

  // ── 2. THE STRIPE SESSION, CARRYING OUR ID, THEN THE BACKFILL ─────────
  const session = await openCheckoutSession(payment, quote.currency.name);

  return {
    replayed: false,
    payload: {
      payment_id: payment.id,
      stripe_session_id: session.id,
      checkout_url: session.url,
      // Echoed for display only. Both were computed server-side and are now
      // frozen on the payment row.
      credits: quote.credits,
      amount_paise: quote.amountPaise,
    },
  };
}

/**
 * The endpoint the post-redirect page polls.
 *
 * A PURE READ of our own database. It never calls Stripe and it can never grant
 * credits — that is the entire point. The browser coming back from Checkout
 * proves nothing about payment, so this reports what the verified webhook has
 * recorded so far and nothing more.
 *
 * Scoped to the authenticated user: another user's session is a 404.
 */
export async function getPaymentBySessionId(
  userId: number,
  stripeSessionId: string,
): Promise<unknown> {
  const payment = await Payment.findOne({
    where: { stripeSessionId, userId },
    include: [{ model: Currency, as: 'currency' }],
  });

  if (payment === null) {
    throw new NotFoundError('No payment found for that checkout session.');
  }

  return {
    payment_id: payment.id,
    stripe_session_id: payment.stripeSessionId,
    status: payment.status,
    purchase_kind: payment.purchaseKind,
    credits: payment.credits,
    currency_code: payment.currency?.code ?? null,
    amount_paise: payment.amountPaise,
  };
}
