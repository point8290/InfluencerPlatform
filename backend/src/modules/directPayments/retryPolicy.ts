import type { ChargeResult } from './gateways/gateway';

/**
 * What the engine does after a gateway call. Pure, so every rule is unit
 * testable without a database or a gateway.
 *
 *   grant            money taken — credit the wallet (exactly once).
 *   fail             definitively not paid — stop.
 *   needs_customer   only the customer can finish this (3-D Secure) — stop.
 *   retry_same_key   re-send THIS attempt; the gateway executes it at most once.
 *   retry_new_key    the attempt definitely failed; start a fresh one.
 *   reconcile        outcome unknown and the budget is spent (or a re-send
 *                    would not help) — leave the payment pending and resolve it
 *                    later. NEVER "fail": the card may have been charged.
 */
export type NextStep =
  | 'grant'
  | 'fail'
  | 'needs_customer'
  | 'retry_same_key'
  | 'retry_new_key'
  | 'reconcile';

export function decideNextStep(result: ChargeResult, retriesUsed: number, maxRetries: number): NextStep {
  const budgetLeft = retriesUsed < maxRetries;

  switch (result.kind) {
    case 'succeeded':
      return 'grant';
    case 'requires_action':
      return 'needs_customer';
    case 'declined':
      if (!result.retryable) return 'fail';
      return budgetLeft ? 'retry_new_key' : 'fail';
    case 'transient':
      // Out of budget on a transient error is NOT a failure. A timed-out call
      // may have charged; only reconciliation can say.
      return budgetLeft ? 'retry_same_key' : 'reconcile';
    case 'unknown':
      return 'reconcile';
  }
}

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with FULL jitter: a uniformly random delay between 0 and
 * min(max, base × 2^(n-1)) before retry n.
 *
 * The exponential part backs off from a struggling gateway; the jitter spreads
 * out clients that all failed at the same moment, so they do not all come back
 * at the same moment too and knock it over again.
 *
 * `random` is injectable so tests can pin it.
 */
export function backoffDelayMs(
  retryNumber: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryNumber - 1));
  return Math.floor(random() * ceiling);
}
