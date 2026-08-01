import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Balance, Currency, LedgerEntry, Payment, Wallet, sequelize } from '../src/models';
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

  describe('chk_ledger_reference_exclusive', () => {
    /**
     * The exclusive arc is only "exclusive" if the database says so. These
     * assert the shapes the application never writes but nothing previously
     * stopped — a ledger row is append-only, so an incoherent one is permanent.
     */
    async function fixture() {
      const user = await createUser(app);
      const payment = await grantCredits(app, user.id, 'campaign', 500);
      const campaign = await createCampaign(app, user);

      const wallet = (await Wallet.findOne({ where: { userId: user.id } }))!;
      const currency = (await Currency.findOne({ where: { code: 'campaign' } }))!;

      return { user, payment, campaign, walletId: wallet.id, currencyId: currency.id };
    }

    it('rejects a row referencing neither a payment nor a campaign', async () => {
      const { walletId, currencyId } = await fixture();

      await expect(
        LedgerEntry.create({ walletId, currencyId, delta: 10, reason: 'purchase' }),
      ).rejects.toThrow();
    });

    it('rejects a row referencing both', async () => {
      const { walletId, currencyId, payment, campaign } = await fixture();

      await expect(
        LedgerEntry.create({
          walletId,
          currencyId,
          delta: -10,
          reason: 'campaign_funding',
          paymentId: payment.id,
          campaignId: campaign.id,
        }),
      ).rejects.toThrow();
    });

    it('rejects a reason that disagrees with the populated reference', async () => {
      const { walletId, currencyId, campaign } = await fixture();

      await expect(
        LedgerEntry.create({
          walletId,
          currencyId,
          delta: 10,
          // A purchase cannot be evidenced by a campaign.
          reason: 'purchase',
          campaignId: campaign.id,
        }),
      ).rejects.toThrow();
    });

    it('still accepts the two legitimate shapes', async () => {
      const { walletId, currencyId, campaign } = await fixture();

      // Funding row: campaign set, payment null.
      await expect(
        LedgerEntry.create({
          walletId,
          currencyId,
          delta: -10,
          reason: 'campaign_funding',
          campaignId: campaign.id,
        }),
      ).resolves.toBeDefined();

      // The purchase shape is already exercised by grantCredits in fixture().
      await expect(
        LedgerEntry.count({ where: { walletId, reason: 'purchase' } }),
      ).resolves.toBe(1);
    });

    it('still refuses to delete a payment a ledger row references', async () => {
      const { payment } = await fixture();

      // The FKs were rewritten without ON DELETE RESTRICT to make the CHECK
      // legal — MySQL forbids referential actions on columns used in a CHECK.
      // InnoDB's default is RESTRICT anyway, so this must still fail. If it
      // ever passes, that rewrite quietly cost real referential integrity.
      await expect(
        sequelize.query('DELETE FROM payments WHERE id = ?', { replacements: [payment.id] }),
      ).rejects.toThrow();

      await expect(Payment.findByPk(payment.id)).resolves.not.toBeNull();
    });
  });

  describe('pagination', () => {
    /**
     * The UI reads `total` to show "showing N of M" and to number rows, and
     * pages with limit/offset. Before those controls existed the frontend
     * silently rendered only the first page — the balance stayed correct while
     * the list was incomplete, which is the worst way for this to be wrong,
     * because the wallet screen invites you to check that the deltas sum to the
     * balance.
     */
    it('pages without gaps or overlaps, and reports the true total', async () => {
      const user = await createUser(app);
      for (let purchase = 0; purchase < 5; purchase++) {
        await grantCredits(app, user.id, 'campaign', 10);
      }

      const pageOne = await request(app)
        .get('/api/wallet/ledger?limit=2&offset=0')
        .set(user.auth)
        .expect(200);
      const pageTwo = await request(app)
        .get('/api/wallet/ledger?limit=2&offset=2')
        .set(user.auth)
        .expect(200);
      const pageThree = await request(app)
        .get('/api/wallet/ledger?limit=2&offset=4')
        .set(user.auth)
        .expect(200);

      expect(pageOne.body.items).toHaveLength(2);
      expect(pageTwo.body.items).toHaveLength(2);
      expect(pageThree.body.items).toHaveLength(1);

      // `total` is the full count regardless of how much was fetched — this is
      // what the "showing N of M" line and the row serials depend on.
      for (const page of [pageOne, pageTwo, pageThree]) {
        expect(page.body.total).toBe(5);
      }

      const ids = [...pageOne.body.items, ...pageTwo.body.items, ...pageThree.body.items].map(
        (item: { id: number }) => item.id,
      );
      expect(new Set(ids).size).toBe(5);
    });

    it('clamps an oversized limit rather than rejecting it', async () => {
      const user = await createUser(app);
      await grantCredits(app, user.id, 'campaign', 10);

      const response = await request(app)
        .get('/api/wallet/ledger?limit=5000')
        .set(user.auth)
        .expect(200);

      // Clamped to MAX_LIMIT, so a client cannot ask for the whole table.
      expect(response.body.limit).toBe(200);
    });

    it('paginates campaigns too, which is what keeps them fundable', async () => {
      const user = await createUser(app);
      for (let index = 0; index < 3; index++) {
        await createCampaign(app, user, `Campaign ${index}`);
      }

      const firstPage = await request(app)
        .get('/api/campaigns?limit=2&offset=0')
        .set(user.auth)
        .expect(200);
      const secondPage = await request(app)
        .get('/api/campaigns?limit=2&offset=2')
        .set(user.auth)
        .expect(200);

      expect(firstPage.body.items).toHaveLength(2);
      expect(secondPage.body.items).toHaveLength(1);
      expect(firstPage.body.total).toBe(3);

      // A campaign only reachable on a later page must still be a real,
      // fundable campaign — the Fund control lives in its row.
      const stranded = secondPage.body.items[0] as { id: number; status: string };
      expect(stranded.status).toBe('draft');
    });
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
