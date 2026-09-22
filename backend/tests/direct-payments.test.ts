import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { LedgerEntry, Payment } from '../src/models';
import { getDirectPaymentGateway, SimulatedGateway } from '../src/modules/directPayments/gateways';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import { createUser, type TestUser } from './helpers/factories';

/**
 * Server-driven payments against the simulated gateway.
 *
 * Every test ends with the same two questions, because they are the only ones
 * that matter to a customer: how many times was the card charged, and how many
 * times were credits granted? Whatever the retries did, both must be at most
 * one — and equal whenever the payment is paid.
 */
describe('direct payments with retries', () => {
  let app: Express;
  const gateway = getDirectPaymentGateway() as SimulatedGateway;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(async () => {
    gateway.reset();
    await resetUserData();
  });

  afterAll(closeDatabase);

  interface PayOptions {
    failures?: number;
    retries?: number;
    key?: string;
  }

  const pay = (user: TestUser, method: string, options: PayOptions = {}) => {
    const call = request(app)
      .post('/api/direct-payments')
      .set(user.auth)
      .send({
        currency_code: 'campaign',
        quantity: 100,
        payment_method: method,
        simulated_failures: options.failures,
        max_retries: options.retries,
      });
    return options.key === undefined ? call : call.set('Idempotency-Key', options.key);
  };

  const reconcile = (user: TestUser, paymentId: number) =>
    request(app).post(`/api/direct-payments/${paymentId}/reconcile`).set(user.auth);

  const grantsFor = (paymentId: number) => LedgerEntry.count({ where: { paymentId } });

  const campaignBalance = async (user: TestUser): Promise<number> => {
    const wallet = await request(app).get('/api/wallet').set(user.auth).expect(200);
    return wallet.body.balances.find((b: { currency_code: string }) => b.currency_code === 'campaign')
      .balance;
  };

  const outcomes = (body: { attempts: { outcome: string }[] }) => body.attempts.map((a) => a.outcome);

  it('charges once and grants on the first call when the gateway succeeds', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_success').expect(201);

    expect(response.body.state).toBe('paid');
    expect(outcomes(response.body)).toEqual(['succeeded']);
    expect(response.body.attempts[0].trigger).toBe('initial');
    expect(gateway.chargesFor(response.body.payment_id)).toBe(1);
    await expect(grantsFor(response.body.payment_id)).resolves.toBe(1);
    await expect(campaignBalance(user)).resolves.toBe(100);
  });

  it('re-sends a timed-out call under the SAME idempotency key', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_network_timeout', { failures: 2, retries: 3 }).expect(201);

    expect(response.body.state).toBe('paid');
    expect(outcomes(response.body)).toEqual(['transient_error', 'transient_error', 'succeeded']);

    // One logical attempt, re-sent: the key never changes.
    const keys = new Set(response.body.attempts.map((a: { idempotency_key: string }) => a.idempotency_key));
    expect(keys.size).toBe(1);
    expect(response.body.attempts.map((a: { attempt_number: number }) => a.attempt_number)).toEqual([1, 1, 1]);
    expect(response.body.attempts.slice(1).every((a: { trigger: string }) => a.trigger === 'retry')).toBe(true);

    expect(gateway.chargesFor(response.body.payment_id)).toBe(1);
    await expect(campaignBalance(user)).resolves.toBe(100);
  });

  it('does not double-charge when the charge succeeded but its response was lost', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_timeout_after_charge', { failures: 1, retries: 3 }).expect(201);

    expect(outcomes(response.body)).toEqual(['transient_error', 'succeeded']);
    // The retry was answered from the gateway's idempotency cache …
    expect(response.body.attempts[1].replayed).toBe(true);
    // … so the card was charged exactly once. A new key here would be two.
    expect(gateway.chargesFor(response.body.payment_id)).toBe(1);
    expect(response.body.gateway_charge_count).toBe(1);
    await expect(grantsFor(response.body.payment_id)).resolves.toBe(1);
  });

  it('starts a NEW attempt with a new key after a retryable decline', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_processing_error', { failures: 2, retries: 3 }).expect(201);

    expect(response.body.state).toBe('paid');
    expect(outcomes(response.body)).toEqual(['declined', 'declined', 'succeeded']);
    expect(response.body.attempts.map((a: { attempt_number: number }) => a.attempt_number)).toEqual([1, 2, 3]);

    const keys = new Set(response.body.attempts.map((a: { idempotency_key: string }) => a.idempotency_key));
    expect(keys.size).toBe(3);
    expect(response.body.attempts[0].error_code).toBe('processing_error');
    expect(gateway.chargesFor(response.body.payment_id)).toBe(1);
  });

  it('fails once the retry budget is spent on retryable declines', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_processing_error', { failures: 5, retries: 2 }).expect(201);

    // max_retries = 2 means at most 3 calls.
    expect(response.body.attempts).toHaveLength(3);
    expect(response.body.status).toBe('failed');
    expect(response.body.state).toBe('failed');
    expect(gateway.chargesFor(response.body.payment_id)).toBe(0);
    await expect(campaignBalance(user)).resolves.toBe(0);
  });

  it('never retries a hard decline, whatever the budget', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_insufficient_funds', { retries: 5 }).expect(201);

    expect(outcomes(response.body)).toEqual(['declined']);
    expect(response.body.attempts[0].error_code).toBe('insufficient_funds');
    expect(response.body.state).toBe('failed');
  });

  it('stops for the customer when authentication is required', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_authentication_required', { retries: 5 }).expect(201);

    expect(outcomes(response.body)).toEqual(['requires_action']);
    expect(response.body.state).toBe('requires_customer');
    await expect(campaignBalance(user)).resolves.toBe(0);
  });

  it('respects max_retries = 0: one call, no retries', async () => {
    const user = await createUser(app);
    const response = await pay(user, 'sim_processing_error', { failures: 1, retries: 0 }).expect(201);

    expect(response.body.attempts).toHaveLength(1);
    expect(response.body.state).toBe('failed');
  });

  it('leaves a payment pending — not failed — when retries run out on transient errors, then reconciles it', async () => {
    const user = await createUser(app);
    const created = await pay(user, 'sim_network_timeout', { failures: 3, retries: 2 }).expect(201);

    // Three calls, all timed out. The card MAY have been charged, so writing
    // the payment off would be wrong: it waits for reconciliation instead.
    expect(created.body.attempts).toHaveLength(3);
    expect(created.body.status).toBe('pending');
    expect(created.body.state).toBe('needs_reconciliation');
    await expect(campaignBalance(user)).resolves.toBe(0);

    const reconciled = await reconcile(user, created.body.payment_id).expect(200);

    const last = reconciled.body.attempts[reconciled.body.attempts.length - 1];
    expect(last.trigger).toBe('reconcile');
    // Reconciliation re-sends the SAME attempt; it never opens a new one.
    expect(last.idempotency_key).toBe(created.body.attempts[0].idempotency_key);
    expect(reconciled.body.state).toBe('paid');
    expect(gateway.chargesFor(created.body.payment_id)).toBe(1);
    await expect(campaignBalance(user)).resolves.toBe(100);
  });

  it('reconciles a charge whose response was lost with no retries left — without charging again', async () => {
    const user = await createUser(app);
    const created = await pay(user, 'sim_timeout_after_charge', { failures: 1, retries: 0 }).expect(201);

    // The money has been taken, but this server does not know it yet.
    expect(created.body.state).toBe('needs_reconciliation');
    expect(gateway.chargesFor(created.body.payment_id)).toBe(1);
    await expect(campaignBalance(user)).resolves.toBe(0);

    const reconciled = await reconcile(user, created.body.payment_id).expect(200);
    const last = reconciled.body.attempts[reconciled.body.attempts.length - 1];

    expect(last.replayed).toBe(true);
    expect(reconciled.body.state).toBe('paid');
    expect(gateway.chargesFor(created.body.payment_id)).toBe(1);
    await expect(grantsFor(created.body.payment_id)).resolves.toBe(1);
  });

  it('treats reconciling a settled payment as a no-op', async () => {
    const user = await createUser(app);
    const created = await pay(user, 'sim_success').expect(201);

    const reconciled = await reconcile(user, created.body.payment_id).expect(200);
    expect(reconciled.body.attempts).toHaveLength(1);
    expect(reconciled.body.state).toBe('paid');
  });

  it('refuses to reconcile while another request holds the payment', async () => {
    const user = await createUser(app);
    const created = await pay(user, 'sim_network_timeout', { failures: 3, retries: 0 }).expect(201);

    await Payment.update({ processingStartedAt: new Date() }, { where: { id: created.body.payment_id } });

    const response = await reconcile(user, created.body.payment_id).expect(409);
    expect(response.body.error.code).toBe('PAYMENT_IN_PROGRESS');
  });

  it("hides another user's payment", async () => {
    const alice = await createUser(app);
    const bob = await createUser(app);
    const created = await pay(alice, 'sim_success').expect(201);

    await request(app).get(`/api/direct-payments/${created.body.payment_id}`).set(bob.auth).expect(404);
    await reconcile(bob, created.body.payment_id).expect(404);
  });

  it('replays a repeated request with the same Idempotency-Key instead of charging again', async () => {
    const user = await createUser(app);
    const key = `direct-${Date.now()}`;

    const first = await pay(user, 'sim_success', { key }).expect(201);
    const second = await pay(user, 'sim_success', { key }).expect(201);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.payment_id).toBe(first.body.payment_id);
    expect(second.body.attempts).toHaveLength(1);
    expect(gateway.chargesFor(first.body.payment_id)).toBe(1);

    const reused = await pay(user, 'sim_insufficient_funds', { key }).expect(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a retry budget above the server cap and an unknown payment method', async () => {
    const user = await createUser(app);

    const tooMany = await pay(user, 'sim_success', { retries: 6 }).expect(400);
    expect(tooMany.body.error.details[0].field).toBe('max_retries');

    const unknown = await pay(user, 'pm_card_visa').expect(400);
    expect(unknown.body.error.details[0].field).toBe('payment_method');

    await expect(Payment.count()).resolves.toBe(0);
  });

  it('describes the gateway and retry limits for the UI', async () => {
    const user = await createUser(app);
    const response = await request(app).get('/api/direct-payments/config').set(user.auth).expect(200);

    expect(response.body.gateway).toBe('simulated');
    expect(response.body.default_max_retries).toBe(3);
    expect(response.body.max_retries_cap).toBe(5);
    expect(response.body.payment_methods.map((m: { id: string }) => m.id)).toContain('sim_timeout_after_charge');
  });
});
