import { env } from '../config/env';
import type { UserRole } from '../models';

/**
 * The domain events the platform publishes, and the Kafka topic each lands on.
 *
 * These payloads are a PUBLIC CONTRACT: the analytics service (analytics/)
 * parses them with matching pydantic models, and Snowflake views read their
 * fields by name. Adding an optional field is safe. Renaming or removing one,
 * or changing a type, is a breaking change — bump SCHEMA_VERSION and teach the
 * consumer both shapes before deploying the producer.
 *
 * Money is integer paise and credits are integer counts, exactly as stored.
 * Nothing is converted to floating point on the way out.
 */
export const SCHEMA_VERSION = 1;

export const TOPICS = {
  users: `${env.kafka.topicPrefix}.users.v1`,
  payments: `${env.kafka.topicPrefix}.payments.v1`,
  campaigns: `${env.kafka.topicPrefix}.campaigns.v1`,
} as const;

export interface UserRegisteredPayload {
  user_id: number;
  email: string;
  role: UserRole;
}

export interface UserRoleChangedPayload {
  user_id: number;
  previous_role: UserRole;
  role: UserRole;
}

export interface CreditsPurchasedPayload {
  payment_id: number;
  user_id: number;
  wallet_id: number;
  currency_code: string;
  module_code: string;
  purchase_kind: string;
  plan_id: number | null;
  credits: number;
  amount_paise: number;
}

export interface CampaignCreatedPayload {
  campaign_id: number;
  user_id: number;
  module_code: string;
}

export interface CampaignFundedPayload {
  campaign_id: number;
  user_id: number;
  wallet_id: number;
  currency_code: string;
  module_code: string;
  credits: number;
  balance_after: number;
}

interface EventDefinition<TPayload> {
  topic: string;
  aggregateType: string;
  aggregateId: (payload: TPayload) => number;
}

/**
 * One entry per event type. The aggregate id becomes the Kafka message key, so
 * every event about one user (or one campaign) is ordered on one partition.
 */
export const EVENTS = {
  'user.registered': {
    topic: TOPICS.users,
    aggregateType: 'user',
    aggregateId: (p: UserRegisteredPayload) => p.user_id,
  } satisfies EventDefinition<UserRegisteredPayload>,
  'user.role_changed': {
    topic: TOPICS.users,
    aggregateType: 'user',
    aggregateId: (p: UserRoleChangedPayload) => p.user_id,
  } satisfies EventDefinition<UserRoleChangedPayload>,
  'credits.purchased': {
    topic: TOPICS.payments,
    aggregateType: 'user',
    aggregateId: (p: CreditsPurchasedPayload) => p.user_id,
  } satisfies EventDefinition<CreditsPurchasedPayload>,
  'campaign.created': {
    topic: TOPICS.campaigns,
    aggregateType: 'campaign',
    aggregateId: (p: CampaignCreatedPayload) => p.campaign_id,
  } satisfies EventDefinition<CampaignCreatedPayload>,
  'campaign.funded': {
    topic: TOPICS.campaigns,
    aggregateType: 'campaign',
    aggregateId: (p: CampaignFundedPayload) => p.campaign_id,
  } satisfies EventDefinition<CampaignFundedPayload>,
} as const;

export type EventType = keyof typeof EVENTS;

export interface EventPayloads {
  'user.registered': UserRegisteredPayload;
  'user.role_changed': UserRoleChangedPayload;
  'credits.purchased': CreditsPurchasedPayload;
  'campaign.created': CampaignCreatedPayload;
  'campaign.funded': CampaignFundedPayload;
}
