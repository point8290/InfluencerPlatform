-- ============================================================================
-- 04 — Governance policies.
--
--   Classification   tags on every CORE column that carries PII or money
--   Masking          tag-based: tag a column and it is masked, no per-column step
--   Row access       module scoping through an entitlement map
--   Retention        scheduled purge of the access log
--   Erasure          a procedure that redacts one user's PII in RAW
--   Audit            access-history and policy-reference views
--
-- Everything here is owned by ANALYTICS_GOVERNOR, which holds no data
-- entitlements itself. The roles these policies constrain cannot alter them.
-- ============================================================================

USE ROLE SECURITYADMIN;
-- The governor owns the objects below and needs to reference RAW for erasure.
GRANT USAGE ON SCHEMA INFLUENCER_ANALYTICS.RAW TO ROLE ANALYTICS_GOVERNOR;
GRANT SELECT, UPDATE ON TABLE INFLUENCER_ANALYTICS.RAW.PLATFORM_EVENTS TO ROLE ANALYTICS_GOVERNOR;
GRANT SELECT, DELETE ON TABLE INFLUENCER_ANALYTICS.GOVERNANCE.API_ACCESS_LOG TO ROLE ANALYTICS_GOVERNOR;

USE ROLE ANALYTICS_GOVERNOR;
USE DATABASE INFLUENCER_ANALYTICS;
USE SCHEMA GOVERNANCE;
USE WAREHOUSE ANALYTICS_WH;

-- ── Classification tags ─────────────────────────────────────────────────────
CREATE TAG IF NOT EXISTS DATA_CLASSIFICATION
  ALLOWED_VALUES 'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
  COMMENT = 'Sensitivity of a column or table.';

CREATE TAG IF NOT EXISTS PII
  ALLOWED_VALUES 'EMAIL'
  COMMENT = 'Personal data type. Columns with this tag are masked unless PII_READER_AR is in session.';

CREATE TAG IF NOT EXISTS FINANCIAL
  ALLOWED_VALUES 'AMOUNT_PAISE'
  COMMENT = 'Money. Columns with this tag are masked unless FINANCIAL_READER_AR is in session.';

-- ── Masking policies ────────────────────────────────────────────────────────
-- Non-readers get a stable pseudonym rather than NULL: distinct counts and
-- joins across views still work, but the address cannot be recovered.
--
-- The hash is SALTED with a secret only the governor can read. An unsalted
-- SHA-256 of an email is not a pseudonym: anyone holding a list of candidate
-- addresses can hash them and match.
CREATE TABLE IF NOT EXISTS PSEUDONYM_SALT (salt VARCHAR NOT NULL)
  COMMENT = 'Single-row secret for PII_STRING_MASK. Readable by ANALYTICS_GOVERNOR only.';
INSERT INTO PSEUDONYM_SALT (salt)
  SELECT UUID_STRING() || UUID_STRING()
  WHERE NOT EXISTS (SELECT 1 FROM PSEUDONYM_SALT);

CREATE OR REPLACE MASKING POLICY PII_STRING_MASK AS (val VARCHAR) RETURNS VARCHAR ->
  CASE
    WHEN val IS NULL THEN NULL
    WHEN IS_ROLE_IN_SESSION('PII_READER_AR') THEN val
    ELSE 'user_' || LEFT(SHA2((SELECT MAX(salt) FROM GOVERNANCE.PSEUDONYM_SALT) || LOWER(val), 256), 12)
  END
  COMMENT = 'Email: clear text for PII_READER_AR, stable SHA-256 pseudonym otherwise.';

CREATE OR REPLACE MASKING POLICY FINANCIAL_NUMBER_MASK AS (val NUMBER) RETURNS NUMBER ->
  CASE
    WHEN IS_ROLE_IN_SESSION('FINANCIAL_READER_AR') THEN val
    ELSE NULL
  END
  COMMENT = 'Money: visible to FINANCIAL_READER_AR only.';

-- Tag-based: every column carrying the tag is masked by the matching policy,
-- including columns added later. Classification IS enforcement.
ALTER TAG PII       SET MASKING POLICY PII_STRING_MASK;
ALTER TAG FINANCIAL SET MASKING POLICY FINANCIAL_NUMBER_MASK;

-- ── Apply classification ────────────────────────────────────────────────────
ALTER TABLE RAW.PLATFORM_EVENTS SET TAG DATA_CLASSIFICATION = 'RESTRICTED';
ALTER TABLE GOVERNANCE.API_ACCESS_LOG SET TAG DATA_CLASSIFICATION = 'CONFIDENTIAL';

ALTER VIEW CORE.DIM_USERS MODIFY COLUMN email
  SET TAG PII = 'EMAIL', DATA_CLASSIFICATION = 'RESTRICTED';
ALTER VIEW CORE.FCT_CREDIT_PURCHASES MODIFY COLUMN amount_paise
  SET TAG FINANCIAL = 'AMOUNT_PAISE', DATA_CLASSIFICATION = 'CONFIDENTIAL';

ALTER VIEW CORE.DIM_USERS            SET TAG DATA_CLASSIFICATION = 'CONFIDENTIAL';
ALTER VIEW CORE.FCT_CREDIT_PURCHASES SET TAG DATA_CLASSIFICATION = 'CONFIDENTIAL';
ALTER VIEW CORE.FCT_CAMPAIGN_FUNDINGS SET TAG DATA_CLASSIFICATION = 'INTERNAL';
ALTER VIEW CORE.FCT_CAMPAIGNS        SET TAG DATA_CLASSIFICATION = 'INTERNAL';

-- ── Row access: module scoping ──────────────────────────────────────────────
-- Roles with ALL_MODULES_AR see every row. Any other role sees only modules it
-- is mapped to here — e.g. a reports-only analyst team gets its own role with
-- a single row, and no new policy.
CREATE TABLE IF NOT EXISTS ROLE_MODULE_ACCESS (
  role_name    VARCHAR(255) NOT NULL,
  module_code  VARCHAR(100) NOT NULL,
  granted_by   VARCHAR(255) NOT NULL DEFAULT CURRENT_USER(),
  granted_at   TIMESTAMP_TZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_role_module_access PRIMARY KEY (role_name, module_code)
)
COMMENT = 'Entitlement map for MODULE_SCOPE. Change rows, not the policy.';

MERGE INTO ROLE_MODULE_ACCESS t
USING (
  SELECT 'ANALYTICS_ANALYST' AS role_name, column1 AS module_code
  FROM VALUES ('campaigns'), ('reports'), ('discovery')
) s
ON t.role_name = s.role_name AND t.module_code = s.module_code
WHEN NOT MATCHED THEN INSERT (role_name, module_code) VALUES (s.role_name, s.module_code);

CREATE OR REPLACE ROW ACCESS POLICY MODULE_SCOPE AS (row_module_code VARCHAR) RETURNS BOOLEAN ->
  IS_ROLE_IN_SESSION('ALL_MODULES_AR')
  OR EXISTS (
    SELECT 1
    FROM GOVERNANCE.ROLE_MODULE_ACCESS m
    WHERE m.module_code = row_module_code
      AND IS_ROLE_IN_SESSION(m.role_name)
  )
  COMMENT = 'Rows visible only for modules the session is entitled to.';

ALTER VIEW CORE.FCT_CREDIT_PURCHASES  ADD ROW ACCESS POLICY MODULE_SCOPE ON (module_code);
ALTER VIEW CORE.FCT_CAMPAIGN_FUNDINGS ADD ROW ACCESS POLICY MODULE_SCOPE ON (module_code);
ALTER VIEW CORE.FCT_CAMPAIGNS         ADD ROW ACCESS POLICY MODULE_SCOPE ON (module_code);

-- ── Retention ───────────────────────────────────────────────────────────────
-- The access log is kept 400 days (a year plus a quarter of overlap for
-- annual reviews), then purged. RAW events are the financial record and are
-- not purged here; PII inside them is handled by ERASE_USER_PII.
CREATE OR REPLACE TASK PURGE_API_ACCESS_LOG
  WAREHOUSE = ANALYTICS_WH
  SCHEDULE = 'USING CRON 15 3 * * * UTC'
  COMMENT = 'Retention: delete API access log rows older than 400 days.'
AS
  DELETE FROM GOVERNANCE.API_ACCESS_LOG
  WHERE occurred_at < DATEADD(day, -400, CURRENT_TIMESTAMP());

ALTER TASK PURGE_API_ACCESS_LOG RESUME;

-- ── Right to erasure ────────────────────────────────────────────────────────
-- Redacts one user's email everywhere it appears in RAW. Financial facts are
-- kept (they are keyed by user_id, not identity) so totals do not change.
-- Time Travel still holds the pre-erasure rows for RAW's retention period
-- (30 days) — state that in any erasure SLA.
CREATE OR REPLACE PROCEDURE ERASE_USER_PII(TARGET_USER_ID NUMBER)
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

-- ── Audit views ─────────────────────────────────────────────────────────────
-- Direct-SQL access to anything in this database (Snowsight, notebooks, BI).
-- ACCOUNT_USAGE has up to ~3h latency; API access is in API_ACCESS_LOG.
CREATE OR REPLACE VIEW V_WAREHOUSE_ACCESS_HISTORY
  COMMENT = 'Who read which governed object, from ACCOUNT_USAGE.ACCESS_HISTORY.'
AS
SELECT
  ah.query_start_time,
  ah.user_name,
  obj.value:objectName::VARCHAR  AS object_name,
  obj.value:objectDomain::VARCHAR AS object_domain,
  ah.query_id
FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah,
     LATERAL FLATTEN(input => ah.base_objects_accessed) obj
WHERE obj.value:objectName::VARCHAR ILIKE 'INFLUENCER_ANALYTICS.%';

CREATE OR REPLACE VIEW V_POLICY_REFERENCES
  COMMENT = 'Every masking / row access policy attached within INFLUENCER_ANALYTICS.'
AS
SELECT
  policy_name,
  policy_kind,
  ref_database_name || '.' || ref_schema_name || '.' || ref_entity_name AS object_name,
  ref_column_name,
  tag_name,
  policy_status
FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
WHERE ref_database_name = 'INFLUENCER_ANALYTICS';

CREATE OR REPLACE VIEW V_TAGGED_COLUMNS
  COMMENT = 'Classification inventory: every tagged object and column.'
AS
SELECT
  tag_name,
  tag_value,
  object_database || '.' || object_schema || '.' || object_name AS object_name,
  column_name,
  domain
FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
WHERE object_database = 'INFLUENCER_ANALYTICS' AND object_deleted IS NULL;

USE ROLE SECURITYADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA INFLUENCER_ANALYTICS.GOVERNANCE TO ROLE GOVERNANCE_READ_AR;
-- Erasure is an admin action, executed with the governor's (owner's) rights.
GRANT USAGE ON PROCEDURE INFLUENCER_ANALYTICS.GOVERNANCE.ERASE_USER_PII(NUMBER) TO ROLE ANALYTICS_ADMIN;
