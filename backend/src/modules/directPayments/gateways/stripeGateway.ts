import type Stripe from 'stripe';
import { getStripe } from '../../../lib/stripe';
import type { ChargeRequest, ChargeResult, PaymentGateway, PaymentMethodOption } from './gateway';

/**
 * Stripe PaymentIntents, created and confirmed by THIS server in one call.
 *
 * A production integration would collect the card with Stripe Elements in the
 * browser and receive a `pm_…` token, so raw card numbers never touch this
 * server. Stripe's test-mode tokens below stand in for that step: each one is
 * a pre-built PaymentMethod that behaves a documented way.
 *
 * Stripe's SDK can retry by itself (`maxNetworkRetries`). It is switched OFF
 * for these calls so that every retry is made — and recorded — by the engine,
 * which is the point of this flow.
 */

const PAYMENT_METHODS: readonly PaymentMethodOption[] = [
  {
    id: 'pm_card_visa',
    label: 'Visa — succeeds',
    description: 'Stripe test card that always succeeds.',
    usesFailureCount: false,
  },
  {
    id: 'pm_card_chargeDeclinedProcessingError',
    label: 'Processing error',
    description:
      'Always declined with processing_error — retryable, so every retry is a new attempt with a new key, until the budget runs out.',
    usesFailureCount: false,
  },
  {
    id: 'pm_card_chargeDeclinedInsufficientFunds',
    label: 'Insufficient funds',
    description: 'Hard decline. Never retried.',
    usesFailureCount: false,
  },
  {
    id: 'pm_card_authenticationRequired',
    label: '3-D Secure required',
    description: 'Requires customer authentication, which a server-side retry cannot provide.',
    usesFailureCount: false,
  },
];

/**
 * Issuer decline codes Stripe documents as worth retrying later. Everything
 * else — stolen card, insufficient funds, incorrect CVC — is final: retrying it
 * cannot succeed and card networks penalise merchants who keep trying.
 */
const RETRYABLE_DECLINE_CODES = new Set([
  'processing_error',
  'issuer_not_available',
  'try_again_later',
  'reenter_transaction',
  'approve_with_id',
]);

function fromPaymentIntent(intent: Stripe.PaymentIntent, replayed: boolean): ChargeResult {
  switch (intent.status) {
    case 'succeeded':
      return { kind: 'succeeded', reference: intent.id, replayed };
    case 'requires_action':
      return {
        kind: 'requires_action',
        reference: intent.id,
        code: 'authentication_required',
        message: 'The customer must authenticate this payment.',
        replayed,
      };
    case 'requires_payment_method':
      return {
        kind: 'declined',
        retryable: false,
        reference: intent.id,
        code: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? 'declined',
        message: intent.last_payment_error?.message ?? 'The payment was declined.',
        replayed,
      };
    default:
      // 'processing' and friends: the charge is under way and its result will
      // arrive later. Nothing to retry — reconcile.
      return {
        kind: 'unknown',
        reference: intent.id,
        code: `status_${intent.status}`,
        message: `PaymentIntent is "${intent.status}".`,
      };
  }
}

/**
 * Turns a thrown Stripe error into an outcome. Exported for unit tests: this
 * mapping is where a wrong answer becomes a double charge or a lost sale.
 */
export function classifyStripeError(error: unknown): ChargeResult | null {
  if (typeof error !== 'object' || error === null) return null;

  const e = error as {
    type?: string;
    code?: string;
    decline_code?: string;
    advice_code?: string;
    message?: string;
    payment_intent?: { id: string };
  };
  const message = e.message ?? 'Stripe request failed.';
  const reference = e.payment_intent?.id ?? null;

  switch (e.type) {
    case 'StripeCardError': {
      const code = e.decline_code ?? e.code ?? 'card_declined';
      if (code === 'authentication_required') {
        return { kind: 'requires_action', reference, code, message, replayed: false };
      }
      const retryable =
        e.advice_code === 'try_again_later' ||
        RETRYABLE_DECLINE_CODES.has(code) ||
        RETRYABLE_DECLINE_CODES.has(e.code ?? '');
      return { kind: 'declined', retryable, reference, code, message, replayed: false };
    }

    // The request may or may not have reached Stripe. Either way the SAME key
    // is safe: if it executed, Stripe replays the stored result.
    case 'StripeConnectionError':
      return { kind: 'transient', code: 'connection_error', message };

    // Refused before execution; nothing was stored under the key.
    case 'StripeRateLimitError':
      return { kind: 'transient', code: e.code ?? 'rate_limited', message };

    // Another request with this key is still running.
    case 'StripeIdempotencyError':
      return { kind: 'transient', code: 'idempotency_in_flight', message };

    // Stripe STORES 5xx results under the idempotency key, so a same-key
    // re-send returns the same 500. The charge may even have gone through.
    // The honest answer is "unknown": stop, and reconcile.
    case 'StripeAPIError':
      return { kind: 'unknown', reference, code: e.code ?? 'api_error', message };

    default:
      if (e.code === 'lock_timeout') {
        return { kind: 'transient', code: 'lock_timeout', message };
      }
      // Invalid request, bad key, permissions: a bug, not a payment outcome.
      return null;
  }
}

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  readonly paymentMethods = PAYMENT_METHODS;

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await getStripe().paymentIntents.create(
        {
          amount: request.amountPaise,
          currency: 'inr',
          payment_method: request.paymentMethod,
          payment_method_types: ['card'],
          confirm: true,
          description: request.description,
          metadata: { payment_id: String(request.paymentId), attempt_key: request.idempotencyKey },
        },
        { idempotencyKey: request.idempotencyKey, maxNetworkRetries: 0 },
      );
      const replayed = intent.lastResponse?.headers?.['idempotent-replayed'] === 'true';
      return fromPaymentIntent(intent, replayed);
    } catch (error) {
      const classified = classifyStripeError(error);
      if (classified === null) throw error;
      return classified;
    }
  }

  async retrieve(reference: string): Promise<ChargeResult> {
    try {
      const intent = await getStripe().paymentIntents.retrieve(reference, undefined, {
        maxNetworkRetries: 0,
      });
      return fromPaymentIntent(intent, false);
    } catch (error) {
      const classified = classifyStripeError(error);
      if (classified === null) throw error;
      return classified;
    }
  }
}
