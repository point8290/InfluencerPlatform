"""Connection check: `analytics-check`.

Logs in to Snowflake as both service users, the way the consumer and the API
will, and reports what works. Run it before starting the analytics stack:
each failure comes with the most likely cause.
"""

from __future__ import annotations

import sys
from typing import Any

from .config import get_settings
from .rbac import SNOWFLAKE_ROLES
from .warehouse.snowflake import connect

OK, FAIL = "  [ok]  ", "  [FAIL]"


def _hint(error: Exception) -> str:
    text = str(error)
    if "JWT token is invalid" in text or "390144" in text:
        return (
            "the public key set on the user does not match your private key "
            "(redo the ALTER USER ... RSA_PUBLIC_KEY step)"
        )
    if "Incorrect username or password" in text or "250001" in text or "404" in text:
        return "SNOWFLAKE_ACCOUNT looks wrong; use the account identifier, e.g. ABCDEFG-XY12345"
    if "does not exist or not authorized" in text:
        return (
            "an object or grant is missing; "
            "re-run the snowflake/*.sql scripts in order as ACCOUNTADMIN"
        )
    if "No such file" in text or "private key" in text.lower():
        return "the key file was not found at SNOWFLAKE_PRIVATE_KEY_PATH"
    return "see the error above"


def _check(label: str, fn: Any) -> bool:
    try:
        detail = fn()
        print(f"{OK} {label}{f': {detail}' if detail else ''}")
        return True
    except Exception as error:  # noqa: BLE001 - report every failure, keep going
        print(f"{FAIL} {label}\n          {type(error).__name__}: {str(error).splitlines()[0]}")
        print(f"          hint: {_hint(error)}")
        return False


def _scalar(conn: Any, sql: str) -> Any:
    cur = conn.cursor()
    try:
        cur.execute(sql)
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        cur.close()


def run() -> None:
    s = get_settings()
    print(f"Snowflake account: {s.snowflake_account or '(SNOWFLAKE_ACCOUNT is empty!)'}")
    print(f"Key file:          {s.snowflake_private_key_path}\n")
    results: list[bool] = []

    print(f"Loader ({s.snowflake_loader_user} as {s.snowflake_loader_role}):")
    loader: dict[str, Any] = {}

    def loader_login() -> str:
        loader["conn"] = connect(
            s,
            user=s.snowflake_loader_user,
            role=s.snowflake_loader_role,
            warehouse=s.snowflake_loader_warehouse,
        )
        return str(_scalar(loader["conn"], "SELECT CURRENT_ROLE()"))

    results.append(_check("log in", loader_login))
    if "conn" in loader:
        conn = loader["conn"]
        events_sql = "SELECT COUNT(*) FROM RAW.PLATFORM_EVENTS"
        log_sql = "SELECT COUNT(*) FROM GOVERNANCE.API_ACCESS_LOG"
        results.append(
            _check(
                "read RAW.PLATFORM_EVENTS",
                lambda: f"{_scalar(conn, events_sql)} event(s) loaded so far",
            )
        )
        results.append(
            _check(
                "read GOVERNANCE.API_ACCESS_LOG",
                lambda: f"{_scalar(conn, log_sql)} access record(s)",
            )
        )
        loader["conn"].close()

    print(f"\nAPI ({s.snowflake_api_user}), one login per platform role:")
    for platform_role, sf_role in SNOWFLAKE_ROLES.items():

        def api_check(sf_role: str = sf_role) -> str:
            conn = connect(
                s, user=s.snowflake_api_user, role=sf_role, warehouse=s.snowflake_warehouse
            )
            try:
                users = _scalar(conn, "SELECT COUNT(*) FROM CORE.DIM_USERS")
                return f"{users} user(s) visible"
            finally:
                conn.close()

        results.append(_check(f"{platform_role:<8} -> {sf_role}", api_check))

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed.")
    if passed == len(results):
        print("Snowflake is ready: docker compose --profile analytics up -d --build")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    run()
