# DESIGN.md — Multi-Currency Credits Wallet & Campaign Funding

> This document is authoritative for the **schema and the guarantees**. The HTTP contract — paths, request/response bodies, status codes, error codes, and flow diagrams — lives in [docs/API.md](docs/API.md).

## Design stance

The design pushes every safety-critical guarantee **down into the database** (unique constraints, row locks, transactional atomicity) rather than relying on application control flow, because application checks have time-of-check-to-time-of-use (TOCTOU) races under concurrency that the database does not.

Two principles run through everything:

1. **The ledger is the source of truth.** Every credit movement is an append-only, signed ledger row. Balances are a _materialized, transactionally-maintained_ projection of the ledger that exists to be locked and read in O(1) — never a second, independent source of truth.
2. **Idempotency is keyed on the payment, not the event.** One Stripe payment fans out into several events (`payment_intent.created/succeeded`, `charge.succeeded/updated`, `checkout.session.completed`), each with a distinct `evt_` id but sharing one `cs_`/`pi_`. Keying on the payment makes "grant exactly once **per payment**" a schema-level fact that survives the fan-out and all redelivery.

---

## Schema & ER diagram

```mermaid
erDiagram
    MODULES ||--|| CURRENCIES : "bound 1:1"
    MODULES ||--o{ CAMPAIGNS : "scopes"
    CURRENCIES ||--o{ PLANS : "has"
    CURRENCIES ||--o{ BALANCES : "denominates"
    CURRENCIES ||--o{ LEDGER : "denominates"
    CURRENCIES ||--o{ PAYMENTS : "grants into"
    USERS ||--|| WALLETS : "owns"
    USERS ||--o{ PAYMENTS : "makes"
    USERS ||--o{ CAMPAIGNS : "creates"
    WALLETS ||--o{ BALANCES : "holds"
    WALLETS ||--o{ LEDGER : "records"
    PLANS ||--o{ PAYMENTS : "priced by"
    PAYMENTS ||--o| LEDGER : "grants (once)"
    CAMPAIGNS ||--o| LEDGER : "funded by (once)"

    MODULES {
        bigint id PK
        varchar code UK
        varchar name
    }
    CURRENCIES {
        bigint id PK
        varchar code UK
        bigint module_id FK "UK - 1:1 binding"
        int price_paise_per_credit
    }
    PLANS {
        bigint id PK
        bigint currency_id FK
        bigint credits
        bigint price_paise
    }
    USERS {
        bigint id PK
        varchar email UK
        varchar password_hash
    }
    WALLETS {
        bigint id PK
        bigint user_id FK "UK - one per user"
    }
    BALANCES {
        bigint id PK
        bigint wallet_id FK
        bigint currency_id FK
        bigint balance "CHECK >= 0"
    }
    LEDGER {
        bigint id PK
        bigint wallet_id FK
        bigint currency_id FK
        bigint delta "signed: +grant / -spend"
        enum reason "purchase | campaign_funding"
        bigint payment_id FK "UK nullable - exactly-once grant"
        bigint campaign_id FK "UK nullable - fund-once"
    }
    PAYMENTS {
        bigint id PK
        bigint user_id FK
        bigint currency_id FK
        bigint plan_id FK "nullable - provenance, NULL for quantity buys"
        enum purchase_kind "plan | quantity"
        varchar stripe_session_id UK "cs_ - nullable, backfilled after session creation"
        varchar stripe_payment_intent_id UK "pi_ - nullable, backfilled from webhook"
        bigint amount_paise "server-computed, frozen"
        bigint credits "server-computed, frozen"
        enum status "pending | paid | expired | failed"
    }
    CAMPAIGNS {
        bigint id PK
        bigint user_id FK
        bigint module_id FK
        varchar name
        enum status "draft | funded"
    }
```

### Table notes (load-bearing details only)

- **`modules`, `currencies`, `plans`** are **seeded configuration**, not created at runtime. Prices are stored, so a new currency/module drops in as data with no business-logic change.
- **Currency↔module binding** is `currencies.module_id` with a **`UNIQUE(module_id)`** → each module has exactly one bound currency. Spend resolves `campaign.module_id → currency`; any other currency is rejected _structurally_, with no hardcoded `if (currency === 'campaign')`. This is what lets Reports/Discovery spending be added later by pattern, not rewrite.
- **`plans.price_paise`** is stored (not computed) because bundles are discounted vs. `credits × per_credit_price` (e.g. 1000 Campaign Credits = ₹2,700, not ₹3,000).
- **`balances`** — one row per `(wallet_id, currency_id)`, enforced by **`UNIQUE(wallet_id, currency_id)`**. This composite unique is what makes `SELECT … FOR UPDATE` lock _exactly one_ row, which is the entire concurrency-safety mechanism for spends. All three rows are provisioned at `0` when the wallet is created, so every grant/spend can assume the row exists and is lockable. `CHECK(balance >= 0)` is a DB-level floor beneath the app's insufficient-funds check (requires MySQL 8.0.16+).
- **`ledger`** is append-only and carries **two** structural guarantees via MySQL's "UNIQUE allows many NULLs" behaviour:
  - `UNIQUE(payment_id)` → **exactly-once grant per payment** (purchase rows).
  - `UNIQUE(campaign_id)` → **fund-a-campaign-at-most-once** (funding rows).
  - Purchase rows have `campaign_id = NULL`; funding rows have `payment_id = NULL`; the many-NULLs rule lets both coexist.
  - `CHECK(chk_ledger_reference_exclusive)` → **exactly one reference is populated, and `reason` agrees with which one**. The two unique indexes hold independently of this, so no correctness guarantee ever depended on it — what it protects is _coherence_. Before it existed a row with both references `NULL`, both set, or a `reason` contradicting the populated column would insert without complaint (confirmed during schema validation). Since the ledger is append-only and is the source of truth for every balance, an incoherent row would be permanent.
  - Adding that check required **rewriting the two foreign keys without referential actions**, because MySQL rejects a `CHECK` over any column carrying `ON DELETE`/`ON UPDATE` clauses (`ERROR 3823`). Nothing was given up, and this was verified rather than assumed: `ON DELETE RESTRICT` is InnoDB's default and still rejects deletion of a referenced payment — asserted by a test that exists specifically to catch it if that ever stops being true — while `ON UPDATE CASCADE` could never fire against `AUTO_INCREMENT` primary keys that are never updated. The FKs gained explicit names (`fk_ledger_payment`, `fk_ledger_campaign`) in the same migration, so a violation names the relationship rather than a position.
  - **Why two nullable FK columns rather than a polymorphic `reference_type`/`reference_id`.** This shape is the _exclusive arc_, whose known weakness is that every new reference type needs another column. It is chosen here for two reasons. First, the set of spending modules is **closed** — three, defined by the platform and seeded, never created at runtime — and an exclusive arc is a reasonable fit for a small closed set, a poor one for an open set. Second, on a financial record a real foreign key is worth more than avoiding a migration. To be precise about the trade-off rather than overstate it: a polymorphic pair with `UNIQUE(reference_type, reference_id)` **would** preserve at-most-once perfectly well — that is not what it costs. What it cannot preserve is the foreign key, and a ledger row referencing a campaign that no longer exists is a corrupt money record that no query would flag. The migration cost also lands in the right place: adding Reports spending means writing a migration for the `reports` table regardless, and one more nullable column on `ledger` inside that same migration is marginal work done by the person with the most context. The honest notes record the trigger that would reverse this decision, and the migration path.
- **`payments`** is inserted (`status='pending'`) **before the Stripe Checkout Session is created**, and therefore before any webhook — so the grant is a one-way `pending → paid` transition on a row guaranteed to exist. The **idempotency identity is `payments.id`** (enforced downstream by `UNIQUE(ledger.payment_id)`), carried on the session as `metadata.payment_id`. Both Stripe id columns are **nullable-unique** and backfilled: `stripe_session_id` immediately after session creation, `stripe_payment_intent_id` from the webhook, the latter for reconciliation and future refund/dispute events (which key on `pi_`/`ch_`, not `cs_`). They are unique so a given Stripe object can never attach to two payment rows, and nullable because the row legitimately predates both ids. Stripe's id chain is **denormalized here** — no separate PI/charge tables — because within this scope the relationship is 1:1 and terminal.
- **`payments.plan_id` + `payments.purchase_kind`** separate _provenance_ from _what was charged_. `purchase_kind` discriminates `plan` from `quantity`; `plan_id` is a nullable FK, populated for `plan` buys and `NULL` for per-credit `quantity` buys (which have no bundle behind them). Crucially `plan_id` is **not a pricing input** — `amount_paise` and `credits` are computed at session-creation time and **frozen** onto the payment row. So if a plan's price is later edited in config, the historical purchase still reads back at the price actually charged, while the FK still says which config row priced it. Config is mutable; the ledger must not be. Keeping both is what makes "every credit traces to a real payment, and every payment to the exact bundle and amount that produced it" true rather than merely claimed. The pairing invariant (`plan` ⇒ `plan_id` present, `quantity` ⇒ `plan_id` NULL) is enforced in the service layer, not as a `CHECK` — expressible either way, but past the point of useful return at this scope.
- **`campaigns.status`** `draft → funded` transition, taken under a row lock, is the readable fund-at-most-once layer; `UNIQUE(ledger.campaign_id)` is the structural backstop beneath it. `campaigns.name` is a display field only — nothing in the funding path reads it.
- **Naming.** `modules.code` / `currencies.code` are named `code`, not `key`: `KEY` is structurally reserved in MySQL (it is the keyword for index declarations — `PRIMARY KEY`, `ADD KEY`, `UNIQUE KEY`), so the parser is especially aggressive about it. Sequelize backticks generated queries, but the failure leaks exactly where it hurts most — an ad-hoc `SELECT … WHERE key = …` in a live `mysql>` session. Every model also pins `tableName` explicitly rather than relying on Sequelize's automatic pluralization, so the migration, the model, and hand-typed SQL always agree on one name. `ledger` is deliberately **singular**: it is one conceptual object — _the_ ledger, the source of truth — not a bag of entries.

---

## Where idempotency & transactions live

**Idempotency** is enforced by database constraints, not application checks:

| Guarantee                         | Enforced by                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| Grant exactly once per payment    | `UNIQUE(ledger.payment_id)` + `payments.status` monotonic `pending→paid`   |
| Fund a campaign at most once      | `UNIQUE(ledger.campaign_id)` + `campaigns.status` monotonic `draft→funded` |
| One payment per Checkout session  | `UNIQUE(payments.stripe_session_id)`                                       |
| At most one row per PaymentIntent | `UNIQUE(payments.stripe_payment_intent_id)` (nullable)                     |
| One payment per purchase intent   | `UNIQUE(payments.user_id, idempotency_key)` (nullable)                     |

**Idempotent checkout-session creation.** A retried POST without a key creates a second `payments` row *and* a second live Stripe session. No credits can be fabricated — the grant is keyed on `payments.id` — but both sessions are payable, so one intent can produce two charges. A client-supplied `Idempotency-Key` header (the same mechanism Stripe's own API uses) makes the retry return the original session, flagged with `Idempotent-Replayed: true`.

Three decisions in that are worth stating:

- **Scoped per user, not globally.** `UNIQUE(user_id, idempotency_key)`, and every lookup filters on `user_id` too. A global key space would be a security defect: one caller could claim a value another later sends, and be answered with the first caller's payment and checkout URL.
- **The checkout URL is stored, not re-fetched.** The replay path exists to absorb failures, and the likeliest reason a client is retrying is that Stripe was slow — so serving the replay *from* Stripe would reintroduce the dependency it exists to survive.
- **A key reused with different parameters is rejected**, not silently replayed. Returning the original would charge for something the caller did not just ask for. That is almost always a client bug (one key generated and reused forever), and it should be loud.

The application-level `if (status === 'pending')` guard is kept as a **fast-path optimization** (early-exit on the common duplicate), but it is explicitly _not_ the safety net — the unique index is. When a duplicate insert raises a duplicate-key error, the handler treats it as **idempotent success** and returns `2xx` so Stripe stops retrying; only genuinely transient failures return `5xx` to invite redelivery.

**Two transaction boundaries:**

1. **Grant** (webhook handler): payment-row lock → ledger insert (`+credits`) → balance increment → status flip → commit.
2. **Fund** (campaign funding): campaign-row lock → currency resolution → balance-row lock → insufficient check → ledger insert (`−credits`) → balance decrement → status flip → commit.

**Lock ordering is fixed** (campaign row locked before balance row in the fund flow) to keep a consistent acquisition order and avoid deadlocks.

---

## Flow walkthroughs

### Buy credits

1. Authenticated user chooses currency + (plan | quantity). **Server computes `amount_paise`** from seeded config — the client-supplied amount is never trusted.
2. **Ordering rule: the local record precedes the money-moving object, always.** The `payments` row is inserted **first** (`status='pending'`, no `cs_` yet). Only then is the Stripe Checkout Session created, with **`metadata.payment_id` stamped onto it**. The returned `cs_` is backfilled onto the row. Frontend redirects to Stripe.
3. On payment, Stripe sends webhooks. The handler **verifies the `Stripe-Signature` on the raw request body first** (forged/unsigned → `400`, DB never touched).
4. The handler resolves the `payments` row in **two tiers**: by `stripe_session_id` (normal path), and on miss by `metadata.payment_id` carried on the event — backfilling the missing `cs_`/`pi_` onto the row inside the same grant transaction.
5. Grant fires **only** on `checkout.session.completed` with `payment_status === 'paid'`, inside transaction boundary #1.

**Why this order.** Stripe is the authority on _money_; this database is the authority on _grants_. The one failure that cannot be tolerated is money taken with no local record to hang the grant on — because the idempotency contract below (`200` on a genuinely unknown payment, so Stripe stops retrying) would then convert it into **permanent silent loss**: a charged user, no credits, and a webhook that cheerfully swallows the evidence. Creating the session before the row is disqualified not because the insert is _likely_ to fail, but because its failure is the worst outcome in the system. Under insert-first, every failure lands on the harmless side:

| Failure point                                          | Outcome                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Insert fails                                           | No Stripe call was made. Nothing charged. Request errors to the user. Clean.                    |
| Session creation fails (after insert)                  | Orphan `pending` row that never transitions. Harmless — a pending intent that expires in place. |
| `cs_` backfill fails (session exists, row not updated) | Caught by the tier-2 metadata lookup, which heals the row during the grant.                     |

**`metadata.payment_id` is the durable anchor; `stripe_session_id` is a convenience index.** The metadata is written atomically with the session's _existence_ and cannot drift from it; the `cs_` column is a post-hoc backfill that can fail or lag. Treating the metadata as the real join key — and the `cs_` column as an optimization that gets healed on miss — is what closes the gap. The same tier-2 path also covers the **reverse race** on the happy path: a fast Stripe webhook arriving before a slow backfill commits. One mechanism, both problems.

**Failure points & defences**

- _Duplicate delivery / multi-event fan-out / out-of-order arrival_ → all resolve to the same `payments` row (by `cs_`, or by `metadata.payment_id`) → the `pending→paid` transition and `UNIQUE(ledger.payment_id)` make every extra delivery a harmless no-op. The unique index does not care which lookup tier found the row, so the grant stays exactly-once either way. The same lock-first dynamic as the funding path applies here: the `payments` row is locked `FOR UPDATE`, so concurrent deliveries serialize on it and the losers usually exit on the `status === 'paid'` fast path rather than on the index. `UNIQUE(ledger.payment_id)` is what makes that safe rather than merely likely — it is the guarantee, the status check is the optimization. Order-independent by construction: the `payments` row is inserted before the session exists, so no event can ever arrive early enough to find "no row".
- _Async payment methods_ (`payment_status: 'unpaid'` on `completed`) → fail the `paid` guard, grant nothing; funds-cleared later arrives as `checkout.session.async_payment_succeeded` (also `paid`) and grants through the _same_ payment-keyed transition. **Not exercised in this build (card only)** but the guard makes premature grants impossible regardless — see honest notes.
- _Forged webhook_ → signature check rejects before the DB.
- _Credit without payment_ → impossible: the grant is gated on a verified, `paid` webhook, never on the browser redirect.

### Fund a campaign

1. Authenticated user funds their `draft` campaign with an amount of Campaign Credits.
2. Transaction boundary #2: lock campaign row → resolve `campaign.module → bound currency` → lock the single `balances` row for `(wallet, that currency)` `FOR UPDATE` → check `balance >= amount` → insert ledger `−amount` → decrement balance → flip `draft→funded` → commit.

**Failure points & defences**

- _Wrong-currency spend_ → the currency is _resolved from the module binding_, not supplied by the caller; a request naming Report/Discovery credits cannot fund a campaign.
- _Insufficient balance_ → checked under the row lock; rejected with ledger and balance untouched.
- _Concurrent spends_ → serialized on the single `balances` row lock; the second request reads the already-decremented balance and rejects if now insufficient. `CHECK(balance >= 0)` is the final floor.
- _Double-fund (same campaign, concurrent)_ → the second request blocks on the campaign row lock. When it acquires the lock its **locking read returns the latest committed row, not its transaction snapshot** — InnoDB's `SELECT … FOR UPDATE` deliberately bypasses REPEATABLE READ's snapshot — so it sees `funded` and the status check rejects it. That is the mechanism that actually fires. `UNIQUE(ledger.campaign_id)` sits beneath it as the backstop: it is what would still make a second funding row impossible if the lock were removed or the status check were wrong. Because both paths return the same `409`, the concurrency tests cannot distinguish them, so the constraint is covered by a separate test that constructs the state the status check cannot see — an existing funding row while the campaign is still `draft`.

---

## Acceptance criteria → mechanism

| Criterion                                               | Mechanism                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Per currency, balance = Σ ledger                        | `balances` updated in the _same transaction_ as every ledger insert; asserted by test             |
| Granted exactly once per payment, never without payment | `pending→paid` + `UNIQUE(ledger.payment_id)`; grant gated on `completed && payment_status='paid'` |
| Each currency spent only in its module                  | `currencies.module_id` (1:1) resolved from `campaigns.module_id`; mismatch rejected               |
| Balance never negative                                  | `SELECT … FOR UPDATE` + insufficient check + `CHECK(balance >= 0)`                                |
| Campaign funded at most once                            | campaign `draft→funded` under lock + `UNIQUE(ledger.campaign_id)`                                 |
| Concurrent spends cannot over-spend                     | serialized on the single `balances` row lock                                                      |
| Wallet/campaign endpoints need login                    | JWT auth middleware                                                                               |

---

## Key decisions (and when I'd revisit each)

- **Grant on `checkout.session.completed` (session-level), not `payment_intent.succeeded`.** The session object carries the business metadata and the `cs_` exists synchronously at creation, so the `payments` row is trivially keyed and always findable. _Would switch to `payment_intent.succeeded` if delayed methods / manual capture became first-class,_ carrying the payment reference via `payment_intent_data.metadata`.
- **Materialized balance row, not purely ledger-derived `SUM()`.** A spend needs a single row to lock; deriving the balance would force inventing a lock row anyway (reinventing this table) plus aggregate reads. _Purely-derived would be fine if there were no concurrent spend requirement._
- **Stripe ids denormalized onto `payments`, not a normalized PI/charge sub-tree.** The grant is one-shot and terminal, so charge/refund lifecycle tables would be over-modeling. _Would normalize the moment refunds/disputes/retries need first-class ongoing state._

---

## Honest notes — improvements & not-done

Everything the acceptance criteria ask for is built and tested. What follows is what I would fix
first, and what I decided not to build.

### Security gaps I would close before this went near production

- **No rate limiting anywhere.** This is the a gap. `/api/auth/login` and `/api/auth/signup`
  are unthrottled, so brute-forcing a password or enumerating accounts costs an attacker nothing but
  time. Per-IP and per-account throttling is the _primary_ control here; the timing-equalisation
  below is a secondary hardening layer and should not be mistaken for the main defence.
- **JWTs are stored in `localStorage`**, which any script on the page can read, so an XSS bug leaks
  the token. An httpOnly cookie would not be readable, at the cost of needing CSRF protection. There
  is also no refresh-token rotation and no revocation list: a stolen token is valid until it expires
  (7 days).

### Deliberate trade-offs

- **A minimum purchase of ₹50 is enforced server-side.** Stripe rejects any charge that converts to
  under ~US$0.50; without this guard, buying 10 Campaign Credits (₹30) surfaced as a `500` from the
  Stripe SDK _after_ a pending payment row had already been written. Now it is a `400` naming the
  field, raised before Stripe is called.

- **Async payment methods not implemented** — card (synchronous) only. The `payment_status === 'paid'` guard already prevents premature grants; the async path (`async_payment_succeeded` / `async_payment_failed`) would slot into the same payment-keyed transition but is out of scope as no delayed method is enabled.
- **Orphan `pending` payments are left in place — deliberately, not by omission.** A `payments` row is inserted before the Checkout Session exists, so any session the user abandons (or that fails to create after the insert) leaves a `pending` row that never reaches a terminal state. This is harmless to correctness — no balance, ledger entry, or grant depends on it, and it can never become `paid` without a verified webhook — but the rows accumulate. The production follow-up is a periodic sweeper that reconciles `pending` rows against Stripe and expires them past the Checkout Session TTL (24h), moving them to `expired`. Not built here: it is operational hygiene rather than a correctness guarantee, and the `expired` status already exists in the enum to receive it.
- Refunds, disputes, and credit expiry are out of scope. `payment_intent_data.metadata` already
  carries `payment_id` onto the PaymentIntent, so refund and dispute events — which key on `pi_`
  rather than `cs_` — could find their payment without a schema change. Reversing a grant would need
  a compensating negative ledger row, never a deletion, since the ledger is append-only.

### Cut for time, in the order I would add them

1. **Rate limiting** on the auth endpoints — the gap above, and the cheapest to close.
2. **A sweeper for orphan `pending` payments**, reconciling against Stripe and expiring them past the
   24h Checkout TTL. The `expired` enum value exists to receive them.
3. **Structured logging and metrics.** Logging is `console` with a `[webhook] <evt_id> <type> ->
<outcome>` line per delivery, which was enough to diagnose a real delivery failure during the
   build but is not something you could alert on. Grant latency and duplicate-delivery rate are the
   two I would export first.
4. **Expiring idempotency keys.** Keys live on the payment row forever, so a client that reused one
   a year later would be answered with the ancient payment. Stripe expires keys after 24h; the same
   would want a `created_at` window on the lookup plus a sweeper. Not built, and low risk while keys
   are UUIDs generated per intent.

### What I would revisit about the model itself

**The ledger's reference columns are an exclusive arc, and that is a bounded decision rather than an
oversight.** `payment_id` and `campaign_id` are separate nullable foreign keys, so adding a second
spending module requires a migration: another nullable column, another unique index, another `reason`
enum value. That is acceptable only while modules are a **closed, product-defined set** — currently
three, all seeded. The reasoning is in the table notes above; the short version is that a polymorphic
pair would avoid the migration and would keep at-most-once, but could not keep a foreign key, and an
unenforceable reference on a money record is the worse failure.

**Revisit if** modules become dynamically created, tenant-defined, or grow beyond roughly five. The
replacement I would reach for is not a magic string but the existing `modules` table as the
discriminator, so the _type_ remains a real foreign key and only the row id is untyped:

```
payment_id       BIGINT NULL UNIQUE  FK → payments
spend_module_id  BIGINT NULL         FK → modules
spend_ref_id     BIGINT NULL
UNIQUE (spend_module_id, spend_ref_id)
```

A new module would then need **no schema change at all**, because it is already a row in `modules`.

**That migration is cheap precisely because the ledger is append-only** — a standard expand/contract,
reversible at every step and with no downtime:

1. add `spend_module_id` and `spend_ref_id` alongside `campaign_id`
2. backfill — `UPDATE ledger SET spend_module_id = <campaigns>, spend_ref_id = campaign_id WHERE campaign_id IS NOT NULL`
3. dual-write for one release
4. add the composite unique, then drop `campaign_id`

Knowing the exit is that clean is what makes it defensible to keep the simpler design now, rather
than building for modules that may never ship.

**"Fund a campaign at most once"** is the brief's requirement (§5.D and §7), not an assumption, and
`UNIQUE(ledger.campaign_id)` enforces it structurally. A real platform would probably want to top up
a running campaign. Relaxing it would mean dropping that unique index, moving idempotency to a
client-supplied key per funding request, and deriving the funded total as a `SUM` over the campaign's
ledger rows rather than reading one row's delta. Notably, **the over-spend protection would not
change at all** — the balance row lock protects the _balance_, not the campaign, and the two
guarantees are independent.
