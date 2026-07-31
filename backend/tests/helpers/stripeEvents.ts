import { createHmac } from 'node:crypto';

/**
 * Builds a Stripe-Signature header by hand.
 *
 * Deliberately NOT using stripe.webhooks.generateTestHeaderString(): signing
 * with the library we verify with would only prove the library agrees with
 * itself. Constructing the header independently, from Stripe's published
 * scheme, tests our verification against something external to it.
 *
 * The scheme is: sign "<timestamp>.<raw body>" with HMAC-SHA256 under the
 * endpoint secret, then send `t=<timestamp>,v1=<hex digest>`.
 */
export function stripeSignatureHeader(
  payload: string,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const digest = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  return `t=${timestampSeconds},v1=${digest}`;
}

interface SessionEventOptions {
  sessionId: string;
  paymentId?: number | null;
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  amountTotal?: number;
  eventId?: string;
  type?: string;
  paymentIntentId?: string;
}

/**
 * A `checkout.session.completed` event body, shaped like Stripe's.
 *
 * Only the fields the handler actually reads are populated — a real event is
 * far larger, and copying all of it would imply the handler depends on more
 * than it does.
 */
export function checkoutSessionEvent(options: SessionEventOptions): Record<string, unknown> {
  const {
    sessionId,
    paymentId = null,
    paymentStatus = 'paid',
    amountTotal = 30_000,
    eventId = `evt_test_${Math.random().toString(36).slice(2, 12)}`,
    type = 'checkout.session.completed',
    paymentIntentId = `pi_test_${Math.random().toString(36).slice(2, 12)}`,
  } = options;

  return {
    id: eventId,
    object: 'event',
    type,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: paymentStatus,
        amount_total: amountTotal,
        currency: 'inr',
        payment_intent: paymentIntentId,
        metadata: paymentId === null ? {} : { payment_id: String(paymentId) },
      },
    },
  };
}
