import type { Express } from 'express';
import request from 'supertest';

/**
 * Stripe is mocked in THIS FILE ONLY.
 *
 * Everything under test here is ours — the unique index, the replay, the
 * concurrent race — and none of it depends on how Stripe behaves. Mocking
 * `sessions.create` keeps the suite self-contained (it needs no Stripe account)
 * while still driving the real service, routes, model and constraints.
 *
 * jest.mock is scoped per module registry, so the webhook tests in other files
 * continue to use the real client for signature verification.
 */
jest.mock('../src/lib/stripe', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async () => {
          const suffix = Math.random().toString(36).slice(2, 12);
          return {
            id: `cs_test_${suffix}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_${suffix}`,
          };
        },
      },
    },
  }),
}));

import { createApp } from '../src/app';
import { Payment } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import { createUser, type TestUser } from './helpers/factories';

/**
 * Idempotent checkout-session creation.
 *
 * Without a key, a retried POST creates a second payment row AND a second live
 * Stripe session. No credits can be fabricated — the grant is keyed on
 * payments.id and guarded by uq_ledger_payment_id — but both sessions are
 * payable, so one intent can produce two charges.
 */
describe('checkout-session idempotency', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  const buy = (user: TestUser, key?: string, quantity = 100) => {
    const call = request(app)
      .post('/api/payments/checkout-session')
      .set(user.auth)
      .send({ currency_code: 'campaign', quantity });

    return key === undefined ? call : call.set('Idempotency-Key', key);
  };

  it('creates one payment and one session for a repeated key', async () => {
    const user = await createUser(app);
    const key = `key-${Date.now()}`;

    const first = await buy(user, key).expect(201);
    const second = await buy(user, key).expect(201);

    expect(second.body.payment_id).toBe(first.body.payment_id);
    expect(second.body.stripe_session_id).toBe(first.body.stripe_session_id);
    expect(second.body.checkout_url).toBe(first.body.checkout_url);

    // The header distinguishes a replay without the body differing, exactly as
    // Stripe's own API does. Status stays 201 on both.
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');

    await expect(Payment.count({ where: { userId: user.id } })).resolves.toBe(1);
  });

  it('creates separate payments without a key — the behaviour being fixed', async () => {
    const user = await createUser(app);

    const first = await buy(user).expect(201);
    const second = await buy(user).expect(201);

    expect(second.body.payment_id).not.toBe(first.body.payment_id);
    await expect(Payment.count({ where: { userId: user.id } })).resolves.toBe(2);
  });

  it('treats different keys as different intents', async () => {
    const user = await createUser(app);

    const first = await buy(user, `a-${Date.now()}`).expect(201);
    const second = await buy(user, `b-${Date.now()}`).expect(201);

    expect(second.body.payment_id).not.toBe(first.body.payment_id);
    await expect(Payment.count({ where: { userId: user.id } })).resolves.toBe(2);
  });

  it('rejects a key reused for a different purchase', async () => {
    const user = await createUser(app);
    const key = `reuse-${Date.now()}`;

    await buy(user, key, 100).expect(201);

    // Same key, different amount. Silently returning the original would charge
    // for something the caller did not just ask for — almost always a client
    // bug, and it should be loud.
    const mismatch = await buy(user, key, 250).expect(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await expect(Payment.count({ where: { userId: user.id } })).resolves.toBe(1);
  });

  it("scopes keys per user, so one user cannot claim another's key", async () => {
    const alice = await createUser(app);
    const bob = await createUser(app);
    const sharedKey = `shared-${Date.now()}`;

    const aliceSession = await buy(alice, sharedKey).expect(201);
    const bobSession = await buy(bob, sharedKey).expect(201);

    // Both succeed, and crucially Bob does NOT receive Alice's payment. A global
    // key space would have denied Bob, or — far worse — answered him with her
    // payment and her checkout URL.
    expect(bobSession.body.payment_id).not.toBe(aliceSession.body.payment_id);
    expect(bobSession.body.checkout_url).not.toBe(aliceSession.body.checkout_url);

    const bobPayment = await Payment.findByPk(bobSession.body.payment_id);
    expect(bobPayment!.userId).toBe(bob.id);
  });

  it('never creates two payments when the same key arrives concurrently', async () => {
    const user = await createUser(app);
    const key = `race-${Date.now()}`;

    // A loser of the unique-index race may get 409 in-progress, which is the
    // correct answer while the winner is still mid-flight. What is never
    // acceptable is two payment rows for one key.
    const responses = await Promise.all([buy(user, key), buy(user, key), buy(user, key)]);

    for (const response of responses) {
      expect([201, 409]).toContain(response.status);
      if (response.status === 409) {
        expect(response.body.error.code).toBe('IDEMPOTENT_REQUEST_IN_PROGRESS');
      }
    }

    expect(responses.filter((response) => response.status === 201).length).toBeGreaterThanOrEqual(1);
    await expect(Payment.count({ where: { userId: user.id } })).resolves.toBe(1);
  });

  it('rejects an empty Idempotency-Key rather than silently ignoring it', async () => {
    const user = await createUser(app);

    const response = await request(app)
      .post('/api/payments/checkout-session')
      .set(user.auth)
      .set('Idempotency-Key', '   ')
      .send({ currency_code: 'campaign', quantity: 100 })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
