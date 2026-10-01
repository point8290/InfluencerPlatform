from __future__ import annotations

import datetime as dt

import jwt
import pytest

from analytics_service.auth import AuthenticationError, principal_from_token
from analytics_service.rbac import ROLE_PERMISSIONS, Permission, Principal

from .conftest import SECRET, make_token


def test_valid_token_yields_principal() -> None:
    p = principal_from_token(make_token(42, "finance"), SECRET)
    assert p == Principal(user_id=42, role="finance")
    assert p.snowflake_role == "ANALYTICS_FINANCE"


def test_token_without_role_claim_is_least_privileged_member() -> None:
    assert principal_from_token(make_token(5, None), SECRET).role == "member"


@pytest.mark.parametrize(
    "token",
    [
        make_token(1, "superuser"),  # a role we never mint
        make_token(1, "admin", sub="abc"),
        make_token(1, "admin", sub="0"),
        make_token(1, "admin", exp=dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)),
        jwt.encode({"sub": "1", "role": "admin"}, SECRET, algorithm="HS256"),  # no exp
        jwt.encode(
            {"sub": "1", "role": "admin", "exp": 9999999999}, "wrong-secret", algorithm="HS256"
        ),
        jwt.encode({"sub": "1", "role": "admin", "exp": 9999999999}, None, algorithm="none"),
        "not-a-jwt",
    ],
)
def test_bad_tokens_are_rejected(token: str) -> None:
    with pytest.raises(AuthenticationError):
        principal_from_token(token, SECRET)


def test_role_permission_matrix_is_monotonic() -> None:
    member, analyst, finance, admin = (
        ROLE_PERMISSIONS[r] for r in ("member", "analyst", "finance", "admin")
    )
    assert member < analyst < finance < admin
    assert admin == frozenset(Permission)
    # Only admin may see unmasked PII or governance data.
    for role in ("member", "analyst", "finance"):
        assert Permission.PII_READ not in ROLE_PERMISSIONS[role]  # type: ignore[index]
        assert Permission.GOVERNANCE_READ not in ROLE_PERMISSIONS[role]  # type: ignore[index]
    assert Permission.REVENUE_READ not in analyst


def test_cache_scopes_never_collide_across_roles_or_users() -> None:
    a = Principal(1, "analyst")
    f = Principal(1, "finance")
    m1, m2 = Principal(1, "member"), Principal(2, "member")
    assert a.cache_scope != f.cache_scope
    assert m1.own_cache_scope() != m2.own_cache_scope()
