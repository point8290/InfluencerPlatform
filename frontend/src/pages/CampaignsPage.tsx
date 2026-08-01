import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  formatCredits,
  type Campaign,
  type WalletBalance,
} from '../api/client';
import { ToastStack, useToasts } from '../components/Toasts';

/** Campaigns fetched per request. The API caps `limit` at 200. */
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export function CampaignsPage() {
  const { toasts, push } = useToasts();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsTotal, setCampaignsTotal] = useState(0);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Mirrors campaigns.length so a refresh reloads the window the user has
  // opened rather than collapsing back to the first page.
  const loadedCount = useRef(0);
  useEffect(() => {
    loadedCount.current = campaigns.length;
  }, [campaigns]);

  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Keyed per campaign, so one row's error or spinner never touches another.
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [fundingId, setFundingId] = useState<number | null>(null);

  const fetchCampaigns = useCallback(
    async (limit: number, offset: number, mode: 'replace' | 'append') => {
      const page = await api.campaigns({ limit, offset });

      setCampaignsTotal(page.total);
      setCampaigns((current) => (mode === 'append' ? [...current, ...page.items] : page.items));
    },
    [],
  );

  /**
   * Reloads the balance and the whole window the user has opened.
   *
   * Not just the first page: funding a campaign that sits on a later page would
   * otherwise collapse the list and hide the row that just changed.
   */
  const refresh = useCallback(async () => {
    const windowSize = Math.min(Math.max(PAGE_SIZE, loadedCount.current), MAX_PAGE_SIZE);

    const [, wallet] = await Promise.all([
      fetchCampaigns(windowSize, 0, 'replace'),
      api.wallet(),
    ]);
    setBalance(wallet.balances.find((entry) => entry.currency_code === 'campaign') ?? null);
  }, [fetchCampaigns]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      await fetchCampaigns(PAGE_SIZE, loadedCount.current, 'append');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchCampaigns]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setCreateError(null);
    setCreating(true);

    try {
      const created = await api.createCampaign(name.trim());
      setName('');
      await refresh();
      push('success', `Campaign “${created.name}” created.`);
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? caught.message : 'Could not create the campaign.');
    } finally {
      setCreating(false);
    }
  }

  async function handleFund(campaign: Campaign) {
    const credits = Number(amounts[campaign.id] ?? '');

    if (!Number.isInteger(credits) || credits <= 0) {
      setErrors((previous) => ({ ...previous, [campaign.id]: 'Enter a positive whole number.' }));
      return;
    }

    setErrors((previous) => ({ ...previous, [campaign.id]: '' }));
    setFundingId(campaign.id);

    try {
      await api.fundCampaign(campaign.id, credits);
      setAmounts((previous) => ({ ...previous, [campaign.id]: '' }));
      await refresh();
      push('success', `Funded “${campaign.name}” with ${formatCredits(credits)} credits.`);
    } catch (caught) {
      // Branch on the code, not the message — these are the states the API
      // documents for this endpoint.
      const message =
        caught instanceof ApiError
          ? caught.code === 'INSUFFICIENT_CREDITS'
            ? `Not enough Campaign Credits — you have ${formatCredits(balance?.balance ?? 0)}.`
            : caught.code === 'CAMPAIGN_ALREADY_FUNDED'
              ? 'This campaign has already been funded.'
              : caught.message
          : 'Could not fund the campaign.';

      setErrors((previous) => ({ ...previous, [campaign.id]: message }));
      push('error', message);
    } finally {
      setFundingId(null);
    }
  }

  const draftCount = campaigns.filter((campaign) => campaign.status === 'draft').length;

  return (
    <>
      <div className="page-header">
        <h1>Campaigns</h1>
        <p className="page-header__sub">
          Create a campaign, then fund it with Campaign Credits.
        </p>
      </div>

      <div className="stack">
        <div className="summary">
          <div className="summary__item">
            <span className="summary__label">Available</span>
            <span className="summary__value">{formatCredits(balance?.balance ?? 0)}</span>
            <span className="subtle">Campaign Credits</span>
          </div>
          <div className="summary__item">
            <span className="summary__label">Campaigns</span>
            {/* The server's count, not the number of rows fetched — otherwise
                this would understate as soon as the list is paginated. */}
            <span className="summary__value">{formatCredits(campaignsTotal)}</span>
            <span className="subtle">{draftCount} awaiting funding</span>
          </div>
        </div>

        <section className="card">
          <div className="card__header">
            <div>
              <h2>New campaign</h2>
              <p className="card__subtitle">New campaigns start as drafts.</p>
            </div>
          </div>

          <div className="card__body">
            {/* A plain cluster, not a stacked form: the input and button belong
                on one line. */}
            <form className="cluster" onSubmit={handleCreate}>
              <input
                className="grow"
                type="text"
                value={name}
                placeholder="e.g. Summer influencer push"
                onChange={(event) => setName(event.target.value)}
                required
              />
              <button type="submit" className="btn btn--primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create campaign'}
              </button>
            </form>
            {createError !== null && (
              <div className="alert alert--error" style={{ marginTop: '0.75rem' }}>
                {createError}
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2>Your campaigns</h2>
              <p className="card__subtitle">A campaign can be funded once.</p>
            </div>
          </div>

          {loading ? (
            <div className="card__body stack stack--xs">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ) : campaigns.length === 0 ? (
            <div className="empty">
              <p className="empty__title">No campaigns yet</p>
              <p>Create one above, then fund it with Campaign Credits.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th className="numeric">Funded</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign, index) => (
                    <tr key={campaign.id}>
                      {/* Display serial, not the database id. Campaigns are
                          listed newest-first, so counting down from the SERVER'S
                          total makes the first one created number 1 — and keeps
                          the numbering stable as further pages are loaded. */}
                      <td className="ref">{campaignsTotal - index}</td>
                      <td>{campaign.name}</td>
                      <td>
                        <span className={`chip chip--${campaign.status}`}>{campaign.status}</span>
                      </td>
                      <td className="numeric">
                        {campaign.funded_credits === null
                          ? '—'
                          : formatCredits(campaign.funded_credits)}
                      </td>
                      <td>
                        {campaign.status === 'funded' ? (
                          <span className="subtle">Already funded</span>
                        ) : (
                          <div className="stack stack--xs">
                            <div className="cluster">
                              <input
                                type="number"
                                min={1}
                                placeholder="credits"
                                aria-label={`Credits to fund ${campaign.name}`}
                                style={{ width: '7rem' }}
                                value={amounts[campaign.id] ?? ''}
                                onChange={(event) =>
                                  setAmounts((previous) => ({
                                    ...previous,
                                    [campaign.id]: event.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm"
                                onClick={() => void handleFund(campaign)}
                                disabled={fundingId === campaign.id}
                              >
                                {fundingId === campaign.id ? 'Funding…' : 'Fund'}
                              </button>
                            </div>
                            {(errors[campaign.id] ?? '') !== '' && (
                              <span className="subtle" style={{ color: 'var(--negative)' }}>
                                {errors[campaign.id]}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Without this, a campaign past the page boundary would vanish from
              the list — and since the Fund control lives in its row, it would
              become unfundable through the UI despite being a valid draft. */}
          {campaigns.length > 0 && (
            <div className="card__body cluster cluster--between">
              <span className="subtle">
                Showing {formatCredits(campaigns.length)} of {formatCredits(campaignsTotal)}
              </span>
              {campaigns.length < campaignsTotal && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? 'Loading…'
                    : `Load ${Math.min(PAGE_SIZE, campaignsTotal - campaigns.length)} more`}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <ToastStack toasts={toasts} />
    </>
  );
}
