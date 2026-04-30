#!/usr/bin/env python3
"""Cross-language consumer-config equivalence example (Py half).

Per design Section 6 / P-CON axis: TS / Py / Rust clients each bind to
two server-managed durable consumers (notifications + channels)
provisioned by the marketplace at
``services/marketplace/src/channels-stream.ts``. The clients no longer
carry ``CONSUMER.CREATE`` permissions (D5/D7), so this test verifies
each language's *expectation* of the canonical config matches the
other two — surfacing any drift in a per-language hardcoded copy.

Canonical values mirror ``channels-stream.ts``:

    ack_wait:           30 s
    max_ack_pending:    1
    max_deliver:        5
    deliver_policy:     "all"
    ack_policy:         "explicit"
    replay_policy:      "instant"  (NATS default)
    inactive_threshold: 7 d (notifications) / 90 d (channels)

Times are reported as nanoseconds — JetStream's wire format for
``ack_wait`` and ``inactive_threshold``.
"""

from __future__ import annotations

import json
import sys

NS_PER_SECOND = 1_000_000_000
SECONDS_PER_DAY = 24 * 60 * 60

ACK_WAIT_NS = 30 * NS_PER_SECOND
NOTIFICATIONS_INACTIVE_NS = 7 * SECONDS_PER_DAY * NS_PER_SECOND
CHANNELS_INACTIVE_NS = 90 * SECONDS_PER_DAY * NS_PER_SECOND


def _shared_consumer_config() -> dict[str, object]:
    return {
        "ack_policy": "explicit",
        "ack_wait": ACK_WAIT_NS,
        "deliver_policy": "all",
        "max_ack_pending": 1,
        "max_deliver": 5,
        "replay_policy": "instant",
    }


def main() -> int:
    payload = {
        "channels": {
            **_shared_consumer_config(),
            "inactive_threshold": CHANNELS_INACTIVE_NS,
        },
        "notifications": {
            **_shared_consumer_config(),
            "inactive_threshold": NOTIFICATIONS_INACTIVE_NS,
        },
    }
    # sort_keys + compact separators — matches the orchestrator's
    # canonical comparison form exactly.
    sys.stdout.write(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
