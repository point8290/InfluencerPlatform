"""Role-based access control for the analytics API.

TWO LAYERS, DELIBERATELY.

1. Application RBAC (this module). Every platform role maps to a fixed set of
   permissions, and every endpoint declares the permission it needs. A `member`
   is additionally pinned to their own rows: the user id comes from the
   verified token and is bound into the SQL as a parameter — it is never read
   from the request.

2. Warehouse governance (snowflake/04_governance.sql). Each platform role also
   maps to a Snowflake FUNCTIONAL ROLE, and every query runs under that role.
   Masking policies (email, money) and row access policies are evaluated by
   Snowflake against CURRENT_ROLE(), so even a bug in layer 1 — a missing
   permission check, a query that selects too much — cannot return a column
   the role is not entitled to. The same policies govern analysts who query
   Snowflake directly from Snowsight, so the dashboard and ad-hoc SQL can
   never disagree about who sees what.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .events import PlatformRole


class Permission(StrEnum):
    # Metrics about the caller's own wallet and campaigns.
    OWN_METRICS_READ = "metrics:own:read"
    # Platform-wide aggregates across all users.
    PLATFORM_METRICS_READ = "metrics:platform:read"
    # Money: amounts in paise, revenue series.
    REVENUE_READ = "revenue:read"
    # Per-user leaderboards. Emails within them are still masked unless PII_READ.
    USER_LEVEL_READ = "users:read"
    # Unmasked personal data (emails).
    PII_READ = "pii:read"
    # Policy catalogue, access audit log.
    GOVERNANCE_READ = "governance:read"
    # Operational controls such as cache invalidation.
    CACHE_MANAGE = "cache:manage"


ROLE_PERMISSIONS: dict[PlatformRole, frozenset[Permission]] = {
    "member": frozenset({Permission.OWN_METRICS_READ}),
    "analyst": frozenset(
        {
            Permission.OWN_METRICS_READ,
            Permission.PLATFORM_METRICS_READ,
            Permission.USER_LEVEL_READ,
        }
    ),
    "finance": frozenset(
        {
            Permission.OWN_METRICS_READ,
            Permission.PLATFORM_METRICS_READ,
            Permission.USER_LEVEL_READ,
            Permission.REVENUE_READ,
        }
    ),
    "admin": frozenset(Permission),
}

# Platform role -> Snowflake functional role (created in 01_rbac.sql).
SNOWFLAKE_ROLES: dict[PlatformRole, str] = {
    "member": "ANALYTICS_MEMBER",
    "analyst": "ANALYTICS_ANALYST",
    "finance": "ANALYTICS_FINANCE",
    "admin": "ANALYTICS_ADMIN",
}


@dataclass(frozen=True, slots=True)
class Principal:
    """The verified caller. Built only from a validated access token."""

    user_id: int
    role: PlatformRole

    @property
    def permissions(self) -> frozenset[Permission]:
        return ROLE_PERMISSIONS[self.role]

    @property
    def snowflake_role(self) -> str:
        return SNOWFLAKE_ROLES[self.role]

    def can(self, permission: Permission) -> bool:
        return permission in self.permissions

    @property
    def cache_scope(self) -> str:
        """The partition of the cache this caller may read from.

        Results are only shareable between callers who would get byte-identical
        answers. Platform aggregates depend on the role alone (masking is by
        role), so same-role callers share them. Own-scope results depend on the
        user, so they never leave that user's partition. Getting this wrong
        would let the cache serve one role's unmasked result to another.
        """
        return f"role:{self.role}"

    def own_cache_scope(self) -> str:
        return f"user:{self.user_id}"
