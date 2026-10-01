from __future__ import annotations

import json

import pytest

from analytics_service.audit import AccessRecord
from analytics_service.consumer.batch import process_batch

from .test_events import envelope

AUDIT = "platform.analytics-audit.v1"


class Msg:
    def __init__(self, topic: str, value: bytes | None, offset: int = 0) -> None:
        self._topic, self._value, self._offset = topic, value, offset

    def topic(self):
        return self._topic

    def partition(self):
        return 0

    def offset(self):
        return self._offset

    def key(self):
        return b"k"

    def value(self):
        return self._value


class Sink:
    def __init__(self, fail: bool = False) -> None:
        self.events: list = []
        self.access: list = []
        self.fail = fail

    def load_platform_events(self, rows):
        if self.fail and rows:
            raise RuntimeError("snowflake down")
        self.events.extend(rows)
        return len(rows)

    def load_access_records(self, rows):
        self.access.extend(rows)
        return len(rows)


class Dlq:
    def __init__(self) -> None:
        self.sent: list[tuple[Msg, str]] = []
        self.flushed = 0

    def send(self, message, reason):
        self.sent.append((message, reason))

    def flush(self):
        self.flushed += 1


def access_record() -> bytes:
    return (
        AccessRecord(
            request_id="r1",
            user_id=1,
            platform_role="admin",
            snowflake_role="ANALYTICS_ADMIN",
            resource="metrics.overview",
            outcome="allowed",
        )
        .model_dump_json()
        .encode()
    )


def test_routes_valid_events_invalid_events_and_audit_records() -> None:
    sink, dlq, bumps = Sink(), Dlq(), []
    good = json.dumps(envelope()).encode()
    bad = json.dumps(envelope(credits="lots")).encode()

    result = process_batch(
        [
            Msg("platform.payments.v1", good, 10),
            Msg("platform.payments.v1", bad, 11),
            Msg("platform.payments.v1", None, 12),
            Msg(AUDIT, access_record(), 0),
        ],
        sink=sink,
        dlq=dlq,
        audit_topic=AUDIT,
        on_loaded=lambda: bumps.append(1),
    )

    assert (result.loaded_events, result.loaded_access_records, result.dead_lettered) == (1, 1, 2)
    assert sink.events[0].offset == 10 and sink.events[0].topic == "platform.payments.v1"
    assert [m.offset() for m, _ in dlq.sent] == [11, 12]
    assert dlq.flushed == 1
    assert bumps == [1]


def test_sink_failure_propagates_so_offsets_are_not_committed() -> None:
    dlq, bumps = Dlq(), []
    with pytest.raises(RuntimeError):
        process_batch(
            [Msg("platform.payments.v1", json.dumps(envelope()).encode())],
            sink=Sink(fail=True),
            dlq=dlq,
            audit_topic=AUDIT,
            on_loaded=lambda: bumps.append(1),
        )
    assert bumps == []  # cache not invalidated for data that never landed


def test_all_invalid_batch_does_not_bump_cache() -> None:
    bumps = []
    process_batch(
        [Msg("platform.users.v1", b"{}")],
        sink=Sink(),
        dlq=Dlq(),
        audit_topic=AUDIT,
        on_loaded=lambda: bumps.append(1),
    )
    assert bumps == []
