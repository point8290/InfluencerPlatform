"""The request pipeline every metric goes through: authorize, cache, query, audit."""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from ..audit import AccessRecord, AuditSink, audit_params
from ..cache import MetricCache
from ..rbac import Permission, Principal
from ..warehouse.metrics import MetricQuery
from ..warehouse.types import QueryExecutor

log = logging.getLogger(__name__)


class Forbidden(Exception):
    def __init__(self, missing: Iterable[Permission]) -> None:
        self.missing = sorted(p.value for p in missing)
        super().__init__(f"missing permission(s): {', '.join(self.missing)}")


class WarehouseUnavailable(Exception):
    pass


@dataclass(slots=True)
class AnalyticsService:
    executor: QueryExecutor
    cache: MetricCache
    audit: AuditSink

    def authorize(
        self,
        principal: Principal,
        resource: str,
        required: Iterable[Permission],
        params: dict[str, Any],
        request_id: str,
    ) -> None:
        missing = set(required) - principal.permissions
        if missing:
            self._audit(principal, resource, params, request_id, "denied")
            raise Forbidden(missing)

    def run(
        self,
        principal: Principal,
        query: MetricQuery,
        *,
        resource: str,
        required: Iterable[Permission],
        cache_scope: str | None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Authorizes, serves from cache or Snowflake, audits. `cache_scope=None` bypasses cache."""
        request_id = request_id or uuid.uuid4().hex
        self.authorize(principal, resource, required, query.params, request_id)

        tag = json.dumps(
            {
                "app": "analytics-api",
                "request_id": request_id,
                "user_id": principal.user_id,
                "metric": query.name,
            },
            separators=(",", ":"),
        )

        def compute() -> list[dict[str, Any]]:
            try:
                return self.executor.query(
                    query.sql, query.params, role=principal.snowflake_role, tag=tag
                )
            except Exception as error:
                log.exception("warehouse query %s failed", query.name)
                raise WarehouseUnavailable(str(error)) from error

        started = time.perf_counter()
        try:
            if cache_scope is None:
                rows, hit = compute(), False
            else:
                cached = self.cache.get_or_compute(query.name, cache_scope, query.params, compute)
                rows, hit = cached.value, cached.hit
        except WarehouseUnavailable:
            self._audit(principal, resource, query.params, request_id, "error")
            raise

        duration_ms = int((time.perf_counter() - started) * 1000)
        self._audit(
            principal,
            resource,
            query.params,
            request_id,
            "allowed",
            cache_hit=hit,
            row_count=len(rows),
            duration_ms=duration_ms,
        )
        return {"request_id": request_id, "metric": query.name, "cached": hit, "rows": rows}

    def _audit(
        self,
        principal: Principal,
        resource: str,
        params: dict[str, Any],
        request_id: str,
        outcome: str,
        **extra: Any,
    ) -> None:
        try:
            self.audit.record(
                AccessRecord(
                    request_id=request_id,
                    user_id=principal.user_id,
                    platform_role=principal.role,
                    snowflake_role=principal.snowflake_role,
                    resource=resource,
                    params=audit_params(params),
                    outcome=outcome,  # type: ignore[arg-type]
                    **extra,
                )
            )
        except Exception:
            # Auditing must never take the API down; the sink logs its own failures.
            log.exception("audit record failed for %s", request_id)
