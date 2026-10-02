-- ============================================================================
-- 03 — Base models: RAW events reshaped into readable views.
--
-- These live in RAW, which only the loader and admins can read, because they
-- are UNMASKED: real emails, real money. Nobody queries them directly.
-- 04_governance.sql builds the CORE views on top of them, adding masking and
-- row filtering; CORE is the only schema dashboards and analysts read.
--
-- ALWAYS RUN 04 AFTER THIS FILE. This script drops the CORE views so that
-- nothing can ever read an ungoverned version: between 03 and 04, CORE is
-- empty and the API fails closed instead of leaking.
--
-- Views, not tables: always as fresh as RAW, no orchestration. RAW has
-- CHANGE_TRACKING on, so any of these can later become a dynamic table.
-- ============================================================================

USE ROLE SYSADMIN;
USE DATABASE INFLUENCER_ANALYTICS;

-- Fail closed: remove any CORE view an earlier version of this script created
-- without governance. 04_governance.sql recreates them.
DROP VIEW IF EXISTS CORE.FCT_CAMPAIGNS;
DROP VIEW IF EXISTS CORE.FCT_CAMPAIGN_FUNDINGS;
DROP VIEW IF EXISTS CORE.FCT_CREDIT_PURCHASES;
DROP VIEW IF EXISTS CORE.DIM_USERS;

CREATE OR REPLACE VIEW RAW.BASE_DIM_USERS
  COMMENT = 'UNMASKED. One row per user with their latest platform role.'
AS
WITH registered AS (
  SELECT
    payload:user_id::NUMBER   AS user_id,
    payload:email::VARCHAR    AS email,
    payload:role::VARCHAR     AS initial_role,
    occurred_at               AS registered_at
  FROM RAW.PLATFORM_EVENTS
  WHERE event_type = 'user.registered'
),
latest_role AS (
  SELECT
    payload:user_id::NUMBER   AS user_id,
    payload:role::VARCHAR     AS platform_role
  FROM RAW.PLATFORM_EVENTS
  WHERE event_type IN ('user.registered', 'user.role_changed')
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY payload:user_id::NUMBER
    ORDER BY occurred_at DESC, kafka_offset DESC
  ) = 1
)
SELECT
  r.user_id,
  r.email,
  COALESCE(l.platform_role, r.initial_role) AS platform_role,
  r.registered_at
FROM registered r
LEFT JOIN latest_role l ON l.user_id = r.user_id;

CREATE OR REPLACE VIEW RAW.BASE_FCT_CREDIT_PURCHASES
  COMMENT = 'UNMASKED. One row per granted credit purchase.'
AS
SELECT
  event_id,
  occurred_at,
  payload:payment_id::NUMBER       AS payment_id,
  payload:user_id::NUMBER          AS user_id,
  payload:wallet_id::NUMBER        AS wallet_id,
  payload:currency_code::VARCHAR   AS currency_code,
  payload:module_code::VARCHAR     AS module_code,
  payload:purchase_kind::VARCHAR   AS purchase_kind,
  payload:plan_id::NUMBER          AS plan_id,
  payload:credits::NUMBER          AS credits,
  payload:amount_paise::NUMBER     AS amount_paise
FROM RAW.PLATFORM_EVENTS
WHERE event_type = 'credits.purchased';

CREATE OR REPLACE VIEW RAW.BASE_FCT_CAMPAIGN_FUNDINGS
  COMMENT = 'One row per funded campaign: the credit spend.'
AS
SELECT
  event_id,
  occurred_at,
  payload:campaign_id::NUMBER      AS campaign_id,
  payload:user_id::NUMBER          AS user_id,
  payload:wallet_id::NUMBER        AS wallet_id,
  payload:currency_code::VARCHAR   AS currency_code,
  payload:module_code::VARCHAR     AS module_code,
  payload:credits::NUMBER          AS credits,
  payload:balance_after::NUMBER    AS balance_after
FROM RAW.PLATFORM_EVENTS
WHERE event_type = 'campaign.funded';

CREATE OR REPLACE VIEW RAW.BASE_FCT_CAMPAIGNS
  COMMENT = 'One row per campaign with its funding outcome, for funnel analysis.'
AS
WITH created AS (
  SELECT
    payload:campaign_id::NUMBER    AS campaign_id,
    payload:user_id::NUMBER        AS user_id,
    payload:module_code::VARCHAR   AS module_code,
    occurred_at                    AS created_at
  FROM RAW.PLATFORM_EVENTS
  WHERE event_type = 'campaign.created'
)
SELECT
  c.campaign_id,
  c.user_id,
  c.module_code,
  c.created_at,
  f.occurred_at                                   AS funded_at,
  f.credits                                       AS funded_credits,
  f.currency_code,
  IFF(f.campaign_id IS NULL, 'draft', 'funded')   AS status
FROM created c
LEFT JOIN RAW.BASE_FCT_CAMPAIGN_FUNDINGS f ON f.campaign_id = c.campaign_id;

USE ROLE SECURITYADMIN;
-- Admins may inspect the unmasked models; nobody else is granted them.
GRANT SELECT ON ALL VIEWS IN SCHEMA INFLUENCER_ANALYTICS.RAW TO ROLE RAW_READ_AR;
