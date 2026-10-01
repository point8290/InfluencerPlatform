from __future__ import annotations

import datetime as dt
import os
from typing import Any

import fakeredis
import jwt
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("JWT_SECRET", "test-secret-shared-with-the-backend")

from analytics_service.api.main import create_app  # noqa: E402
from analytics_service.api.service import AnalyticsService  # noqa: E402
from analytics_service.audit import AccessRecord  # noqa: E402
from analytics_service.cache import MetricCache  # noqa: E402
from analytics_service.config import Settings  # noqa: E402

SECRET = os.environ["JWT_SECRET"]


class FakeExecutor:
    """Records every query and the Snowflake role it ran under."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.rows: list[dict[str, Any]] = [{"value": 1}]
        self.fail: Exception | None = None

    def query(self, sql: str, params: dict[str, Any], *, role: str, tag: str) -> list[dict]:
        self.calls.append({"sql": sql, "params": params, "role": role, "tag": tag})
        if self.fail is not None:
            raise self.fail
        return self.rows


class MemoryAudit:
    def __init__(self) -> None:
        self.records: list[AccessRecord] = []

    def record(self, entry: AccessRecord) -> None:
        self.records.append(entry)


def make_token(user_id: int = 7, role: str | None = "member", **overrides: Any) -> str:
    claims: dict[str, Any] = {
        "sub": str(user_id),
        "exp": dt.datetime.now(dt.UTC) + dt.timedelta(hours=1),
    }
    if role is not None:
        claims["role"] = role
    claims.update(overrides)
    return jwt.encode(claims, overrides.pop("secret", SECRET), algorithm="HS256")


def auth(user_id: int = 7, role: str | None = "member") -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user_id, role)}"}


@pytest.fixture
def redis_client() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis()


@pytest.fixture
def executor() -> FakeExecutor:
    return FakeExecutor()


@pytest.fixture
def audit() -> MemoryAudit:
    return MemoryAudit()


@pytest.fixture
def service(executor: FakeExecutor, redis_client: fakeredis.FakeRedis, audit: MemoryAudit):
    return AnalyticsService(executor=executor, cache=MetricCache(redis_client, 300), audit=audit)


@pytest.fixture
def client(service: AnalyticsService) -> TestClient:
    return TestClient(create_app(service, Settings()))  # type: ignore[call-arg]
