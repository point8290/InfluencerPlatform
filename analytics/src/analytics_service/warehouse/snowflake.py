"""Snowflake connections for the API (per-role pools) and the consumer (loader).

The API's service user holds every functional reader role; each query borrows a
connection opened AS the caller's mapped role. Snowflake then evaluates every
masking and row access policy against that role — the API cannot accidentally
read a column the caller is not entitled to, because the warehouse will not
return it.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import queue
import threading
from decimal import Decimal
from pathlib import Path
from typing import Any

from ..audit import AccessRecord
from ..config import Settings
from ..rbac import SNOWFLAKE_ROLES
from .types import PlatformEventRow, Row

log = logging.getLogger(__name__)

_ALLOWED_QUERY_ROLES = frozenset(SNOWFLAKE_ROLES.values())
LOAD_CHUNK_SIZE = 500


def _auth_kwargs(settings: Settings) -> dict[str, Any]:
    if settings.snowflake_private_key_path:
        from cryptography.hazmat.primitives import serialization

        passphrase = settings.snowflake_private_key_passphrase
        key = serialization.load_pem_private_key(
            Path(settings.snowflake_private_key_path).read_bytes(),
            password=passphrase.get_secret_value().encode() if passphrase else None,
        )
        return {
            "private_key": key.private_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        }
    if settings.snowflake_password:
        return {"password": settings.snowflake_password.get_secret_value()}
    raise RuntimeError(
        "Snowflake credentials missing: set SNOWFLAKE_PRIVATE_KEY_PATH (recommended) "
        "or SNOWFLAKE_PASSWORD."
    )


def connect(settings: Settings, *, user: str, role: str, warehouse: str) -> Any:
    import snowflake.connector

    if not settings.snowflake_account:
        raise RuntimeError("SNOWFLAKE_ACCOUNT is not set.")

    conn = snowflake.connector.connect(
        account=settings.snowflake_account,
        user=user,
        role=role,
        warehouse=warehouse,
        database=settings.snowflake_database,
        application="influencer-analytics",
        client_session_keep_alive=True,
        session_parameters={"TIMEZONE": "UTC", "STATEMENT_TIMEOUT_IN_SECONDS": 60},
        **_auth_kwargs(settings),
    )
    # Belt and braces with DEFAULT_SECONDARY_ROLES = () on the user (01_rbac.sql):
    # with secondary roles active, IS_ROLE_IN_SESSION would see every role the
    # service user holds and the masking policies would unmask for everyone.
    conn.cursor().execute("USE SECONDARY ROLES NONE")
    return conn


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dt.datetime | dt.date):
        return value.isoformat()
    return value


class _RolePool:
    def __init__(self, factory: Any, max_size: int) -> None:
        self._factory = factory
        self._idle: queue.LifoQueue[Any] = queue.LifoQueue()
        self._slots = threading.BoundedSemaphore(max_size)

    def acquire(self) -> Any:
        self._slots.acquire()
        try:
            return self._idle.get_nowait()
        except queue.Empty:
            try:
                return self._factory()
            except BaseException:
                self._slots.release()
                raise

    def release(self, conn: Any, *, broken: bool) -> None:
        try:
            if broken:
                try:
                    conn.close()
                except Exception:  # noqa: S110 - already broken; closing is best effort
                    pass
            else:
                self._idle.put(conn)
        finally:
            self._slots.release()


class SnowflakeQueryExecutor:
    """QueryExecutor for the API: one bounded connection pool per Snowflake role."""

    def __init__(self, settings: Settings, pool_size: int = 4) -> None:
        self._settings = settings
        self._pool_size = pool_size
        self._pools: dict[str, _RolePool] = {}
        self._lock = threading.Lock()

    def _pool(self, role: str) -> _RolePool:
        with self._lock:
            pool = self._pools.get(role)
            if pool is None:
                s = self._settings
                pool = _RolePool(
                    lambda: connect(
                        s, user=s.snowflake_api_user, role=role, warehouse=s.snowflake_warehouse
                    ),
                    self._pool_size,
                )
                self._pools[role] = pool
            return pool

    def query(self, sql: str, params: dict[str, Any], *, role: str, tag: str) -> list[Row]:
        # The role is never caller-supplied (it comes from rbac.SNOWFLAKE_ROLES),
        # but refusing anything else keeps a future bug from opening a
        # connection as, say, ANALYTICS_LOADER.
        if role not in _ALLOWED_QUERY_ROLES:
            raise ValueError(f"refusing to query as non-reader role {role!r}")

        pool = self._pool(role)
        conn = pool.acquire()
        broken = False
        try:
            cur = conn.cursor()
            try:
                # Lets QUERY_HISTORY be joined to GOVERNANCE.API_ACCESS_LOG.
                cur.execute("ALTER SESSION SET QUERY_TAG = %s", (tag,))
                cur.execute(sql, params)
                columns = [c[0].lower() for c in cur.description]
                return [
                    {col: _jsonable(val) for col, val in zip(columns, row, strict=True)}
                    for row in cur.fetchall()
                ]
            finally:
                cur.close()
        except Exception as error:
            import snowflake.connector.errors as sf_errors

            broken = isinstance(error, sf_errors.OperationalError | sf_errors.InterfaceError)
            raise
        finally:
            pool.release(conn, broken=broken)


_PLATFORM_EVENTS_MERGE = """
MERGE INTO RAW.PLATFORM_EVENTS t
USING (
  SELECT
    column1 AS event_id, column2 AS event_type, column3 AS schema_version,
    TO_TIMESTAMP_TZ(column4) AS occurred_at, column5 AS producer,
    column6 AS aggregate_type, column7 AS aggregate_id, PARSE_JSON(column8) AS payload,
    column9 AS kafka_topic, column10 AS kafka_partition, column11 AS kafka_offset
  FROM VALUES {values}
  -- A batch can contain the same event twice (relay redelivery); keep one.
  QUALIFY ROW_NUMBER() OVER (PARTITION BY column1 ORDER BY column11) = 1
) s
ON t.event_id = s.event_id
WHEN NOT MATCHED THEN INSERT (
  event_id, event_type, schema_version, occurred_at, producer, aggregate_type,
  aggregate_id, payload, kafka_topic, kafka_partition, kafka_offset
) VALUES (
  s.event_id, s.event_type, s.schema_version, s.occurred_at, s.producer, s.aggregate_type,
  s.aggregate_id, s.payload, s.kafka_topic, s.kafka_partition, s.kafka_offset
)
"""

_ACCESS_LOG_MERGE = """
MERGE INTO GOVERNANCE.API_ACCESS_LOG t
USING (
  SELECT
    column1 AS request_id, TO_TIMESTAMP_TZ(column2) AS occurred_at, column3 AS user_id,
    column4 AS platform_role, column5 AS snowflake_role, column6 AS resource,
    PARSE_JSON(column7) AS params, column8 AS outcome, column9 AS cache_hit,
    column10 AS row_count, column11 AS duration_ms
  FROM VALUES {values}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY column1 ORDER BY column2) = 1
) s
ON t.request_id = s.request_id
WHEN NOT MATCHED THEN INSERT (
  request_id, occurred_at, user_id, platform_role, snowflake_role, resource, params,
  outcome, cache_hit, row_count, duration_ms
) VALUES (
  s.request_id, s.occurred_at, s.user_id, s.platform_role, s.snowflake_role, s.resource,
  s.params, s.outcome, s.cache_hit, s.row_count, s.duration_ms
)
"""


def platform_event_values(row: PlatformEventRow) -> tuple[Any, ...]:
    e = row.envelope
    return (
        e.event_id,
        e.event_type,
        e.schema_version,
        e.occurred_at.isoformat(),
        e.producer,
        e.aggregate_type,
        e.aggregate_id,
        json.dumps(e.payload, separators=(",", ":")),
        row.topic,
        row.partition,
        row.offset,
    )


def access_record_values(r: AccessRecord) -> tuple[Any, ...]:
    return (
        r.request_id,
        r.occurred_at.isoformat(),
        r.user_id,
        r.platform_role,
        r.snowflake_role,
        r.resource,
        json.dumps(r.params, separators=(",", ":"), default=str),
        r.outcome,
        r.cache_hit,
        r.row_count,
        r.duration_ms,
    )


def build_merge(template: str, rows: list[tuple[Any, ...]]) -> tuple[str, tuple[Any, ...]]:
    """Expands a MERGE ... USING (VALUES ...) for `rows`, fully parameterised.

    Values are always bound, never interpolated: only the placeholder skeleton
    is generated here. That is what makes it safe to load event payloads whose
    contents (campaign names, emails) are user-controlled.
    """
    if not rows:
        raise ValueError("build_merge needs at least one row")
    width = len(rows[0])
    placeholder = "(" + ", ".join(["%s"] * width) + ")"
    sql = template.format(values=", ".join([placeholder] * len(rows)))
    params = tuple(value for row in rows for value in row)
    return sql, params


class SnowflakeEventSink:
    """EventSink for the consumer. MERGE on the natural key = idempotent loads."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._conn: Any = None

    def _connection(self) -> Any:
        if self._conn is None or self._conn.is_closed():
            s = self._settings
            self._conn = connect(
                s,
                user=s.snowflake_loader_user,
                role=s.snowflake_loader_role,
                warehouse=s.snowflake_loader_warehouse,
            )
        return self._conn

    def _merge(self, template: str, rows: list[tuple[Any, ...]]) -> int:
        inserted = 0
        for start in range(0, len(rows), LOAD_CHUNK_SIZE):
            sql, params = build_merge(template, rows[start : start + LOAD_CHUNK_SIZE])
            cur = self._connection().cursor()
            try:
                cur.execute(sql, params)
                result = cur.fetchone()
                inserted += int(result[0]) if result else 0
            except Exception:
                # Drop the connection: the next attempt reconnects cleanly.
                self.close()
                raise
            finally:
                cur.close()
        return inserted

    def load_platform_events(self, rows: list[PlatformEventRow]) -> int:
        if not rows:
            return 0
        return self._merge(_PLATFORM_EVENTS_MERGE, [platform_event_values(r) for r in rows])

    def load_access_records(self, rows: list[AccessRecord]) -> int:
        if not rows:
            return 0
        return self._merge(_ACCESS_LOG_MERGE, [access_record_values(r) for r in rows])

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None
