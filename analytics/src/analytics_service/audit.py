"""Access audit trail for the analytics API.

Every metric request — allowed or denied — produces one AccessRecord. Records
are published to Kafka (fire-and-forget, never on the request's critical path)
and loaded by the consumer into GOVERNANCE.API_ACCESS_LOG, next to Snowflake's
own ACCESS_HISTORY. Together they answer "who looked at what, and which
policies applied" for both dashboard and direct-SQL access.

Parameters are recorded; results never are.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

log = logging.getLogger("analytics.audit")

AuditOutcome = Literal["allowed", "denied", "error"]


class AccessRecord(BaseModel):
    request_id: str = Field(min_length=1, max_length=64)
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    user_id: int
    platform_role: str
    snowflake_role: str
    resource: str
    params: dict[str, Any] = Field(default_factory=dict)
    outcome: AuditOutcome
    cache_hit: bool | None = None
    row_count: int | None = None
    duration_ms: int | None = None


class AuditSink(Protocol):
    def record(self, entry: AccessRecord) -> None: ...


class LoggingAuditSink:
    """Development fallback and last resort: structured log lines."""

    def record(self, entry: AccessRecord) -> None:
        log.info("access %s", entry.model_dump_json())


class KafkaAuditSink:
    """Publishes records to the audit topic without blocking the request."""

    def __init__(self, producer: Any, topic: str) -> None:
        self._producer = producer
        self._topic = topic
        self._fallback = LoggingAuditSink()

    def record(self, entry: AccessRecord) -> None:
        def on_delivery(err: Any, _msg: Any) -> None:
            if err is not None:
                # The record is not lost: it lands in the service log, which is
                # shipped like every other log.
                log.error("audit publish failed (%s); falling back to log", err)
                self._fallback.record(entry)

        try:
            self._producer.produce(
                self._topic,
                key=str(entry.user_id),
                value=entry.model_dump_json(),
                on_delivery=on_delivery,
            )
            self._producer.poll(0)
        except Exception:  # BufferError, KafkaException: never fail the request
            log.exception("audit enqueue failed; falling back to log")
            self._fallback.record(entry)


def audit_params(params: dict[str, Any]) -> dict[str, Any]:
    """JSON-safe copy of request parameters for the audit record."""
    return json.loads(json.dumps(params, default=str))
