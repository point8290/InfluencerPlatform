import type { ChargeResult } from '../src/modules/directPayments/gateways/gateway';
import { classifyStripeError } from '../src/modules/directPayments/gateways/stripeGateway';
import { backoffDelayMs, decideNextStep } from '../src/modules/directPayments/retryPolicy';

/**
 * The retry rules as pure functions — no database, no gateway. Each case here
 * is a line an interviewer would probe: which failures are retried, with which
 * key, and what happens when the budget runs out.
 */
describe('retry policy', () => {
  const transient: ChargeResult = { kind: 'transient', code: 'network_timeout', message: '' };
  const unknown: ChargeResult = { kind: 'unknown', reference: null, code: 'api_error', message: '' };
  const decline = (retryable: boolean): ChargeResult => ({
    kind: 'declined',
    retryable,
    reference: null,
    code: 'x',
    message: '',
    replayed: false,
  });

  it('grants on success and hands 3-D Secure back to the customer', () => {
    expect(decideNextStep({ kind: 'succeeded', reference: 'r', replayed: false }, 0, 3)).toBe('grant');
    expect(
      decideNextStep(
        { kind: 'requires_action', reference: null, code: 'x', message: '', replayed: false },
        0,
        3,
      ),
    ).toBe('needs_customer');
  });

  it('re-sends transient failures under the same key while budget remains', () => {
    expect(decideNextStep(transient, 0, 3)).toBe('retry_same_key');
    expect(decideNextStep(transient, 2, 3)).toBe('retry_same_key');
  });

  it('never fails a payment on transient errors — it reconciles instead', () => {
    expect(decideNextStep(transient, 3, 3)).toBe('reconcile');
    expect(decideNextStep(unknown, 0, 3)).toBe('reconcile');
  });

  it('starts a new attempt only for retryable declines, and fails hard declines at once', () => {
    expect(decideNextStep(decline(true), 0, 3)).toBe('retry_new_key');
    expect(decideNextStep(decline(true), 3, 3)).toBe('fail');
    expect(decideNextStep(decline(false), 0, 3)).toBe('fail');
  });

  it('backs off exponentially with full jitter, capped', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 500 };
    const top = () => 0.999999;

    expect(backoffDelayMs(1, policy, top)).toBe(99);
    expect(backoffDelayMs(2, policy, top)).toBe(199);
    expect(backoffDelayMs(3, policy, top)).toBe(399);
    expect(backoffDelayMs(4, policy, top)).toBe(499); // capped at 500
    expect(backoffDelayMs(4, policy, () => 0)).toBe(0); // jitter reaches zero
  });
});

describe('Stripe error classification', () => {
  it('treats processing errors as retryable declines and insufficient funds as final', () => {
    expect(classifyStripeError({ type: 'StripeCardError', code: 'processing_error' })).toMatchObject({
      kind: 'declined',
      retryable: true,
    });
    expect(
      classifyStripeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'insufficient_funds' }),
    ).toMatchObject({ kind: 'declined', retryable: false });
    expect(
      classifyStripeError({ type: 'StripeCardError', code: 'card_declined', advice_code: 'try_again_later' }),
    ).toMatchObject({ kind: 'declined', retryable: true });
  });

  it('re-sends connection errors and rate limits, but not 5xx', () => {
    expect(classifyStripeError({ type: 'StripeConnectionError' })).toMatchObject({ kind: 'transient' });
    expect(classifyStripeError({ type: 'StripeRateLimitError' })).toMatchObject({ kind: 'transient' });
    // Stripe stores a 5xx under the key, so a same-key re-send cannot help.
    expect(classifyStripeError({ type: 'StripeAPIError' })).toMatchObject({ kind: 'unknown' });
  });

  it('refuses to classify programming errors as payment outcomes', () => {
    expect(classifyStripeError({ type: 'StripeInvalidRequestError', code: 'parameter_missing' })).toBeNull();
    expect(classifyStripeError({ type: 'StripeAuthenticationError' })).toBeNull();
  });
});
