import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
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

/** Ledger rows fetched per request. The API caps `limit` at 200. */
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

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
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerFilter, setLedgerFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mirrors ledger.length, so a refresh can reload exactly the window the user
  // has opened without the fetch callback depending on the list it sets.
  const loadedCount = useRef(0);
  useEffect(() => {
    loadedCount.current = ledger.length;
  }, [ledger]);

  const [currencyCode, setCurrencyCode] = useState('campaign');
  const [purchaseMode, setPurchaseMode] = useState<'plan' | 'quantity'>('plan');
  const [planId, setPlanId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(100);
  const [buyError, setBuyError] = useState<string[]>([]);
  const [redirecting, setRedirecting] = useState(false);

  const [pollState, setPollState] = useState<PollState>('idle');

  /**
   * Identifies the current purchase INTENT, not the current attempt.
   *
   * Generated on first submit and kept if that submit fails, so a retry — after
   * a timeout, or a second click once the button re-enables — resolves to the
   * same Stripe session rather than creating a second payable one. Cleared
   * whenever the purchase parameters change, because that is a different intent
   * and deserves its own key.
   */
  const purchaseIdempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    purchaseIdempotencyKey.current = null;
  }, [currencyCode, purchaseMode, planId, quantity]);

  const refreshWallet = useCallback(async () => {
    setWallet(await api.wallet());
  }, []);

  const fetchLedger = useCallback(
    async (limit: number, offset: number, mode: 'replace' | 'append') => {
      const page = await api.ledger({
        currencyCode: ledgerFilter === '' ? undefined : ledgerFilter,
        limit,
        offset,
      });

      // `total` is the authoritative count, independent of how much has been
      // fetched — it drives both the "showing N of M" line and the row serials.
      setLedgerTotal(page.total);
      setLedger((current) => (mode === 'append' ? [...current, ...page.items] : page.items));
    },
    [ledgerFilter],
  );

  /**
   * Reloads the balances and the whole ledger window the user has opened.
   *
   * Deliberately not just the first page: after funding a campaign from a
   * later page, collapsing back to page 1 would hide the row that just changed.
   */
  const refresh = useCallback(async () => {
    const windowSize = Math.min(Math.max(PAGE_SIZE, loadedCount.current), MAX_PAGE_SIZE);

    try {
      await Promise.all([refreshWallet(), fetchLedger(windowSize, 0, 'replace')]);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the wallet.');
    }
  }, [refreshWallet, fetchLedger]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      await fetchLedger(PAGE_SIZE, loadedCount.current, 'append');
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : 'Could not load more entries.');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchLedger]);

  useEffect(() => {
    api.currencies().then(setCurrencies).catch(() => setLoadError('Could not load currencies.'));
  }, []);

  // Mount, and every filter change. A filter change resets to the first page
  // rather than preserving a window that belonged to a different filter.
  useEffect(() => {
    loadedCount.current = 0;
    setLoading(true);

    Promise.all([refreshWallet(), fetchLedger(PAGE_SIZE, 0, 'replace')])
      .then(() => setLoadError(null))
      .catch((caught: unknown) =>
        setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the wallet.'),
      )
      .finally(() => setLoading(false));
  }, [refreshWallet, fetchLedger]);

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
      // The server's count, not the number of rows fetched — otherwise this
      // would understate as soon as the list is paginated.
      movements: ledgerTotal,
    };
  }, [wallet, ledgerTotal]);

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

    // Reused if this submit fails, so a retry returns the original session.
    purchaseIdempotencyKey.current ??= crypto.randomUUID();

    try {
      const session = await api.createCheckoutSession(
        purchaseMode === 'plan'
          ? { currency_code: currencyCode, plan_id: planId ?? 0 }
          : { currency_code: currencyCode, quantity },
        purchaseIdempotencyKey.current,
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

  const hasMore = ledger.length < ledgerTotal;

  return (
    <>
      <div className="page-header">
        <h1>Wallet</h1>
        <p className="page-header__sub">Buy credits and track every purchase and spend.</p>
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
                <strong>Confirming your payment…</strong>
                <p>This usually takes a few seconds. Your credits will appear below.</p>
              </>
            )}
            {pollState === 'paid' && <strong>Credits added. Your balance is updated below.</strong>}
            {pollState === 'cancelled' && <strong>Checkout cancelled — nothing was charged.</strong>}
            {pollState === 'timed-out' && (
              <>
                <strong>This is taking longer than usual.</strong>
                <p>
                  If your payment went through, your credits will appear as soon as it is confirmed.
                </p>
              </>
            )}
            <div className="cluster">
              {pollState === 'timed-out' && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void refresh()}
                >
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
            <span className="summary__label">Activity</span>
            <span className="summary__value">{formatCredits(totals.movements)}</span>
            <span className="subtle">purchases and spends</span>
          </div>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="card__header">
              <div>
                <h2>Balances</h2>
                <p className="card__subtitle">
                  Each credit type is used in one area of the platform.
                </p>
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
                            {currency?.module.name ?? '—'}
                          </span>
                        </div>
                        <div className="cluster">
                          <span className={`chip chip--${spendable ? 'spendable' : 'locked'}`}>
                            {spendable ? 'Spendable' : 'Coming soon'}
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
                <p className="card__subtitle">Pay securely with Stripe.</p>
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
                    <span className="field__hint">
                      Bundles are discounted against the per-credit rate.
                    </span>
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
                  <span className="muted">Total</span>
                  <strong style={{ fontSize: '1.125rem' }}>{formatRupees(previewPaise)}</strong>
                </div>

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
              <h2>Activity</h2>
              <p className="card__subtitle">
                Every credit purchase and campaign funding, newest first.
              </p>
            </div>
            <select
              aria-label="Filter activity by credit type"
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
              <p className="empty__title">No activity yet</p>
              <p>Buy credits above and your purchases will appear here.</p>
            </div>
          ) : (
            <>
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
                        {/* A display serial, not the database id. Entries come
                            back newest-first, so counting down from the SERVER'S
                            total makes the oldest entry 1 — and keeps the
                            numbering stable as further pages are loaded. */}
                        <td className="ref">{ledgerTotal - index}</td>
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

              {/* Without this the list would silently stop at the page size, and
                  the visible deltas would not sum to the balance shown above —
                  which is exactly the invariant this screen invites you to check. */}
              <div className="card__body cluster cluster--between">
                <span className="subtle">
                  Showing {formatCredits(ledger.length)} of {formatCredits(ledgerTotal)}
                </span>
                {hasMore && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, ledgerTotal - ledger.length)} more`}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ToastStack toasts={toasts} />
    </>
  );
}
