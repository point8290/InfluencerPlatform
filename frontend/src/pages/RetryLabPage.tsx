import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  formatCredits,
  formatRupees,
  type Currency,
  type DirectPayment,
  type DirectPaymentAttempt,
  type DirectPaymentConfig,
} from '../api/client';

/**
 * A test bench for the server-driven payment flow.
 *
 * Unlike the wallet's Buy button — which hands the browser to Stripe Checkout
 * and lets Stripe run the charge — this page asks OUR server to call the
 * gateway, so the server can retry. Pick how the gateway should misbehave and
 * how many retries the server may spend, then read the call log: every row is
 * one request from our server to the gateway.
 */

const STATE_CHIP: Record<DirectPayment['state'], { tone: string; label: string; explanation: string }> = {
  paid: {
    tone: 'positive',
    label: 'Paid',
    explanation: 'The gateway took the money and the credits were granted exactly once.',
  },
  failed: {
    tone: 'negative',
    label: 'Failed',
    explanation:
      'The gateway definitively declined the payment, either with a hard decline or after the retry budget ran out on retryable declines. Nothing was charged.',
  },
  requires_customer: {
    tone: 'warning',
    label: 'Needs customer',
    explanation:
      'The bank asked for 3-D Secure / OTP. A server-side retry cannot complete this. In a real integration the client_secret goes back to the browser so the customer can authenticate.',
  },
  needs_reconciliation: {
    tone: 'warning',
    label: 'Outcome unknown',
    explanation:
      'Retries ran out on transient errors. The card MAY have been charged, so the payment stays pending rather than failed. Reconcile re-sends the last attempt under its SAME key: a charge that went through is replayed, not repeated.',
  },
  processing: {
    tone: 'info',
    label: 'Processing',
    explanation: 'A request is calling the gateway for this payment right now.',
  },
};

const OUTCOME_CHIP: Record<DirectPaymentAttempt['outcome'], { tone: string; label: string }> = {
  succeeded: { tone: 'positive', label: 'Succeeded' },
  declined: { tone: 'negative', label: 'Declined' },
  requires_action: { tone: 'warning', label: 'Needs customer' },
  transient_error: { tone: 'warning', label: 'Transient' },
  unknown: { tone: 'warning', label: 'Unknown' },
  in_flight: { tone: 'info', label: 'In flight' },
};

/** Why this call was made, in words that make the key rule visible. */
function describeCall(attempt: DirectPaymentAttempt, previous: DirectPaymentAttempt | undefined): string {
  if (attempt.trigger === 'initial') return 'First call';
  if (attempt.trigger === 'reconcile') return 'Reconcile: same key';
  return previous !== undefined && previous.attempt_number === attempt.attempt_number
    ? 'Retry: same key'
    : 'Retry: new attempt, new key';
}

/** Keys are long; the distinguishing part is the tail. */
function shortKey(key: string): string {
  return key.length > 24 ? `…${key.slice(-22)}` : key;
}

export function RetryLabPage() {
  const [config, setConfig] = useState<DirectPaymentConfig | null>(null);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currencyCode, setCurrencyCode] = useState('campaign');
  const [quantity, setQuantity] = useState(100);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [failures, setFailures] = useState(1);
  const [maxRetries, setMaxRetries] = useState(3);

  const [busy, setBusy] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [payment, setPayment] = useState<DirectPayment | null>(null);

  useEffect(() => {
    Promise.all([api.directPaymentConfig(), api.currencies()])
      .then(([loadedConfig, loadedCurrencies]) => {
        setConfig(loadedConfig);
        setCurrencies(loadedCurrencies);
        setMaxRetries(loadedConfig.default_max_retries);
        setPaymentMethod(loadedConfig.payment_methods[0]?.id ?? '');
      })
      .catch((caught: unknown) => {
        setLoadError(
          caught instanceof ApiError && caught.status === 404
            ? 'Direct payments are disabled on this server (DIRECT_PAYMENT_GATEWAY=disabled).'
            : caught instanceof ApiError
              ? caught.message
              : 'Could not load the retry lab.',
        );
      });
  }, []);

  const method = config?.payment_methods.find((m) => m.id === paymentMethod);
  const currency = currencies.find((c) => c.code === currencyCode);
  const previewPaise = quantity * (currency?.price_paise_per_credit ?? 0);

  const summary = useMemo(() => {
    if (payment === null) return null;
    return {
      calls: payment.attempts.length,
      keys: new Set(payment.attempts.map((a) => a.idempotency_key)).size,
      replays: payment.attempts.filter((a) => a.replayed).length,
    };
  }, [payment]);

  async function run(action: () => Promise<DirectPayment>) {
    setBusy(true);
    setFormErrors([]);
    try {
      setPayment(await action());
    } catch (caught) {
      setFormErrors(
        caught instanceof ApiError
          ? caught.details.length > 0
            ? caught.details.map((d) => d.message)
            : [caught.message]
          : ['Request failed.'],
      );
    } finally {
      setBusy(false);
    }
  }

  function handleCharge(event: FormEvent) {
    event.preventDefault();
    void run(() =>
      api.createDirectPayment(
        {
          currency_code: currencyCode,
          quantity,
          payment_method: paymentMethod,
          max_retries: maxRetries,
          ...(config?.gateway === 'simulated' ? { simulated_failures: failures } : {}),
        },
        // One key per click: each click is a new purchase intent. The retries
        // under test happen server-side, between our server and the gateway.
        crypto.randomUUID(),
      ),
    );
  }

  const stateChip = payment === null ? null : STATE_CHIP[payment.state];

  return (
    <>
      <div className="page-header">
        <h1>Retry lab</h1>
        <p className="page-header__sub">
          Our server calls the payment gateway directly and retries failures. Choose how the
          gateway misbehaves and read every call it made.
        </p>
      </div>

      <div className="stack">
        {loadError !== null && <div className="alert alert--error">{loadError}</div>}

        <div className="grid-2">
          <section className="card">
            <div className="card__header">
              <div>
                <h2>Charge</h2>
                <p className="card__subtitle">
                  Gateway: <strong>{config?.gateway ?? '…'}</strong>
                  {config !== null &&
                    ` · backoff ${config.base_delay_ms}ms doubling, max ${config.max_delay_ms}ms, full jitter`}
                </p>
              </div>
            </div>

            <div className="card__body">
              <form className="stack stack--sm" onSubmit={handleCharge}>
                <div className="field">
                  <label className="field__label" htmlFor="lab-currency">
                    Currency
                  </label>
                  <select
                    id="lab-currency"
                    value={currencyCode}
                    onChange={(event) => setCurrencyCode(event.target.value)}
                  >
                    {currencies.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({formatRupees(c.price_paise_per_credit)}/credit)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="lab-quantity">
                    Credits
                  </label>
                  <input
                    id="lab-quantity"
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(event) => setQuantity(Number(event.target.value))}
                  />
                  <span className="field__hint">Charge: {formatRupees(previewPaise)} (minimum ₹50)</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="lab-method">
                    Gateway behaviour
                  </label>
                  <select
                    id="lab-method"
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value)}
                  >
                    {(config?.payment_methods ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {method !== undefined && <span className="field__hint">{method.description}</span>}
                </div>

                {method?.uses_failure_count === true && (
                  <div className="field">
                    <label className="field__label" htmlFor="lab-failures">
                      Failures before recovery (N)
                    </label>
                    <input
                      id="lab-failures"
                      type="number"
                      min={0}
                      max={config?.max_simulated_failures ?? 10}
                      value={failures}
                      onChange={(event) => setFailures(Number(event.target.value))}
                    />
                    <span className="field__hint">
                      Set N above the retry budget to watch retries run out, then Reconcile.
                    </span>
                  </div>
                )}

                <div className="field">
                  <label className="field__label" htmlFor="lab-retries">
                    Max retries
                  </label>
                  <input
                    id="lab-retries"
                    type="number"
                    min={0}
                    max={config?.max_retries_cap ?? 5}
                    value={maxRetries}
                    onChange={(event) => setMaxRetries(Number(event.target.value))}
                  />
                  <span className="field__hint">
                    Retries, not calls: {maxRetries} allows up to {maxRetries + 1} gateway{' '}
                    {maxRetries === 0 ? 'call' : 'calls'}. Server
                    cap: {config?.max_retries_cap ?? '…'}.
                  </span>
                </div>

                {formErrors.length > 0 && (
                  <div className="alert alert--error">
                    {formErrors.map((message) => (
                      <div key={message}>{message}</div>
                    ))}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn btn--primary btn--block"
                  disabled={busy || config === null || paymentMethod === ''}
                >
                  {busy ? 'Charging…' : `Charge ${formatRupees(previewPaise)}`}
                </button>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <div>
                <h2>How retries are decided</h2>
                <p className="card__subtitle">Every gateway answer is sorted into one of these.</p>
              </div>
            </div>
            <div className="card__body stack stack--sm">
              <p>
                <span className="chip chip--warning">Transient</span> Timeout, dropped connection or
                429. Re-sent under the <strong>same idempotency key</strong>. If the lost call did
                charge, the gateway replays that result instead of charging again.
              </p>
              <p>
                <span className="chip chip--negative">Declined, retryable</span> For example
                processing_error. The attempt definitely failed, so the retry is a{' '}
                <strong>new attempt with a new key</strong>.
              </p>
              <p>
                <span className="chip chip--negative">Declined, final</span> For example insufficient
                funds. <strong>Never retried</strong>.
              </p>
              <p>
                <span className="chip chip--warning">Needs customer</span> 3-D Secure / OTP.{' '}
                <strong>Stop</strong>. Only the customer can finish it.
              </p>
              <p className="subtle">
                Out of retries on a transient error means “unknown”, not “failed”: the payment stays
                pending until it is reconciled.
              </p>
            </div>
          </section>
        </div>

        {payment !== null && stateChip !== null && summary !== null && (
          <section className="card">
            <div className="card__header">
              <div>
                <h2>
                  Payment #{payment.payment_id}{' '}
                  <span className={`chip chip--${stateChip.tone}`}>{stateChip.label}</span>
                </h2>
                <p className="card__subtitle">{stateChip.explanation}</p>
              </div>
              <div className="cluster">
                {payment.state === 'needs_reconciliation' && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={busy}
                    onClick={() => void run(() => api.reconcileDirectPayment(payment.payment_id))}
                  >
                    Reconcile
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={busy}
                  onClick={() => void run(() => api.directPayment(payment.payment_id))}
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="card__body stack stack--sm">
              <div className="summary">
                <div className="summary__item">
                  <span className="summary__label">Gateway calls</span>
                  <span className="summary__value">{summary.calls}</span>
                  <span className="subtle">
                    across {summary.keys} idempotency {summary.keys === 1 ? 'key' : 'keys'}
                  </span>
                </div>
                <div className="summary__item">
                  <span className="summary__label">Card charged</span>
                  <span className="summary__value">
                    {payment.gateway_charge_count === null ? '—' : `${payment.gateway_charge_count}×`}
                  </span>
                  <span className="subtle">
                    {payment.gateway_charge_count === null
                      ? 'check the Stripe dashboard'
                      : `${summary.replays} replayed from the gateway's cache`}
                  </span>
                </div>
                <div className="summary__item">
                  <span className="summary__label">Credits</span>
                  <span className="summary__value">{formatCredits(payment.credits)}</span>
                  <span className="subtle">
                    {formatRupees(payment.amount_paise)} · {payment.status === 'paid' ? 'granted' : 'not granted'}
                  </span>
                </div>
              </div>
            </div>

            <div className="card__body card__body--flush">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Call</th>
                      <th>Why</th>
                      <th>Idempotency key</th>
                      <th>Outcome</th>
                      <th>Detail</th>
                      <th className="numeric">Waited</th>
                      <th className="numeric">Took</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payment.attempts.map((attempt, index) => {
                      const chip = OUTCOME_CHIP[attempt.outcome];
                      return (
                        <tr key={attempt.call_number}>
                          <td className="numeric">
                            #{attempt.call_number}
                            <div className="subtle">attempt {attempt.attempt_number}</div>
                          </td>
                          <td>{describeCall(attempt, payment.attempts[index - 1])}</td>
                          <td className="mono" title={attempt.idempotency_key}>
                            {shortKey(attempt.idempotency_key)}
                          </td>
                          <td>
                            <span className={`chip chip--${chip.tone}`}>{chip.label}</span>
                            {attempt.replayed && <div className="subtle">replayed from cache</div>}
                          </td>
                          <td>
                            {attempt.error_code !== null ? (
                              <>
                                <span className="mono">{attempt.error_code}</span>
                                <div className="subtle">{attempt.error_message}</div>
                              </>
                            ) : (
                              <span className="mono subtle">{attempt.gateway_reference ?? '—'}</span>
                            )}
                          </td>
                          <td className="numeric">{attempt.delay_before_ms}ms</td>
                          <td className="numeric">
                            {attempt.duration_ms === null ? '—' : `${attempt.duration_ms}ms`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
