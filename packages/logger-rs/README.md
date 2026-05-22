# klodi-logger (Rust)

Rust implementation of the unified `KlodiLogger` contract from
`@klodi/tool-catalog/logging`. One contract per language (TS / Py / Rust);
three implementations.

## Use

```rust
use klodi_logger::KlodiLogger;
use std::collections::HashMap;
use serde_json::{Value, json};

let log = KlodiLogger::new("klodi-moltis");
let mut fields: HashMap<String, Value> = HashMap::new();
fields.insert("event_id".into(), json!(event_id));
fields.insert("kind".into(), json!("offer.proposed"));
log.info("wake_handler_invoked", Some(fields));
```

The contract pins three things every implementation honors:

1. The four log levels (`Debug` < `Info` < `Warn` < `Error`).
2. The redact list — field names whose values are replaced with
   `"[redacted]"` at INFO/WARN/ERROR. DEBUG bypasses redaction.
3. The required-field map per call-site type — enforced by the
   cross-language integration test, not the logger itself.

## Privacy boundary

Operator logs are redacted by construction. The eval/audit consumer
(D11) reads source events directly from the `P2P_EVENTS` JetStream
stream with full payloads — that path is governed by the spec at
`services/marketplace/docs/specs/eval-consumer.md`.

## Integration

`klodi-rust-host`'s `forwarder` module already routes the body-leak
path through this crate. New Rust adapters that need redacted logs
should construct a `KlodiLogger` and pass it through their `SharedState`
struct.
