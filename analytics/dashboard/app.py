"""Analytics dashboard (Streamlit).

The dashboard holds no credentials and never talks to Snowflake directly. It
signs the user in against the backend, then calls the analytics API with the
user's own token — so every tile is subject to the same RBAC, cache scoping,
Snowflake masking/row access policies and audit trail as any other client.
What a user sees here is exactly what their role is entitled to, and nothing
on this page can widen that.

Run:  streamlit run dashboard/app.py
"""

from __future__ import annotations

import datetime as dt
import os
from typing import Any

import altair as alt
import httpx
import pandas as pd
import streamlit as st

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:4000")
ANALYTICS_URL = os.environ.get("ANALYTICS_API_URL", "http://localhost:8000")

# Colour follows the entity (currency), never its rank: a filter that hides a
# currency must not repaint the others. Validated for CVD separation; two
# slots are below 3:1 contrast, so every chart ships with a table view.
CURRENCY_COLORS = {
    "campaign": "#2a78d6",
    "report": "#eb6834",
    "discovery": "#1baf7a",
}
FALLBACK_COLOR = "#eda100"

st.set_page_config(page_title="Platform Analytics", page_icon="📊", layout="wide")


# ── API client ─────────────────────────────────────────────────────────────
class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code = status, code


def login(email: str, password: str) -> str:
    r = httpx.post(
        f"{BACKEND_URL}/api/auth/login", json={"email": email, "password": password}, timeout=10
    )
    if r.status_code != 200:
        raise ApiError(r.status_code, "LOGIN_FAILED", "Email or password is incorrect.")
    return r.json()["token"]


def api(path: str, **params: Any) -> dict[str, Any]:
    r = httpx.get(
        f"{ANALYTICS_URL}{path}",
        params={k: v for k, v in params.items() if v is not None},
        headers={"Authorization": f"Bearer {st.session_state['token']}"},
        timeout=60,
    )
    if r.status_code != 200:
        err = (
            r.json().get("error", {})
            if r.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        raise ApiError(r.status_code, err.get("code", "ERROR"), err.get("message", r.text))
    return r.json()


def frame(result: dict[str, Any]) -> pd.DataFrame:
    return pd.DataFrame(result.get("rows", []))


def color_scale(values: list[str]) -> alt.Scale:
    domain = sorted(set(values))
    return alt.Scale(domain=domain, range=[CURRENCY_COLORS.get(v, FALLBACK_COLOR) for v in domain])


def with_table(df: pd.DataFrame, label: str = "Show table") -> None:
    with st.expander(label):
        st.dataframe(df, use_container_width=True, hide_index=True)


def cached_badge(result: dict[str, Any]) -> None:
    st.caption(
        ("Served from cache" if result.get("cached") else "Fresh from Snowflake")
        + f" · request {result.get('request_id', '')[:8]}"
    )


def guarded(render) -> None:
    """Renders a tile; a 403 becomes a quiet notice, other failures an error."""
    try:
        render()
    except ApiError as error:
        if error.status == 403:
            st.info("Your role does not include this view.")
        elif error.status == 401:
            st.session_state.pop("token", None)
            st.warning("Session expired — sign in again.")
        else:
            st.error(f"{error.code}: {error}")


# ── Sign-in ────────────────────────────────────────────────────────────────
if "token" not in st.session_state:
    st.title("Platform Analytics")
    with st.form("login"):
        email = st.text_input("Email")
        password = st.text_input("Password", type="password")
        if st.form_submit_button("Sign in"):
            try:
                st.session_state["token"] = login(email, password)
                st.rerun()
            except (ApiError, httpx.HTTPError) as error:
                st.error(str(error))
    st.stop()

try:
    me = api("/v1/me")
except ApiError:
    st.session_state.pop("token", None)
    st.rerun()

perms = set(me["permissions"])
platform_allowed = "metrics:platform:read" in perms

# ── Filters (one row, above the charts) ────────────────────────────────────
st.title("Platform Analytics")
st.caption(
    f"Signed in as user {me['user_id']} · role **{me['role']}** "
    f"(Snowflake role `{me['snowflake_role']}`)"
)

c1, c2, c3, c4 = st.columns([2, 1, 1, 1])
today = dt.date.today()
date_range = c1.date_input("Date range", (today - dt.timedelta(days=29), today), max_value=today)
grain = c2.selectbox("Grain", ["day", "week", "month"])
scope = c3.selectbox(
    "Scope",
    ["platform", "own"] if platform_allowed else ["own"],
    format_func=lambda s: "Whole platform" if s == "platform" else "My account",
)
if c4.button("Sign out"):
    st.session_state.pop("token", None)
    st.rerun()

if not isinstance(date_range, tuple) or len(date_range) != 2:
    st.stop()
window = {"from": date_range[0].isoformat(), "to": date_range[1].isoformat()}

tabs = ["Overview", "Credits", "Campaigns"]
if "revenue:read" in perms:
    tabs.append("Revenue")
if "users:read" in perms:
    tabs.append("Users")
if "governance:read" in perms:
    tabs.append("Governance")
tab = dict(zip(tabs, st.tabs(tabs), strict=True))


# ── Overview ───────────────────────────────────────────────────────────────
def render_overview() -> None:
    result = api("/v1/metrics/overview", scope=scope, **window)
    row = (result["rows"] or [{}])[0]
    tiles = [
        ("Credits purchased", row.get("credits_purchased")),
        ("Credits spent", row.get("credits_spent")),
        ("Campaigns created", row.get("campaigns_created")),
        ("Campaigns funded", row.get("campaigns_funded")),
    ]
    if scope == "platform":
        tiles = [
            ("Total users", row.get("total_users")),
            ("New users", row.get("new_users")),
            *tiles,
        ]
    if row.get("revenue_paise") is not None:
        tiles.append(("Revenue (₹)", f"{row['revenue_paise'] / 100:,.2f}"))
    for col, (label, value) in zip(st.columns(len(tiles)), tiles, strict=True):
        col.metric(
            label, "—" if value is None else (f"{value:,}" if isinstance(value, int) else value)
        )
    cached_badge(result)


with tab["Overview"]:
    guarded(render_overview)


# ── Credits ────────────────────────────────────────────────────────────────
def render_credits() -> None:
    result = api("/v1/metrics/credits-flow", scope=scope, grain=grain, **window)
    df = frame(result)
    if df.empty:
        st.info("No credit movement in this window.")
        return
    df["period"] = pd.to_datetime(df["period"])
    scale = color_scale(df["currency_code"].tolist())
    # Two charts, one axis each — purchased and spent are compared within a
    # chart by currency, never on a shared dual axis.
    for measure, title in (
        ("credits_purchased", "Credits purchased"),
        ("credits_spent", "Credits spent"),
    ):
        chart = (
            alt.Chart(df, title=title)
            .mark_line(point=alt.OverlayMarkDef(size=64), strokeWidth=2)
            .encode(
                x=alt.X("period:T", title=None),
                y=alt.Y(f"{measure}:Q", title="Credits"),
                color=alt.Color("currency_code:N", scale=scale, title="Currency"),
                tooltip=[
                    alt.Tooltip("period:T", title="Period"),
                    alt.Tooltip("currency_code:N", title="Currency"),
                    alt.Tooltip(f"{measure}:Q", title=title, format=","),
                ],
            )
            .properties(height=260)
        )
        st.altair_chart(chart, use_container_width=True)
    with_table(df)
    cached_badge(result)


with tab["Credits"]:
    guarded(render_credits)


# ── Campaigns ──────────────────────────────────────────────────────────────
def render_campaigns() -> None:
    result = api("/v1/metrics/campaign-funnel", scope=scope, **window)
    df = frame(result)
    if df.empty:
        st.info("No campaigns created in this window.")
        return
    long = df.melt(
        id_vars="module_code",
        value_vars=["campaigns_created", "campaigns_funded"],
        var_name="stage",
        value_name="campaigns",
    )
    long["stage"] = long["stage"].map(
        {"campaigns_created": "Created", "campaigns_funded": "Funded"}
    )
    chart = (
        alt.Chart(long, title="Campaign funnel by module")
        .mark_bar(cornerRadiusEnd=4, size=28)
        .encode(
            y=alt.Y("module_code:N", title=None),
            x=alt.X("campaigns:Q", title="Campaigns"),
            yOffset="stage:N",
            color=alt.Color(
                "stage:N",
                scale=alt.Scale(domain=["Created", "Funded"], range=["#86b6ef", "#1c5cab"]),
                title="Stage",
            ),
            tooltip=["module_code", "stage", alt.Tooltip("campaigns:Q", format=",")],
        )
        .properties(height=max(160, 70 * len(df)))
    )
    st.altair_chart(chart, use_container_width=True)
    with_table(df)
    cached_badge(result)


with tab["Campaigns"]:
    guarded(render_campaigns)


# ── Revenue (finance, admin) ───────────────────────────────────────────────
def render_revenue() -> None:
    result = api("/v1/metrics/revenue", grain=grain, **window)
    df = frame(result)
    if df.empty:
        st.info("No purchases in this window.")
        return
    df["period"] = pd.to_datetime(df["period"])
    df["revenue_inr"] = df["revenue_paise"].astype("float") / 100
    chart = (
        alt.Chart(df, title="Revenue (₹)")
        .mark_bar(cornerRadiusTopLeft=4, cornerRadiusTopRight=4)
        .encode(
            x=alt.X("period:T", title=None),
            y=alt.Y("sum(revenue_inr):Q", title=None, stack="zero"),
            color=alt.Color(
                "currency_code:N", scale=color_scale(df["currency_code"].tolist()), title="Currency"
            ),
            tooltip=[
                alt.Tooltip("period:T"),
                "currency_code",
                alt.Tooltip("revenue_inr:Q", title="₹", format=",.2f"),
                alt.Tooltip("purchases:Q", format=","),
            ],
        )
        .properties(height=300)
    )
    st.altair_chart(chart, use_container_width=True)
    with_table(df)
    cached_badge(result)


if "Revenue" in tab:
    with tab["Revenue"]:
        guarded(render_revenue)


# ── Users (analyst, finance, admin) ────────────────────────────────────────
def render_users() -> None:
    left, right = st.columns(2)
    with left:
        st.subheader("Top spenders")
        result = api("/v1/metrics/top-spenders", limit=20, **window)
        st.dataframe(frame(result), use_container_width=True, hide_index=True)
        if "pii:read" not in perms:
            st.caption("Emails are pseudonymised by Snowflake for your role.")
        cached_badge(result)
    with right:
        st.subheader("Signups")
        result = api("/v1/metrics/signups", grain=grain, **window)
        df = frame(result)
        if df.empty:
            st.info("No signups in this window.")
        else:
            df["period"] = pd.to_datetime(df["period"])
            totals = df.groupby("period", as_index=False)["signups"].sum()
            chart = (
                alt.Chart(totals)
                .mark_bar(cornerRadiusTopLeft=4, cornerRadiusTopRight=4, color="#2a78d6")
                .encode(
                    x=alt.X("period:T", title=None),
                    y=alt.Y("signups:Q", title="Signups"),
                    tooltip=[alt.Tooltip("period:T"), "signups"],
                )
                .properties(height=260)
            )
            st.altair_chart(chart, use_container_width=True)
            with_table(df)


if "Users" in tab:
    with tab["Users"]:
        guarded(render_users)


# ── Governance (admin) ─────────────────────────────────────────────────────
def render_governance() -> None:
    policies = api("/v1/governance/policies")
    st.subheader("Role → permission matrix")
    matrix = pd.DataFrame(
        [
            {
                "role": role,
                "snowflake_role": v["snowflake_role"],
                "permissions": ", ".join(v["permissions"]),
            }
            for role, v in policies["rbac"].items()
        ]
    )
    st.dataframe(matrix, use_container_width=True, hide_index=True)

    st.subheader("Policies attached in Snowflake")
    st.dataframe(
        pd.DataFrame(policies["warehouse_policies"]), use_container_width=True, hide_index=True
    )

    st.subheader("Recent API access")
    log = frame(api("/v1/governance/access-log", limit=200))
    st.dataframe(log, use_container_width=True, hide_index=True)

    if st.button("Invalidate analytics cache"):
        r = httpx.post(
            f"{ANALYTICS_URL}/v1/admin/cache/invalidate",
            headers={"Authorization": f"Bearer {st.session_state['token']}"},
            timeout=10,
        )
        st.success(f"Cache version is now {r.json().get('data_version')}.")


if "Governance" in tab:
    with tab["Governance"]:
        guarded(render_governance)
