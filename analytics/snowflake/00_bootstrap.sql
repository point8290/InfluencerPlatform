-- ============================================================================
-- 00 — Compute, storage and cost guardrails.
--
-- Run as ACCOUNTADMIN once per account. Idempotent: every statement is
-- IF NOT EXISTS / OR REPLACE-safe, so re-running converges rather than fails.
-- ============================================================================

USE ROLE SYSADMIN;

-- Two warehouses so ingestion and dashboards never queue behind each other,
-- and so cost is attributable per workload.
CREATE WAREHOUSE IF NOT EXISTS INGEST_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Kafka -> RAW loads (analytics consumer).';

CREATE WAREHOUSE IF NOT EXISTS ANALYTICS_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  -- A runaway dashboard query is cancelled rather than billed for hours.
  STATEMENT_TIMEOUT_IN_SECONDS = 120
  COMMENT = 'Dashboard and analytics API reads.';

CREATE DATABASE IF NOT EXISTS INFLUENCER_ANALYTICS
  DATA_RETENTION_TIME_IN_DAYS = 7
  COMMENT = 'Influencer platform analytics. Source of record: backend MySQL ledger via Kafka.';

-- MANAGED ACCESS: only the schema owner (and MANAGE GRANTS holders) can grant
-- on objects inside. A table owner cannot quietly share data sideways.
CREATE SCHEMA IF NOT EXISTS INFLUENCER_ANALYTICS.RAW WITH MANAGED ACCESS
  COMMENT = 'Immutable event log, exactly as published. Loader writes; nobody else reads except admins.';
CREATE SCHEMA IF NOT EXISTS INFLUENCER_ANALYTICS.CORE WITH MANAGED ACCESS
  COMMENT = 'Governed, modelled views. The only schema dashboards and analysts read.';
CREATE SCHEMA IF NOT EXISTS INFLUENCER_ANALYTICS.GOVERNANCE WITH MANAGED ACCESS
  COMMENT = 'Tags, masking and row access policies, entitlement maps, audit log.';

USE ROLE ACCOUNTADMIN;

CREATE RESOURCE MONITOR IF NOT EXISTS ANALYTICS_MONITOR
  WITH CREDIT_QUOTA = 100
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS
    ON 75 PERCENT DO NOTIFY
    ON 90 PERCENT DO NOTIFY
    ON 100 PERCENT DO SUSPEND;

ALTER WAREHOUSE INGEST_WH SET RESOURCE_MONITOR = ANALYTICS_MONITOR;
ALTER WAREHOUSE ANALYTICS_WH SET RESOURCE_MONITOR = ANALYTICS_MONITOR;
