-- ============================================================================
-- 04 — Governance. Runs on EVERY edition, Standard included.
--
--   Masking       emails pseudonymised, money hidden, unless the reader holds
--                 the entitlement role (PII_READER_AR / FINANCIAL_READER_AR)
--   Row access    fact rows filtered to the modules a role is entitled to
--   Retention     scheduled purge of the API access log
--   Erasure       a procedure that redacts one user's PII in RAW
--   Audit         query history and a policy catalogue for the dashboard
--
-- HOW, WITHOUT ENTERPRISE FEATURES: the CORE views are SECURE views whose
-- column expressions and WHERE clause test IS_ROLE_IN_SESSION() and
-- CURRENT_ROLE() for the person running the query. Snowflake evaluates those
-- per reader, so the same view returns real emails to an admin and
-- pseudonyms to an analyst. SECURE hides the view body and stops the
-- optimiser from leaking filtered-out rows, which is what makes a view a
-- safe access-control boundary. Readers get SELECT on these views only —
-- never on RAW, never on the salt — so there is no way around them.
--
-- (On Enterprise edition the same rules could move to native masking and row
-- access policies; behaviour for readers would be identical.)
--
-- Run AFTER 03_core_views.sql, and again whenever 03 is re-run.
-- ============================================================================

USE ROLE ACCOUNTADMIN;
-- The retention task is owned by SYSADMIN, so SYSADMIN must be able to run tasks.
GRANT EXECUTE TASK ON ACCOUNT TO ROLE SYSADMIN;
-- For the QUERY_HISTORY audit view below.
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE SYSADMIN;

USE ROLE SYSADMIN;
USE DATABASE INFLUENCER_ANALYTICS;
USE WAREHOUSE ANALYTICS_WH;

-- ── Governance data ─────────────────────────────────────────────────────────
-- Which roles may see which modules. Roles holding ALL_MODULES_AR see every
-- module and need no rows here. Change access by editing rows, not views.
CREATE TABLE IF NOT EXISTS GOVERNANCE.ROLE_MODULE_ACCESS (
  role_name    VARCHAR(255) NOT NULL,
  module_code  VARCHAR(100) NOT NULL,
  granted_by   VARCHAR(255) NOT NULL DEFAULT CURRENT_USER(),
  granted_at   TIMESTAMP_TZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_role_module_access PRIMARY KEY (role_name, module_code)
)
COMMENT = 'Entitlement map: role -> module rows it may see in CORE fact views.';

MERGE INTO GOVERNANCE.ROLE_MODULE_ACCESS t
USING (
  SELECT 'ANALYTICS_ANALYST' AS role_name, column1 AS module_code
  FROM VALUES ('campaigns'), ('reports'), ('discovery')
) s
ON t.role_name = s.role_name AND t.module_code = s.module_code
WHEN NOT MATCHED THEN INSERT (role_name, module_code) VALUES (s.role_name, s.module_code);

-- Secret mixed into email pseudonyms. Without it, anyone with a list of
-- candidate addresses could hash them and match. Granted to nobody: only the
-- views (which run with their owner's rights) can read it.
CREATE TABLE IF NOT EXISTS GOVERNANCE.PSEUDONYM_SALT (salt VARCHAR NOT NULL)
  COMMENT = 'Single-row secret for email pseudonyms. Never grant SELECT on this.';
INSERT INTO GOVERNANCE.PSEUDONYM_SALT (salt)
  SELECT UUID_STRING() || UUID_STRING()
  WHERE NOT EXISTS (SELECT 1 FROM GOVERNANCE.PSEUDONYM_SALT);

-- ── Governed CORE views ─────────────────────────────────────────────────────
-- Masking rules, used identically in every view:
--   email         clear text with PII_READER_AR, else 'user_' + 12 hex chars of
--                 SHA-256(salt || lower(email)) — stable, so joins and distinct
--                 counts still work, but not reversible
--   amount_paise  value with FINANCIAL_READER_AR, else NULL
-- Row rule for fact views:
--   ALL_MODULES_AR in session, or the current role is mapped to the row's
--   module in GOVERNANCE.ROLE_MODULE_ACCESS.

CREATE OR REPLACE SECURE VIEW CORE.DIM_USERS
  COMMENT = 'One row per user. email is PII: pseudonymised unless PII_READER_AR.'
AS
SELECT
  u.user_id,
  CASE
    WHEN u.email IS NULL THEN NULL
    WHEN IS_ROLE_IN_SESSION('PII_READER_AR') THEN u.email
    ELSE 'user_' || LEFT(SHA2(s.salt || LOWER(u.email), 256), 12)
  END AS email,
  u.platform_role,
  u.registered_at
FROM RAW.BASE_DIM_USERS u
CROSS JOIN (SELECT MAX(salt) AS salt FROM GOVERNANCE.PSEUDONYM_SALT) s;

CREATE OR REPLACE SECURE VIEW CORE.FCT_CREDIT_PURCHASES
  COMMENT = 'One row per credit purchase. amount_paise only with FINANCIAL_READER_AR; module-scoped.'
AS
SELECT
  event_id,
  occurred_at,
  payment_id,
  user_id,
  wallet_id,
  currency_code,
  module_code,
  purchase_kind,
  plan_id,
  credits,
  IFF(IS_ROLE_IN_SESSION('FINANCIAL_READER_AR'), amount_paise, NULL) AS amount_paise
FROM RAW.BASE_FCT_CREDIT_PURCHASES
WHERE IS_ROLE_IN_SESSION('ALL_MODULES_AR')
   OR module_code IN (
        SELECT module_code FROM GOVERNANCE.ROLE_MODULE_ACCESS
        WHERE role_name = CURRENT_ROLE()
      );

CREATE OR REPLACE SECURE VIEW CORE.FCT_CAMPAIGN_FUNDINGS
  COMMENT = 'One row per funded campaign. Module-scoped.'
AS
SELECT
  event_id,
  occurred_at,
  campaign_id,
  user_id,
  wallet_id,
  currency_code,
  module_code,
  credits,
  balance_after
FROM RAW.BASE_FCT_CAMPAIGN_FUNDINGS
WHERE IS_ROLE_IN_SESSION('ALL_MODULES_AR')
   OR module_code IN (
        SELECT module_code FROM GOVERNANCE.ROLE_MODULE_ACCESS
        WHERE role_name = CURRENT_ROLE()
      );

CREATE OR REPLACE SECURE VIEW CORE.FCT_CAMPAIGNS
  COMMENT = 'One row per campaign with funding outcome. Module-scoped.'
AS
SELECT
  campaign_id,
  user_id,
  module_code,
  created_at,
  funded_at,
  funded_credits,
  currency_code,
  status
FROM RAW.BASE_FCT_CAMPAIGNS
WHERE IS_ROLE_IN_SESSION('ALL_MODULES_AR')
   OR module_code IN (
        SELECT module_code FROM GOVERNANCE.ROLE_MODULE_ACCESS
        WHERE role_name = CURRENT_ROLE()
      );

-- ── Retention ───────────────────────────────────────────────────────────────
-- The access log is kept 400 days, then purged. RAW events are the financial
-- record and are not purged; PII inside them is handled by ERASE_USER_PII.
CREATE OR REPLACE TASK GOVERNANCE.PURGE_API_ACCESS_LOG
  WAREHOUSE = ANALYTICS_WH
  SCHEDULE = 'USING CRON 15 3 * * * UTC'
  COMMENT = 'Retention: delete API access log rows older than 400 days.'
AS
  DELETE FROM GOVERNANCE.API_ACCESS_LOG
  WHERE occurred_at < DATEADD(day, -400, CURRENT_TIMESTAMP());

ALTER TASK GOVERNANCE.PURGE_API_ACCESS_LOG RESUME;

-- ── Right to erasure ────────────────────────────────────────────────────────
-- Redacts one user's email everywhere it appears in RAW. Financial facts are
-- kept (keyed by user_id, not identity) so totals do not change. Time Travel
-- keeps pre-erasure rows for the database retention (1 day), then Fail-safe
-- for 7 more — state both in any erasure SLA.
CREATE OR REPLACE PROCEDURE GOVERNANCE.ERASE_USER_PII(TARGET_USER_ID NUMBER)
  RETURNS VARCHAR
  LANGUAGE SQL
  EXECUTE AS OWNER
  COMMENT = 'GDPR/DPDP erasure: redact a user''s PII in RAW.PLATFORM_EVENTS.'
AS
$$
BEGIN
  UPDATE RAW.PLATFORM_EVENTS
     SET payload = OBJECT_INSERT(
           payload, 'email', 'erased-' || :TARGET_USER_ID || '@redacted.invalid', TRUE)
   WHERE payload:user_id::NUMBER = :TARGET_USER_ID
     AND payload:email IS NOT NULL;
  RETURN 'redacted ' || SQLROWCOUNT || ' event(s) for user ' || :TARGET_USER_ID;
END;
$$;

-- ── Audit and catalogue views ───────────────────────────────────────────────
-- Every query against this database, from any tool. API queries carry a
-- QUERY_TAG holding the request_id, so they join to GOVERNANCE.API_ACCESS_LOG.
-- (ACCOUNT_USAGE lags by up to ~45 minutes.)
CREATE OR REPLACE VIEW GOVERNANCE.V_QUERY_AUDIT
  COMMENT = 'Who queried INFLUENCER_ANALYTICS, as which role, from ACCOUNT_USAGE.QUERY_HISTORY.'
AS
SELECT
  start_time,
  user_name,
  role_name,
  query_type,
  TRY_PARSE_JSON(query_tag):request_id::VARCHAR AS api_request_id,
  LEFT(query_text, 500)                         AS query_text,
  execution_status,
  query_id
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE database_name = 'INFLUENCER_ANALYTICS';

-- What the dashboard's governance tab lists. On Standard edition the rules
-- live in the view definitions above, so they are catalogued here by hand;
-- keep this in step with them.
CREATE OR REPLACE VIEW GOVERNANCE.V_POLICY_REFERENCES
  COMMENT = 'Catalogue of the governance rules applied in CORE views.'
AS
SELECT * FROM VALUES
  ('EMAIL_PSEUDONYMISATION', 'MASKING',    'INFLUENCER_ANALYTICS.CORE.DIM_USERS',             'EMAIL',        'PII_READER_AR',       'ACTIVE'),
  ('AMOUNT_MASKING',         'MASKING',    'INFLUENCER_ANALYTICS.CORE.FCT_CREDIT_PURCHASES',  'AMOUNT_PAISE', 'FINANCIAL_READER_AR', 'ACTIVE'),
  ('MODULE_SCOPE',           'ROW_ACCESS', 'INFLUENCER_ANALYTICS.CORE.FCT_CREDIT_PURCHASES',  'MODULE_CODE',  'ALL_MODULES_AR',      'ACTIVE'),
  ('MODULE_SCOPE',           'ROW_ACCESS', 'INFLUENCER_ANALYTICS.CORE.FCT_CAMPAIGN_FUNDINGS', 'MODULE_CODE',  'ALL_MODULES_AR',      'ACTIVE'),
  ('MODULE_SCOPE',           'ROW_ACCESS', 'INFLUENCER_ANALYTICS.CORE.FCT_CAMPAIGNS',         'MODULE_CODE',  'ALL_MODULES_AR',      'ACTIVE')
  AS t (policy_name, policy_kind, object_name, ref_column_name, tag_name, policy_status);

USE ROLE SECURITYADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA INFLUENCER_ANALYTICS.CORE       TO ROLE CORE_READ_AR;
GRANT SELECT ON ALL VIEWS IN SCHEMA INFLUENCER_ANALYTICS.GOVERNANCE TO ROLE GOVERNANCE_READ_AR;
-- The governor maintains the entitlement map (but still cannot read data).
GRANT SELECT, INSERT, DELETE ON TABLE INFLUENCER_ANALYTICS.GOVERNANCE.ROLE_MODULE_ACCESS
  TO ROLE ANALYTICS_GOVERNOR;
-- Erasure is an admin action, executed with the owner's (SYSADMIN's) rights.
GRANT USAGE ON PROCEDURE INFLUENCER_ANALYTICS.GOVERNANCE.ERASE_USER_PII(NUMBER)
  TO ROLE ANALYTICS_ADMIN;
