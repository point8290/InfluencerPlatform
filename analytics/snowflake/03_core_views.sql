-- ============================================================================
-- 03 — CORE: the governed, modelled layer.
--
-- Views, not tables: they are always exactly as fresh as RAW, need no
-- orchestration, and masking/row access policies attach to their columns.
-- If query cost grows, any of these can become a DYNAMIC TABLE with the same
-- name and columns (TARGET_LAG = '5 minutes') without touching a consumer —
-- RAW has CHANGE_TRACKING enabled for exactly that reason.
--
-- Owned by SYSADMIN. Readers need SELECT on the view only, never on RAW.
-- ============================================================================

USE ROLE SYSADMIN;
USE DATABASE INFLUENCER_ANALYTICS;

CREATE OR REPLACE VIEW CORE.DIM_USERS
  COMMENT = 'One row per user with their latest platform role. email is PII (masked by tag).'
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

CREATE OR REPLACE VIEW CORE.FCT_CREDIT_PURCHASES
  COMMENT = 'One row per granted credit purchase. amount_paise is FINANCIAL (masked by tag).'
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

CREATE OR REPLACE VIEW CORE.FCT_CAMPAIGN_FUNDINGS
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

CREATE OR REPLACE VIEW CORE.FCT_CAMPAIGNS
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
LEFT JOIN CORE.FCT_CAMPAIGN_FUNDINGS f ON f.campaign_id = c.campaign_id;

USE ROLE SECURITYADMIN;
GRANT SELECT ON ALL VIEWS IN SCHEMA INFLUENCER_ANALYTICS.CORE TO ROLE CORE_READ_AR;
