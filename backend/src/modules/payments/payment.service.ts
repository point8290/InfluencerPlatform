import { env } from '../../config/env';
import { getStripe } from '../../lib/stripe';
import { NotFoundError } from '../../lib/errors';
import { Currency, Payment } from '../../models';
import { quotePurchase } from './pricing.service';

/**
 * Every platform price is quoted in Indian paise, and Stripe's smallest-unit
 * convention for INR is also paise — so `amount_paise` passes straight through
 * as `unit_amount` with no conversion. Verified against the live test account
 * before this code was written.
 */
const STRIPE_CURRENCY = 'inr';

export async function createCheckoutSession(userId: number, body: unknown): Promise<unknown> {
  const quote = await quotePurchase(body);

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
  const payment = await Payment.create({
    userId,
    currencyId: quote.currency.id,
    planId: quote.plan?.id ?? null,
    purchaseKind: quote.purchaseKind,
    credits: quote.credits,
    amountPaise: quote.amountPaise,
    status: 'pending',
  });

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
  try {
    await payment.update({ stripeSessionId: session.id });
  } catch (error) {
    console.error(
      `[payments] failed to backfill stripe_session_id for payment ${payment.id}; ` +
        'the webhook will heal it via metadata.payment_id.',
      error,
    );
  }

  if (session.url === null) {
    throw new Error(`Stripe returned session ${session.id} without a checkout URL.`);
  }

  return {
    payment_id: payment.id,
    stripe_session_id: session.id,
    checkout_url: session.url,
    // Echoed for display only. Both were computed server-side and are now
    // frozen on the payment row.
    credits: quote.credits,
    amount_paise: quote.amountPaise,
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
