/**
 * The contract between the retry engine and any payment gateway.
 *
 * The engine never sees a gateway's own error classes. Each gateway translates
 * its responses into ONE of the outcomes below, and that translation is the
 * single most important thing a gateway adapter does — because the outcome, not
 * the error message, decides whether a retry is safe:
 *
 *   succeeded        money taken. Grant.
 *   requires_action  the customer must act (3-D Secure / OTP). No server retry
 *                    can complete it — stop and hand back to the customer.
 *   declined         the gateway executed the charge and it failed.
 *                      retryable: a fresh attempt (NEW idempotency key) may
 *                                 succeed — processing_error, issuer down.
 *                      otherwise: stop — stolen card, insufficient funds …
 *   transient        the call failed in a way that is safe to RE-SEND UNDER THE
 *                    SAME KEY: a timeout, a dropped connection, a 429. Either
 *                    the charge never executed, or it did and the gateway will
 *                    replay the stored result. Never a new key: if the lost
 *                    call did charge, a new key would charge again.
 *   unknown          the outcome cannot be determined and a re-send would not
 *                    help (e.g. Stripe caches 5xx responses under the key).
 *                    Stop and reconcile later.
 */
export type ChargeResult =
  | { kind: 'succeeded'; reference: string; replayed: boolean }
  | { kind: 'requires_action'; reference: string | null; code: string; message: string; replayed: boolean }
  | {
      kind: 'declined';
      retryable: boolean;
      reference: string | null;
      code: string;
      message: string;
      replayed: boolean;
    }
  | { kind: 'transient'; code: string; message: string }
  | { kind: 'unknown'; reference: string | null; code: string; message: string };

export interface ChargeRequest {
  paymentId: number;
  /** One per ATTEMPT. Re-sends of the same attempt reuse it. */
  idempotencyKey: string;
  amountPaise: number;
  description: string;
  paymentMethod: string;
  /** Read only by the simulated gateway: how many failures to inject. */
  simulatedFailures: number;
}

export interface PaymentMethodOption {
  id: string;
  label: string;
  description: string;
  /** Whether the "simulated failures" count changes this method's behaviour. */
  usesFailureCount: boolean;
}

export interface PaymentGateway {
  readonly name: 'simulated' | 'stripe';
  /** The test instruments the UI may offer. Anything else is rejected. */
  readonly paymentMethods: readonly PaymentMethodOption[];

  /** Performs (or replays, under the same key) one charge attempt. */
  charge(request: ChargeRequest): Promise<ChargeResult>;

  /**
   * Looks a charge up by the gateway's own reference. Used by reconciliation
   * when an attempt's outcome was unknown but the gateway did hand back an id.
   */
  retrieve(reference: string): Promise<ChargeResult>;
}
