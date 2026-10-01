"""Batch processing, independent of Kafka and Snowflake client libraries.

ORDER OF OPERATIONS IS THE GUARANTEE:

    1. parse every message; route invalid ones to the dead-letter queue
    2. MERGE valid events into Snowflake           (idempotent on event_id)
    3. flush the DLQ producer                       (invalid messages are durable)
    4. bump the cache version                       (dashboards see new data)
    5. -> caller commits Kafka offsets

A crash anywhere before 5 redelivers the batch, and steps 2-4 are all safe to
repeat. Offsets are never committed for a message that is not either in
Snowflake or in the DLQ — so no event is ever silently dropped.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import ValidationError

from ..audit import AccessRecord
from ..events import InvalidEvent, parse_event
from ..warehouse.types import EventSink, PlatformEventRow

log = logging.getLogger(__name__)


class Message(Protocol):
    """The subset of confluent_kafka.Message the loader uses."""

    def topic(self) -> str | None: ...
    def partition(self) -> int | None: ...
    def offset(self) -> int | None: ...
    def key(self) -> bytes | None: ...
    def value(self) -> bytes | None: ...


class DeadLetterQueue(Protocol):
    def send(self, message: Message, reason: str) -> None: ...
    def flush(self) -> None: ...


@dataclass(slots=True)
class BatchResult:
    loaded_events: int = 0
    loaded_access_records: int = 0
    dead_lettered: int = 0
    reasons: list[str] = field(default_factory=list)


def process_batch(
    messages: Sequence[Message],
    *,
    sink: EventSink,
    dlq: DeadLetterQueue,
    audit_topic: str,
    on_loaded: Callable[[], object] | None = None,
) -> BatchResult:
    """Loads one batch. Raises if Snowflake fails; the caller must not commit then."""
    result = BatchResult()
    events: list[PlatformEventRow] = []
    access: list[AccessRecord] = []

    for message in messages:
        raw = message.value()
        if raw is None:
            # Tombstones are meaningless on an append-only event topic.
            dlq.send(message, "empty message value")
            result.dead_lettered += 1
            continue

        try:
            if message.topic() == audit_topic:
                access.append(AccessRecord.model_validate_json(raw))
            else:
                events.append(
                    PlatformEventRow(
                        envelope=parse_event(raw),
                        topic=message.topic() or "",
                        partition=message.partition() or 0,
                        offset=message.offset() or 0,
                    )
                )
        except (InvalidEvent, ValidationError) as error:
            reason = str(error).splitlines()[0][:500]
            log.warning(
                "dead-lettering %s[%s]@%s: %s",
                message.topic(),
                message.partition(),
                message.offset(),
                reason,
            )
            dlq.send(message, reason)
            result.dead_lettered += 1
            result.reasons.append(reason)

    result.loaded_events = sink.load_platform_events(events)
    result.loaded_access_records = sink.load_access_records(access)
    dlq.flush()

    if on_loaded is not None and (events or access):
        on_loaded()

    return result
