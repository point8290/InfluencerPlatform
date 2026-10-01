"""Service configuration, read once from the environment.

Every setting has an ANALYTICS_-free, explicit env name so the same variables
can be shared with the Node backend where they overlap (JWT_SECRET,
KAFKA_BROKERS, KAFKA_TOPIC_PREFIX).
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    environment: str = Field("development", alias="ENVIRONMENT")

    # ── Auth ────────────────────────────────────────────────────────────────
    # The SAME secret the backend signs access tokens with. The analytics API
    # never issues tokens; it only verifies the backend's.
    jwt_secret: SecretStr = Field(alias="JWT_SECRET")

    # ── Kafka ───────────────────────────────────────────────────────────────
    kafka_brokers: str = Field("localhost:9094", alias="KAFKA_BROKERS")
    kafka_topic_prefix: str = Field("platform", alias="KAFKA_TOPIC_PREFIX")
    kafka_consumer_group: str = Field("analytics-snowflake-loader", alias="KAFKA_CONSUMER_GROUP")
    kafka_batch_size: int = Field(500, alias="KAFKA_BATCH_SIZE")
    kafka_batch_timeout_s: float = Field(5.0, alias="KAFKA_BATCH_TIMEOUT_S")

    # ── Redis ───────────────────────────────────────────────────────────────
    redis_url: str = Field("redis://localhost:6379/0", alias="REDIS_URL")
    cache_ttl_s: int = Field(300, alias="CACHE_TTL_S")

    # ── Snowflake ───────────────────────────────────────────────────────────
    snowflake_account: str = Field("", alias="SNOWFLAKE_ACCOUNT")
    snowflake_warehouse: str = Field("ANALYTICS_WH", alias="SNOWFLAKE_WAREHOUSE")
    snowflake_database: str = Field("INFLUENCER_ANALYTICS", alias="SNOWFLAKE_DATABASE")
    # Loader service user (consumer). Writes RAW; reads nothing else.
    snowflake_loader_user: str = Field("ANALYTICS_LOADER_SVC", alias="SNOWFLAKE_LOADER_USER")
    snowflake_loader_role: str = Field("ANALYTICS_LOADER", alias="SNOWFLAKE_LOADER_ROLE")
    snowflake_loader_warehouse: str = Field("INGEST_WH", alias="SNOWFLAKE_LOADER_WAREHOUSE")
    # API service user. Granted every functional reader role; each query runs
    # under the role mapped from the caller's platform role (see rbac.py).
    snowflake_api_user: str = Field("ANALYTICS_API_SVC", alias="SNOWFLAKE_API_USER")
    # Key-pair auth (recommended for service users) or password, not both.
    snowflake_private_key_path: str | None = Field(None, alias="SNOWFLAKE_PRIVATE_KEY_PATH")
    snowflake_private_key_passphrase: SecretStr | None = Field(
        None, alias="SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"
    )
    snowflake_password: SecretStr | None = Field(None, alias="SNOWFLAKE_PASSWORD")

    # ── API ─────────────────────────────────────────────────────────────────
    api_host: str = Field("0.0.0.0", alias="ANALYTICS_API_HOST")  # noqa: S104
    api_port: int = Field(8000, alias="ANALYTICS_API_PORT")
    cors_origins: str = Field("http://localhost:5173,http://localhost:8501", alias="CORS_ORIGINS")

    @field_validator("jwt_secret")
    @classmethod
    def _secret_not_blank(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("JWT_SECRET must be set to the backend's signing secret.")
        return value

    @property
    def topics(self) -> dict[str, str]:
        p = self.kafka_topic_prefix
        return {
            "users": f"{p}.users.v1",
            "payments": f"{p}.payments.v1",
            "campaigns": f"{p}.campaigns.v1",
            "audit": f"{p}.analytics-audit.v1",
            "dead_letter": f"{p}.analytics-dlq.v1",
        }

    @property
    def domain_topics(self) -> list[str]:
        t = self.topics
        return [t["users"], t["payments"], t["campaigns"]]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
