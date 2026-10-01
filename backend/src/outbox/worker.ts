import { env } from '../config/env';
import { sequelize } from '../config/database';
import { KafkaPublisher } from './kafkaPublisher';
import { runRelayLoop } from './relay';

/**
 * Entry point for the outbox relay: `npm run outbox:relay`.
 *
 * A separate process from the API on purpose. The API never holds a broker
 * connection, so Kafka being down cannot slow or fail a user request — it only
 * grows the outbox until the relay catches up.
 */
async function main(): Promise<void> {
  // The relay polls every second; per-query SQL logging would drown its output.
  (sequelize as unknown as { options: { logging: unknown } }).options.logging = false;
  await sequelize.authenticate();

  const publisher = new KafkaPublisher();
  await publisher.connect();
  console.log(`[outbox] relay connected to Kafka at ${env.kafka.brokers.join(',')}`);

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await runRelayLoop(publisher, {
    batchSize: env.outbox.batchSize,
    pollIntervalMs: env.outbox.pollIntervalMs,
    signal: controller.signal,
  });

  await publisher.disconnect();
  await sequelize.close();
  console.log('[outbox] relay stopped');
}

main().catch((error: unknown) => {
  console.error('[outbox] relay failed to start:', error);
  process.exit(1);
});
