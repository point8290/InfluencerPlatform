import { QueryTypes, type QueryInterface } from 'sequelize';

/**
 * Seeds the platform's configuration: three modules, three currencies bound
 * 1:1 to them, and six bundle plans.
 *
 * This is the data that makes currencies "configurable" rather than hardcoded.
 * Adding a fourth currency and module is an edit to the arrays below plus a new
 * seeder — no business logic changes, because pricing is read from
 * `currencies.price_paise_per_credit` / `plans.price_paise`, and spend currency
 * is resolved through `currencies.module_id`.
 *
 * All three tables are seeded in ONE file rather than three, because currencies
 * need the generated module ids and plans need the generated currency ids.
 * Splitting them would couple separate files through auto-increment values.
 *
 * Every price is in integer paise. Rs 3.00 is 300, never 3.0.
 */

const MODULES = [
  { code: 'campaigns', name: 'Campaigns' },
  { code: 'reports', name: 'Reports' },
  { code: 'discovery', name: 'Discovery' },
] as const;

const CURRENCIES = [
  // Rs 3 per credit
  { code: 'campaign', name: 'Campaign Credits', moduleCode: 'campaigns', pricePaisePerCredit: 300 },
  // Rs 10 per credit
  { code: 'report', name: 'Report Credits', moduleCode: 'reports', pricePaisePerCredit: 1000 },
  // Rs 5 per credit
  { code: 'discovery', name: 'Discovery Credits', moduleCode: 'discovery', pricePaisePerCredit: 500 },
] as const;

/**
 * Bundle prices are discounted against the per-credit rate, which is exactly
 * why plans.price_paise is stored rather than computed:
 *   1,000 Campaign Credits = Rs 2,700, not 1,000 x Rs 3 = Rs 3,000.
 */
const PLANS = [
  { currencyCode: 'campaign', credits: 100, pricePaise: 30_000 }, //     Rs 300
  { currencyCode: 'campaign', credits: 1_000, pricePaise: 270_000 }, //  Rs 2,700
  { currencyCode: 'report', credits: 10, pricePaise: 10_000 }, //        Rs 100
  { currencyCode: 'report', credits: 100, pricePaise: 90_000 }, //       Rs 900
  { currencyCode: 'discovery', credits: 100, pricePaise: 50_000 }, //    Rs 500
  { currencyCode: 'discovery', credits: 1_000, pricePaise: 450_000 }, // Rs 4,500
] as const;

/** Reads back the generated ids so the next table can reference them. */
async function idsByCode(
  queryInterface: QueryInterface,
  table: 'modules' | 'currencies',
): Promise<Map<string, number>> {
  const rows = await queryInterface.sequelize.query<{ id: number; code: string }>(
    `SELECT id, code FROM ${table}`,
    { type: QueryTypes.SELECT },
  );
  return new Map(rows.map((row) => [row.code, row.id]));
}

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.bulkInsert(
    'modules',
    MODULES.map((module) => ({ code: module.code, name: module.name })),
  );

  const moduleIds = await idsByCode(queryInterface, 'modules');

  await queryInterface.bulkInsert(
    'currencies',
    CURRENCIES.map((currency) => {
      const moduleId = moduleIds.get(currency.moduleCode);
      if (moduleId === undefined) {
        throw new Error(`Seed error: no module seeded with code "${currency.moduleCode}".`);
      }
      return {
        code: currency.code,
        name: currency.name,
        module_id: moduleId,
        price_paise_per_credit: currency.pricePaisePerCredit,
      };
    }),
  );

  const currencyIds = await idsByCode(queryInterface, 'currencies');

  await queryInterface.bulkInsert(
    'plans',
    PLANS.map((plan) => {
      const currencyId = currencyIds.get(plan.currencyCode);
      if (currencyId === undefined) {
        throw new Error(`Seed error: no currency seeded with code "${plan.currencyCode}".`);
      }
      return {
        currency_id: currencyId,
        credits: plan.credits,
        price_paise: plan.pricePaise,
      };
    }),
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  // Reverse foreign-key order, same as the migrations unwind.
  await queryInterface.bulkDelete('plans', {});
  await queryInterface.bulkDelete('currencies', {});
  await queryInterface.bulkDelete('modules', {});
}
