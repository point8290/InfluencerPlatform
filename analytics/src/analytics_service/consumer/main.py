"""Kafka consumer entry point: `analytics-consumer`.

At-least-once: auto-commit is OFF and offsets are committed only after
process_batch() returns. A Snowflake outage pauses consumption (the batch is
retried with backoff) rather than skipping data; Kafka retains it meanwhile.
"""

from __future__ import annotations

import logging
import signal
import time
from typing import Any

import redis
from confluent_kafka import Consumer, KafkaError, KafkaException, Producer

from ..cache import MetricCache
from ..config import Settings, get_settings
from ..warehouse.snowflake import SnowflakeEventSink
from .batch import Message, process_batch

log = logging.getLogger("analytics.consumer")

MAX_BACKOFF_S = 60.0


class KafkaDeadLetterQueue:
    def __init__(self, producer: Producer, topic: str) -> None:
        self._producer = producer
        self._topic = topic

    def send(self, message: Message, reason: str) -> None:
        self._producer.produce(
            self._topic,
            key=message.key(),
            value=message.value(),
            headers={
                "dlq.reason": reason,
                "dlq.source.topic": message.topic() or "",
                "dlq.source.partition": str(message.partition()),
                "dlq.source.offset": str(message.offset()),
            },
        )
        self._producer.poll(0)

    def flush(self) -> None:
        remaining = self._producer.flush(30)
        if remaining:
            # Not committing is the only safe response: the batch redelivers.
            raise RuntimeError(f"{remaining} dead-letter message(s) not acknowledged")


def _consumer(settings: Settings) -> Consumer:
    return Consumer(
        {
            "bootstrap.servers": settings.kafka_brokers,
            "group.id": settings.kafka_consumer_group,
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
            # Room for Snowflake retries inside one batch before a rebalance.
            "max.poll.interval.ms": 600_000,
            "partition.assignment.strategy": "cooperative-sticky",
        }
    )


def _poll_batch(consumer: Consumer, settings: Settings) -> list[Any]:
    batch: list[Any] = []
    deadline = time.monotonic() + settings.kafka_batch_timeout_s
    while len(batch) < settings.kafka_batch_size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        msgs = consumer.consume(
            num_messages=settings.kafka_batch_size - len(batch), timeout=remaining
        )
        for msg in msgs:
            err = msg.error()
            if err is None:
                batch.append(msg)
            elif err.code() == KafkaError._PARTITION_EOF:
                continue
            else:
                raise KafkaException(err)
    return batch


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()

    consumer = _consumer(settings)
    topics = [*settings.domain_topics, settings.topics["audit"]]
    consumer.subscribe(topics)

    dlq = KafkaDeadLetterQueue(
        Producer({"bootstrap.servers": settings.kafka_brokers, "enable.idempotence": True}),
        settings.topics["dead_letter"],
    )
    sink = SnowflakeEventSink(settings)
    cache = MetricCache(redis.Redis.from_url(settings.redis_url), settings.cache_ttl_s)

    stopping = False

    def _stop(*_: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    log.info("consuming %s as group %s", ", ".join(topics), settings.kafka_consumer_group)
    try:
        while not stopping:
            batch = _poll_batch(consumer, settings)
            if not batch:
                continue

            backoff = 1.0
            while True:
                try:
                    result = process_batch(
                        batch,
                        sink=sink,
                        dlq=dlq,
                        audit_topic=settings.topics["audit"],
                        on_loaded=cache.bump_version,
                    )
                    break
                except Exception:
                    if stopping:
                        # Exit WITHOUT committing; the batch redelivers on restart.
                        log.warning("shutdown during retry; batch will be redelivered")
                        return
                    log.exception("batch load failed; retrying in %.0fs", backoff)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, MAX_BACKOFF_S)

            consumer.commit(asynchronous=False)
            log.info(
                "batch of %d: %d event(s), %d access record(s) loaded, %d dead-lettered",
                len(batch),
                result.loaded_events,
                result.loaded_access_records,
                result.dead_lettered,
            )
    finally:
        consumer.close()
        sink.close()


if __name__ == "__main__":
    run()
