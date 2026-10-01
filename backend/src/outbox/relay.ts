import { QueryTypes } from 'sequelize';
import { OutboxEvent, sequelize } from '../models';
import { SCHEMA_VERSION } from './events';

export const PRODUCER_NAME = 'credits-wallet-backend';

/**
 * The wire format of every event, on every topic. The analytics consumer's
 * `EventEnvelope` model mirrors this shape.
 */
export interface EventEnvelope {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  producer: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface OutboundMessage {
  topic: string;
  key: string;
  envelope: EventEnvelope;
}

/**
 * Where relayed events go. Kafka in production (src/outbox/kafkaPublisher.ts);
 * an in-memory fake in tests, so the relay's database behaviour is testable
 * without a broker.
 *
 * `publish` must resolve only once the broker has acknowledged EVERY message.
 * The relay marks rows published after it resolves, so an early resolve would
 * turn a broker failure into a silently lost event.
 */
export interface EventPublisher {
  publish(messages: OutboundMessage[]): Promise<void>;
}

export function toEnvelope(row: OutboxEvent): EventEnvelope {
  return {
    event_id: row.eventId,
    event_type: row.eventType,
    schema_version: SCHEMA_VERSION,
    occurred_at: row.occurredAt.toISOString(),
    producer: PRODUCER_NAME,
    aggregate_type: row.aggregateType,
    aggregate_id: row.aggregateId,
    payload: row.payload,
  };
}

const MAX_ERROR_LENGTH = 1024;

/**
 * Publishes one batch of unpublished events. Returns how many were published.
 *
 * DELIVERY IS AT-LEAST-ONCE, by construction. The rows are marked published
 * only after the broker acknowledges them, so a crash between the two
 * republishes the batch on the next run. Consumers dedupe on `event_id`; the
 * analytics loader does so with a MERGE.
 *
 * `FOR UPDATE SKIP LOCKED` lets several relays run without double-sending the
 * same row at the same time. Running more than one does give up strict
 * per-aggregate ordering across batches; the analytics marts are aggregations
 * that do not depend on order, but anything that does should run one relay.
 *
 * On a publish failure the batch's attempt counters and last error are
 * recorded and the error is rethrown, so the caller can back off.
 */
export async function relayBatch(publisher: EventPublisher, batchSize: number): Promise<number> {
  let publishError: unknown = null;

  const published = await sequelize.transaction(async (transaction) => {
    // Raw SQL because Sequelize's `skipLocked` option is silently ignored by
    // its MySQL dialect: the generated query would be a plain FOR UPDATE, and a
    // second relay would block behind the first instead of taking other rows.
    const locked = await sequelize.query<{ id: number }>(
      'SELECT id FROM outbox_events WHERE published_at IS NULL ' +
        'ORDER BY id ASC LIMIT :limit FOR UPDATE SKIP LOCKED',
      { replacements: { limit: batchSize }, type: QueryTypes.SELECT, transaction },
    );

    if (locked.length === 0) return 0;

    const ids = locked.map((row) => row.id);
    const rows = await OutboxEvent.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction });

    try {
      await publisher.publish(
        rows.map((row) => ({ topic: row.topic, key: row.aggregateId, envelope: toEnvelope(row) })),
      );
    } catch (error) {
      publishError = error;
      const message = error instanceof Error ? error.message : String(error);
      await OutboxEvent.update(
        {
          attempts: sequelize.literal('attempts + 1') as unknown as number,
          lastError: message.slice(0, MAX_ERROR_LENGTH),
        },
        { where: { id: ids }, transaction },
      );
      return 0;
    }

    await OutboxEvent.update(
      {
        publishedAt: new Date(),
        attempts: sequelize.literal('attempts + 1') as unknown as number,
        lastError: null,
      },
      { where: { id: ids }, transaction },
    );
    return rows.length;
  });

  // Rethrown only after the attempt counters have committed.
  if (publishError !== null) throw publishError;
  return published;
}

export interface RelayLoopOptions {
  batchSize: number;
  pollIntervalMs: number;
  maxBackoffMs?: number;
  signal: AbortSignal;
  log?: Pick<Console, 'log' | 'error'>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * Drains the outbox continuously until `signal` aborts.
 *
 * A full batch is followed immediately by another, so a backlog drains at
 * broker speed; an empty or partial batch waits one poll interval. Failures
 * back off exponentially up to `maxBackoffMs`, so a broker outage does not
 * become a hot loop of doomed transactions against MySQL.
 */
export async function runRelayLoop(publisher: EventPublisher, options: RelayLoopOptions): Promise<void> {
  const log = options.log ?? console;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let backoffMs = options.pollIntervalMs;

  while (!options.signal.aborted) {
    try {
      const count = await relayBatch(publisher, options.batchSize);
      backoffMs = options.pollIntervalMs;
      if (count > 0) log.log(`[outbox] published ${count} event(s)`);
      if (count < options.batchSize) await sleep(options.pollIntervalMs, options.signal);
    } catch (error) {
      log.error(`[outbox] publish failed; retrying in ${backoffMs}ms`, error);
      await sleep(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}
