"""Metric definitions: the only SQL the API can run.

Every query reads CORE views (never RAW), binds every value as a parameter,
and takes its scope from the caller's Principal — never from the request. The
one piece of SQL text that varies per request is the DATE_TRUNC grain, and it
is chosen from a closed set, not interpolated from input.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..rbac import Permission, Principal


class Scope(StrEnum):
    OWN = "own"
    PLATFORM = "platform"


class Grain(StrEnum):
    DAY = "day"
    WEEK = "week"
    MONTH = "month"


@dataclass(frozen=True, slots=True)
class Window:
    date_from: dt.date
    date_to: dt.date  # inclusive

    def params(self) -> dict[str, Any]:
        return {"date_from": self.date_from, "date_to_excl": self.date_to + dt.timedelta(days=1)}


@dataclass(frozen=True, slots=True)
class MetricQuery:
    name: str
    sql: str
    params: dict[str, Any] = field(default_factory=dict)


_IN_WINDOW = "{col} >= %(date_from)s AND {col} < %(date_to_excl)s"
_OWN_FILTER = " AND user_id = %(user_id)s"


def _window(col: str) -> str:
    return _IN_WINDOW.format(col=col)


def _scoped(scope: Scope, principal: Principal, params: dict[str, Any]) -> str:
    """Returns the row filter for `scope` and binds the caller's id when needed."""
    if scope is Scope.OWN:
        params["user_id"] = principal.user_id
        return _OWN_FILTER
    return ""


def required_permissions(metric: str, scope: Scope) -> frozenset[Permission]:
    base = Permission.OWN_METRICS_READ if scope is Scope.OWN else Permission.PLATFORM_METRICS_READ
    extra = METRIC_EXTRA_PERMISSIONS.get(metric, frozenset())
    return frozenset({base}) | extra


# Permissions beyond the scope's base permission.
METRIC_EXTRA_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "revenue": frozenset({Permission.REVENUE_READ}),
    "top_spenders": frozenset({Permission.USER_LEVEL_READ}),
}

# Metrics that only make sense platform-wide.
PLATFORM_ONLY = frozenset({"revenue", "top_spenders", "signups"})


def overview(principal: Principal, scope: Scope, window: Window) -> MetricQuery:
    params = window.params()
    f = _scoped(scope, principal, params)
    platform = scope is Scope.PLATFORM
    users = (
        f"""(SELECT COUNT(*) FROM CORE.DIM_USERS WHERE registered_at < %(date_to_excl)s)
                AS total_users,
            (SELECT COUNT(*) FROM CORE.DIM_USERS WHERE {_window("registered_at")}) AS new_users,"""
        if platform
        else "NULL AS total_users, NULL AS new_users,"
    )
    # Revenue is only selected for callers allowed to see it. Snowflake's
    # FINANCIAL tag would mask it to NULL anyway; not asking is cleaner.
    revenue = (
        f"(SELECT SUM(amount_paise) FROM CORE.FCT_CREDIT_PURCHASES "
        f"WHERE {_window('occurred_at')}{f}) AS revenue_paise"
        if platform and principal.can(Permission.REVENUE_READ)
        else "NULL AS revenue_paise"
    )
    sql = f"""
        SELECT
            {users}
            (SELECT COALESCE(SUM(credits), 0) FROM CORE.FCT_CREDIT_PURCHASES
                WHERE {_window("occurred_at")}{f}) AS credits_purchased,
            (SELECT COALESCE(SUM(credits), 0) FROM CORE.FCT_CAMPAIGN_FUNDINGS
                WHERE {_window("occurred_at")}{f}) AS credits_spent,
            (SELECT COUNT(*) FROM CORE.FCT_CAMPAIGNS
                WHERE {_window("created_at")}{f}) AS campaigns_created,
            (SELECT COUNT(*) FROM CORE.FCT_CAMPAIGNS
                WHERE {_window("funded_at")}{f}) AS campaigns_funded,
            {revenue}
    """
    return MetricQuery("overview", sql, params)


def credits_flow(principal: Principal, scope: Scope, window: Window, grain: Grain) -> MetricQuery:
    params = window.params()
    f = _scoped(scope, principal, params)
    g = Grain(grain).value  # closed set; never request text
    sql = f"""
        WITH purchased AS (
            SELECT DATE_TRUNC('{g}', occurred_at)::DATE AS period, currency_code,
                   SUM(credits) AS credits
            FROM CORE.FCT_CREDIT_PURCHASES
            WHERE {_window("occurred_at")}{f}
            GROUP BY 1, 2
        ),
        spent AS (
            SELECT DATE_TRUNC('{g}', occurred_at)::DATE AS period, currency_code,
                   SUM(credits) AS credits
            FROM CORE.FCT_CAMPAIGN_FUNDINGS
            WHERE {_window("occurred_at")}{f}
            GROUP BY 1, 2
        )
        SELECT
            COALESCE(p.period, s.period)                AS period,
            COALESCE(p.currency_code, s.currency_code)  AS currency_code,
            COALESCE(p.credits, 0)                      AS credits_purchased,
            COALESCE(s.credits, 0)                      AS credits_spent
        FROM purchased p
        FULL OUTER JOIN spent s
          ON s.period = p.period AND s.currency_code = p.currency_code
        ORDER BY period, currency_code
    """
    return MetricQuery("credits_flow", sql, params)


def revenue(principal: Principal, window: Window, grain: Grain) -> MetricQuery:
    params = window.params()
    g = Grain(grain).value
    sql = f"""
        SELECT
            DATE_TRUNC('{g}', occurred_at)::DATE  AS period,
            currency_code,
            COUNT(*)                              AS purchases,
            SUM(credits)                          AS credits,
            SUM(amount_paise)                     AS revenue_paise
        FROM CORE.FCT_CREDIT_PURCHASES
        WHERE {_window("occurred_at")}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
    return MetricQuery("revenue", sql, params)


def campaign_funnel(principal: Principal, scope: Scope, window: Window) -> MetricQuery:
    params = window.params()
    f = _scoped(scope, principal, params)
    sql = f"""
        SELECT
            module_code,
            COUNT(*)                                                 AS campaigns_created,
            COUNT_IF(status = 'funded')                              AS campaigns_funded,
            ROUND(COUNT_IF(status = 'funded') / NULLIF(COUNT(*), 0), 4) AS funding_rate,
            ROUND(AVG(funded_credits), 2)                            AS avg_funded_credits,
            ROUND(AVG(DATEDIFF('minute', created_at, funded_at)) / 60, 2)
                                                                     AS avg_hours_to_fund
        FROM CORE.FCT_CAMPAIGNS
        WHERE {_window("created_at")}{f}
        GROUP BY module_code
        ORDER BY campaigns_created DESC
    """
    return MetricQuery("campaign_funnel", sql, params)


def top_spenders(principal: Principal, window: Window, limit: int) -> MetricQuery:
    params = window.params() | {"limit": int(limit)}
    # `email` is selected unconditionally: the PII tag's masking policy decides
    # whether the caller sees an address or a pseudonym. The API does not get
    # a vote, so it cannot get it wrong.
    sql = f"""
        SELECT
            f.user_id,
            u.email,
            COUNT(*)        AS campaigns_funded,
            SUM(f.credits)  AS credits_spent
        FROM CORE.FCT_CAMPAIGN_FUNDINGS f
        LEFT JOIN CORE.DIM_USERS u ON u.user_id = f.user_id
        WHERE {_window("f.occurred_at")}
        GROUP BY f.user_id, u.email
        ORDER BY credits_spent DESC, f.user_id
        LIMIT %(limit)s
    """
    return MetricQuery("top_spenders", sql, params)


def signups(principal: Principal, window: Window, grain: Grain) -> MetricQuery:
    params = window.params()
    g = Grain(grain).value
    sql = f"""
        SELECT
            DATE_TRUNC('{g}', registered_at)::DATE AS period,
            platform_role,
            COUNT(*)                               AS signups
        FROM CORE.DIM_USERS
        WHERE {_window("registered_at")}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
    return MetricQuery("signups", sql, params)


def access_log(limit: int) -> MetricQuery:
    sql = """
        SELECT occurred_at, request_id, user_id, platform_role, snowflake_role, resource,
               outcome, cache_hit, row_count, duration_ms
        FROM GOVERNANCE.API_ACCESS_LOG
        ORDER BY occurred_at DESC
        LIMIT %(limit)s
    """
    return MetricQuery("access_log", sql, {"limit": int(limit)})


def policy_references() -> MetricQuery:
    sql = """
        SELECT policy_name, policy_kind, object_name, ref_column_name, tag_name, policy_status
        FROM GOVERNANCE.V_POLICY_REFERENCES
        ORDER BY policy_kind, object_name, ref_column_name
    """
    return MetricQuery("policy_references", sql, {})
