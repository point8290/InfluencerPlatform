import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Balance, Currency, LedgerEntry, Module, sequelize } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import { balanceOf, createCampaign, createUser, grantCredits } from './helpers/factories';

/**
 * Each currency is spendable only in its own module.
 *
 * The spend currency is RESOLVED from campaign.moduleId -> currencies.moduleId.
 * `currency_code` in the request body is optional and is only ever COMPARED
 * against the resolved currency — it is never used as input. So funding a
 * campaign with Report or Discovery credits is not merely rejected by a check
 * that could be removed; there is no code path that would carry it out.
 */
describe('currency isolation', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  it('binds each currency to exactly one module at the schema level', async () => {
    const currencies = await Currency.findAll({ include: [{ model: Module, as: 'module' }] });
    expect(currencies).toHaveLength(3);

    const moduleIds = currencies.map((currency) => currency.moduleId);
    expect(new Set(moduleIds).size).toBe(3);

    // UNIQUE(currencies.module_id) is what makes the binding 1:1 rather than a
    // convention the seeders happen to follow.
    const campaignCurrency = currencies.find((c) => c.code === 'campaign')!;
    await expect(
      sequelize.query(
        'INSERT INTO currencies (code, name, module_id, price_paise_per_credit) VALUES (?, ?, ?, ?)',
        { replacements: ['imposter', 'Imposter Credits', campaignCurrency.moduleId, 100] },
      ),
    ).rejects.toThrow();
  });

  it.each(['report', 'discovery'])(
    'rejects funding a campaign with %s credits',
    async (wrongCurrency) => {
      const user = await createUser(app);
      await grantCredits(app, user.id, 'campaign', 500);
      await grantCredits(app, user.id, wrongCurrency, 500);
      const campaign = await createCampaign(app, user);

      const ledgerBefore = await LedgerEntry.count();

      const response = await request(app)
        .post(`/api/campaigns/${campaign.id}/fund`)
        .set(user.auth)
        .send({ credits: 100, currency_code: wrongCurrency })
        .expect(400);

      expect(response.body.error.code).toBe('CURRENCY_MODULE_MISMATCH');

      // Rejected before the transaction opens, so nothing was written and no
      // lock was taken.
      await expect(LedgerEntry.count()).resolves.toBe(ledgerBefore);
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(500);
      await expect(balanceOf(user.id, wrongCurrency)).resolves.toBe(500);
    },
  );

  it('spends the resolved currency when the body names no currency at all', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 500);
    await grantCredits(app, user.id, 'report', 500);
    const campaign = await createCampaign(app, user);

    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 100 })
      .expect(200);

    // Only Campaign Credits moved. The other currencies are untouched.
    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(400);
    await expect(balanceOf(user.id, 'report')).resolves.toBe(500);
    await expect(balanceOf(user.id, 'discovery')).resolves.toBe(0);
  });

  it('accepts a currency_code that agrees with the resolved currency', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 500);
    const campaign = await createCampaign(app, user);

    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 100, currency_code: 'campaign' })
      .expect(200);

    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(400);
  });

  it('never lets a spend touch a currency other than the campaign module\'s', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 300);
    await grantCredits(app, user.id, 'report', 300);
    await grantCredits(app, user.id, 'discovery', 300);
    const campaign = await createCampaign(app, user);

    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 300 })
      .expect(200);

    const campaignCurrency = await Currency.findOne({ where: { code: 'campaign' } });
    const spendRows = await LedgerEntry.findAll({ where: { reason: 'campaign_funding' } });

    expect(spendRows).toHaveLength(1);
    expect(spendRows[0]!.currencyId).toBe(campaignCurrency!.id);
    expect(spendRows[0]!.delta).toBe(-300);
  });

  it('keeps each currency ledger independent and self-consistent', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 400);
    await grantCredits(app, user.id, 'report', 250);
    await grantCredits(app, user.id, 'discovery', 175);

    const campaign = await createCampaign(app, user);
    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 150 })
      .expect(200);

    const balances = await Balance.findAll({ include: [{ model: Currency, as: 'currency' }] });

    for (const balance of balances) {
      const entries = await LedgerEntry.findAll({
        where: { walletId: balance.walletId, currencyId: balance.currencyId },
      });
      const sum = entries.reduce((total, entry) => total + entry.delta, 0);

      expect(sum).toBe(balance.balance);
    }

    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(250);
    await expect(balanceOf(user.id, 'report')).resolves.toBe(250);
    await expect(balanceOf(user.id, 'discovery')).resolves.toBe(175);
  });
});
