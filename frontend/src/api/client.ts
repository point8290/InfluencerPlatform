const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const TOKEN_STORAGE_KEY = 'credits-wallet-token';

/**
 * The token lives in localStorage.
 *
 * Honest trade-off: localStorage is readable by any script on the page, so an
 * XSS bug leaks the token. An httpOnly cookie would not be, but would need CSRF
 * protection and a same-site story. For an assignment with a separate API
 * origin this is the simpler correct-enough choice; a production build would
 * use httpOnly cookies plus CSRF tokens.
 */
export const tokenStorage = {
  get: (): string | null => localStorage.getItem(TOKEN_STORAGE_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_STORAGE_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_STORAGE_KEY),
};

export interface ErrorDetail {
  field: string;
  message: string;
}

/**
 * Mirrors the API's error envelope. Screens branch on `code`, never on
 * `message` — the message is for humans and may be reworded at any time.
 */
export class ApiError extends Error {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: Vite's tsconfig sets `erasableSyntaxOnly`, which forbids TS-only
  // syntax that has no JavaScript equivalent to erase to.
  readonly code: string;
  readonly status: number;
  readonly details: ErrorDetail[];

  constructor(code: string, message: string, status: number, details: ErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Read the token per request rather than caching it, so a login or logout is
  // reflected immediately without any subscription plumbing.
  const token = tokenStorage.get();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = (body as { error?: { code?: string; message?: string; details?: ErrorDetail[] } })
      ?.error;

    throw new ApiError(
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      envelope?.details ?? [],
    );
  }

  return body as T;
}

// ── Types mirroring the API contract in docs/API.md ────────────────────────

export interface User {
  id: number;
  email: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Plan {
  id: number;
  credits: number;
  price_paise: number;
}

export interface Currency {
  code: string;
  name: string;
  module: { code: string; name: string };
  price_paise_per_credit: number;
  plans: Plan[];
}

export interface WalletBalance {
  currency_code: string;
  currency_name: string;
  balance: number;
}

export interface Wallet {
  wallet_id: number;
  balances: WalletBalance[];
}

export interface LedgerItem {
  id: number;
  currency_code: string;
  delta: number;
  reason: 'purchase' | 'campaign_funding';
  payment_id: number | null;
  campaign_id: number | null;
  created_at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CheckoutSession {
  payment_id: number;
  stripe_session_id: string;
  checkout_url: string;
  credits: number;
  amount_paise: number;
}

export interface PaymentStatus {
  payment_id: number;
  stripe_session_id: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
  purchase_kind: 'plan' | 'quantity';
  credits: number;
  currency_code: string;
  amount_paise: number;
}

export interface Campaign {
  id: number;
  name: string;
  module_code: string;
  status: 'draft' | 'funded';
  funded_credits: number | null;
  created_at: string;
}

export interface DirectPaymentMethod {
  id: string;
  label: string;
  description: string;
  uses_failure_count: boolean;
}

export interface DirectPaymentConfig {
  gateway: 'simulated' | 'stripe';
  default_max_retries: number;
  max_retries_cap: number;
  max_simulated_failures: number;
  base_delay_ms: number;
  max_delay_ms: number;
  payment_methods: DirectPaymentMethod[];
}

export interface DirectPaymentAttempt {
  call_number: number;
  attempt_number: number;
  idempotency_key: string;
  trigger: 'initial' | 'retry' | 'reconcile';
  outcome: 'in_flight' | 'succeeded' | 'requires_action' | 'declined' | 'transient_error' | 'unknown';
  error_code: string | null;
  error_message: string | null;
  gateway_reference: string | null;
  replayed: boolean;
  delay_before_ms: number;
  duration_ms: number | null;
  created_at: string;
}

export interface DirectPayment {
  payment_id: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  state: 'paid' | 'failed' | 'requires_customer' | 'processing' | 'needs_reconciliation';
  credits: number;
  amount_paise: number;
  currency_code: string;
  gateway: 'simulated' | 'stripe' | null;
  payment_method: string | null;
  max_retries: number | null;
  simulated_failures: number | null;
  /** Simulated gateway only: how many times money was actually taken. */
  gateway_charge_count: number | null;
  attempts: DirectPaymentAttempt[];
  created_at: string;
}

/**
 * Builds a query string, omitting anything undefined so the server applies its
 * own defaults rather than receiving `limit=undefined`.
 *
 * `currencyCode` is spelled `currency_code` on the wire — the casing boundary
 * between TypeScript and the API contract lives here, not in the pages.
 */
function toQueryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    const wireKey = key === 'currencyCode' ? 'currency_code' : key;
    query.set(wireKey, String(value));
  }

  const serialised = query.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

export const api = {
  signup: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ user: User }>('/api/auth/me'),

  currencies: () => request<Currency[]>('/api/currencies'),

  wallet: () => request<Wallet>('/api/wallet'),

  ledger: (params: { currencyCode?: string; limit?: number; offset?: number } = {}) =>
    request<Paged<LedgerItem>>(`/api/wallet/ledger${toQueryString(params)}`),

  /**
   * `idempotencyKey` must identify the *intent*, not the attempt — the same key
   * has to be sent on every retry of one purchase, or it protects nothing.
   */
  createCheckoutSession: (
    body: { currency_code: string; plan_id?: number; quantity?: number },
    idempotencyKey?: string,
  ) =>
    request<CheckoutSession>('/api/payments/checkout-session', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey },
    }),

  paymentStatus: (stripeSessionId: string) =>
    request<PaymentStatus>(`/api/payments/session/${stripeSessionId}`),

  directPaymentConfig: () => request<DirectPaymentConfig>('/api/direct-payments/config'),

  createDirectPayment: (
    body: {
      currency_code: string;
      quantity: number;
      payment_method: string;
      max_retries: number;
      simulated_failures?: number;
    },
    idempotencyKey: string,
  ) =>
    request<DirectPayment>('/api/direct-payments', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  directPayment: (id: number) => request<DirectPayment>(`/api/direct-payments/${id}`),

  reconcileDirectPayment: (id: number) =>
    request<DirectPayment>(`/api/direct-payments/${id}/reconcile`, { method: 'POST' }),

  campaigns: (params: { limit?: number; offset?: number } = {}) =>
    request<Paged<Campaign>>(`/api/campaigns${toQueryString(params)}`),

  createCampaign: (name: string) =>
    request<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify({ name }) }),

  fundCampaign: (id: number, credits: number) =>
    request<{ campaign: Campaign; balance: { currency_code: string; balance: number } }>(
      `/api/campaigns/${id}/fund`,
      { method: 'POST', body: JSON.stringify({ credits }) },
    ),
};

/**
 * Integer paise to a display string.
 *
 * Formatting only — this division is the single place a money value becomes a
 * float, and the result is never read back into a calculation or sent to the
 * API. Every amount on the wire stays an integer.
 */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Credits are integers; this only adds thousands separators. */
export function formatCredits(credits: number): string {
  return credits.toLocaleString('en-IN');
}
