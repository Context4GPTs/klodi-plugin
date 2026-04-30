/**
 * Cross-language consumer-config equivalence example (TS half).
 *
 * Per design Section 6 / P-CON axis: TS / Py / Rust clients each bind
 * to two server-managed durable consumers (notifications + channels)
 * provisioned by the marketplace at
 * `services/marketplace/src/channels-stream.ts`. The clients no longer
 * carry `CONSUMER.CREATE` permissions (D5/D7), so this test verifies
 * each language's *expectation* of the canonical config matches the
 * other two — surfacing any drift in a per-language hardcoded copy.
 *
 * Canonical values mirror `channels-stream.ts`:
 *   ack_wait:           30 s
 *   max_ack_pending:    1
 *   max_deliver:        5
 *   deliver_policy:     "all"
 *   ack_policy:         "explicit"
 *   replay_policy:      "instant"  (NATS default)
 *   inactive_threshold: 7 d (notifications) / 90 d (channels)
 *
 * Times are reported as nanoseconds — JetStream's wire format for
 * `ack_wait` and `inactive_threshold`.
 */

const NS_PER_SECOND = 1_000_000_000;
const SECONDS_PER_DAY = 24 * 60 * 60;

const ACK_WAIT_NS = 30 * NS_PER_SECOND;
const NOTIFICATIONS_INACTIVE_NS = 7 * SECONDS_PER_DAY * NS_PER_SECOND;
const CHANNELS_INACTIVE_NS = 90 * SECONDS_PER_DAY * NS_PER_SECOND;

const sharedConsumerConfig = {
  ack_policy: "explicit",
  ack_wait: ACK_WAIT_NS,
  deliver_policy: "all",
  max_ack_pending: 1,
  max_deliver: 5,
  replay_policy: "instant",
};

const payload = {
  channels: {
    ...sharedConsumerConfig,
    inactive_threshold: CHANNELS_INACTIVE_NS,
  },
  notifications: {
    ...sharedConsumerConfig,
    inactive_threshold: NOTIFICATIONS_INACTIVE_NS,
  },
};

// Stable sorted-key emit so the canonical-JSON comparator the
// orchestrator uses reads the same bytes regardless of TS object-spread
// ordering quirks. JSON.stringify with the keys sorted manually is the
// shortest cross-version-stable path.
const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

process.stdout.write(JSON.stringify(sortKeysDeep(payload)) + "\n");
