# klodi-logger (Python)

Python implementation of the unified `KlodiLogger` contract from
`@klodi/tool-catalog/logging`. One contract per language (TS / Py / Rust);
three implementations.

## Use

```python
from klodi_logger import KlodiLogger

log = KlodiLogger("klodi-hermes")
log.info("wake_handler_invoked", {"event_id": eid, "kind": "offer.proposed"})
```

The contract pins three things every implementation honors:

1. The four log levels (`DEBUG` < `INFO` < `WARN` < `ERROR`).
2. The redact list — field names whose values are replaced with
   `"[redacted]"` at INFO/WARN/ERROR. DEBUG bypasses redaction.
3. The required-field map per call-site type — enforced by the
   cross-language integration test, not the logger itself.

## Privacy boundary

Operator logs are redacted by construction. The eval/audit consumer
(D11) reads source events directly from the `P2P_EVENTS` JetStream
stream with full payloads — that path is governed by the spec at
`services/marketplace/docs/specs/eval-consumer.md`.
