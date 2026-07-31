import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ApiError,
  api,
  formatCredits,
  formatRupees,
  type Currency,
  type LedgerItem,
  type Wallet,
} from '../api/client';
import { ToastStack, useToasts } from '../components/Toasts';

/** Poll for at most this long before falling back to a manual refresh. */
const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_ATTEMPTS = 15;

/**
 * Modules whose spending is actually implemented.
 *
 * Display only — the server resolves the spend currency from the campaign's
 * module regardless of what this says. It exists so the UI can be honest that
 * Report and Discovery credits are purchasable but not yet spendable, rather
 * than showing three balances that look equally usable.
 */
const SPENDABLE_MODULES = new Set(['campaigns']);

type PollState = 'idle' | 'polling' | 'paid' | 'timed-out' | 'cancelled';

export function WalletPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toasts, push } = useToasts();

  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [ledgerFilter, setLedgerFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currencyCode, setCurrencyCode] = useState('campaign');
  const [purchaseMode, setPurchaseMode] = useState<'plan' | 'quantity'>('plan');
  const [planId, setPlanId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(100);
  const [buyError, setBuyError] = useState<string[]>([]);
  const [redirecting, setRedirecting] = useState(false);

  const [pollState, setPollState] = useState<PollState>('idle');
  const [pollAttempt, setPollAttempt] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [walletData, ledgerData] = await Promise.all([
        api.wallet(),
        api.ledger(ledgerFilter === '' ? undefined : ledgerFilter),
      ]);
      setWallet(walletData);
      setLedger(ledgerData.items);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the wallet.');
    } finally {
      setLoading(false);
    }
  }, [ledgerFilter]);

  useEffect(() => {
    api.currencies().then(setCurrencies).catch(() => setLoadError('Could not load currencies.'));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const currency = currencies.find((entry) => entry.code === currencyCode);
    setPlanId(currency?.plans[0]?.id ?? null);
  }, [currencies, currencyCode]);

  /**
   * After Stripe redirects back, poll OUR OWN payment row until the webhook
   * flips it to paid.
   *
   * The redirect proves nothing — it is the browser navigating, not Stripe
   * confirming payment. Credits are granted only by the verified webhook, which
   * arrives out-of-band and may land before or after this page loads. So the
   * page reports what the webhook has recorded and never concludes success by
   * itself; if the webhook never arrives it gives up and offers a refresh.
   */
  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    const checkout = searchParams.get('checkout');

    if (checkout === 'cancelled') {
      setPollState('cancelled');
      return;
    }
    if (sessionId === null) return;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    setPollState('polling');

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      attempts += 1;
      setPollAttempt(attempts);

      try {
        const payment = await api.paymentStatus(sessionId);

        if (payment.status === 'paid') {
          setPollState('paid');
          push('success', `${formatCredits(payment.credits)} credits granted.`);
          await refresh();
          return;
        }
        if (payment.status === 'expired' || payment.status === 'failed') {
          setPollState('timed-out');
          return;
        }
      } catch {
        // Transient read failure; keep polling until the budget runs out.
      }

      if (attempts >= POLL_MAX_ATTEMPTS) {
        setPollState('timed-out');
        return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchParams, refresh, push]);

  const selectedCurrency = currencies.find((entry) => entry.code === currencyCode);

  const currencyByCode = useMemo(
    () => new Map(currencies.map((currency) => [currency.code, currency])),
    [currencies],
  );

  const totals = useMemo(() => {
    const balances = wallet?.balances ?? [];
    return {
      spendable: balances.find((balance) => balance.currency_code === 'campaign')?.balance ?? 0,
      all: balances.reduce((sum, balance) => sum + balance.balance, 0),
      movements: ledger.length,
    };
  }, [wallet, ledger]);

  // Display only. The server recomputes this from seeded configuration and its
  // number is what gets charged — this is a preview, not an input.
  const previewPaise =
    purchaseMode === 'plan'
      ? (selectedCurrency?.plans.find((plan) => plan.id === planId)?.price_paise ?? 0)
      : quantity * (selectedCurrency?.price_paise_per_credit ?? 0);

  async function handleBuy(event: FormEvent) {
    event.preventDefault();
    setBuyError([]);
    setRedirecting(true);

    try {
      const session = await api.createCheckoutSession(
        purchaseMode === 'plan'
          ? { currency_code: currencyCode, plan_id: planId ?? 0 }
          : { currency_code: currencyCode, quantity },
      );
      window.location.href = session.checkout_url;
    } catch (caught) {
      if (caught instanceof ApiError) {
        setBuyError(
          caught.details.length > 0 ? caught.details.map((d) => d.message) : [caught.message],
        );
      } else {
        setBuyError(['Could not start checkout.']);
      }
      setRedirecting(false);
    }
  }

  function dismissBanner() {
    searchParams.delete('session_id');
    searchParams.delete('checkout');
    setSearchParams(searchParams, { replace: true });
    setPollState('idle');
  }

  return (
    <>
      <div className="page-header">
        <h1>Wallet</h1>
        <p className="page-header__sub">
          Three separate credit currencies, each spendable only in its own module.
        </p>
      </div>

      <div className="stack">
        {pollState !== 'idle' && (
          <div
            className={`alert alert--${
              pollState === 'paid' ? 'success' : pollState === 'cancelled' ? 'warning' : 'info'
            }`}
          >
            {pollState === 'polling' && (
              <>
                <strong>Payment received — waiting for Stripe to confirm.</strong>
                <p>
                  Credits are granted only by a verified webhook, never by this redirect. Checking…
                  ({pollAttempt}/{POLL_MAX_ATTEMPTS})
                </p>
              </>
            )}
            {pollState === 'paid' && <strong>Credits granted. Your balance is updated below.</strong>}
            {pollState === 'cancelled' && <strong>Checkout cancelled — nothing was charged.</strong>}
            {pollState === 'timed-out' && (
              <>
                <strong>Still waiting for confirmation.</strong>
                <p>
                  If you completed payment, credits appear once the webhook is processed. Check that{' '}
                  <code>stripe listen</code> is running, then refresh.
                </p>
              </>
            )}
            <div className="cluster">
              {pollState === 'timed-out' && (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void refresh()}>
                  Refresh
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--sm" onClick={dismissBanner}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {loadError !== null && <div className="alert alert--error">{loadError}</div>}

        <div className="summary">
          <div className="summary__item">
            <span className="summary__label">Spendable now</span>
            <span className="summary__value">{formatCredits(totals.spendable)}</span>
            <span className="subtle">Campaign Credits</span>
          </div>
          <div className="summary__item">
            <span className="summary__label">All credits</span>
            <span className="summary__value">{formatCredits(totals.all)}</span>
            <span className="subtle">across 3 currencies</span>
          </div>
          <div className="summary__item">
            <span className="summary__label">Movements</span>
            <span className="summary__value">{formatCredits(totals.movements)}</span>
            <span className="subtle">ledger entries</span>
          </div>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="card__header">
              <div>
                <h2>Balances</h2>
                <p className="card__subtitle">Each currency is bound to exactly one module.</p>
              </div>
            </div>

            <div className="card__body card__body--flush">
              {loading
                ? [0, 1, 2].map((row) => (
                    <div key={row} className="balance">
                      <div className="skeleton" style={{ width: '10rem' }} />
                      <div className="skeleton" style={{ width: '3rem' }} />
                    </div>
                  ))
                : (wallet?.balances ?? []).map((balance) => {
                    const currency = currencyByCode.get(balance.currency_code);
                    const moduleCode = currency?.module.code ?? '';
                    const spendable = SPENDABLE_MODULES.has(moduleCode);

                    return (
                      <div key={balance.currency_code} className="balance">
                        <div className="balance__meta">
                          <span className="balance__name">{balance.currency_name}</span>
                          <span className="balance__detail">
                            {currency !== undefined &&
                              `${formatRupees(currency.price_paise_per_credit)}/credit · `}
                            {currency?.module.name ?? '—'} module
                          </span>
                        </div>
                        <div className="cluster">
                          <span className={`chip chip--${spendable ? 'spendable' : 'locked'}`}>
                            {spendable ? 'Spendable' : 'Module not built'}
                          </span>
                          <span className="balance__amount">
                            <span className="balance__value">{formatCredits(balance.balance)}</span>
                            <br />
                            <span className="balance__unit">credits</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <div>
                <h2>Buy credits</h2>
                <p className="card__subtitle">Priced by the server, then paid through Stripe.</p>
              </div>
            </div>

            <div className="card__body">
              <form className="stack stack--sm" onSubmit={handleBuy}>
                <div className="field">
                  <label className="field__label" htmlFor="currency">
                    Currency
                  </label>
                  <select
                    id="currency"
                    value={currencyCode}
                    onChange={(event) => setCurrencyCode(event.target.value)}
                  >
                    {currencies.map((currency) => (
                      <option key={currency.code} value={currency.code}>
                        {currency.name} — {formatRupees(currency.price_paise_per_credit)}/credit
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <span className="field__label">How</span>
                  <div className="segmented">
                    {(['plan', 'quantity'] as const).map((mode) => (
                      <label
                        key={mode}
                        className={`segmented__option ${purchaseMode === mode ? 'is-active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="purchase-mode"
                          checked={purchaseMode === mode}
                          onChange={() => setPurchaseMode(mode)}
                        />
                        {mode === 'plan' ? 'Bundle' : 'Per credit'}
                      </label>
                    ))}
                  </div>
                </div>

                {purchaseMode === 'plan' ? (
                  <div className="field">
                    <label className="field__label" htmlFor="plan">
                      Bundle
                    </label>
                    <select
                      id="plan"
                      value={planId ?? ''}
                      onChange={(event) => setPlanId(Number(event.target.value))}
                    >
                      {(selectedCurrency?.plans ?? []).map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {formatCredits(plan.credits)} credits — {formatRupees(plan.price_paise)}
                        </option>
                      ))}
                    </select>
                    <span className="field__hint">Bundles are discounted against the per-credit rate.</span>
                  </div>
                ) : (
                  <div className="field">
                    <label className="field__label" htmlFor="quantity">
                      Quantity
                    </label>
                    <input
                      id="quantity"
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(event) => setQuantity(Number(event.target.value))}
                    />
                    <span className="field__hint">Minimum purchase is ₹50.</span>
                  </div>
                )}

                <div className="cluster cluster--between">
                  <span className="muted">Preview</span>
                  <strong style={{ fontSize: '1.125rem' }}>{formatRupees(previewPaise)}</strong>
                </div>
                <p className="subtle">
                  The server recomputes this from seeded configuration; its figure is what gets charged.
                </p>

                {buyError.length > 0 && (
                  <div className="alert alert--error">
                    {buyError.map((message) => (
                      <span key={message}>{message}</span>
                    ))}
                  </div>
                )}

                <button type="submit" className="btn btn--primary btn--block" disabled={redirecting}>
                  {redirecting ? 'Redirecting to Stripe…' : 'Buy with Stripe'}
                </button>
              </form>
            </div>
          </section>
        </div>

        <section className="card">
          <div className="card__header">
            <div>
              <h2>Ledger</h2>
              <p className="card__subtitle">
                Append-only. For each currency, these deltas sum to the balance above.
              </p>
            </div>
            <select
              aria-label="Filter ledger by currency"
              value={ledgerFilter}
              onChange={(event) => setLedgerFilter(event.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="">All currencies</option>
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.name}
                </option>
              ))}
            </select>
          </div>

          {ledger.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No movements yet</p>
              <p>Buy credits above and they will appear here once Stripe confirms the payment.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Currency</th>
                    <th className="numeric">Change</th>
                    <th>Reason</th>
                    <th>Reference</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((item, index) => (
                    <tr key={item.id}>
                      {/* A display serial, not the database id. Entries are
                          returned newest-first, so counting down from the
                          loaded count makes the OLDEST entry 1 — which is how a
                          ledger reads. The database id still appears in the
                          Reference column of the rows that have one. */}
                      <td className="ref">{ledger.length - index}</td>
                      <td>{currencyByCode.get(item.currency_code)?.name ?? item.currency_code}</td>
                      <td className={`numeric ${item.delta > 0 ? 'delta--in' : 'delta--out'}`}>
                        {item.delta > 0 ? '+' : ''}
                        {formatCredits(item.delta)}
                      </td>
                      <td>{item.reason === 'purchase' ? 'Purchase' : 'Campaign funding'}</td>
                      <td className="ref">
                        {item.payment_id !== null
                          ? `payment #${item.payment_id}`
                          : item.campaign_id !== null
                            ? `campaign #${item.campaign_id}`
                            : '—'}
                      </td>
                      <td className="subtle">{new Date(item.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <ToastStack toasts={toasts} />
    </>
  );
}
