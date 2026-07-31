import request from 'supertest';
import type { Express } from 'express';
import { Balance, Currency, Payment, Wallet } from '../../src/models';
import { checkoutSessionEvent, stripeSignatureHeader } from './stripeEvents';

let sequence = 0;
const unique = (): string => `${Date.now()}-${++sequence}`;

export interface TestUser {
  id: number;
  email: string;
  token: string;
  auth: { Authorization: string };
}

export async function createUser(app: Express): Promise<TestUser> {
  const email = `test-${unique()}@example.com`;

  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'test-password-123' })
    .expect(201);

  const { id } = response.body.user;
  const token = response.body.token as string;

  return { id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

/**
 * Creates a pending payment exactly as the checkout-session endpoint would,
 * without calling Stripe.
 *
 * The endpoint's own behaviour is covered elsewhere; what tests need from this
 * is a payment row that a webhook can then resolve, so hitting the Stripe API
 * for every fixture would add network flakiness for nothing.
 */
export async function createPendingPayment(
  userId: number,
  currencyCode: string,
  credits: number,
): Promise<Payment> {
  const currency = await Currency.findOne({ where: { code: currencyCode } });
  if (currency === null) {
    throw new Error(`Test fixture error: no seeded currency "${currencyCode}".`);
  }

  return Payment.create({
    userId,
    currencyId: currency.id,
    planId: null,
    purchaseKind: 'quantity',
    credits,
    amountPaise: credits * currency.pricePaisePerCredit,
    status: 'pending',
    stripeSessionId: `cs_test_${unique()}`,
  });
}

/** POSTs a correctly-signed webhook, exactly as Stripe would. */
export function postSignedWebhook(
  app: Express,
  event: Record<string, unknown>,
): request.Test {
  const payload = JSON.stringify(event);

  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', stripeSignatureHeader(payload, process.env.STRIPE_WEBHOOK_SECRET!))
    // .send() with a string keeps supertest from re-serializing, so the bytes
    // signed above are the bytes the server verifies.
    .send(payload);
}

/**
 * Grants credits through the REAL webhook path — signature verification, payment
 * resolution, ledger insert, balance increment, status transition.
 *
 * Tests that need a funded wallet use this rather than writing a balance row
 * directly, so their starting state is one the production code actually
 * produces. A hand-written balance could satisfy a test while being impossible
 * in practice.
 */
export async function grantCredits(
  app: Express,
  userId: number,
  currencyCode: string,
  credits: number,
): Promise<Payment> {
  const payment = await createPendingPayment(userId, currencyCode, credits);

  await postSignedWebhook(
    app,
    checkoutSessionEvent({
      sessionId: payment.stripeSessionId!,
      paymentId: payment.id,
      amountTotal: payment.amountPaise,
    }),
  ).expect(200);

  return payment;
}

export async function balanceOf(userId: number, currencyCode: string): Promise<number> {
  const wallet = await Wallet.findOne({ where: { userId } });
  const currency = await Currency.findOne({ where: { code: currencyCode } });

  const balance = await Balance.findOne({
    where: { walletId: wallet!.id, currencyId: currency!.id },
  });

  return balance!.balance;
}

export async function createCampaign(app: Express, user: TestUser, name = 'Test campaign') {
  const response = await request(app)
    .post('/api/campaigns')
    .set(user.auth)
    .send({ name })
    .expect(201);

  return response.body as { id: number; status: string; funded_credits: number | null };
}
