-- ============================================================================
-- 02 — RAW landing tables. Owned by SYSADMIN; written only by the loader.
--
-- RAW is an append-only log of every event exactly as published. event_id is
-- the dedupe key: the relay delivers at-least-once and the loader MERGEs on it,
-- so a redelivered event is a no-op rather than a double-counted purchase.
-- ============================================================================

USE ROLE SYSADMIN;
USE DATABASE INFLUENCER_ANALYTICS;

CREATE TABLE IF NOT EXISTS RAW.PLATFORM_EVENTS (
  event_id         VARCHAR(36)   NOT NULL,
  event_type       VARCHAR(100)  NOT NULL,
  schema_version   NUMBER(4,0)   NOT NULL,
  occurred_at      TIMESTAMP_TZ  NOT NULL,
  producer         VARCHAR(100)  NOT NULL,
  aggregate_type   VARCHAR(50)   NOT NULL,
  aggregate_id     VARCHAR(64)   NOT NULL,
  payload          VARIANT       NOT NULL,
  kafka_topic      VARCHAR(255)  NOT NULL,
  kafka_partition  NUMBER(10,0)  NOT NULL,
  kafka_offset     NUMBER(38,0)  NOT NULL,
  ingested_at      TIMESTAMP_TZ  NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_platform_events PRIMARY KEY (event_id)  -- informational; MERGE enforces it
)
CLUSTER BY (TO_DATE(occurred_at), event_type)
CHANGE_TRACKING = TRUE
COMMENT = 'Domain events from the backend transactional outbox. Contains PII (payload:email).';

CREATE TABLE IF NOT EXISTS GOVERNANCE.API_ACCESS_LOG (
  request_id       VARCHAR(64)   NOT NULL,
  occurred_at      TIMESTAMP_TZ  NOT NULL,
  user_id          NUMBER(20,0)  NOT NULL,
  platform_role    VARCHAR(20)   NOT NULL,
  snowflake_role   VARCHAR(255)  NOT NULL,
  resource         VARCHAR(255)  NOT NULL,
  params           VARIANT,
  outcome          VARCHAR(20)   NOT NULL,
  cache_hit        BOOLEAN,
  row_count        NUMBER(10,0),
  duration_ms      NUMBER(10,0),
  ingested_at      TIMESTAMP_TZ  NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_api_access_log PRIMARY KEY (request_id)
)
COMMENT = 'Every analytics API request, allowed or denied. Loaded from the audit Kafka topic.';

USE ROLE SECURITYADMIN;
-- Future grants in 01 cover new tables; these cover tables that already exist
-- when the script is re-run.
GRANT SELECT, INSERT ON TABLE INFLUENCER_ANALYTICS.RAW.PLATFORM_EVENTS TO ROLE RAW_WRITE_AR;
GRANT SELECT         ON TABLE INFLUENCER_ANALYTICS.RAW.PLATFORM_EVENTS TO ROLE RAW_READ_AR;
GRANT SELECT, INSERT ON TABLE INFLUENCER_ANALYTICS.GOVERNANCE.API_ACCESS_LOG TO ROLE RAW_WRITE_AR;
GRANT SELECT         ON TABLE INFLUENCER_ANALYTICS.GOVERNANCE.API_ACCESS_LOG TO ROLE GOVERNANCE_READ_AR;
