from __future__ import annotations

import datetime as dt
import json

import pytest

from analytics_service.events import parse_event
from analytics_service.rbac import Principal
from analytics_service.warehouse import metrics as m
from analytics_service.warehouse.snowflake import (
    _PLATFORM_EVENTS_MERGE,
    SnowflakeQueryExecutor,
    build_merge,
    platform_event_values,
)
from analytics_service.warehouse.types import PlatformEventRow

from .test_events import envelope

W = m.Window(dt.date(2026, 9, 1), dt.date(2026, 9, 30))


def test_window_upper_bound_is_exclusive_next_day() -> None:
    assert W.params() == {"date_from": dt.date(2026, 9, 1), "date_to_excl": dt.date(2026, 10, 1)}


@pytest.mark.parametrize(
    "build",
    [
        lambda p, s: m.overview(p, s, W),
        lambda p, s: m.credits_flow(p, s, W, m.Grain.WEEK),
        lambda p, s: m.campaign_funnel(p, s, W),
    ],
)
def test_own_scope_always_binds_user_id_and_platform_never_does(build) -> None:
    p = Principal(11, "admin")
    own = build(p, m.Scope.OWN)
    platform = build(p, m.Scope.PLATFORM)
    assert own.params["user_id"] == 11 and "%(user_id)s" in own.sql
    assert "user_id" not in platform.params and "%(user_id)s" not in platform.sql


def test_metrics_read_only_core_views() -> None:
    p = Principal(1, "admin")
    queries = [
        m.overview(p, m.Scope.PLATFORM, W),
        m.credits_flow(p, m.Scope.PLATFORM, W, m.Grain.DAY),
        m.revenue(p, W, m.Grain.DAY),
        m.campaign_funnel(p, m.Scope.PLATFORM, W),
        m.top_spenders(p, W, 5),
        m.signups(p, W, m.Grain.MONTH),
    ]
    for q in queries:
        assert "RAW." not in q.sql
        assert "CORE." in q.sql


def test_merge_is_fully_parameterised() -> None:
    hostile = envelope("user.registered", email="x'); DROP TABLE RAW.PLATFORM_EVENTS; --@e.com")
    row = PlatformEventRow(parse_event(json.dumps(hostile)), "t", 0, 5)
    sql, params = build_merge(_PLATFORM_EVENTS_MERGE, [platform_event_values(row)] * 2)

    assert "DROP TABLE" not in sql
    assert sql.count("(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)") == 2
    assert len(params) == 22
    assert json.loads(params[7])["email"].startswith("x');")


def test_executor_refuses_non_reader_roles() -> None:
    executor = SnowflakeQueryExecutor.__new__(SnowflakeQueryExecutor)
    with pytest.raises(ValueError):
        executor.query("SELECT 1", {}, role="ANALYTICS_LOADER", tag="t")
