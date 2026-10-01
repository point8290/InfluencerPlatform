"""FastAPI application: `analytics-api`.

No `from __future__ import annotations` here: FastAPI resolves dependency
annotations at runtime, and the Annotated aliases below are function-local.
"""

import datetime as dt
import logging
import uuid
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..auth import AuthenticationError, principal_from_token
from ..cache import MetricCache
from ..config import Settings, get_settings
from ..rbac import ROLE_PERMISSIONS, SNOWFLAKE_ROLES, Permission, Principal
from ..warehouse import metrics as m
from .service import AnalyticsService, Forbidden, WarehouseUnavailable

log = logging.getLogger("analytics.api")

MAX_WINDOW_DAYS = 366
DEFAULT_WINDOW_DAYS = 30


class HTTPError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status, self.code, self.message = status, code, message


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    # Same shape as the backend's errors: { error: { code, message } }.
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message, **extra}}
    )


def create_app(service: AnalyticsService, settings: Settings) -> FastAPI:
    app = FastAPI(title="Influencer Platform Analytics", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )
    secret = settings.jwt_secret.get_secret_value()

    # ── Dependencies ──────────────────────────────────────────────────────
    def principal(authorization: Annotated[str | None, Header()] = None) -> Principal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise HTTPError(
                401, "UNAUTHENTICATED", 'Authorization header must be "Bearer <token>".'
            )
        try:
            return principal_from_token(authorization.removeprefix("Bearer ").strip(), secret)
        except AuthenticationError as error:
            raise HTTPError(401, "UNAUTHENTICATED", str(error)) from error

    def window(
        date_from: Annotated[dt.date | None, Query(alias="from")] = None,
        date_to: Annotated[dt.date | None, Query(alias="to")] = None,
    ) -> m.Window:
        to = date_to or dt.datetime.now(dt.UTC).date()
        frm = date_from or to - dt.timedelta(days=DEFAULT_WINDOW_DAYS - 1)
        if frm > to:
            raise HTTPError(422, "INVALID_WINDOW", '"from" must not be after "to".')
        if (to - frm).days + 1 > MAX_WINDOW_DAYS:
            raise HTTPError(
                422, "INVALID_WINDOW", f"Window may span at most {MAX_WINDOW_DAYS} days."
            )
        return m.Window(frm, to)

    def request_id(request: Request) -> str:
        return request.state.request_id

    Caller = Annotated[Principal, Depends(principal)]
    Win = Annotated[m.Window, Depends(window)]
    ReqId = Annotated[str, Depends(request_id)]
    GrainQ = Annotated[m.Grain, Query()]

    def resolve_scope(p: Principal, scope: m.Scope | None) -> m.Scope:
        if scope is not None:
            return scope
        return m.Scope.PLATFORM if p.can(Permission.PLATFORM_METRICS_READ) else m.Scope.OWN

    def cache_scope(p: Principal, scope: m.Scope) -> str:
        return p.own_cache_scope() if scope is m.Scope.OWN else p.cache_scope

    # ── Middleware & error mapping ────────────────────────────────────────
    @app.middleware("http")
    async def assign_request_id(request: Request, call_next: Any) -> Any:
        request.state.request_id = uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(HTTPError)
    async def _http_error(_: Request, exc: HTTPError) -> JSONResponse:
        return _error(exc.status, exc.code, exc.message)

    @app.exception_handler(Forbidden)
    async def _forbidden(_: Request, exc: Forbidden) -> JSONResponse:
        return _error(403, "FORBIDDEN", "Your role does not allow this.", missing=exc.missing)

    @app.exception_handler(WarehouseUnavailable)
    async def _warehouse(_: Request, __: WarehouseUnavailable) -> JSONResponse:
        return _error(503, "WAREHOUSE_UNAVAILABLE", "Analytics are temporarily unavailable.")

    # ── Routes ────────────────────────────────────────────────────────────
    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "environment": settings.environment}

    @app.get("/v1/me")
    def me(p: Caller) -> dict[str, Any]:
        return {
            "user_id": p.user_id,
            "role": p.role,
            "snowflake_role": p.snowflake_role,
            "permissions": sorted(x.value for x in p.permissions),
        }

    @app.get("/v1/metrics/overview")
    def overview(p: Caller, w: Win, rid: ReqId, scope: m.Scope | None = None) -> dict[str, Any]:
        s = resolve_scope(p, scope)
        return service.run(
            p,
            m.overview(p, s, w),
            resource="metrics.overview",
            required=m.required_permissions("overview", s),
            cache_scope=cache_scope(p, s),
            request_id=rid,
        ) | {"scope": s.value}

    @app.get("/v1/metrics/credits-flow")
    def credits_flow(
        p: Caller, w: Win, rid: ReqId, grain: GrainQ = m.Grain.DAY, scope: m.Scope | None = None
    ) -> dict[str, Any]:
        s = resolve_scope(p, scope)
        return service.run(
            p,
            m.credits_flow(p, s, w, grain),
            resource="metrics.credits_flow",
            required=m.required_permissions("credits_flow", s),
            cache_scope=cache_scope(p, s),
            request_id=rid,
        ) | {"scope": s.value}

    @app.get("/v1/metrics/campaign-funnel")
    def campaign_funnel(
        p: Caller, w: Win, rid: ReqId, scope: m.Scope | None = None
    ) -> dict[str, Any]:
        s = resolve_scope(p, scope)
        return service.run(
            p,
            m.campaign_funnel(p, s, w),
            resource="metrics.campaign_funnel",
            required=m.required_permissions("campaign_funnel", s),
            cache_scope=cache_scope(p, s),
            request_id=rid,
        ) | {"scope": s.value}

    @app.get("/v1/metrics/revenue")
    def revenue(p: Caller, w: Win, rid: ReqId, grain: GrainQ = m.Grain.DAY) -> dict[str, Any]:
        return service.run(
            p,
            m.revenue(p, w, grain),
            resource="metrics.revenue",
            required=m.required_permissions("revenue", m.Scope.PLATFORM),
            cache_scope=p.cache_scope,
            request_id=rid,
        ) | {"scope": m.Scope.PLATFORM.value}

    @app.get("/v1/metrics/top-spenders")
    def top_spenders(
        p: Caller, w: Win, rid: ReqId, limit: Annotated[int, Query(ge=1, le=100)] = 10
    ) -> dict[str, Any]:
        return service.run(
            p,
            m.top_spenders(p, w, limit),
            resource="metrics.top_spenders",
            required=m.required_permissions("top_spenders", m.Scope.PLATFORM),
            cache_scope=p.cache_scope,
            request_id=rid,
        ) | {"scope": m.Scope.PLATFORM.value}

    @app.get("/v1/metrics/signups")
    def signups(p: Caller, w: Win, rid: ReqId, grain: GrainQ = m.Grain.DAY) -> dict[str, Any]:
        return service.run(
            p,
            m.signups(p, w, grain),
            resource="metrics.signups",
            required=m.required_permissions("signups", m.Scope.PLATFORM),
            cache_scope=p.cache_scope,
            request_id=rid,
        ) | {"scope": m.Scope.PLATFORM.value}

    @app.get("/v1/governance/policies")
    def policies(p: Caller, rid: ReqId) -> dict[str, Any]:
        result = service.run(
            p,
            m.policy_references(),
            resource="governance.policies",
            required={Permission.GOVERNANCE_READ},
            cache_scope=p.cache_scope,
            request_id=rid,
        )
        return {
            "request_id": result["request_id"],
            "rbac": {
                role: {
                    "snowflake_role": SNOWFLAKE_ROLES[role],
                    "permissions": sorted(x.value for x in perms),
                }
                for role, perms in ROLE_PERMISSIONS.items()
            },
            "warehouse_policies": result["rows"],
        }

    @app.get("/v1/governance/access-log")
    def access_log(
        p: Caller, rid: ReqId, limit: Annotated[int, Query(ge=1, le=500)] = 100
    ) -> dict[str, Any]:
        # Never cached: an audit view that can be minutes stale is misleading.
        return service.run(
            p,
            m.access_log(limit),
            resource="governance.access_log",
            required={Permission.GOVERNANCE_READ},
            cache_scope=None,
            request_id=rid,
        )

    @app.post("/v1/admin/cache/invalidate")
    def invalidate(p: Caller, rid: ReqId) -> dict[str, Any]:
        service.authorize(p, "admin.cache_invalidate", {Permission.CACHE_MANAGE}, {}, rid)
        version = service.cache.bump_version()
        return {"data_version": version}

    return app


def build_default_app() -> FastAPI:
    """Wires real Redis, Snowflake and Kafka. Imported lazily by `run`."""
    import redis
    from confluent_kafka import Producer

    from ..audit import KafkaAuditSink
    from ..warehouse.snowflake import SnowflakeQueryExecutor

    settings = get_settings()
    producer = Producer(
        {
            "bootstrap.servers": settings.kafka_brokers,
            "enable.idempotence": True,
            "linger.ms": 50,
        }
    )
    service = AnalyticsService(
        executor=SnowflakeQueryExecutor(settings),
        cache=MetricCache(redis.Redis.from_url(settings.redis_url), settings.cache_ttl_s),
        audit=KafkaAuditSink(producer, settings.topics["audit"]),
    )
    app = create_app(service, settings)

    # Deliver buffered audit records before the process exits.
    app.router.on_shutdown.append(lambda: producer.flush(10))
    return app


def run() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    uvicorn.run(
        "analytics_service.api.main:build_default_app",
        factory=True,
        host=settings.api_host,
        port=settings.api_port,
    )


if __name__ == "__main__":
    run()
