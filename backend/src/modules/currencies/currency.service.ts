import { Currency, Module, Plan } from '../../models';

/**
 * The whole priced configuration in one read.
 *
 * This exists so the frontend never hardcodes a price. The buy screen renders
 * whatever this returns, which means adding a fourth currency is a seeder
 * change that the UI picks up with no code edit.
 *
 * Note the casing boundary: attributes are camelCase inside TypeScript and
 * snake_case on the wire, matching docs/API.md. The translation happens here,
 * in the service that owns the response shape, and nowhere else.
 */
export async function listCurrencies(): Promise<unknown[]> {
  const currencies = await Currency.findAll({
    include: [
      { model: Module, as: 'module' },
      { model: Plan, as: 'plans' },
    ],
    order: [
      ['id', 'ASC'],
      [{ model: Plan, as: 'plans' }, 'credits', 'ASC'],
    ],
  });

  return currencies.map((currency) => ({
    code: currency.code,
    name: currency.name,
    module: {
      code: currency.module?.code ?? null,
      name: currency.module?.name ?? null,
    },
    price_paise_per_credit: currency.pricePaisePerCredit,
    plans: (currency.plans ?? []).map((plan) => ({
      id: plan.id,
      credits: plan.credits,
      price_paise: plan.pricePaise,
    })),
  }));
}
