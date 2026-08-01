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

function readIdempotencyKey(raw: unknown): string | null {
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
 * Answers a repeat request with the payment the first one created.
 *
 * Two things are refused rather than papered over:
 *
 *   - A key reused with DIFFERENT parameters. Returning the original silently
 *     would charge for something the caller did not just ask for; this is
 *     almost always a client bug (a key generated once and reused forever) and
 *     it should be loud. Stripe behaves the same way.
 *   - A key whose payment has no checkout URL yet. That means a concurrent
 *     request won the unique index and is still mid-flight with Stripe, so
 *     there is nothing coherent to return. The caller is told to retry rather
 *     than handed a half-built response.
 */
function replayExistingPayment(existing: Payment, quote: PriceQuote): CheckoutSessionResult {
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

  if (existing.checkoutUrl === null) {
    throw new ConflictError(
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    );
  }

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

  // ── 2. THE STRIPE SESSION, CARRYING OUR ID ──────────────────────────────
  //
  // metadata.payment_id is the DURABLE ANCHOR. It is written atomically with
  // the session's existence, so it cannot drift from it and cannot be missing
  // from any event about this session. The stripe_session_id column, backfilled
  // below, is only a convenience index — and the webhook heals it if this
  // backfill fails or has not committed by the time the event arrives.
  //
  // If this call throws, the pending row above is orphaned. That is harmless
  // and documented: no grant can ever depend on it, and it can never become
  // 'paid' without a verified webhook. DESIGN.md records the periodic sweeper
  // as an explicit out-of-scope decision rather than an oversight.
  const paymentReference = { payment_id: String(payment.id) };

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: STRIPE_CURRENCY,
          product_data: { name: `${quote.credits} ${quote.currency.name}` },
          unit_amount: quote.amountPaise,
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
  });

  // ── 3. BACKFILL THE CONVENIENCE INDEX ───────────────────────────────────
  //
  // A failure here is NOT fatal to the request. The session exists and is
  // payable, and the webhook's tier-2 lookup will find the payment by
  // metadata.payment_id and heal this column during the grant. Failing the
  // request would be worse: the caller would see an error for a session that
  // is live and will charge them.
  if (session.url === null) {
    throw new Error(`Stripe returned session ${session.id} without a checkout URL.`);
  }

  try {
    // checkoutUrl is written in the same update: it is what lets an idempotent
    // replay be answered from our own database, and its presence is also the
    // signal that this request finished — a concurrent caller that finds it
    // still NULL knows the winner is mid-flight.
    await payment.update({ stripeSessionId: session.id, checkoutUrl: session.url });
  } catch (error) {
    console.error(
      `[payments] failed to backfill stripe_session_id for payment ${payment.id}; ` +
        'the webhook will heal it via metadata.payment_id.',
      error,
    );
  }

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
