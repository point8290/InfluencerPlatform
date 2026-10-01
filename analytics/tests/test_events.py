from __future__ import annotations

import json
import uuid

import pytest

from analytics_service.events import InvalidEvent, parse_event


def envelope(event_type: str = "credits.purchased", **payload_overrides: object) -> dict:
    payloads = {
        "credits.purchased": {
            "payment_id": 1,
            "user_id": 2,
            "wallet_id": 3,
            "currency_code": "campaign",
            "module_code": "campaigns",
            "purchase_kind": "plan",
            "plan_id": 4,
            "credits": 100,
            "amount_paise": 30000,
        },
        "user.registered": {"user_id": 2, "email": "a@example.com", "role": "member"},
        "campaign.funded": {
            "campaign_id": 9,
            "user_id": 2,
            "wallet_id": 3,
            "currency_code": "campaign",
            "module_code": "campaigns",
            "credits": 50,
            "balance_after": 50,
        },
    }
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "schema_version": 1,
        "occurred_at": "2026-10-01T10:00:00.000Z",
        "producer": "credits-wallet-backend",
        "aggregate_type": "user",
        "aggregate_id": "2",
        "payload": {**payloads[event_type], **payload_overrides},
    }


@pytest.mark.parametrize("event_type", ["credits.purchased", "user.registered", "campaign.funded"])
def test_valid_events_parse(event_type: str) -> None:
    parsed = parse_event(json.dumps(envelope(event_type)))
    assert parsed.event_type == event_type


def test_unknown_payload_fields_are_tolerated() -> None:
    parse_event(json.dumps(envelope(new_optional_field="x")))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda e: e.update(event_type="ledger.deleted"),
        lambda e: e.update(schema_version=2),
        lambda e: e.update(event_id="short"),
        lambda e: e["payload"].update(credits="100"),  # strict: no string coercion
        lambda e: e["payload"].update(credits=0),
        lambda e: e["payload"].update(amount_paise=-1),
        lambda e: e["payload"].pop("user_id"),
    ],
)
def test_invalid_events_are_rejected(mutate) -> None:
    e = envelope()
    mutate(e)
    with pytest.raises(InvalidEvent):
        parse_event(json.dumps(e))


def test_garbage_is_rejected() -> None:
    with pytest.raises(InvalidEvent):
        parse_event(b"\x00not json")
