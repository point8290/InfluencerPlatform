"""Verifies the backend's access tokens.

The analytics service is a RESOURCE SERVER: it trusts tokens minted by the
backend (backend/src/lib/jwt.ts) and never issues its own. Algorithm pinning
mirrors the backend exactly — HS256 only, never taken from the token header.
"""

from __future__ import annotations

from typing import get_args

import jwt

from .events import PlatformRole
from .rbac import Principal

ALGORITHM = "HS256"
_VALID_ROLES = frozenset(get_args(PlatformRole))


class AuthenticationError(Exception):
    """Every token failure collapses to this; callers learn only 'rejected'."""


def principal_from_token(token: str, secret: str) -> Principal:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[ALGORITHM],
            options={"require": ["sub", "exp"]},
        )
    except jwt.PyJWTError as error:
        raise AuthenticationError("Invalid or expired token.") from error

    try:
        user_id = int(claims["sub"])
    except (TypeError, ValueError) as error:
        raise AuthenticationError("Invalid or expired token.") from error
    if user_id <= 0:
        raise AuthenticationError("Invalid or expired token.")

    # Tokens issued before roles existed carry no claim: least privilege.
    # A claim naming an unknown role is not "member" — it is a token we did
    # not mint, so it is rejected outright rather than downgraded.
    role = claims.get("role", "member")
    if role not in _VALID_ROLES:
        raise AuthenticationError("Invalid or expired token.")

    return Principal(user_id=user_id, role=role)
