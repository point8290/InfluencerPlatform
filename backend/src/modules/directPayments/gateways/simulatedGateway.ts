import { randomUUID } from 'node:crypto';
import type { ChargeRequest, ChargeResult, PaymentGateway, PaymentMethodOption } from './gateway';

/**
 * A fake gateway whose failures can be scripted, so every branch of the retry
 * engine can be driven on demand. A real gateway will not time out when asked.
 *
 * It models the two behaviours of a real gateway that retries depend on:
 *
 *   1. IDEMPOTENCY. A key that has executed stores its result; any later call
 *      with that key gets the stored result back, flagged `replayed`, and does
 *      NOT charge again. Failures that never reached execution (a timeout on
 *      the way in, a 429, an outage) store nothing, so a re-send executes fresh.
 *
 *   2. A CHARGE LEDGER. `chargesFor(paymentId)` counts how many times money was
 *      actually taken for a payment. It is the ground truth a test — or the UI —
 *      uses to prove a retry never double-charged.
 *
 * State is in memory: it is per process and lost on restart. That is fine for a
 * teaching tool, and the reason a real integration reconciles against the
 * gateway rather than trusting its own memory.
 */

type Scenario = (callNumber: number, failures: number) => 'execute' | ChargeResult | 'charge_then_lose_response';

const SIMULATED_LATENCY_MS = 25;

const PAYMENT_METHODS: readonly PaymentMethodOption[] = [
  {
    id: 'sim_success',
    label: 'Succeeds',
    description: 'The charge goes through on the first call.',
    usesFailureCount: false,
  },
  {
    id: 'sim_network_timeout',
    label: 'Network timeout',
    description:
      'The first N calls time out before reaching the gateway. Transient: re-sent with the SAME key.',
    usesFailureCount: true,
  },
  {
    id: 'sim_rate_limited',
    label: 'Rate limited (429)',
    description: 'The first N calls are rejected with 429. Transient: re-sent with the SAME key.',
    usesFailureCount: true,
  },
  {
    id: 'sim_timeout_after_charge',
    label: 'Charged, response lost',
    description:
      'The first call CHARGES the card but its response is lost, as are the next N-1. ' +
      'The same-key re-send is answered from the idempotency cache — one charge, not two.',
    usesFailureCount: true,
  },
  {
    id: 'sim_processing_error',
    label: 'Processing error',
    description:
      'The first N attempts are declined with processing_error. Retryable decline: each retry is a NEW attempt with a NEW key.',
    usesFailureCount: true,
  },
  {
    id: 'sim_insufficient_funds',
    label: 'Insufficient funds',
    description: 'Hard decline. Never retried — only the customer can fix it.',
    usesFailureCount: false,
  },
  {
    id: 'sim_authentication_required',
    label: '3-D Secure required',
    description: 'The bank demands customer authentication. No server retry can complete it.',
    usesFailureCount: false,
  },
];

function transient(code: string, message: string): ChargeResult {
  return { kind: 'transient', code, message };
}

/**
 * Each scenario decides, from the gateway's own count of calls it has seen for
 * this payment, what happens to this call. 'execute' means "reach the gateway
 * and run the charge normally".
 */
const SCENARIOS: Record<string, Scenario> = {
  sim_success: () => 'execute',

  sim_network_timeout: (call, failures) =>
    call <= failures ? transient('network_timeout', 'Request timed out before reaching the gateway.') : 'execute',

  sim_rate_limited: (call, failures) =>
    call <= failures ? transient('rate_limited', 'HTTP 429: too many requests.') : 'execute',

  // Every call up to N loses its response; the first of them charges. With
  // N = 0 this degrades to a plain success.
  sim_timeout_after_charge: (call, failures) => (call <= failures ? 'charge_then_lose_response' : 'execute'),

  // Counted per ATTEMPT (distinct keys) rather than per call, because a
  // processing error is an executed result: the same key replays it.
  sim_processing_error: () => 'execute',

  sim_insufficient_funds: () => ({
    kind: 'declined',
    retryable: false,
    reference: null,
    code: 'insufficient_funds',
    message: 'The card has insufficient funds.',
    replayed: false,
  }),

  sim_authentication_required: () => ({
    kind: 'requires_action',
    reference: null,
    code: 'authentication_required',
    message: 'The card issuer requires the customer to authenticate this payment.',
    replayed: false,
  }),
};

export class SimulatedGateway implements PaymentGateway {
  readonly name = 'simulated' as const;
  readonly paymentMethods = PAYMENT_METHODS;

  /** idempotency key -> the result that key executed to. */
  private readonly executed = new Map<string, ChargeResult>();
  /** payment id -> calls received (including ones that "timed out"). */
  private readonly callsByPayment = new Map<number, number>();
  /** payment id -> distinct keys that executed a charge attempt. */
  private readonly attemptsByPayment = new Map<number, number>();
  /** payment id -> times money was actually taken. */
  private readonly charges = new Map<number, number>();
  /** reference -> result, for retrieve(). */
  private readonly byReference = new Map<string, ChargeResult>();

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));

    const scenario = SCENARIOS[request.paymentMethod];
    if (scenario === undefined) {
      throw new Error(`Simulated gateway has no payment method "${request.paymentMethod}".`);
    }

    const call = (this.callsByPayment.get(request.paymentId) ?? 0) + 1;
    this.callsByPayment.set(request.paymentId, call);

    const plan = scenario(call, request.simulatedFailures);

    // A failure on the way IN never reaches the idempotency layer, so it is
    // decided before the cache is consulted.
    if (typeof plan === 'object' && plan.kind === 'transient') return plan;

    const cached = this.executed.get(request.idempotencyKey);
    if (cached !== undefined) {
      const replay = { ...cached, replayed: true } as ChargeResult;
      // The response can be lost on the way OUT even when it is a replay.
      return plan === 'charge_then_lose_response'
        ? transient('network_timeout', 'Response lost after the gateway processed the request.')
        : replay;
    }

    const result = this.execute(request, plan);
    this.executed.set(request.idempotencyKey, result);

    return plan === 'charge_then_lose_response'
      ? transient('network_timeout', 'Response lost after the gateway processed the request.')
      : result;
  }

  async retrieve(reference: string): Promise<ChargeResult> {
    const result = this.byReference.get(reference);
    if (result === undefined) {
      return { kind: 'unknown', reference, code: 'not_found', message: 'No such charge.' };
    }
    return { ...result, replayed: false } as ChargeResult;
  }

  /** Ground truth for tests and the UI: how many times money was taken. */
  chargesFor(paymentId: number): number {
    return this.charges.get(paymentId) ?? 0;
  }

  /** Tests truncate the database between cases, so payment ids repeat. */
  reset(): void {
    this.executed.clear();
    this.callsByPayment.clear();
    this.attemptsByPayment.clear();
    this.charges.clear();
    this.byReference.clear();
  }

  private execute(request: ChargeRequest, plan: ReturnType<Scenario>): ChargeResult {
    const attempt = (this.attemptsByPayment.get(request.paymentId) ?? 0) + 1;
    this.attemptsByPayment.set(request.paymentId, attempt);

    const reference = `sim_ch_${randomUUID().slice(0, 12)}`;

    if (request.paymentMethod === 'sim_processing_error' && attempt <= request.simulatedFailures) {
      const declined: ChargeResult = {
        kind: 'declined',
        retryable: true,
        reference,
        code: 'processing_error',
        message: 'An error occurred while processing the card. Try again.',
        replayed: false,
      };
      this.byReference.set(reference, declined);
      return declined;
    }

    if (typeof plan === 'object') {
      const withReference = { ...plan, reference } as ChargeResult;
      this.byReference.set(reference, withReference);
      return withReference;
    }

    this.charges.set(request.paymentId, (this.charges.get(request.paymentId) ?? 0) + 1);
    const succeeded: ChargeResult = { kind: 'succeeded', reference, replayed: false };
    this.byReference.set(reference, succeeded);
    return succeeded;
  }
}
