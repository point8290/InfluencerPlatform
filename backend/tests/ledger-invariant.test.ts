import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Balance, Currency, LedgerEntry, Wallet } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import { balanceOf, createCampaign, createUser, grantCredits } from './helpers/factories';

/**
 * The headline acceptance criterion: for each currency, the wallet balance
 * equals the sum of that currency's ledger entries.
 *
 * `balances` is a projection maintained in the same transaction as every ledger
 * insert, never an independent record. This asserts the projection has not
 * drifted — after grants, spends, rejected spends, duplicates and concurrency.
 */
async function expectLedgerMatchesBalances(): Promise<void> {
  const balances = await Balance.findAll();

  for (const balance of balances) {
    const entries = await LedgerEntry.findAll({
      where: { walletId: balance.walletId, currencyId: balance.currencyId },
    });
    const sum = entries.reduce((total, entry) => total + entry.delta, 0);

    expect({
      walletId: balance.walletId,
      currencyId: balance.currencyId,
      sum,
    }).toEqual({
      walletId: balance.walletId,
      currencyId: balance.currencyId,
      sum: balance.balance,
    });
  }
}

describe('ledger is the source of truth', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  it('provisions one zero balance per currency at signup', async () => {
    const user = await createUser(app);

    const wallet = await Wallet.findOne({ where: { userId: user.id } });
    expect(wallet).not.toBeNull();

    const balances = await Balance.findAll({ where: { walletId: wallet!.id } });
    const currencies = await Currency.findAll();

    // Every balance row exists from signup, which is what lets every later
    // grant and spend assume the row is there to be locked.
    expect(balances).toHaveLength(currencies.length);
    expect(balances.every((balance) => balance.balance === 0)).toBe(true);
    await expectLedgerMatchesBalances();
  });

  it('holds after a mix of grants, spends and rejected spends', async () => {
    const user = await createUser(app);

    await grantCredits(app, user.id, 'campaign', 1000);
    await grantCredits(app, user.id, 'report', 300);

    const funded = await createCampaign(app, user, 'Funded');
    await request(app)
      .post(`/api/campaigns/${funded.id}/fund`)
      .set(user.auth)
      .send({ credits: 250 })
      .expect(200);

    // Rejected: insufficient.
    const tooBig = await createCampaign(app, user, 'Too big');
    await request(app)
      .post(`/api/campaigns/${tooBig.id}/fund`)
      .set(user.auth)
      .send({ credits: 999_999 })
      .expect(422);

    // Rejected: wrong currency.
    const wrongCurrency = await createCampaign(app, user, 'Wrong currency');
    await request(app)
      .post(`/api/campaigns/${wrongCurrency.id}/fund`)
      .set(user.auth)
      .send({ credits: 10, currency_code: 'report' })
      .expect(400);

    // Rejected: already funded.
    await request(app)
      .post(`/api/campaigns/${funded.id}/fund`)
      .set(user.auth)
      .send({ credits: 10 })
      .expect(409);

    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(750);
    await expect(balanceOf(user.id, 'report')).resolves.toBe(300);
    await expectLedgerMatchesBalances();
  });

  it('holds across several wallets acting concurrently', async () => {
    const users = await Promise.all([createUser(app), createUser(app), createUser(app)]);

    for (const user of users) {
      await grantCredits(app, user.id, 'campaign', 600);
    }

    const campaigns = await Promise.all(users.map((user) => createCampaign(app, user)));

    // Different wallets, so all three should succeed — they lock different rows.
    const responses = await Promise.all(
      users.map((user, index) =>
        request(app)
          .post(`/api/campaigns/${campaigns[index]!.id}/fund`)
          .set(user.auth)
          .send({ credits: 200 }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);

    for (const user of users) {
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(400);
    }
    await expectLedgerMatchesBalances();
  });

  it('records every movement with a signed delta and a single reference', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 500);

    const campaign = await createCampaign(app, user);
    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 200 })
      .expect(200);

    const entries = await LedgerEntry.findAll({ order: [['id', 'ASC']] });
    expect(entries).toHaveLength(2);

    const [purchase, spend] = entries;

    expect(purchase!.reason).toBe('purchase');
    expect(purchase!.delta).toBe(500);
    expect(purchase!.paymentId).not.toBeNull();
    expect(purchase!.campaignId).toBeNull();

    expect(spend!.reason).toBe('campaign_funding');
    expect(spend!.delta).toBe(-200);
    expect(spend!.campaignId).toBe(campaign.id);
    expect(spend!.paymentId).toBeNull();

    await expectLedgerMatchesBalances();
  });

  it('exposes the same numbers through the wallet API', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 800);

    const campaign = await createCampaign(app, user);
    await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 300 })
      .expect(200);

    const wallet = await request(app).get('/api/wallet').set(user.auth).expect(200);
    const campaignBalance = wallet.body.balances.find(
      (entry: { currency_code: string }) => entry.currency_code === 'campaign',
    );
    expect(campaignBalance.balance).toBe(500);

    const ledger = await request(app).get('/api/wallet/ledger').set(user.auth).expect(200);
    const sum = ledger.body.items.reduce(
      (total: number, item: { currency_code: string; delta: number }) =>
        item.currency_code === 'campaign' ? total + item.delta : total,
      0,
    );

    // What the API reports must reconcile to what it reports elsewhere.
    expect(sum).toBe(campaignBalance.balance);
  });
});
