# Analytics service

Event-driven analytics for the platform: the backend's ledger changes flow through Kafka into
Snowflake, and a Python API serves them — RBAC-checked, Redis-cached, audited — to a Streamlit
dashboard.

```
 backend API ──(same MySQL txn)──▶ outbox_events ──▶ outbox-relay ──▶ Kafka
                                                                       │ platform.{users,payments,campaigns}.v1
                                                                       ▼
                                   Snowflake RAW.PLATFORM_EVENTS ◀── analytics-consumer ──▶ DLQ
                                          │  (MERGE on event_id)           │ bumps cache version
                                          ▼                                ▼
                         CORE views + masking / row access policies      Redis
                                          ▲                                ▲
                       USE ROLE <mapped>  │                                │ read-through
                                          └──────── analytics-api ─────────┘
                                                      ▲   │ access audit ──▶ Kafka ──▶ GOVERNANCE.API_ACCESS_LOG
                                          Bearer JWT  │
                                               Streamlit dashboard
```

| Component | Where | What it does |
| --- | --- | --- |
| Transactional outbox | `backend/src/outbox/` | Writes each domain event in the **same transaction** as the ledger change. |
| Outbox relay | `npm run outbox:relay` (backend) | Publishes unpublished outbox rows to Kafka, at-least-once. |
| Consumer | `analytics-consumer` | Validates events, MERGEs them into Snowflake, dead-letters bad ones, invalidates the cache. |
| API | `analytics-api` (FastAPI, port 8000) | Verifies the backend JWT, enforces RBAC, queries Snowflake as the caller's role, caches in Redis, audits. |
| Dashboard | `dashboard/app.py` (Streamlit, port 8501) | Signs in via the backend and shows only the tabs the role permits. |
| Snowflake | `snowflake/*.sql` | Warehouses, RBAC roles, RAW tables, CORE views, governance policies. |

## Why it's built this way

**Decoupled by an outbox.** The API never talks to Kafka. If Kafka is down, checkouts and
funding still work and analytics fall behind until the relay catches up. Events are written in
the same transaction as the money movement, so an event exists **if and only if** its change
committed. A crash can't leave an event without its change, or a change without its event.

**At-least-once, deduplicated downstream.** The relay can resend after a crash, and the consumer
commits Kafka offsets only after the Snowflake MERGE (keyed on `event_id`) succeeds. Duplicates
are no-ops, and no message is acknowledged until it is either in Snowflake or in the DLQ.

**Governance enforced by the warehouse, not only the app.** Each platform role maps to a
Snowflake functional role, and every API query runs **as that role**. Masking and row access
policies are evaluated by Snowflake. So even an API bug can't return an email to an analyst.
Analysts querying Snowsight directly get the same view the dashboard shows.

**Cache scoped by entitlement.** Cache keys include the caller's role (platform metrics) or user
id (own metrics), so one role's result is never served to another. Invalidation works by a
version counter that the consumer bumps after each load. Redis being down makes requests slower,
not wrong.

## RBAC

Roles come from `users.role` in MySQL and travel in the backend JWT's `role` claim. Every user
starts as `member`. To change a role (it takes effect at the user's next login):

```bash
cd backend && npm run user:set-role -- someone@example.com analyst
```

| Permission | member | analyst | finance | admin |
| --- | :-: | :-: | :-: | :-: |
| `metrics:own:read` — own wallet & campaigns | ✓ | ✓ | ✓ | ✓ |
| `metrics:platform:read` — platform aggregates | | ✓ | ✓ | ✓ |
| `users:read` — top spenders, signups | | ✓ | ✓ | ✓ |
| `revenue:read` — amounts in paise | | | ✓ | ✓ |
| `pii:read` — unmasked emails | | | | ✓ |
| `governance:read` — policy catalogue, access log | | | | ✓ |
| `cache:manage` — invalidate cache | | | | ✓ |
| **Snowflake role** | `ANALYTICS_MEMBER` | `ANALYTICS_ANALYST` | `ANALYTICS_FINANCE` | `ANALYTICS_ADMIN` |

A `member` is pinned to their own rows. The user id is bound into the SQL from the verified
token and is never read from the request.

## Governance policies (Snowflake)

| Policy | Mechanism | File |
| --- | --- | --- |
| PII masking | `PII` tag → `PII_STRING_MASK`. Emails show in clear text only with `PII_READER_AR`, otherwise as a salted SHA-256 pseudonym (joins and distinct counts still work). | `04_governance.sql` |
| Financial masking | `FINANCIAL` tag → `FINANCIAL_NUMBER_MASK`. `amount_paise` is NULL without `FINANCIAL_READER_AR`. | `04_governance.sql` |
| Row access | `MODULE_SCOPE` on every fact view. Roles without `ALL_MODULES_AR` see only the modules listed in `GOVERNANCE.ROLE_MODULE_ACCESS`. | `04_governance.sql` |
| Classification | `DATA_CLASSIFICATION` tag on every table and view, and on each sensitive column. | `04_governance.sql` |
| Least privilege | Separate access roles and functional roles; `MANAGED ACCESS` schemas; the loader can only write RAW; readers never touch RAW. | `01_rbac.sql` |
| Separation of duties | `ANALYTICS_GOVERNOR` owns the policies but holds no data entitlements. | `01_rbac.sql` |
| Retention | Daily task purges `API_ACCESS_LOG` rows older than 400 days. Kafka topics keep 30 days (DLQ: 90). | `04_governance.sql`, `docker/kafka/create-topics.sh` |
| Right to erasure | `CALL GOVERNANCE.ERASE_USER_PII(<user_id>)` redacts the email in RAW and keeps financial facts. Time Travel keeps the old rows for 1 more day (the retention set in `00_bootstrap.sql`), then Snowflake Fail-safe for 7. | `04_governance.sql` |
| Audit | Every API request (allowed, denied or error) goes to `GOVERNANCE.API_ACCESS_LOG`. Its `request_id` is also the Snowflake `QUERY_TAG`, so it joins to `QUERY_HISTORY`. Direct SQL access is in `V_WAREHOUSE_ACCESS_HISTORY`. | `audit.py`, `02_raw.sql` |
| Cost | Resource monitor (suspends at 100% of quota), auto-suspend at 60 s, 120 s statement timeout on `ANALYTICS_WH`. | `00_bootstrap.sql` |

> The API's service user holds every reader role so it can switch roles per request. That is
> only safe because secondary roles are disabled (`DEFAULT_SECONDARY_ROLES = ()` on the user,
> plus `USE SECONDARY ROLES NONE` on every connection). With them enabled,
> `IS_ROLE_IN_SESSION` would see every role, and the masking policies would unmask data for
> everyone.

## Setup

### 1. Snowflake (once per account)

Generate a key pair for the two service users:

```bash
mkdir -p analytics/secrets && cd analytics/secrets
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out snowflake_rsa_key.p8 -nocrypt
openssl rsa -in snowflake_rsa_key.p8 -pubout -out snowflake_rsa_key.pub
```

Then run the scripts in order as `ACCOUNTADMIN` (Snowsight worksheet or `snow sql -f`):

```
snowflake/00_bootstrap.sql   warehouses, database, schemas, resource monitor
snowflake/01_rbac.sql        roles, grants, service users
snowflake/02_raw.sql         RAW.PLATFORM_EVENTS, GOVERNANCE.API_ACCESS_LOG
snowflake/03_core_views.sql  CORE.DIM_USERS, FCT_CREDIT_PURCHASES, FCT_CAMPAIGN_FUNDINGS, FCT_CAMPAIGNS
snowflake/04_governance.sql  tags, masking, row access, retention, erasure, audit views
```

Attach the public key (paste the key body without the header and footer lines):

```sql
ALTER USER ANALYTICS_LOADER_SVC SET RSA_PUBLIC_KEY = 'MIIBIjANBg...';
ALTER USER ANALYTICS_API_SVC    SET RSA_PUBLIC_KEY = 'MIIBIjANBg...';
```

Every script is idempotent, so running it again converges instead of failing.

> **Edition.** `00`–`03` run on any edition. `04_governance.sql` uses tags, masking policies
> and row access policies, which need **Enterprise** edition or higher; on Standard it fails
> with "Unsupported feature". Snowflake trials let you pick the edition at signup.

### 2. Check the connection

```bash
docker compose --profile analytics build analytics-api
docker compose --profile analytics run --rm analytics-api analytics-check
```

It logs in as both service users, the way the services will, and prints `[ok]` or `[FAIL]`
with the likely cause for each step. When all 7 pass, start the stack.

### 3. Run the stack

```bash
cp analytics/.env.example analytics/.env      # set SNOWFLAKE_ACCOUNT and JWT_SECRET
docker compose up -d                          # mysql, backend, frontend, kafka, redis, outbox-relay
docker compose --profile analytics up -d      # + analytics-consumer, analytics-api, analytics-dashboard
```

Dashboard: <http://localhost:8501>. API docs: <http://localhost:8000/docs>.

`JWT_SECRET` must match the backend's value, because the analytics API verifies the backend's
tokens.

### Local development (without Docker for the Python side)

```bash
cd analytics
python3 -m venv .venv && .venv/bin/pip install -e '.[dev,dashboard]'
.venv/bin/pytest                 # no Kafka, Redis or Snowflake needed
.venv/bin/ruff check . && .venv/bin/ruff format --check src tests dashboard
.venv/bin/analytics-api          # needs Redis + Snowflake
.venv/bin/analytics-consumer     # needs Kafka + Redis + Snowflake
.venv/bin/streamlit run dashboard/app.py
```

## API

All endpoints except `/health` need `Authorization: Bearer <backend token>`. Errors use the
backend's shape: `{ "error": { "code", "message" } }`. A 403 response adds `missing`, the list
of permissions the caller lacks. Every response carries an `X-Request-ID` header, the same id
used in the audit log.

Date-ranged endpoints accept `from` / `to` (ISO dates, inclusive, at most 366 days; the default
is the last 30 days). Time series endpoints also accept `grain` = `day` | `week` | `month`.

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /v1/me` | — | Role, Snowflake role and permissions. |
| `GET /v1/metrics/overview?scope=own\|platform` | own / platform | KPIs. Revenue is included only with `revenue:read`. |
| `GET /v1/metrics/credits-flow` | own / platform | Credits purchased vs. spent, by currency. |
| `GET /v1/metrics/campaign-funnel` | own / platform | Created → funded, by module. |
| `GET /v1/metrics/revenue` | `revenue:read` | Revenue in paise by period and currency. |
| `GET /v1/metrics/top-spenders?limit=` | `users:read` | Emails are masked by Snowflake unless the caller is admin. |
| `GET /v1/metrics/signups` | platform | Signups by period and current role. |
| `GET /v1/governance/policies` | `governance:read` | RBAC matrix plus the policies attached in Snowflake. |
| `GET /v1/governance/access-log?limit=` | `governance:read` | Never cached. |
| `POST /v1/admin/cache/invalidate` | `cache:manage` | Bumps the cache version. |

`scope` defaults to `platform` if the caller may read platform metrics, and to `own` otherwise.

## Event contract

Each Kafka message value is an envelope:

```json
{
  "event_id": "uuid", "event_type": "credits.purchased", "schema_version": 1,
  "occurred_at": "2026-10-01T10:00:00.000Z", "producer": "credits-wallet-backend",
  "aggregate_type": "user", "aggregate_id": "42", "payload": { ... }
}
```

| `event_type` | Topic | Emitted by |
| --- | --- | --- |
| `user.registered` | `platform.users.v1` | signup |
| `user.role_changed` | `platform.users.v1` | `npm run user:set-role` |
| `credits.purchased` | `platform.payments.v1` | Stripe webhook grant (only once per payment, even on webhook redelivery) |
| `campaign.created` | `platform.campaigns.v1` | campaign creation |
| `campaign.funded` | `platform.campaigns.v1` | successful funding (a rejected funding emits nothing) |

Payload shapes are defined in `backend/src/outbox/events.ts` and mirrored in
`src/analytics_service/events.py`. Adding an optional field is safe. Any other change means
bumping `schema_version` and teaching the consumer to read both versions first.

## Known limits

- **Role changes take up to the token lifetime to apply.** The role travels in the JWT, so a
  demoted user keeps their old role until the token expires (`JWT_EXPIRES_IN`, 7 days by
  default). Shorten the expiry, or add a revocation check, before relying on demotion.
- **Member row scoping is enforced in the app, not in Snowflake.** Snowflake policies can't
  identify an individual platform user behind the shared service role. Role-level masking and
  module scoping are enforced in Snowflake.
- **CORE objects are views.** If dashboard query cost grows, turn them into dynamic tables with
  the same names. `RAW` has change tracking enabled for that.
- **Strict per-aggregate ordering needs a single relay.** Several relays can run safely, but the
  marts don't depend on event order.
