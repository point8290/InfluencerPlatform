from __future__ import annotations

import threading

import fakeredis
import redis

from analytics_service.cache import MetricCache


def test_hit_after_miss() -> None:
    cache = MetricCache(fakeredis.FakeRedis(), 60)
    calls = []

    def compute():
        calls.append(1)
        return [{"a": 1}]

    assert cache.get_or_compute("m", "role:x", {"p": 1}, compute).hit is False
    hit = cache.get_or_compute("m", "role:x", {"p": 1}, compute)
    assert hit.hit is True and hit.value == [{"a": 1}]
    assert len(calls) == 1


def test_params_scope_and_version_partition_the_key_space() -> None:
    cache = MetricCache(fakeredis.FakeRedis(), 60)
    base = cache.key(0, "m", "role:analyst", {"a": 1, "b": 2})
    assert base == cache.key(0, "m", "role:analyst", {"b": 2, "a": 1})  # order-insensitive
    assert base != cache.key(0, "m", "role:admin", {"a": 1, "b": 2})
    assert base != cache.key(0, "m", "role:analyst", {"a": 2, "b": 2})
    assert base != cache.key(1, "m", "role:analyst", {"a": 1, "b": 2})


def test_version_bump_invalidates() -> None:
    cache = MetricCache(fakeredis.FakeRedis(), 60)
    cache.get_or_compute("m", "s", {}, lambda: 1)
    cache.bump_version()
    assert cache.get_or_compute("m", "s", {}, lambda: 2).value == 2


def test_entries_expire() -> None:
    r = fakeredis.FakeRedis()
    cache = MetricCache(r, 42)
    cache.get_or_compute("m", "s", {}, lambda: 1)
    assert r.ttl(cache.key(0, "m", "s", {})) == 42


class BrokenRedis:
    def __getattr__(self, _name):
        def fail(*_a, **_k):
            raise redis.ConnectionError("down")

        return fail


def test_fails_open_when_redis_is_down() -> None:
    cache = MetricCache(BrokenRedis(), 60)  # type: ignore[arg-type]
    result = cache.get_or_compute("m", "s", {}, lambda: [1])
    assert result.value == [1] and result.hit is False
    assert cache.bump_version() is None


def test_single_flight_computes_once_under_concurrency() -> None:
    cache = MetricCache(fakeredis.FakeRedis(), 60)
    calls = []
    started = threading.Event()

    def slow():
        calls.append(1)
        started.set()
        threading.Event().wait(0.2)
        return "v"

    results = []
    threads = [
        threading.Thread(target=lambda: results.append(cache.get_or_compute("m", "s", {}, slow)))
        for _ in range(5)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(calls) == 1
    assert {r.value for r in results} == {"v"}
    assert sum(r.hit for r in results) == 4
