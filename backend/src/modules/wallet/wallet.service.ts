import { Balance, Currency, LedgerEntry, Wallet } from '../../models';
import { NotFoundError, ValidationError } from '../../lib/errors';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Reads limit/offset from a query string, clamping rather than rejecting.
 * A caller asking for 10,000 rows gets 200, not an error.
 */
export function parsePagination(query: Record<string, unknown>): Pagination {
  const readInt = (raw: unknown, fallback: number): number => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError('Pagination values must be non-negative integers.', [
        { field: 'limit/offset', message: `Received "${String(raw)}".` },
      ]);
    }
    return value;
  };

  return {
    limit: Math.min(readInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT),
    offset: readInt(query.offset, 0),
  };
}

async function walletFor(userId: number): Promise<Wallet> {
  const wallet = await Wallet.findOne({ where: { userId } });
  if (wallet === null) {
    // Signup creates the wallet in the same transaction as the user, so this
    // is unreachable unless that invariant has been broken.
    throw new NotFoundError('This account has no wallet.');
  }
  return wallet;
}

/**
 * All three balances, always — including zeros. The rows exist from signup, so
 * there is no "currency the user has not used yet" case to special-case in the
 * UI, and no lazy creation to race.
 */
export async function getWalletBalances(userId: number): Promise<unknown> {
  const wallet = await walletFor(userId);

  const balances = await Balance.findAll({
    where: { walletId: wallet.id },
    include: [{ model: Currency, as: 'currency' }],
    order: [['currencyId', 'ASC']],
  });

  return {
    wallet_id: wallet.id,
    balances: balances.map((balance) => ({
      currency_code: balance.currency?.code ?? null,
      currency_name: balance.currency?.name ?? null,
      balance: balance.balance,
    })),
  };
}

/**
 * Ledger history, newest first, optionally filtered to one currency.
 *
 * The ledger is the source of truth: for any currency, the sum of `delta` here
 * equals that currency's balance. Exposing it is what makes that checkable from
 * outside the system rather than only in a test.
 */
export async function getLedger(
  userId: number,
  currencyCode: string | undefined,
  pagination: Pagination,
): Promise<unknown> {
  const wallet = await walletFor(userId);

  const where: { walletId: number; currencyId?: number } = { walletId: wallet.id };

  if (currencyCode !== undefined && currencyCode !== '') {
    const currency = await Currency.findOne({ where: { code: currencyCode.toLowerCase() } });
    if (currency === null) {
      throw new NotFoundError(`No currency with code "${currencyCode}".`);
    }
    where.currencyId = currency.id;
  }

  const { rows, count } = await LedgerEntry.findAndCountAll({
    where,
    include: [{ model: Currency, as: 'currency' }],
    order: [['id', 'DESC']],
    limit: pagination.limit,
    offset: pagination.offset,
  });

  return {
    items: rows.map((entry) => ({
      id: entry.id,
      currency_code: entry.currency?.code ?? null,
      // Signed: positive for a purchase, negative for a spend.
      delta: entry.delta,
      reason: entry.reason,
      payment_id: entry.paymentId,
      campaign_id: entry.campaignId,
      created_at: entry.createdAt,
    })),
    total: count,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}
