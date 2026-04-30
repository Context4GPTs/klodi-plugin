//! Cross-language consumer-config equivalence example (Rust half).
//!
//! Per design Section 6 / P-CON axis: TS / Py / Rust clients each bind
//! to two server-managed durable consumers (notifications + channels)
//! provisioned by the marketplace at
//! `services/marketplace/src/channels-stream.ts`. The clients no longer
//! carry `CONSUMER.CREATE` permissions (D5/D7), so this test verifies
//! each language's *expectation* of the canonical config matches the
//! other two — surfacing any drift in a per-language hardcoded copy.
//!
//! Canonical values mirror `channels-stream.ts`:
//!   ack_wait:           30 s
//!   max_ack_pending:    1
//!   max_deliver:        5
//!   deliver_policy:     "all"
//!   ack_policy:         "explicit"
//!   replay_policy:      "instant"  (NATS default)
//!   inactive_threshold: 7 d (notifications) / 90 d (channels)
//!
//! Times are reported as nanoseconds — JetStream's wire format for
//! `ack_wait` and `inactive_threshold`.

use serde_json::{json, to_string};

const NS_PER_SECOND: u64 = 1_000_000_000;
const SECONDS_PER_DAY: u64 = 24 * 60 * 60;

const ACK_WAIT_NS: u64 = 30 * NS_PER_SECOND;
const NOTIFICATIONS_INACTIVE_NS: u64 = 7 * SECONDS_PER_DAY * NS_PER_SECOND;
const CHANNELS_INACTIVE_NS: u64 = 90 * SECONDS_PER_DAY * NS_PER_SECOND;

fn shared() -> serde_json::Value {
    // BTreeMap-backed Value (via the `json!` macro on a literal object)
    // serializes alphabetically — same canonical form Py / TS produce
    // after their sorted-keys pass.
    json!({
        "ack_policy": "explicit",
        "ack_wait": ACK_WAIT_NS,
        "deliver_policy": "all",
        "max_ack_pending": 1,
        "max_deliver": 5,
        "replay_policy": "instant",
    })
}

fn with_inactive(base: &serde_json::Value, ns: u64) -> serde_json::Value {
    let mut out = base.clone();
    out["inactive_threshold"] = json!(ns);
    out
}

fn main() {
    let base = shared();
    let payload = json!({
        "channels": with_inactive(&base, CHANNELS_INACTIVE_NS),
        "notifications": with_inactive(&base, NOTIFICATIONS_INACTIVE_NS),
    });
    // serde_json::to_string emits keys in insertion order; we built the
    // outer map alphabetically (channels before notifications) so the
    // bytes match Py / TS canonical form.
    println!("{}", to_string(&payload).expect("serialize"));
}
