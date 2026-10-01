import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { OutboxEvent } from '../models';
import { EVENTS, type EventPayloads, type EventType } from './events';

/**
 * Appends a domain event to the outbox INSIDE the caller's transaction.
 *
 * The transaction is required, not optional, and that is the whole point: the
 * event commits or rolls back together with the change it describes. There is
 * deliberately no overload that writes outside a transaction — an event
 * recorded on its own could describe something that never happened.
 */
export async function recordEvent<T extends EventType>(
  transaction: Transaction,
  eventType: T,
  payload: EventPayloads[T],
): Promise<OutboxEvent> {
  const definition = EVENTS[eventType];
  const aggregateId = (definition.aggregateId as (p: EventPayloads[T]) => number)(payload);

  return OutboxEvent.create(
    {
      eventId: randomUUID(),
      topic: definition.topic,
      eventType,
      aggregateType: definition.aggregateType,
      aggregateId: String(aggregateId),
      payload: payload as unknown as Record<string, unknown>,
      occurredAt: new Date(),
    },
    { transaction },
  );
}
