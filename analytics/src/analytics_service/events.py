"""The event contract shared with the backend's transactional outbox.

Mirrors backend/src/outbox/events.ts and backend/src/outbox/relay.ts. Payloads
are validated strictly on the way in: an event that does not match its schema
is dead-lettered rather than loaded, so a producer bug shows up as a DLQ
message instead of as quietly wrong numbers on a dashboard.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

PlatformRole = Literal["member", "analyst", "finance", "admin"]

SUPPORTED_SCHEMA_VERSIONS = frozenset({1})

NonNegativeInt = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(gt=0)]


class _Payload(BaseModel):
    # Unknown fields are tolerated (forward-compatible: a producer may add
    # optional fields before the consumer learns them); wrong types are not.
    model_config = ConfigDict(extra="allow", strict=True)


class UserRegistered(_Payload):
    user_id: PositiveInt
    email: str
    role: PlatformRole


class UserRoleChanged(_Payload):
    user_id: PositiveInt
    previous_role: PlatformRole
    role: PlatformRole


class CreditsPurchased(_Payload):
    payment_id: PositiveInt
    user_id: PositiveInt
    wallet_id: PositiveInt
    currency_code: str
    module_code: str
    purchase_kind: str
    plan_id: PositiveInt | None
    credits: PositiveInt
    amount_paise: NonNegativeInt


class CampaignCreated(_Payload):
    campaign_id: PositiveInt
    user_id: PositiveInt
    module_code: str


class CampaignFunded(_Payload):
    campaign_id: PositiveInt
    user_id: PositiveInt
    wallet_id: PositiveInt
    currency_code: str
    module_code: str
    credits: PositiveInt
    balance_after: NonNegativeInt


PAYLOAD_MODELS: dict[str, type[_Payload]] = {
    "user.registered": UserRegistered,
    "user.role_changed": UserRoleChanged,
    "credits.purchased": CreditsPurchased,
    "campaign.created": CampaignCreated,
    "campaign.funded": CampaignFunded,
}


class EventEnvelope(BaseModel):
    model_config = ConfigDict(extra="ignore")

    event_id: Annotated[str, Field(min_length=36, max_length=36)]
    event_type: str
    schema_version: int
    occurred_at: datetime
    producer: str
    aggregate_type: str
    aggregate_id: str
    payload: dict[str, Any]


class InvalidEvent(Exception):
    """Raised for a message that can never be loaded, however often it is retried."""


def parse_event(raw: bytes | str) -> EventEnvelope:
    """Parses and validates one Kafka message value. Raises InvalidEvent."""
    try:
        envelope = EventEnvelope.model_validate_json(raw)
    except ValidationError as error:
        raise InvalidEvent(f"malformed envelope: {error.error_count()} error(s)") from error

    if envelope.schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise InvalidEvent(f"unsupported schema_version {envelope.schema_version}")

    model = PAYLOAD_MODELS.get(envelope.event_type)
    if model is None:
        raise InvalidEvent(f"unknown event_type {envelope.event_type!r}")

    try:
        model.model_validate(envelope.payload)
    except ValidationError as error:
        raise InvalidEvent(
            f"{envelope.event_type} payload failed validation: {error.error_count()} error(s)"
        ) from error

    return envelope
