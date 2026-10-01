"""Interfaces the API and consumer depend on, so both are testable without Snowflake."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ..audit import AccessRecord
from ..events import EventEnvelope

Row = dict[str, Any]


class QueryExecutor(Protocol):
    def query(self, sql: str, params: dict[str, Any], *, role: str, tag: str) -> list[Row]:
        """Runs `sql` with Snowflake's CURRENT_ROLE() = `role`."""
        ...


@dataclass(frozen=True, slots=True)
class PlatformEventRow:
    envelope: EventEnvelope
    topic: str
    partition: int
    offset: int


class EventSink(Protocol):
    def load_platform_events(self, rows: list[PlatformEventRow]) -> int: ...

    def load_access_records(self, rows: list[AccessRecord]) -> int: ...
