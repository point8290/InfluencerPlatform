import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { LedgerEntry, Payment } from '../src/models';
import { assertUsingTestDatabase, closeDatabase, resetUserData } from './helpers/db';
import {
  balanceOf,
  createPendingPayment,
  createUser,
  postSignedWebhook,
} from './helpers/factories';
import { checkoutSessionEvent, stripeSignatureHeader } from './helpers/stripeEvents';

/**
 * REQUIRED TEST: a duplicate credit-purchase webhook grants credits only once.
 *
 * The point of the concurrent case below is that it cannot be satisfied by the
 * application's `status === 'pending'` check. Several deliveries read the row
 * before any of them commits, so all of them pass that check. What stops the
 * second grant is UNIQUE(ledger.payment_id) — a database constraint, not
 * application control flow.
 */
describe('webhook idempotency', () => {
  let app: Express;

  beforeAll(() => {
    assertUsingTestDatabase();
    app = createApp();
  });

  beforeEach(resetUserData);
  afterAll(closeDatabase);

  describe('signature verification happens before any database access', () => {
    it('rejects a request with no Stripe-Signature header', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);

      const response = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(checkoutSessionEvent({ sessionId: payment.stripeSessionId! })));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_SIGNATURE');
      await expect(LedgerEntry.count()).resolves.toBe(0);
    });

    it('rejects a wrongly-signed request', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);
      const payload = JSON.stringify(
        checkoutSessionEvent({ sessionId: payment.stripeSessionId! }),
      );

      const response = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', stripeSignatureHeader(payload, 'whsec_not_the_real_secret'))
        .send(payload);

      expect(response.status).toBe(400);
      await expect(LedgerEntry.count()).resolves.toBe(0);
    });

    it('rejects a body altered after it was signed', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);
      const payload = JSON.stringify(
        checkoutSessionEvent({ sessionId: payment.stripeSessionId!, amountTotal: 30_000 }),
      );
      const signature = stripeSignatureHeader(payload, process.env.STRIPE_WEBHOOK_SECRET!);

      // Correct signature, tampered payload — the classic forgery attempt.
      const response = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payload.replace('30000', '99999999'));

      expect(response.status).toBe(400);
      await expect(LedgerEntry.count()).resolves.toBe(0);
      await expect(
        Payment.findByPk(payment.id).then((p) => p!.status),
      ).resolves.toBe('pending');
    });
  });

  describe('a verified event grants exactly once', () => {
    it('grants on the first delivery', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);

      const response = await postSignedWebhook(
        app,
        checkoutSessionEvent({ sessionId: payment.stripeSessionId!, paymentId: payment.id }),
      ).expect(200);

      expect(response.body.outcome).toBe('granted');
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
      await expect(LedgerEntry.count()).resolves.toBe(1);
      await expect(
        Payment.findByPk(payment.id).then((p) => p!.status),
      ).resolves.toBe('paid');
    });

    it('does not grant again on sequential redeliveries', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);
      const event = checkoutSessionEvent({
        sessionId: payment.stripeSessionId!,
        paymentId: payment.id,
      });

      await postSignedWebhook(app, event).expect(200);

      for (let delivery = 0; delivery < 5; delivery++) {
        const response = await postSignedWebhook(app, event).expect(200);
        expect(response.body.outcome).toBe('already_granted');
      }

      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
      await expect(LedgerEntry.count()).resolves.toBe(1);
    });

    it('grants once when eight deliveries arrive CONCURRENTLY', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);

      // Distinct evt_ ids, one cs_ — exactly how Stripe's event fan-out and
      // retries look. Concurrency is what defeats the application-level status
      // check: every one of these reads `pending` before any of them commits.
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postSignedWebhook(
            app,
            checkoutSessionEvent({
              sessionId: payment.stripeSessionId!,
              paymentId: payment.id,
            }),
          ),
        ),
      );

      for (const response of responses) {
        // Never a 5xx: Stripe retries those, and a duplicate is not a failure.
        expect(response.status).toBe(200);
      }

      const granted = responses.filter((r) => r.body.outcome === 'granted');
      expect(granted).toHaveLength(1);

      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
      await expect(LedgerEntry.count({ where: { paymentId: payment.id } })).resolves.toBe(1);
    });
  });

  describe('events that must not grant', () => {
    it('ignores an unhandled event type', async () => {
      const response = await postSignedWebhook(app, {
        id: 'evt_test_other',
        object: 'event',
        type: 'payment_intent.created',
        data: { object: { id: 'pi_test_x' } },
      }).expect(200);

      expect(response.body.outcome).toBe('unhandled_event_type');
      await expect(LedgerEntry.count()).resolves.toBe(0);
    });

    it('does not grant when a completed session is unpaid', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);

      const response = await postSignedWebhook(
        app,
        checkoutSessionEvent({
          sessionId: payment.stripeSessionId!,
          paymentId: payment.id,
          paymentStatus: 'unpaid',
        }),
      ).expect(200);

      expect(response.body.outcome).toBe('not_paid');
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(0);
      await expect(LedgerEntry.count()).resolves.toBe(0);
    });

    it('acknowledges an event for a payment it has never heard of', async () => {
      const response = await postSignedWebhook(
        app,
        checkoutSessionEvent({ sessionId: 'cs_test_never_created' }),
      ).expect(200);

      // 200, not 5xx: retrying cannot make an unknown payment known.
      expect(response.body.outcome).toBe('unknown_payment');
    });
  });

  describe('tier-2 resolution by metadata.payment_id', () => {
    it('grants and heals the row when stripe_session_id was never backfilled', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 250);
      const sessionId = payment.stripeSessionId!;

      // Simulate the backfill failing, or simply not having committed before
      // Stripe delivered the event.
      await Payment.update({ stripeSessionId: null }, { where: { id: payment.id } });

      const response = await postSignedWebhook(
        app,
        checkoutSessionEvent({ sessionId, paymentId: payment.id }),
      ).expect(200);

      expect(response.body.outcome).toBe('granted');
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(250);

      const healed = await Payment.findByPk(payment.id);
      expect(healed!.stripeSessionId).toBe(sessionId);
      expect(healed!.stripePaymentIntentId).not.toBeNull();
    });

    it('still grants only once when tier 1 and tier 2 race each other', async () => {
      const user = await createUser(app);
      const payment = await createPendingPayment(user.id, 'campaign', 100);
      const sessionId = payment.stripeSessionId!;

      const responses = await Promise.all([
        // Resolvable by cs_ only.
        postSignedWebhook(app, checkoutSessionEvent({ sessionId })),
        // Resolvable by metadata only.
        postSignedWebhook(
          app,
          checkoutSessionEvent({ sessionId: 'cs_test_unknown', paymentId: payment.id }),
        ),
      ]);

      expect(responses.filter((r) => r.body.outcome === 'granted')).toHaveLength(1);
      await expect(balanceOf(user.id, 'campaign')).resolves.toBe(100);
      await expect(LedgerEntry.count({ where: { paymentId: payment.id } })).resolves.toBe(1);
    });
  });
});
