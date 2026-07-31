/**
 * Walkthrough helper: creates a real Stripe Checkout Session through the running
 * API, prints the URL to pay, then watches the payment status until the webhook
 * grants the credits.
 *
 *   npm run demo:checkout                 1,000 Campaign Credits (bundle, Rs 2,700)
 *   npm run demo:checkout -- --quantity 50   50 credits at the per-credit rate
 *   npm run demo:checkout -- --currency report --quantity 10
 *
 * Requires the API running (`npm run dev`) and, for the grant to land,
 * `stripe listen --forward-to localhost:4000/api/webhooks/stripe`.
 *
 * This deliberately talks to the API over HTTP rather than calling services
 * directly, so it exercises exactly the path a browser would. It reads the
 * database only at the end, to show what the webhook actually wrote.
 */
import { env } from '../src/config/env';
import { Balance, Currency, LedgerEntry, Payment, Wallet, sequelize } from '../src/models';

const API = process.env.API_URL ?? `http://localhost:${env.port}`;
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@example.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

interface Args {
  currencyCode: string;
  quantity: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const read = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };

  const quantityRaw = read('--quantity');
  return {
    currencyCode: read('--currency') ?? 'campaign',
    quantity: quantityRaw === null ? null : Number(quantityRaw),
  };
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Signs the demo user up, or logs in if they already exist. */
async function authenticate(): Promise<string> {
  const credentials = JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD });

  const signup = await api('/api/auth/signup', { method: 'POST', body: credentials });
  if (signup.status === 201) {
    console.log(`Created demo user ${DEMO_EMAIL}`);
    return signup.body.token;
  }

  const login = await api('/api/auth/login', { method: 'POST', body: credentials });
  if (login.status !== 200) {
    throw new Error(`Could not authenticate as ${DEMO_EMAIL}: ${JSON.stringify(login.body)}`);
  }
  console.log(`Logged in as ${DEMO_EMAIL}`);
  return login.body.token;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const health = await api('/health').catch(() => null);
  if (health === null || health.status !== 200) {
    throw new Error(`API is not responding at ${API}. Start it with: npm run dev`);
  }

  const token = await authenticate();
  const auth = { Authorization: `Bearer ${token}` };

  const currencies = await api('/api/currencies');
  const currency = currencies.body.find((c: any) => c.code === args.currencyCode);
  if (currency === undefined) {
    throw new Error(
      `No currency "${args.currencyCode}". Available: ${currencies.body.map((c: any) => c.code).join(', ')}`,
    );
  }

  // Default to the largest bundle so the discount is visible in the output.
  const body =
    args.quantity !== null
      ? { currency_code: currency.code, quantity: args.quantity }
      : {
          currency_code: currency.code,
          plan_id: currency.plans.reduce((a: any, b: any) => (a.credits > b.credits ? a : b)).id,
        };

  const created = await api('/api/payments/checkout-session', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  });

  if (created.status !== 201) {
    throw new Error(`Checkout session creation failed: ${JSON.stringify(created.body)}`);
  }

  const { payment_id, stripe_session_id, checkout_url, credits, amount_paise } = created.body;

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`payment_id     ${payment_id}   (the durable anchor, in session metadata)`);
  console.log(`session        ${stripe_session_id}`);
  console.log(`buying         ${credits} ${currency.name}`);
  console.log(`amount         ${amount_paise} paise  (Rs ${(amount_paise / 100).toFixed(2)})`);
  if (args.quantity === null) {
    const undiscounted = credits * currency.price_paise_per_credit;
    console.log(`undiscounted   ${undiscounted} paise  -> bundle saves ${undiscounted - amount_paise}`);
  }
  console.log('─────────────────────────────────────────────────────────────');
  console.log('\nPay with test card 4242 4242 4242 4242, any future expiry, any CVC:\n');
  console.log(checkout_url);

  console.log('\nWatching payment status. Note it stays "pending" after the browser');
  console.log('redirects back — the redirect grants nothing. Only the webhook does.\n');

  const startedAt = Date.now();
  let status = 'pending';

  while (status === 'pending' && Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const polled = await api(`/api/payments/session/${stripe_session_id}`, { headers: auth });
    status = polled.body?.status ?? 'pending';

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  ${seconds}s  status=${status}   `);
  }

  console.log('\n');

  if (status !== 'paid') {
    console.log(`Gave up after ${Math.round(POLL_TIMEOUT_MS / 1000)}s with status "${status}".`);
    console.log('If you paid, check that `stripe listen` is running and forwarding to');
    console.log(`  ${API}/api/webhooks/stripe`);
    await sequelize.close();
    return;
  }

  // Read what the webhook actually wrote.
  const payment = await Payment.findByPk(payment_id);
  const wallet = await Wallet.findOne({ where: { userId: payment!.userId } });
  const balances = await Balance.findAll({
    where: { walletId: wallet!.id },
    include: [{ model: Currency, as: 'currency' }],
  });
  const entries = await LedgerEntry.findAll({
    where: { walletId: wallet!.id },
    order: [['id', 'DESC']],
    limit: 5,
  });

  console.log('GRANTED. What the webhook wrote:\n');
  console.log(`  payments.status            ${payment!.status}`);
  console.log(`  payments.stripe_session_id ${payment!.stripeSessionId}`);
  console.log(`  payments.payment_intent    ${payment!.stripePaymentIntentId}`);
  console.log('\n  balances:');
  for (const balance of balances) {
    console.log(`    ${(balance.currency?.code ?? '?').padEnd(10)} ${balance.balance}`);
  }
  console.log('\n  ledger (most recent 5):');
  for (const entry of entries) {
    const sign = entry.delta > 0 ? '+' : '';
    console.log(
      `    #${String(entry.id).padEnd(4)} ${sign}${String(entry.delta).padEnd(7)} ${entry.reason.padEnd(17)} payment_id=${entry.paymentId ?? '-'}`,
    );
  }

  const total = entries.reduce((sum, entry) => sum + entry.delta, 0);
  console.log(`\n  (ledger sum of the rows shown: ${total})`);
  console.log('\nTry `stripe events resend <evt_id>` now — the balance will not move.');

  await sequelize.close();
}

main().catch((error: unknown) => {
  console.error('\n' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
