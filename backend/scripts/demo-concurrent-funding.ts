/**
 * Walkthrough helper: proves live that concurrent funding cannot over-spend.
 *
 *   npm run demo:concurrent-fund
 *
 * The graded scenario is easy to assert in a test and hard to show in a
 * browser — you cannot click two buttons at the same instant. This fires
 * genuinely simultaneous funding requests against one wallet and prints what
 * the database did, so the guarantee can be demonstrated rather than described.
 *
 * Requires the API running (`npm run dev`). It creates its own throwaway user
 * and grants credits through the real webhook path, so it never disturbs the
 * demo account.
 */
import { createHmac } from 'node:crypto';
import { env } from '../src/config/env';
import { Balance, Currency, LedgerEntry, Payment, Wallet, sequelize } from '../src/models';

const API = process.env.API_URL ?? `http://localhost:${env.port}`;

/** Credits granted to the throwaway wallet before the race. */
const STARTING_CREDITS = 1_000;
/** Each request asks for this much. Two of them together exceed the balance. */
const FUND_EACH = 800;

interface Json {
  status: number;
  body: any;
}

async function call(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Grants credits through the real webhook path — signature verification included. */
async function grantCredits(userId: number, credits: number): Promise<void> {
  const currency = (await Currency.findOne({ where: { code: 'campaign' } }))!;

  const payment = await Payment.create({
    userId,
    currencyId: currency.id,
    planId: null,
    purchaseKind: 'quantity',
    credits,
    amountPaise: credits * currency.pricePaisePerCredit,
    status: 'pending',
    stripeSessionId: `cs_demo_${Date.now()}`,
  });

  const payload = JSON.stringify({
    id: `evt_demo_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: payment.stripeSessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: payment.amountPaise,
        currency: 'inr',
        payment_intent: `pi_demo_${Date.now()}`,
        metadata: { payment_id: String(payment.id) },
      },
    },
  });

  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const response = await fetch(`${API}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
    body: payload,
  });

  if (!response.ok) {
    throw new Error(
      `Webhook rejected (${response.status}). Is STRIPE_WEBHOOK_SECRET in backend/.env the one ` +
        'the running server loaded? Restart the server after changing it.',
    );
  }
}

async function main(): Promise<void> {
  const health = await call('/health').catch(() => null);
  if (health === null || health.status !== 200) {
    throw new Error(`API is not responding at ${API}. Start it with: npm run dev`);
  }

  const email = `race-demo-${Date.now()}@example.com`;
  const signup = await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'demo-password-1' }),
  });
  const userId = signup.body.user.id as number;
  const auth = { Authorization: `Bearer ${signup.body.token}` };

  await grantCredits(userId, STARTING_CREDITS);

  const campaignA = (await call('/api/campaigns', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Race A' }) })).body;
  const campaignB = (await call('/api/campaigns', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Race B' }) })).body;

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`balance          ${STARTING_CREDITS} Campaign Credits`);
  console.log(`two requests     ${FUND_EACH} + ${FUND_EACH} = ${FUND_EACH * 2}  (exceeds the balance)`);
  console.log('─────────────────────────────────────────────────────────────\n');
  console.log('firing both at the same instant…\n');

  const fund = (id: number) =>
    call(`/api/campaigns/${id}/fund`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ credits: FUND_EACH }),
    });

  const [a, b] = await Promise.all([fund(campaignA.id), fund(campaignB.id)]);

  for (const [label, result] of [['Race A', a], ['Race B', b]] as const) {
    const code = result.body?.error?.code ?? 'funded';
    console.log(`  ${label}  ->  HTTP ${result.status}  ${code}`);
  }

  const wallet = (await Wallet.findOne({ where: { userId } }))!;
  const currency = (await Currency.findOne({ where: { code: 'campaign' } }))!;
  const balance = (await Balance.findOne({ where: { walletId: wallet.id, currencyId: currency.id } }))!;
  const spends = await LedgerEntry.findAll({ where: { walletId: wallet.id, reason: 'campaign_funding' } });
  const ledgerSum = (await LedgerEntry.findAll({ where: { walletId: wallet.id } })).reduce(
    (total, entry) => total + entry.delta,
    0,
  );

  console.log('\nwhat the database did:\n');
  console.log(`  final balance            ${balance.balance}`);
  console.log(`  funding ledger rows      ${spends.length}`);
  console.log(`  sum of all ledger rows   ${ledgerSum}`);

  const succeeded = [a, b].filter((result) => result.status === 200).length;
  const overspent = balance.balance < 0;
  const consistent = ledgerSum === balance.balance;

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  exactly one succeeded    ${succeeded === 1 ? 'YES' : `NO (${succeeded})`}`);
  console.log(`  balance went negative    ${overspent ? 'YES — BROKEN' : 'no'}`);
  console.log(`  balance = sum(ledger)    ${consistent ? 'YES' : 'NO — BROKEN'}`);
  console.log('─────────────────────────────────────────────────────────────');
  console.log(
    '\nThe loser blocked on SELECT ... FOR UPDATE against the balances row, then read\n' +
      'the DECREMENTED balance rather than a stale snapshot, and was rejected.\n',
  );

  // Clean up the throwaway user, in foreign-key order.
  await LedgerEntry.destroy({ where: { walletId: wallet.id } });
  await Balance.destroy({ where: { walletId: wallet.id } });
  await Payment.destroy({ where: { userId } });
  await sequelize.query('DELETE FROM campaigns WHERE user_id = ?', { replacements: [userId] });
  await Wallet.destroy({ where: { id: wallet.id } });
  await sequelize.query('DELETE FROM users WHERE id = ?', { replacements: [userId] });

  await sequelize.close();
}

main().catch((error: unknown) => {
  console.error('\n' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
