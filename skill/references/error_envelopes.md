# Error envelopes

Every klodi tool call that fails — pre-call guard rejection, transport failure, marketplace `{error, message}`, or unexpected adapter exception — returns the same four-key envelope on every adapter. Recognise the shape, read `error`, and follow `recovery_hint` when present.

See `docs/decisions/0011-adapter-exception-envelope.md` for the full contract.

## The envelope shape

```json
{
  "error":         "<code>",
  "message":       "<human-readable prose>",
  "details":       { "...": "..." } | null,
  "recovery_hint": { "kind": "...", "...": "..." } | null
}
```

All four keys are ALWAYS present. `details` and `recovery_hint` may be `null` (literal JSON null — never absent, never `undefined`). The same `error` code surfaces from every adapter (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw) for the same failure mode.

## When to use this

Whenever a tool call returns with the error flag set (`isError: true` in TS, the equivalent flag in Python and the Rust host), the body is a serialised envelope. Parse it, then:

1. Look at `error` first. It's drawn from a closed vocabulary (see below) — pattern-match on the literal.
2. If `recovery_hint` is non-null, follow it. The `kind` discriminant tells you the action type; the remaining fields carry the action's payload.
3. Use `message` for operator surfaces (chat, logs). Don't pattern-match on `message` — it is free-form prose and may vary between adapters.
4. Use `details` to enrich the agent's reasoning. The fields are code-specific (see the table below).

## Error code vocabulary

The agent never receives a code outside this table. The vocabulary is append-only without renames; new codes require an ADR amendment.

| `error` code              | When it surfaces                                                                                                                                                                       | `details` shape                                              | `recovery_hint`                                          |
|---------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|----------------------------------------------------------|
| `not_registered`          | `${KLODI_HOME}/nats.creds` or `config.json` missing.                                                                                                                                   | `null`                                                       | `{kind:"cli", command:"klodi-<host>-register", message}` |
| `klodi_home_missing`      | `${KLODI_HOME}` directory absent / unwritable for tools with on-disk side effects (listings, searches, watch).                                                                         | `null`                                                       | `{kind:"tool", tool:"klodi_setup_status", message}`      |
| `connection_not_ready`    | NATS-WS connection has not been established.                                                                                                                                           | `null`                                                       | `{kind:"tool", tool:"klodi_setup_status", message}`      |
| `consumer_missing`        | Server-managed durable consumer absent at subscribe time (the marketplace's provisioning pass has not yet run).                                                                        | `{consumer: "notifications" \| "channels"}`                  | `{kind:"tool", tool:"klodi_setup_status", message}`      |
| `invalid_request`         | Adapter-side schema validation failed before NATS dispatch.                                                                                                                            | `{field: "<name>", problem: "missing" \| "wrong_type" \| "empty"}` | `null` — agent re-calls with corrected args.        |
| `unauthorized`            | Marketplace rejected because the calling user does not own the target resource.                                                                                                        | `{marketplace_error_code, resource}`                         | `null` (forward-compatible; see ADR-0011 open Q2)        |
| `not_found`               | Marketplace rejected because the target id does not exist.                                                                                                                             | `{resource, resource_id}`                                    | `null`                                                   |
| `conflict`                | Marketplace rejected the transition (tx already confirmed, listing sold, offer accepted, channel closed).                                                                              | `{current_state}`                                            | `{kind:"tool", tool:"klodi_<resource>_status", message}` |
| `validation_failed`       | Marketplace rejected the request shape (server-side schema).                                                                                                                           | `{field, reason}`                                            | `null` — agent re-calls with corrected args.             |
| `rate_limited`            | Marketplace throttled the request.                                                                                                                                                     | `{retry_after_seconds?}`                                     | `null` — agent waits and retries.                        |
| `marketplace_error`       | Marketplace returned an error code not in the more-specific subset above.                                                                                                              | `{marketplace_error_code, marketplace_message}`              | `null`                                                   |
| `upload_failed`           | Photo upload step failed during `klodi_list_create` / `klodi_list_update`.                                                                                                             | `{path}`                                                     | `null` — agent retries.                                  |
| `internal_error`          | Adapter-internal exception (JSON decode failure, panic, unexpected transport error).                                                                                                   | `{exception_class?, trace_id?}`                              | `null` — agent retries once or surfaces to operator.     |

## `recovery_hint` vocabulary

`recovery_hint` mirrors the `NextAction` discriminated union the agent already learned from `klodi_setup_status`. Three `kind` variants reach the agent today; two are reserved for future ADR amendments.

| `kind`   | Payload                            | What the agent does                                                                                                                  |
|----------|------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `cli`    | `{command, message}`               | Surface the `command` string to the operator verbatim. The agent does NOT invoke shells itself — it tells the operator what to run. |
| `tool`   | `{tool, message}`                  | Invoke the named klodi tool directly. `klodi_setup_status` is the most common target.                                                |
| `shell`  | `{shell, message}` (reserved)      | Surface the shell command to the operator. Same surface contract as `cli`; reserved for future use.                                  |
| `dialog` | `{path, message}` (reserved)       | Prompt the user to edit a file or answer questions in chat. Reserved.                                                                |

When `recovery_hint` is `null`, the agent decides next steps from `error` + `details` alone:

- `invalid_request`, `validation_failed` → re-call with `details.field` corrected.
- `rate_limited` → wait `details.retry_after_seconds`, then retry.
- `unauthorized`, `not_found`, `conflict`, `marketplace_error` → surface to the operator unless context implies a different recovery.
- `internal_error` → retry ONCE; if it persists, surface.

## Cross-adapter parity

Every adapter produces the same `error` value for the same failure mode (exact-string match). `recovery_hint.kind` and the structural payload match across adapters (modulo placeholder substitution for the per-host CLI name). The only fields that legitimately vary between adapters are:

- `message` — free-form prose; do not pattern-match on it.
- `details` may carry transport-specific values (timestamps, trace_ids, source IPs) on top of the documented fields.

The cross-language oracle is `packages/tool-catalog/tests/fixtures/envelope-golden.json` — every adapter's test suite reads it and asserts the envelope it produces under matching conditions deserialises to the same JSON document (after sorting keys).

## Common recovery loops

```
klodi_list_update { listing_id: "..." }
  → {error: "not_registered", recovery_hint: {kind: "cli", command: "klodi-zeroclaw-register"}}
    → surface to operator: "Run klodi-zeroclaw-register to mint credentials."

klodi_tx_confirm { transaction_id: "..." }
  → {error: "connection_not_ready", recovery_hint: {kind: "tool", tool: "klodi_setup_status"}}
    → call klodi_setup_status → read next_action → follow.

klodi_offer_respond { offer_id: "..." }
  → {error: "conflict", details: {current_state: "accepted"}, recovery_hint: {kind: "tool", tool: "klodi_offer_status"}}
    → call klodi_offer_status to read fresh state; do not retry the same transition.

klodi_list_create { ... }
  → {error: "invalid_request", details: {field: "asking_price", problem: "missing"}, recovery_hint: null}
    → re-call with asking_price populated.
```
