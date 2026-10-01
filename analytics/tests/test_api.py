from __future__ import annotations

import pytest

from .conftest import auth


def test_health_needs_no_auth(client) -> None:
    assert client.get("/health").json()["status"] == "ok"


def test_missing_token_is_401(client, executor) -> None:
    r = client.get("/v1/metrics/overview")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"
    assert executor.calls == []


def test_me_reports_role_and_permissions(client) -> None:
    body = client.get("/v1/me", headers=auth(3, "finance")).json()
    assert body["snowflake_role"] == "ANALYTICS_FINANCE"
    assert "revenue:read" in body["permissions"]
    assert "pii:read" not in body["permissions"]


def test_member_defaults_to_own_scope_and_is_pinned_to_their_user_id(client, executor) -> None:
    r = client.get("/v1/metrics/overview", headers=auth(7, "member"))
    assert r.status_code == 200
    assert r.json()["scope"] == "own"

    call = executor.calls[0]
    assert call["role"] == "ANALYTICS_MEMBER"
    assert call["params"]["user_id"] == 7
    assert "user_id = %(user_id)s" in call["sql"]


def test_member_cannot_override_user_id_via_query_string(client, executor) -> None:
    client.get("/v1/metrics/overview?user_id=999", headers=auth(7, "member"))
    assert executor.calls[0]["params"]["user_id"] == 7


@pytest.mark.parametrize(
    ("path", "role", "missing"),
    [
        ("/v1/metrics/overview?scope=platform", "member", "metrics:platform:read"),
        ("/v1/metrics/revenue", "analyst", "revenue:read"),
        ("/v1/metrics/top-spenders", "member", "users:read"),
        ("/v1/metrics/signups", "member", "metrics:platform:read"),
        ("/v1/governance/policies", "finance", "governance:read"),
        ("/v1/governance/access-log", "analyst", "governance:read"),
    ],
)
def test_forbidden_requests_never_reach_snowflake_and_are_audited(
    client, executor, audit, path, role, missing
) -> None:
    r = client.get(path, headers=auth(1, role))
    assert r.status_code == 403
    assert missing in r.json()["error"]["missing"]
    assert executor.calls == []
    assert [rec.outcome for rec in audit.records] == ["denied"]


def test_finance_can_read_revenue_under_finance_role(client, executor) -> None:
    r = client.get("/v1/metrics/revenue?grain=month", headers=auth(1, "finance"))
    assert r.status_code == 200
    assert executor.calls[0]["role"] == "ANALYTICS_FINANCE"
    assert "DATE_TRUNC('month'" in executor.calls[0]["sql"]


def test_analyst_overview_does_not_select_revenue(client, executor) -> None:
    client.get("/v1/metrics/overview", headers=auth(1, "analyst"))
    sql = executor.calls[0]["sql"]
    assert "NULL AS revenue_paise" in sql
    assert "amount_paise" not in sql


def test_invalid_grain_is_rejected_before_any_query(client, executor) -> None:
    r = client.get("/v1/metrics/credits-flow?grain=year');DROP", headers=auth(1, "analyst"))
    assert r.status_code == 422
    assert executor.calls == []


@pytest.mark.parametrize(
    "qs",
    ["from=2026-02-01&to=2026-01-01", "from=2024-01-01&to=2026-01-01", "from=not-a-date"],
)
def test_invalid_windows_are_rejected(client, executor, qs) -> None:
    assert client.get(f"/v1/metrics/overview?{qs}", headers=auth()).status_code == 422
    assert executor.calls == []


def test_second_identical_request_is_served_from_cache(client, executor, audit) -> None:
    h = auth(1, "analyst")
    first = client.get("/v1/metrics/campaign-funnel", headers=h).json()
    second = client.get("/v1/metrics/campaign-funnel", headers=h).json()
    assert (first["cached"], second["cached"]) == (False, True)
    assert len(executor.calls) == 1
    assert [r.cache_hit for r in audit.records] == [False, True]


def test_cache_is_not_shared_between_roles(client, executor) -> None:
    client.get("/v1/metrics/top-spenders", headers=auth(1, "analyst"))
    client.get("/v1/metrics/top-spenders", headers=auth(2, "admin"))
    # The admin must get a fresh query under ANALYTICS_ADMIN, never the
    # analyst's (masked) cached rows — and vice versa.
    assert [c["role"] for c in executor.calls] == ["ANALYTICS_ANALYST", "ANALYTICS_ADMIN"]


def test_cache_is_not_shared_between_members(client, executor) -> None:
    client.get("/v1/metrics/overview", headers=auth(1, "member"))
    client.get("/v1/metrics/overview", headers=auth(2, "member"))
    assert [c["params"]["user_id"] for c in executor.calls] == [1, 2]


def test_cache_invalidation_requires_admin_and_forces_recompute(client, executor) -> None:
    h = auth(1, "admin")
    client.get("/v1/metrics/signups", headers=h)
    assert client.post("/v1/admin/cache/invalidate", headers=auth(2, "finance")).status_code == 403
    assert client.post("/v1/admin/cache/invalidate", headers=h).json()["data_version"] == 1
    client.get("/v1/metrics/signups", headers=h)
    assert len(executor.calls) == 2


def test_access_log_is_never_cached(client, executor) -> None:
    h = auth(1, "admin")
    client.get("/v1/governance/access-log", headers=h)
    client.get("/v1/governance/access-log", headers=h)
    assert len(executor.calls) == 2


def test_policies_returns_rbac_matrix(client) -> None:
    body = client.get("/v1/governance/policies", headers=auth(1, "admin")).json()
    assert body["rbac"]["analyst"]["snowflake_role"] == "ANALYTICS_ANALYST"
    assert "pii:read" in body["rbac"]["admin"]["permissions"]


def test_warehouse_failure_is_503_and_audited(client, executor, audit) -> None:
    executor.fail = RuntimeError("warehouse suspended")
    r = client.get("/v1/metrics/overview", headers=auth())
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "WAREHOUSE_UNAVAILABLE"
    assert "suspended" not in r.text  # internals are not leaked
    assert audit.records[-1].outcome == "error"


def test_query_tag_carries_request_id_for_audit_correlation(client, executor) -> None:
    r = client.get("/v1/metrics/overview", headers=auth())
    assert r.headers["X-Request-ID"] in executor.calls[0]["tag"]
