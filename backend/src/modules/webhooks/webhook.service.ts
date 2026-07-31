import type Stripe from 'stripe';
import { requireStripeWebhookSecret } from '../../config/env';
import { getStripe } from '../../lib/stripe';
import { BadRequestError } from '../../lib/errors';
import { isUniqueViolation } from '../../lib/isUniqueViolation';
import { Balance, LedgerEntry, Payment, Wallet, sequelize } from '../../models';

/**
 * Why every outcome below is a 200.
 *
 * Stripe retries on any non-2xx. A 5xx is therefore a REQUEST to be redelivered
 * and should be reserved for failures a retry could plausibly fix — a database
 * blip, a deadlock. Everything else is final: a duplicate delivery, an event
 * type we do not handle, a session that was never paid. Returning 5xx for those
 * would make Stripe retry for days against an endpoint that will never behave
 * differently.
 *
 * The one non-2xx is a bad signature, which is a 400: it is not a redelivery
 * candidate, it is a rejected request.
 */
export type GrantOutcome =
  | 'granted'
  | 'already_granted'
  | 'already_granted_concurrent'
  | 'unknown_payment'
  | 'payment_not_pending'
  | 'not_paid'
  | 'unhandled_event_type';

/**
 * Events that can move credits. Both carry a Checkout Session and both resolve
 * to the same payment-keyed transition, so they share one code path.
 *
 * `async_payment_succeeded` fires for delayed methods where the session
 * completes before funds clear. No such method is enabled here — this build is
 * card-only — but handling it costs one line and makes DESIGN.md's claim that
 * the async path "slots into the same transition" literally true rather than
 * hypothetical.
 */
const GRANTING_EVENT_TYPES = new Set<string>([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/**
 * Verifies the Stripe-Signature header against the RAW request bytes.
 *
 * This runs before anything touches the database. A forged or unsigned request
 * is rejected here, so an attacker cannot cause so much as a SELECT.
 *
 * Stripe signs the exact bytes it sent. `rawBody` must therefore be the
 * unparsed Buffer — re-serializing a parsed object would not reproduce those
 * bytes (key order, whitespace, unicode escaping all differ) and every
 * signature would fail for reasons unrelated to authenticity.
 */
export function constructVerifiedEvent(rawBody: unknown, signature: unknown): Stripe.Event {
  if (!Buffer.isBuffer(rawBody)) {
    // A 500, not a 400: the caller did nothing wrong, the server is miswired.
    // This fires if express.raw is ever mounted after express.json, and says so
    // instead of presenting as a mysterious run of signature failures.
    throw new Error(
      'Webhook body was not raw bytes. express.raw({ type: "application/json" }) must be ' +
        'mounted for this route BEFORE the global express.json() in app.ts.',
    );
  }

  if (typeof signature !== 'string' || signature === '') {
    throw new BadRequestError('INVALID_SIGNATURE', 'Missing Stripe-Signature header.');
  }

  try {
    return getStripe().webhooks.constructEvent(rawBody, signature, requireStripeWebhookSecret());
  } catch (error) {
    // Logged server-side but never echoed back: a caller probing the endpoint
    // learns only that it was rejected, while an operator can tell a genuine
    // forgery from a stale STRIPE_WEBHOOK_SECRET — which otherwise presents as
    // "the webhook silently does nothing", the least debuggable failure there is.
    console.warn(
      `[webhook] REJECTED: signature verification failed (${
        error instanceof Error ? error.message : 'unknown reason'
      }). If deliveries are being rejected in bulk, check STRIPE_WEBHOOK_SECRET ` +
        'against `stripe listen --print-secret`.',
    );
    throw new BadRequestError('INVALID_SIGNATURE', 'Signature verification failed.');
  }
}

function readPaymentIdFromMetadata(session: Stripe.Checkout.Session): number | null {
  const raw = session.metadata?.payment_id;
  if (raw === undefined) return null;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === 'string') return session.payment_intent;
  return session.payment_intent?.id ?? null;
}

/**
 * Grants credits for a paid Checkout Session — at most once, ever.
 *
 * TWO-TIER PAYMENT RESOLUTION
 *   Tier 1: by stripe_session_id, the normal path.
 *   Tier 2: by metadata.payment_id, when tier 1 misses.
 *
 * Tier 2 is not a fallback for rare corruption; it covers two real cases. The
 * cs_ backfill in checkout-session creation can FAIL, and it can also simply be
 * LATE — Stripe is entirely capable of delivering the webhook before our own
 * UPDATE commits. metadata is written atomically with the session's existence
 * and cannot drift, which is why it, not the column, is the durable anchor.
 *
 * Whichever tier finds the row, the grant is keyed on payments.id, so
 * uq_ledger_payment_id is indifferent to how we got there.
 *
 * EXACTLY-ONCE has two layers, and only the second is a guarantee:
 *   - the payment row is locked FOR UPDATE and the status checked. This
 *     serializes concurrent deliveries and makes duplicates cheap.
 *   - UNIQUE(ledger.payment_id) makes a second grant IMPOSSIBLE. If the lock
 *     were removed tomorrow, credits would still be granted exactly once.
 */
export async function grantCreditsForSession(session: Stripe.Checkout.Session): Promise<GrantOutcome> {
  const metadataPaymentId = readPaymentIdFromMetadata(session);
  const paymentIntentId = readPaymentIntentId(session);

  try {
    return await sequelize.transaction(async (transaction) => {
      // Tier 1.
      let payment = await Payment.findOne({
        where: { stripeSessionId: session.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      // Tier 2 — heals a missing or not-yet-committed cs_.
      if (payment === null && metadataPaymentId !== null) {
        payment = await Payment.findOne({
          where: { id: metadataPaymentId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      }

      if (payment === null) {
        // Genuinely unknown to us. Retrying cannot change that, so this is a
        // 200 — but it is logged, because it should never happen.
        console.error(
          `[webhook] no payment found for session ${session.id} ` +
            `(metadata.payment_id=${metadataPaymentId ?? 'absent'})`,
        );
        return 'unknown_payment';
      }

      // Heal the convenience columns from the event, inside the same
      // transaction as the grant.
      const healed: Partial<{ stripeSessionId: string; stripePaymentIntentId: string }> = {};
      if (payment.stripeSessionId === null) healed.stripeSessionId = session.id;
      if (payment.stripePaymentIntentId === null && paymentIntentId !== null) {
        healed.stripePaymentIntentId = paymentIntentId;
      }
      if (Object.keys(healed).length > 0) {
        await payment.update(healed, { transaction });
      }

      // Fast path: this payment already granted. Not an error — it is the
      // expected result of a redelivery, and Stripe redelivers routinely.
      if (payment.status === 'paid') {
        return 'already_granted';
      }

      // 'expired' or 'failed' must never become 'paid'. The transition is
      // strictly pending -> paid, one way.
      if (payment.status !== 'pending') {
        console.error(
          `[webhook] refusing to grant for payment ${payment.id}: status is "${payment.status}", not "pending".`,
        );
        return 'payment_not_pending';
      }

      // Sanity check, logged rather than enforced. amount_total is derived from
      // the unit_amount WE sent, so a mismatch means our own data drifted — a
      // bug worth surfacing, but the frozen row is authoritative for credits
      // and refusing to grant here would punish the customer for our error.
      if (session.amount_total !== null && session.amount_total !== payment.amountPaise) {
        console.error(
          `[webhook] amount mismatch on payment ${payment.id}: ` +
            `Stripe ${session.amount_total} vs recorded ${payment.amountPaise}.`,
        );
      }

      const wallet = await Wallet.findOne({ where: { userId: payment.userId }, transaction });
      if (wallet === null) {
        // Signup creates the wallet in the same transaction as the user, so
        // this is unreachable. Throwing gives a 500 and a redelivery rather
        // than silently swallowing a broken invariant.
        throw new Error(`Payment ${payment.id} belongs to user ${payment.userId}, who has no wallet.`);
      }

      // THE structural guarantee. A concurrent duplicate that gets past the
      // status check above dies here, on the unique index.
      await LedgerEntry.create(
        {
          walletId: wallet.id,
          currencyId: payment.currencyId,
          delta: payment.credits,
          reason: 'purchase',
          paymentId: payment.id,
        },
        { transaction },
      );

      // Atomic SQL increment (balance = balance + n), not read-then-write, so
      // concurrent grants to the same balance cannot lose an update. The spend
      // path locks this row explicitly instead, because it must READ the value
      // to check sufficiency — a grant only ever adds.
      await Balance.increment(
        { balance: payment.credits },
        { where: { walletId: wallet.id, currencyId: payment.currencyId }, transaction },
      );

      await payment.update({ status: 'paid' }, { transaction });

      return 'granted';
    });
  } catch (error) {
    // A duplicate here means a concurrent delivery won the race and granted
    // first. This whole transaction rolled back, so nothing partial was
    // written — and the credits are already in the wallet. Idempotent success.
    if (isUniqueViolation(error, 'uq_ledger_payment_id')) {
      return 'already_granted_concurrent';
    }
    throw error;
  }
}

/**
 * Routes a verified event. Anything that is not a paid, granting event is
 * acknowledged and ignored.
 */
export async function processVerifiedEvent(event: Stripe.Event): Promise<GrantOutcome> {
  if (!GRANTING_EVENT_TYPES.has(event.type)) {
    return 'unhandled_event_type';
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // The guard that makes "no credits without payment" true. A session can be
  // 'completed' while still unpaid — delayed payment methods do exactly that —
  // so completion alone is never sufficient.
  if (session.payment_status !== 'paid') {
    return 'not_paid';
  }

  return grantCreditsForSession(session);
}
