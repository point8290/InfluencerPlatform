import { Currency, Plan, type PurchaseKind } from '../../models';
import { BadRequestError, NotFoundError, ValidationError, type ErrorDetail } from '../../lib/errors';

/**
 * Stripe rejects amounts above this for INR. Guarding here means an absurd
 * quantity fails as a clean 400 naming the field, rather than as an opaque
 * Stripe API error after we have already written a pending payment row.
 */
const MAX_AMOUNT_PAISE = 99_999_999;

export interface PriceQuote {
  currency: Currency;
  plan: Plan | null;
  purchaseKind: PurchaseKind;
  credits: number;
  amountPaise: number;
}

interface PurchaseRequest {
  currencyCode: string;
  planId: number | null;
  quantity: number | null;
}

function validatePurchaseRequest(body: unknown): PurchaseRequest {
  const details: ErrorDetail[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  const rawCurrency = input.currency_code;
  let currencyCode = '';
  if (typeof rawCurrency !== 'string' || rawCurrency.trim() === '') {
    details.push({ field: 'currency_code', message: 'currency_code is required.' });
  } else {
    currencyCode = rawCurrency.trim().toLowerCase();
  }

  const hasPlan = input.plan_id !== undefined && input.plan_id !== null;
  const hasQuantity = input.quantity !== undefined && input.quantity !== null;

  // Exactly one. Both would be contradictory; neither leaves nothing to price.
  if (hasPlan === hasQuantity) {
    details.push({
      field: 'plan_id',
      message: 'Provide exactly one of plan_id or quantity.',
    });
  }

  let planId: number | null = null;
  if (hasPlan) {
    const value = Number(input.plan_id);
    if (!Number.isInteger(value) || value <= 0) {
      details.push({ field: 'plan_id', message: 'plan_id must be a positive integer.' });
    } else {
      planId = value;
    }
  }

  let quantity: number | null = null;
  if (hasQuantity) {
    const value = Number(input.quantity);
    if (!Number.isInteger(value) || value <= 0) {
      details.push({ field: 'quantity', message: 'quantity must be a positive integer.' });
    } else {
      quantity = value;
    }
  }

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }
  return { currencyCode, planId, quantity };
}

/**
 * Turns a purchase request into an amount, entirely from seeded configuration.
 *
 * THE CLIENT NEVER SUPPLIES AN AMOUNT, and there is no field it could put one
 * in. It names a currency and either a plan or a quantity; every rupee figure
 * is read from `currencies.price_paise_per_credit` or `plans.price_paise`.
 *
 * The two paths differ in a way that matters:
 *   - plan     -> amountPaise comes from the stored bundle price, which is
 *                 DISCOUNTED against the per-credit rate.
 *   - quantity -> amountPaise is quantity x the per-credit rate, undiscounted.
 *
 * Computing a plan's price instead of reading it would overcharge every bundle
 * (1,000 Campaign Credits at Rs 3 each is Rs 3,000, but the bundle is Rs 2,700).
 */
export async function quotePurchase(body: unknown): Promise<PriceQuote> {
  const request = validatePurchaseRequest(body);

  const currency = await Currency.findOne({ where: { code: request.currencyCode } });
  if (currency === null) {
    throw new NotFoundError(`No currency with code "${request.currencyCode}".`);
  }

  let quote: PriceQuote;

  if (request.planId !== null) {
    const plan = await Plan.findByPk(request.planId);
    if (plan === null) {
      throw new NotFoundError(`No plan with id ${request.planId}.`);
    }

    // A plan belonging to another currency would let a caller buy Campaign
    // Credits at Report Credit prices, so this is a rejection, not a coercion.
    if (plan.currencyId !== currency.id) {
      throw new BadRequestError(
        'PLAN_CURRENCY_MISMATCH',
        `Plan ${plan.id} belongs to a different currency than "${currency.code}".`,
      );
    }

    quote = {
      currency,
      plan,
      purchaseKind: 'plan',
      credits: plan.credits,
      amountPaise: plan.pricePaise,
    };
  } else {
    const quantity = request.quantity as number;
    quote = {
      currency,
      plan: null,
      purchaseKind: 'quantity',
      credits: quantity,
      amountPaise: quantity * currency.pricePaisePerCredit,
    };
  }

  // Both operands are integers, so the product is exact — no rounding step and
  // no floating point anywhere in the money path.
  if (quote.amountPaise > MAX_AMOUNT_PAISE) {
    throw new ValidationError('Requested amount exceeds the maximum Stripe accepts.', [
      {
        field: request.planId !== null ? 'plan_id' : 'quantity',
        message: `Amount ${quote.amountPaise} paise exceeds the maximum of ${MAX_AMOUNT_PAISE}.`,
      },
    ]);
  }

  return quote;
}
