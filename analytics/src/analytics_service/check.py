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
            "Snowflake rejected the key: compare 'Key fingerprint' above with "
            "RSA_PUBLIC_KEY_FP in DESC USER; if they differ, redo ALTER USER ... RSA_PUBLIC_KEY. "
            "If they match, check the clock line above"
        )
    if "Incorrect username or password" in text or "250001" in text or "404" in text:
        return "SNOWFLAKE_ACCOUNT looks wrong; use the account identifier, e.g. ABCDEFG-XY12345"
    if "CORE." in text and "does not exist" in text:
        return "CORE views missing: run 03_core_views.sql and then 04_governance.sql"
    if "does not exist or not authorized" in text:
        return (
            "an object or grant is missing; "
            "re-run the snowflake/*.sql scripts in order as ACCOUNTADMIN"
        )
    if "No such file" in text or "private key" in text.lower():
        return "the key file was not found at SNOWFLAKE_PRIVATE_KEY_PATH"
    return "see the error above"


def _key_fingerprint(path: str | None, passphrase: Any) -> str:
    """SHA256 fingerprint of the public half, in Snowflake's RSA_PUBLIC_KEY_FP format."""
    import base64
    import hashlib
    from pathlib import Path

    from cryptography.hazmat.primitives import serialization

    if not path:
        return "(no SNOWFLAKE_PRIVATE_KEY_PATH)"
    key = serialization.load_pem_private_key(
        Path(path).read_bytes(),
        password=passphrase.get_secret_value().encode() if passphrase else None,
    )
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return "SHA256:" + base64.b64encode(hashlib.sha256(der).digest()).decode()


def _clock_skew_s(account: str) -> float | None:
    """Seconds this machine's clock is ahead of Snowflake's (from the HTTP Date header)."""
    import email.utils
    import time
    import urllib.error
    import urllib.request

    url = f"https://{account}.snowflakecomputing.com/"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:  # noqa: S310 - fixed https URL
            date = response.headers.get("Date")
    except urllib.error.HTTPError as error:
        date = error.headers.get("Date")
    except Exception:  # noqa: BLE001 - network trouble shows up in the login checks
        return None
    if not date:
        return None
    return time.time() - email.utils.parsedate_to_datetime(date).timestamp()


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
    print(f"Key file:          {s.snowflake_private_key_path}")
    try:
        fingerprint = _key_fingerprint(
            s.snowflake_private_key_path, s.snowflake_private_key_passphrase
        )
    except Exception as error:  # noqa: BLE001
        fingerprint = f"(could not read key: {error})"
    print(f"Key fingerprint:   {fingerprint}")
    print("                   must equal RSA_PUBLIC_KEY_FP from: DESC USER ANALYTICS_API_SVC;")
    skew = _clock_skew_s(s.snowflake_account) if s.snowflake_account else None
    if skew is None:
        print("Clock:             could not compare with Snowflake")
    elif abs(skew) > 30:
        print(
            f"Clock:             OFF BY {skew:+.0f}s vs Snowflake. Key-pair logins fail when the "
            "clock is wrong; restart Docker Desktop (or run `wsl --shutdown` on Windows)."
        )
    else:
        print(f"Clock:             ok ({skew:+.1f}s vs Snowflake)")
    print()
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

    print("\nGovernance (as ANALYTICS_ANALYST, who must NOT see emails or money):")

    def masking_check() -> str:
        conn = connect(
            s,
            user=s.snowflake_api_user,
            role=SNOWFLAKE_ROLES["analyst"],
            warehouse=s.snowflake_warehouse,
        )
        try:
            leaked_emails = _scalar(conn, "SELECT COUNT_IF(email LIKE '%@%') FROM CORE.DIM_USERS")
            leaked_amounts = _scalar(
                conn,
                "SELECT COUNT_IF(amount_paise IS NOT NULL) FROM CORE.FCT_CREDIT_PURCHASES",
            )
        finally:
            conn.close()
        if leaked_emails or leaked_amounts:
            raise RuntimeError(
                f"{leaked_emails} real email(s) and {leaked_amounts} amount(s) visible to an "
                "analyst; re-run snowflake/04_governance.sql"
            )
        return "emails pseudonymised, amounts hidden"

    results.append(_check("masking", masking_check))

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed.")
    if passed == len(results):
        print("Snowflake is ready: docker compose --profile analytics up -d --build")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    run()
