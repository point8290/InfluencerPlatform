import {
  Balance,
  Campaign,
  Currency,
  LedgerEntry,
  Module,
  Wallet,
  sequelize,
} from '../../models';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type ErrorDetail,
} from '../../lib/errors';
import { isUniqueViolation } from '../../lib/isUniqueViolation';
import type { Pagination } from '../wallet/wallet.service';

/**
 * The module a campaign belongs to. The client never supplies this: choosing a
 * module is choosing a currency, and that decision is not the caller's to make.
 */
const CAMPAIGN_MODULE_CODE = 'campaigns';

const MAX_NAME_LENGTH = 255;

interface CampaignView {
  id: number;
  name: string;
  module_code: string | null;
  status: string;
  funded_credits: number | null;
  created_at: Date;
}

/**
 * `funded_credits` is derived from the single ledger row referencing this
 * campaign, never stored on the campaign itself. The ledger is the source of
 * truth for credit movement; a copy here would be a second place to be wrong.
 *
 * The stored delta is negative (it is a spend), so it is negated for display.
 */
function toView(campaign: Campaign): CampaignView {
  const entry = campaign.ledgerEntry;

  return {
    id: campaign.id,
    name: campaign.name,
    module_code: campaign.module?.code ?? null,
    status: campaign.status,
    funded_credits: entry === undefined || entry === null ? null : -entry.delta,
    created_at: campaign.createdAt,
  };
}

const VIEW_INCLUDES = [
  { model: Module, as: 'module' },
  { model: LedgerEntry, as: 'ledgerEntry' },
];

export async function createCampaign(userId: number, body: unknown): Promise<CampaignView> {
  const input = (body ?? {}) as Record<string, unknown>;
  const details: ErrorDetail[] = [];
  const rawName = input.name;

  let name = '';
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    details.push({ field: 'name', message: 'name is required.' });
  } else {
    name = rawName.trim();
    if (name.length > MAX_NAME_LENGTH) {
      details.push({ field: 'name', message: `name must be at most ${MAX_NAME_LENGTH} characters.` });
    }
  }

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }

  const module = await Module.findOne({ where: { code: CAMPAIGN_MODULE_CODE } });
  if (module === null) {
    throw new Error(
      `The "${CAMPAIGN_MODULE_CODE}" module is not seeded. Run \`npm run seed\`.`,
    );
  }

  const campaign = await Campaign.create({ userId, moduleId: module.id, name, status: 'draft' });

  const created = await Campaign.findByPk(campaign.id, { include: VIEW_INCLUDES });
  return toView(created!);
}

export async function listCampaigns(
  userId: number,
  pagination: Pagination,
): Promise<unknown> {
  const { rows, count } = await Campaign.findAndCountAll({
    where: { userId },
    include: VIEW_INCLUDES,
    order: [['id', 'DESC']],
    limit: pagination.limit,
    offset: pagination.offset,
    // Required because the includes make this a join: without it the count
    // would count joined rows rather than campaigns.
    distinct: true,
  });

  return {
    items: rows.map(toView),
    total: count,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export async function getCampaign(userId: number, campaignId: number): Promise<CampaignView> {
  const campaign = await Campaign.findOne({
    where: { id: campaignId, userId },
    include: VIEW_INCLUDES,
  });

  // Scoped by userId, so another user's campaign is indistinguishable from one
  // that does not exist. Ownership is not an information leak.
  if (campaign === null) {
    throw new NotFoundError('No such campaign.');
  }
  return toView(campaign);
}

interface FundInput {
  credits: number;
  currencyCode: string | null;
}

function validateFundInput(body: unknown): FundInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const details: ErrorDetail[] = [];

  const rawCredits = input.credits;
  let credits = 0;

  if (rawCredits === undefined || rawCredits === null) {
    details.push({ field: 'credits', message: 'credits is required.' });
  } else {
    const value = Number(rawCredits);
    if (!Number.isInteger(value) || value <= 0) {
      details.push({ field: 'credits', message: 'credits must be a positive integer.' });
    } else {
      credits = value;
    }
  }

  const rawCurrency = input.currency_code;
  let currencyCode: string | null = null;

  if (rawCurrency !== undefined && rawCurrency !== null) {
    if (typeof rawCurrency !== 'string' || rawCurrency.trim() === '') {
      details.push({ field: 'currency_code', message: 'currency_code must be a non-empty string.' });
    } else {
      currencyCode = rawCurrency.trim().toLowerCase();
    }
  }

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }
  return { credits, currencyCode };
}

/**
 * Funds a campaign — at most once, never below zero, never in the wrong currency.
 *
 * CURRENCY RESOLUTION (before the transaction opens)
 *   The spend currency is resolved campaign.moduleId -> currencies.moduleId.
 *   `currency_code` in the body is OPTIONAL and is never used as input: if
 *   present it is only COMPARED against the resolved currency, and a
 *   disagreement is rejected before any lock is taken. There is no code path in
 *   which a client-supplied value reaches the balance row, so funding a
 *   campaign with Report or Discovery credits is not merely rejected — it is
 *   unrepresentable.
 *
 * LOCK ORDER (fixed: campaign, then balance)
 *   Both locks are taken in the same order on every path that takes both, so
 *   two concurrent requests can never hold one each and wait on the other.
 *
 * WHY EXPLICIT LOCK-THEN-UPDATE
 *   The decrement could be written as an atomic guarded
 *   `UPDATE ... SET balance = balance - n WHERE balance >= n`, which is equally
 *   correct. The explicit SELECT ... FOR UPDATE is chosen because the read, the
 *   sufficiency check and the write are then three visible steps in one
 *   transaction — the serialization is something you can point at rather than
 *   something implied by a WHERE clause.
 */
export async function fundCampaign(
  userId: number,
  campaignId: number,
  body: unknown,
): Promise<unknown> {
  const { credits, currencyCode } = validateFundInput(body);

  // ── Resolution and rejection happen BEFORE any transaction ──────────────
  const campaign = await Campaign.findOne({ where: { id: campaignId, userId } });
  if (campaign === null) {
    throw new NotFoundError('No such campaign.');
  }

  const currency = await Currency.findOne({ where: { moduleId: campaign.moduleId } });
  if (currency === null) {
    // UNIQUE(currencies.module_id) guarantees at most one; seeding guarantees
    // at least one. Reaching here means configuration is broken.
    throw new Error(`Module ${campaign.moduleId} has no bound currency. Check the seeders.`);
  }

  if (currencyCode !== null && currencyCode !== currency.code) {
    throw new BadRequestError(
      'CURRENCY_MODULE_MISMATCH',
      `Campaigns in the "${campaign.module?.code ?? CAMPAIGN_MODULE_CODE}" module are funded ` +
        `with "${currency.code}" credits, not "${currencyCode}".`,
    );
  }

  const wallet = await Wallet.findOne({ where: { userId } });
  if (wallet === null) {
    throw new NotFoundError('This account has no wallet.');
  }

  try {
    await sequelize.transaction(async (transaction) => {
      // ── LOCK 1: the campaign ──────────────────────────────────────────
      const lockedCampaign = await Campaign.findOne({
        where: { id: campaignId, userId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (lockedCampaign === null) {
        throw new NotFoundError('No such campaign.');
      }

      // draft -> funded is one-way. Re-read under the lock, so a concurrent
      // request that already flipped it is seen here rather than missed.
      if (lockedCampaign.status !== 'draft') {
        throw new ConflictError('CAMPAIGN_ALREADY_FUNDED', 'This campaign is already funded.');
      }

      // ── LOCK 2: the single balance row for (wallet, currency) ──────────
      // UNIQUE(wallet_id, currency_id) is what makes this lock exactly one
      // row. A second concurrent funding request blocks here until this
      // transaction commits, then reads the DECREMENTED balance — which is
      // why two requests cannot both pass the sufficiency check below.
      const balance = await Balance.findOne({
        where: { walletId: wallet.id, currencyId: currency.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (balance === null) {
        throw new Error(
          `Wallet ${wallet.id} has no balance row for currency ${currency.id}. ` +
            'Signup should have created one per currency.',
        );
      }

      if (balance.balance < credits) {
        // Rejected with ledger and balance untouched: the transaction rolls
        // back, so nothing written above this point survives.
        throw new UnprocessableError(
          'INSUFFICIENT_CREDITS',
          `Balance ${balance.balance} is less than the requested ${credits} credits.`,
        );
      }

      // Append-only record of the movement. UNIQUE(ledger.campaign_id) is the
      // structural backstop: even if the status check above were bypassed, a
      // second funding row for this campaign cannot exist.
      await LedgerEntry.create(
        {
          walletId: wallet.id,
          currencyId: currency.id,
          delta: -credits,
          reason: 'campaign_funding',
          campaignId: lockedCampaign.id,
        },
        { transaction },
      );

      // Safe as a read-modify-write only because the row is locked above.
      // CHECK(balance >= 0) in the migration is the final floor beneath it.
      await balance.update({ balance: balance.balance - credits }, { transaction });

      await lockedCampaign.update({ status: 'funded' }, { transaction });
    });
  } catch (error) {
    // A concurrent request won the race and funded first. The whole
    // transaction rolled back, so nothing partial was written.
    if (isUniqueViolation(error, 'uq_ledger_campaign_id')) {
      throw new ConflictError('CAMPAIGN_ALREADY_FUNDED', 'This campaign is already funded.');
    }
    throw error;
  }

  const funded = await Campaign.findByPk(campaignId, { include: VIEW_INCLUDES });
  const updatedBalance = await Balance.findOne({
    where: { walletId: wallet.id, currencyId: currency.id },
  });

  return {
    campaign: toView(funded!),
    balance: {
      currency_code: currency.code,
      balance: updatedBalance?.balance ?? 0,
    },
  };
}
