"""Redis read-through cache for warehouse query results.

INVALIDATION BY VERSION, NOT BY DELETE.

Every key embeds a global data version. The Kafka consumer INCRs the version
after each batch it commits to Snowflake, so the next request computes under a
new key and the old entries simply age out on their TTL. There is no
key-scanning DEL, and no window where a reader can repopulate a key with data
that predates the write that was supposed to invalidate it.

The TTL is the upper bound on staleness if the version bump itself is lost
(Redis down at the moment of the bump): correctness never depends on Redis.

FAIL OPEN. Redis is an optimisation. If it is unreachable, requests go straight
to Snowflake — slower and more expensive, but correct, because the role the
query runs under (and therefore every masking policy) is unaffected.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import redis

log = logging.getLogger(__name__)

VERSION_KEY = "analytics:data_version"
KEY_PREFIX = "analytics:metric"
LOCK_TTL_S = 30
LOCK_WAIT_S = 2.0
LOCK_POLL_S = 0.05


@dataclass(frozen=True, slots=True)
class CacheResult:
    value: Any
    hit: bool


def _params_digest(params: dict[str, Any]) -> str:
    canonical = json.dumps(params, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:24]


class MetricCache:
    def __init__(self, client: redis.Redis, ttl_s: int) -> None:
        self._redis = client
        self._ttl_s = ttl_s

    def data_version(self) -> int:
        raw = self._redis.get(VERSION_KEY)
        return int(raw) if raw is not None else 0

    def bump_version(self) -> int | None:
        """Called by the consumer after a successful load. Best effort."""
        try:
            return int(self._redis.incr(VERSION_KEY))
        except redis.RedisError:
            log.warning("cache version bump failed; entries will expire on TTL", exc_info=True)
            return None

    def key(self, version: int, metric: str, scope: str, params: dict[str, Any]) -> str:
        return f"{KEY_PREFIX}:v{version}:{metric}:{scope}:{_params_digest(params)}"

    def get_or_compute(
        self,
        metric: str,
        scope: str,
        params: dict[str, Any],
        compute: Callable[[], Any],
    ) -> CacheResult:
        try:
            key = self.key(self.data_version(), metric, scope, params)
            cached = self._redis.get(key)
        except redis.RedisError:
            log.warning("cache unavailable; serving %s uncached", metric, exc_info=True)
            return CacheResult(compute(), hit=False)

        if cached is not None:
            return CacheResult(json.loads(cached), hit=True)

        # Single-flight: only the lock holder queries Snowflake. Everyone else
        # waits briefly for its result, so a cold popular dashboard tile costs
        # one warehouse query rather than one per concurrent viewer.
        lock_key = f"{key}:lock"
        try:
            have_lock = bool(self._redis.set(lock_key, "1", nx=True, ex=LOCK_TTL_S))
        except redis.RedisError:
            have_lock = False

        if not have_lock:
            deadline = time.monotonic() + LOCK_WAIT_S
            while time.monotonic() < deadline:
                time.sleep(LOCK_POLL_S)
                try:
                    cached = self._redis.get(key)
                except redis.RedisError:
                    break
                if cached is not None:
                    return CacheResult(json.loads(cached), hit=True)
            # The holder is slow or died: compute rather than fail the request.

        try:
            value = compute()
            try:
                self._redis.set(key, json.dumps(value, default=str), ex=self._ttl_s)
            except redis.RedisError:
                log.warning("cache write failed for %s", metric, exc_info=True)
            return CacheResult(value, hit=False)
        finally:
            if have_lock:
                try:
                    self._redis.delete(lock_key)
                except redis.RedisError:
                    pass
