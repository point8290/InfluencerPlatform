import { Kafka, logLevel, type Producer } from 'kafkajs';
import { env } from '../config/env';
import type { EventPublisher, OutboundMessage } from './relay';

/**
 * Kafka-backed EventPublisher.
 *
 * `idempotent: true` makes the broker drop duplicates caused by the PRODUCER's
 * own retries within a session (it implies acks=all and a single in-flight
 * request). It cannot dedupe a batch the relay re-sends after a crash — that is
 * what `event_id` and the consumer's MERGE are for.
 */
export class KafkaPublisher implements EventPublisher {
  private readonly producer: Producer;

  constructor() {
    const kafka = new Kafka({
      clientId: env.kafka.clientId,
      brokers: env.kafka.brokers,
      logLevel: logLevel.WARN,
    });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }

  async publish(messages: OutboundMessage[]): Promise<void> {
    const byTopic = new Map<string, OutboundMessage[]>();
    for (const message of messages) {
      const list = byTopic.get(message.topic) ?? [];
      list.push(message);
      byTopic.set(message.topic, list);
    }

    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic.entries()].map(([topic, list]) => ({
        topic,
        messages: list.map((message) => ({
          key: message.key,
          value: JSON.stringify(message.envelope),
          headers: {
            event_id: message.envelope.event_id,
            event_type: message.envelope.event_type,
            schema_version: String(message.envelope.schema_version),
          },
        })),
      })),
    });
  }
}
