# Multi-Currency Credits Wallet & Campaign Funding

A slice of an influencer-marketing platform. A user signs up and gets a wallet holding three
separate credit currencies, tops one up by paying through Stripe, creates campaigns, and funds a
campaign by spending credits of that campaign module's currency.

Real money enters the system exactly once — when credits are bought. Everything after that is
internal credit accounting.

|              |                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------- |
| **Backend**  | Node.js 22, TypeScript, Express 4, Sequelize 6 (migrations only, never `sync()`), MySQL 8 |
| **Payments** | Stripe Checkout, test mode                                                                |
| **Frontend** | React 19 + Vite + TypeScript                                                              |
| **Tests**    | Jest against a real MySQL schema built from the real migrations                           |

**Design reasoning lives in [DESIGN.md](DESIGN.md).** The HTTP contract and flow diagrams live in
[docs/API.md](docs/API.md).

---

## 1. Prerequisites

- **Node.js 20+** (developed on 22)
- **Docker** — used for MySQL, so nothing needs installing locally
- **A Stripe test account** and the [Stripe CLI](https://docs.stripe.com/stripe-cli), for the
  payment flow only. The test suite does **not** need either.

> MySQL 8.0.16+ is required because the schema uses `CHECK` constraints; earlier versions parse and
> silently ignore them. The pinned `mysql:8.0` image resolves well past that.

---

## 2. Start the database

```bash
docker compose up -d mysql
```

This publishes MySQL on **host port 3307** (not 3306, so it coexists with any local install) and
creates both `credits_wallet` and `credits_wallet_test` on first boot.

It is bound to `127.0.0.1` deliberately — Docker publishes to `0.0.0.0` by default, which would
expose the database (as `root`, with a development password) on every network interface, and on
Linux Docker's own iptables rules bypass the host firewall.

---

## 3. Configure the backend

```bash
cd backend
cp .env.example .env
npm install
```

`.env.example` already points at the Dockerised MySQL. The two values you must set yourself:

```bash
# Generate a signing secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

- `JWT_SECRET` — paste the output above.
- `STRIPE_SECRET_KEY` — your `sk_test_…` from Stripe Dashboard → Developers → API keys.
- `STRIPE_WEBHOOK_SECRET` — printed by `stripe listen` in step 6. Leave blank until then; the server
  starts without it and only asserts it when a webhook actually arrives.

`.env` is gitignored. Never commit real keys.

---

## 4. Create the schema and seed configuration

```bash
npm run migrate     # 9 tables, in foreign-key order
npm run seed        # 3 modules, 3 currencies, 6 plans
```

Verify:

```bash
npm run migrate:status
```

To wipe and rebuild the local database, recreate the container volume:

```bash
docker compose down -v          # removes the mysql_data volume
docker compose up -d mysql      # docker/mysql/init.sql recreates both databases
cd backend && npm run migrate && npm run seed
```

> The reset above operates on the **Docker volume**, so
> it is structurally incapable of reaching any database other than the local container — a guarantee
> no environment-variable guard can offer.
>
> The test suite still rebuilds its schema by dropping it, via `tests/helpers/dropTestSchema.ts`.
> That helper refuses any database whose name does not end in `_test`, is not reachable from any npm
> script, and is never emitted to `dist`.
>
> Note that unwinding with `migrate:undo:all` and `seed:undo` is _not_ a working alternative once the
> database holds data: the seeder's `down()` deletes from `plans`, which `payments.plan_id`
> references with `ON DELETE RESTRICT`, so any bundle purchase breaks it — and skipping the seeder
> undo leaves `SequelizeData` behind, so the reseed reports "No seeders found", exits 0, and leaves a
> migrated but **completely unseeded** database.

---

## 5. Run the app

Two terminals:

```bash
cd backend  && npm run dev     # http://localhost:4000
cd frontend && npm install && cp .env.example .env && npm run dev    # http://localhost:5173
```

Or run everything in containers instead:

```bash
docker compose up
```

Configuration resolves for both modes without branching: `dotenv` does not overwrite variables that
are already set, so Compose-supplied values win inside a container and `backend/.env` fills in on the
host.

---

## 6. Stripe webhooks

Credits are granted **only** by a verified webhook, so nothing is credited until this is running.

```bash
# bash / zsh
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

```powershell
# PowerShell
$env:STRIPE_API_KEY = (Select-String '^STRIPE_SECRET_KEY=' backend\.env).Line.Split('=')[1]
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET` in `backend/.env`, then **restart the
backend** — the secret is read at startup.

> Pass the key through the **environment**, not as `--api-key sk_test_…`. Command-line arguments are
> visible to anything that can list processes (`tasklist`, `ps`, Task Manager) and land in shell
> history. The environment variable keeps it out of both.
>
> Cleanest of all is `stripe login` against the _correct_ account, which removes the need to supply
> a key here at all — see below for why the account matters.

### `--api-key` is not optional, and here is why

`stripe login` authenticates the CLI to whichever account you picked, which is **not necessarily the
account your `sk_test_…` belongs to**. If they differ, `stripe listen` subscribes to events on one
account while your Checkout Sessions are created in another. Stripe then has no destination for
those events, so **nothing is delivered, nothing errors, and payments silently never grant**.

The tell is that `stripe events resend <evt_id>` reports `No such notification` — there was never a
delivery attempt to resend. Passing `--api-key` forces the CLI onto the same account as the key.

To check which account each is using:

```bash
stripe config --list                      # the CLI's account_id
curl https://api.stripe.com/v1/account -u "$STRIPE_SECRET_KEY:" | head -c 200
```

---

## 7. Exercise the flows

### In the browser

1. Open http://localhost:5173 and sign up. The wallet is created with all three currencies at zero.
2. **Buy credits** — pick a currency, then a bundle or a per-credit quantity, and pay with test card
   `4242 4242 4242 4242`, any future expiry, any CVC.
3. Watch the wallet after the redirect: it shows _"waiting for Stripe to confirm"_ and keeps polling.
   **The redirect grants nothing** — the balance only moves when the webhook lands.
4. **Campaigns** — create one, then fund it. Try funding it twice, and try funding more than you have.
5. **Retry lab** — the server-driven payment flow, where *this server* calls the gateway and retries.
   Pick a gateway behaviour (timeout, 429, processing error, "charged but response lost", hard decline,
   3-D Secure), how many failures to inject and the retry budget, then read the call log. Set the
   failure count above the retry budget to leave a payment _outcome unknown_ and press **Reconcile**.
   Runs against a simulated gateway by default (`DIRECT_PAYMENT_GATEWAY`, see `.env.example`); set it to
   `stripe` to confirm real test-mode PaymentIntents instead.

### From the terminal

A helper creates a real Checkout Session, prints the URL, then watches the payment until the webhook
grants it and dumps what was written:

```bash
cd backend
npm run demo:checkout                              # 1,000 Campaign Credits (bundle)
npm run demo:checkout -- --quantity 50             # per-credit
npm run demo:checkout -- --currency report --quantity 10
```

### Prove the graded behaviours by hand

**Concurrent funding cannot over-spend.** You cannot click two buttons at the same instant, so this
fires genuinely simultaneous requests and prints what the database did:

```bash
cd backend
npm run demo:concurrent-fund
```

```
balance          1000 Campaign Credits
two requests     800 + 800 = 1600  (exceeds the balance)

  Race A  ->  HTTP 200  funded
  Race B  ->  HTTP 422  INSUFFICIENT_CREDITS

  final balance            200
  exactly one succeeded    YES
  balance went negative    no
  balance = sum(ledger)    YES
```

It creates its own throwaway user and cleans up after itself, so it never disturbs the demo account.

**Duplicate webhook grants once.** Grab an `evt_` id from the `stripe listen` output after a payment
and resend it:

```bash
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe events resend <evt_id>
```

The server logs `-> already_granted`, and the balance does not move.

**No credits without a verified webhook.** Stop `stripe listen`, pay again, and watch the wallet sit
on "waiting for confirmation" with the balance unchanged — the money moved at Stripe, the credits did
not.

**Wrong currency is rejected.**

```bash
curl -X POST http://localhost:4000/api/campaigns/1/fund \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"credits":10,"currency_code":"report"}'
# 400 CURRENCY_MODULE_MISMATCH — rejected before any transaction opens
```

**Inspect the constraints that do the real work:**

```bash
docker compose exec mysql mysql -uroot -pdevroot credits_wallet -e "SHOW CREATE TABLE ledger\G"
# UNIQUE KEY uq_ledger_payment_id  (payment_id)   <- exactly-once grant
# UNIQUE KEY uq_ledger_campaign_id (campaign_id)  <- fund at most once
```

---

## 8. Tests

```bash
cd backend
npm test
```

**46 tests, 5 suites.** They run against `credits_wallet_test`, whose schema is built by running the
real migrations — never `sync()`, because sync would build the schema from the models and the tests
would then be validating the models against themselves. The constraints under test exist only in
migrations.

Real MySQL rather than SQLite is required: the concurrency tests depend on `SELECT … FOR UPDATE` row
locking, which SQLite does not implement, so they would pass there without proving anything.

**No Stripe account is needed.** Webhook signatures are built from Stripe's published scheme with
`crypto.createHmac` — deliberately not with Stripe's own helper, since signing with the library we
verify with would only prove the library agrees with itself.

| Suite                 | Proves                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-idempotency` | Eight **concurrent** deliveries of one payment grant exactly once. All pass the application status check; `UNIQUE(ledger.payment_id)` is what stops the second grant. Also covers forged, wrongly-signed and tampered-after-signing requests, and tier-2 resolution by `metadata.payment_id`. |
| `concurrent-funding`  | Ten simultaneous fundings drain a balance to exactly zero, never below. Includes a `FOR UPDATE NOWAIT` test proving the row lock is genuinely held, and a raw-SQL test proving `CHECK(balance >= 0)` holds with the application bypassed.                                                     |
| `currency-isolation`  | A campaign cannot be funded with Report or Discovery credits; the spend currency is resolved from the module, never taken from the client.                                                                                                                                                    |
| `ledger-invariant`    | For every wallet and currency, balance equals the sum of that currency's ledger deltas — after grants, spends, rejected spends, duplicates and concurrency.                                                                                                                                   |
| `auth-validation`     | Password policy, and that login is not an account-existence oracle.                                                                                                                                                                                                                           |

---

## 9. Layout

```
backend/
  config/sequelize.config.js   connection settings for sequelize-cli
  migrations/                  9 tables, foreign-key order
  seeders/                     modules, currencies, plans
  scripts/create-checkout.ts   walkthrough helper
  src/
    config/                    env validation, Sequelize instance
    models/                    Sequelize models + associations
    modules/                   auth, currencies, payments, directPayments, wallet, campaigns, webhooks
    middleware/                requireAuth, error handler
    lib/                       jwt, password, stripe, errors
  tests/
frontend/src/
  api/client.ts                typed API client + error envelope
  auth/AuthContext.tsx
  pages/                       auth, wallet, campaigns
docker/mysql/init.sql          creates both databases
```

---

## 10. Troubleshooting

| Symptom                                                 | Cause                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Payment succeeds, credits never appear                  | `stripe listen` not running, or running **without** `--api-key` and subscribed to a different Stripe account (§6)                     |
| Every webhook returns 400                               | `STRIPE_WEBHOOK_SECRET` does not match the running listener. Compare with `stripe listen --print-secret`, then restart the backend    |
| Webhook returns 400 with no server log                  | Check the backend is the process actually on port 4000 — a stale process holding the port will serve the old secret                   |
| `npm run migrate` says "No migrations were executed"    | Expected when already up to date. `npm run migrate:status` lists them                                                                 |
| `seed:undo` fails on a foreign key                      | Expected once data exists — `payments.plan_id` references `plans` with `ON DELETE RESTRICT`. Reset via the Docker volume instead (§4) |
| Tests fail on signup with "No currencies are seeded"    | The test schema lost its seed data. `npm test` rebuilds it from scratch each run                                                      |
| `Access denied` connecting to MySQL                     | Port 3307, not 3306. The Docker instance and any local MySQL are different servers                                                    |
| Checkout fails with "must convert to at least 50 cents" | Below Stripe's minimum charge. The API rejects amounts under ₹50 with a clear 400 before calling Stripe                               |
