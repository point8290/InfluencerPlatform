#!/bin/sh
# Creates the event topics with explicit settings. Idempotent (--if-not-exists).
set -eu

BIN=/opt/kafka/bin
P="${KAFKA_TOPIC_PREFIX:-platform}"

create() {
  # $1 topic, $2 partitions, $3 retention.ms
  "$BIN/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --create --if-not-exists \
    --topic "$1" --partitions "$2" --replication-factor 1 \
    --config retention.ms="$3" --config cleanup.policy=delete
  echo "topic ready: $1"
}

THIRTY_DAYS=2592000000
NINETY_DAYS=7776000000

# Domain events. Keyed by aggregate id, so per-user / per-campaign order holds
# within a partition. Kafka is a buffer here, not the system of record (MySQL
# is), so 30 days covers any realistic consumer outage.
create "$P.users.v1"              3 "$THIRTY_DAYS"
create "$P.payments.v1"           3 "$THIRTY_DAYS"
create "$P.campaigns.v1"          3 "$THIRTY_DAYS"
# Analytics API access audit -> GOVERNANCE.API_ACCESS_LOG.
create "$P.analytics-audit.v1"    3 "$THIRTY_DAYS"
# Events that failed validation. Longer retention: these need a human.
create "$P.analytics-dlq.v1"      1 "$NINETY_DAYS"
