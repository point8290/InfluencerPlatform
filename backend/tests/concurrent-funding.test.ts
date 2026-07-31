import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { Balance, Campaign, Currency, LedgerEntry, Wallet, sequelize } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import { balanceOf, createCampaign, createUser, grantCredits } from './helpers/factories';

/**
 * REQUIRED TEST: an over-spend is impossible.
 *
 * These run against real MySQL, not SQLite, because the guarantee under test is
 * SELECT ... FOR UPDATE row locking — which SQLite does not implement. On
 * SQLite these tests would pass without proving anything.
 */
describe('concurrent campaign funding', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  it('two simultaneous fundings that together exceed the balance cannot both succeed', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 1000);

    const first = await createCampaign(app, user, 'Campaign A');
    const second = await createCampaign(app, user, 'Campaign B');

    // 800 + 800 = 1600 against a balance of 1000.
    const [a, b] = await Promise.all([
      request(app).post(`/api/campaigns/${first.id}/fund`).set(user.auth).send({ credits: 800 }),
      request(app).post(`/api/campaigns/${second.id}/fund`).set(user.auth).send({ credits: 800 }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);

    const rejected = [a, b].find((r) => r.status === 422)!;
    expect(rejected.body.error.code).toBe('INSUFFICIENT_CREDITS');

    // The whole point: 200, not -600.
    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(200);
    await expect(LedgerEntry.count({ where: { reason: 'campaign_funding' } })).resolves.toBe(1);
  });

  it('ten simultaneous fundings drain the balance exactly, never past zero', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 1000);

    // Ten campaigns at 200 each wants 2000 from a balance of 1000, so exactly
    // five can succeed. Higher concurrency makes genuine overlap near-certain
    // rather than hoped-for.
    const campaigns = await Promise.all(
      Array.from({ length: 10 }, (_, index) => createCampaign(app, user, `Campaign ${index}`)),
    );

    const responses = await Promise.all(
      campaigns.map((campaign) =>
        request(app).post(`/api/campaigns/${campaign.id}/fund`).set(user.auth).send({ credits: 200 }),
      ),
    );

    const funded = responses.filter((r) => r.status === 200);
    const refused = responses.filter((r) => r.status === 422);

    expect(funded).toHaveLength(5);
    expect(refused).toHaveLength(5);

    const balance = await balanceOf(user.id, 'campaign');
    expect(balance).toBe(0);
    expect(balance).toBeGreaterThanOrEqual(0);

    await expect(LedgerEntry.count({ where: { reason: 'campaign_funding' } })).resolves.toBe(5);
  });

  it('funding the same campaign concurrently succeeds exactly once', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 1000);
    const campaign = await createCampaign(app, user);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post(`/api/campaigns/${campaign.id}/fund`).set(user.auth).send({ credits: 100 }),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);

    // UNIQUE(ledger.campaign_id) is what makes this exactly one, independently
    // of the draft -> funded status check.
    await expect(LedgerEntry.count({ where: { campaignId: campaign.id } })).resolves.toBe(1);
    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(900);
  });

  it('a rejected funding leaves the balance and ledger completely untouched', async () => {
    const user = await createUser(app);
    await grantCredits(app, user.id, 'campaign', 100);
    const campaign = await createCampaign(app, user);

    const ledgerBefore = await LedgerEntry.count();

    const response = await request(app)
      .post(`/api/campaigns/${campaign.id}/fund`)
      .set(user.auth)
      .send({ credits: 500 })
      .expect(422);

    expect(response.body.error.code).toBe('INSUFFICIENT_CREDITS');
    await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
    await expect(LedgerEntry.count()).resolves.toBe(ledgerBefore);
    await expect(
      Campaign.findByPk(campaign.id).then((c) => c!.status),
    ).resolves.toBe('draft');
  });

  describe('the mechanisms underneath', () => {
    it('SELECT ... FOR UPDATE genuinely locks the balance row', async () => {
      const user = await createUser(app);
      await grantCredits(app, user.id, 'campaign', 100);

      const wallet = await Wallet.findOne({ where: { userId: user.id } });
      const currency = await Currency.findOne({ where: { code: 'campaign' } });

      const holder = await sequelize.transaction();
      await Balance.findOne({
        where: { walletId: wallet!.id, currencyId: currency!.id },
        transaction: holder,
        lock: holder.LOCK.UPDATE,
      });

      // NOWAIT fails immediately instead of waiting, so a lock that is NOT held
      // would let this succeed and the test would fail — which is what makes
      // this a real assertion rather than a slow no-op.
      let secondLockerWasBlocked = false;
      try {
        await sequelize.query(
          'SELECT id FROM balances WHERE wallet_id = ? AND currency_id = ? FOR UPDATE NOWAIT',
          { replacements: [wallet!.id, currency!.id] },
        );
      } catch {
        secondLockerWasBlocked = true;
      } finally {
        await holder.rollback();
      }

      expect(secondLockerWasBlocked).toBe(true);
    });

    it('CHECK(balance >= 0) refuses a negative balance even in raw SQL', async () => {
      const user = await createUser(app);
      await grantCredits(app, user.id, 'campaign', 100);
      const wallet = await Wallet.findOne({ where: { userId: user.id } });

      // The application check produces the friendly 422. This is the floor
      // beneath it, and it holds even when the application is bypassed entirely.
      await expect(
        sequelize.query('UPDATE balances SET balance = -1 WHERE wallet_id = ?', {
          replacements: [wallet!.id],
        }),
      ).rejects.toThrow();

      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
    });
  });
});
