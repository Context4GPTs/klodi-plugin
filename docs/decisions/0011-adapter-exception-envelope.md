---
id: 0011-adapter-exception-envelope
title: Adapter exception envelope and pre-call guard contract
tags: [envelope, guards, error-handling, adapters, parity]
card: adapter-guard-and-exception-parity-with-zeroclaw
commit: 73dddd3
updated_at: 2026-06-19
updated_by_card: fix-skill-error-envelopes-catalog-drift-ghost-tool
---

# ADR-0011 — Adapter exception envelope and pre-call guard contract

## Status

Accepted (2026-05-23). Affects every adapter (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw) and the shared `klodi-rust-host` crate. Supersedes the per-adapter ad-hoc envelopes the in-flight 0.2.x line shipped.

Forward-looking placeholder in [`ADR-0006`](./0006-direct-to-storage-photo-uploads.md) — the photo-upload stage error codes (`upload_failed`) referenced there now live in this ADR's R2 vocabulary.

## Context

Before this card, the six adapters surfaced error responses to agents in three different shapes:

- **openclaw (TS)** returned flat strings via `formatError`/`errorResult` — `{content: [{type:"text", text: "<message>"}], isError: true}`.
- **hermes / nanobot (Python)** returned partial JSON — `json.dumps({"error": "klodi_unavailable", "message": "..."})` — with the catch-all `except BaseException` arm mislabelling every non-Klodi exception as `connection_not_ready`.
- **moltis / ironclaw / zeroclaw (Rust)** delegated to the shared host's `map_klodi_err` which produced `McpError::invalid_request(message, Some({error, message, details}))` for marketplace errors but leaked raw `McpError::invalid_params` / `internal_error` for local-tool validation failures.

The founder's intent was explicit: an agent that learned to recover from a failure on one adapter must succeed at recovery on every other adapter without retraining or branching on adapter identity. The cross-language drift defeated that — same failure mode, three different wire shapes, three different vocabularies, three different recovery semantics.

The lib-layer prototype existed earliest in the Rust shared host (`KlodiError::Marketplace { code, message, details }`); zeroclaw inherited it by being the most recently-rewritten adapter. The five other adapters needed to converge on a shared shape, vocabulary, and pre-call guard discipline — adapted only where a host's binding model genuinely differs (TypedDict vs struct, MCP vs custom transport).

## Decision

**Lock a single tool-result envelope shape across every adapter, a closed error-code vocabulary, and a uniform pre-call guard chain. The catalog is the single source of truth; the three language stacks consume it via codegen.**

### Envelope shape (R1)

Every failure surfaces to the agent as a structured object with **exactly these four keys, always present**:

```json
{
  "error":         "<code>",
  "message":       "<human-prose>",
  "details":       { ... | null },
  "recovery_hint": { ... NextAction | null }
}
```

- Field names are `snake_case`.
- `details` and `recovery_hint` are `null` when absent — never elided. Language idioms (Python `None`, Rust `Option::None`, TS `undefined`) do **not** leak to the wire.
- `recovery_hint` is a value of the existing `NextAction` discriminated union (`{kind: "cli" | "tool" | "shell" | "dialog", ...}`) defined at `packages/klodi-rust-host/src/setup_status.rs:46`. Reusing it means the agent has zero new vocabulary to learn — `NextAction` is already taught by `klodi_setup_status`.

The wire-format oracle is `packages/tool-catalog/tests/fixtures/envelope-golden.json`. Every adapter's test suite reads it and asserts byte-for-byte equivalence under matching failure modes (modulo `message` prose and transport-specific `details` payloads — see fixture's `_doc`).

### Closed error-code vocabulary (R2)

Every `error` value is drawn from the frozen map in `packages/tool-catalog/src/error-codes.ts`. Initial vocabulary:

| Code | Stage | Recovery target |
|---|---|---|
| `not_registered` | Pre-call guard | `cli: klodi-<host>-register` |
| `klodi_home_missing` | Pre-call guard | `tool: klodi_setup_status` |
| `connection_not_ready` | Pre-call guard | `tool: klodi_setup_status` |
| `consumer_missing` | Dispatch | `tool: klodi_setup_status` |
| `invalid_request` | Pre-call guard (adapter-side schema) | `null` |
| `unauthorized` | Marketplace | `null` |
| `not_found` | Marketplace | `null` |
| `conflict` | Marketplace | `tool: klodi_<resource>_status` |
| `validation_failed` | Marketplace | `null` |
| `rate_limited` | Marketplace | `null` |
| `marketplace_error` | Marketplace catch-all | `null` |
| `upload_failed` | Adapter internal (carry-over from [ADR-0006](./0006-direct-to-storage-photo-uploads.md)) | `null` |
| `internal_error` | Adapter internal | `null` |

The set is **append-only without renames**. Renames break in-flight agents that pattern-match on the literal. New codes require an amendment to this ADR.

**Marketplace passthrough collapses to `marketplace_error`.** The server's original code rides in `details.marketplace_error_code`, the message in `details.marketplace_message`, extras in `details.marketplace_details`. This keeps R2 closed — the agent never sees a code outside the table. The finer-grained subset (`unauthorized` / `not_found` / `conflict` / `validation_failed` / `rate_limited`) is reserved for the follow-up ADR amendment once the marketplace enumerates its error vocabulary (see Open Questions).

### Pre-call guard chain (R4)

Every state-mutating tool runs the same three-guard chain in the same order **before any I/O** (no NATS dial, no filesystem read beyond the creds stat, no marketplace request):

1. **`creds_present`** — stats `${KLODI_HOME}/nats.creds` AND `${KLODI_HOME}/config.json`. Either missing → `not_registered` envelope with the per-host CLI in `recovery_hint`.
2. **`connection_ready`** — checks whether the persistent NATS-WS connection is live (Rust: `handler.klodi_client()` cached connection; Python: `get_client()` cached client; TS: `isClientConnected()`). Down → `connection_not_ready` envelope with `klodi_setup_status` hint.
3. **`args_well_formed`** — validates required-field presence and type per tool's catalog schema (uuid / string / integer / bool / non_empty_string). Failure → `invalid_request` envelope with `details: {field, problem}`.

First failure short-circuits. No later guard depends on an earlier guard's side effects. The chain is structurally enforced via grep: production callers exist in every language stack; the parity tests substitute `get_client()` with a panic-on-call sentinel and assert no I/O happens before the envelope returns.

### Read-only-tool exemption (R5/R6)

`klodi_setup_status`, `klodi_health`, and `klodi_setup_repair` are the **targets** of recovery hints. They MUST always return their diagnostic payload (even degraded — `klodi_health` returns `{ok: false, issue: ...}` on transport failure) and never the envelope. If an agent receives the envelope from these tools, the contract is broken.

Read-only data tools (`klodi_whoami`, `klodi_search`, `klodi_*_get`, `klodi_*_mine`, `klodi_*_status` non-local, `klodi_ratings`, `klodi_list_comments`, `klodi_channel_history`, `klodi_channel_mine`, `klodi_searches_list`) **share the envelope contract** for failure paths but skip `klodi_home_missing` and `invalid_request` guards (catalog schema is the validator for read-only inputs).

### Per-host CLI substitution (R8)

`recovery_hint: {kind: "cli", command: "klodi-<host>-register"}` is host-specific. Every Rust bin's `McpConfig` carries a mandatory `register_cli` field; the dispatcher's `envelope_for` helper substitutes the literal CLI name into the hint via `envelope_from_klodi_err_with_cli`. Python adapters pass `HERMES_REGISTER_CLI` / `NANOBOT_REGISTER_CLI` constants; openclaw passes `"klodi-openclaw-register"`. The hint's `kind: "cli"` is host-agnostic; the `command` value is the per-host literal.

**`recovery_hint` references only tools the same adapter exposes.** Closes the failure where an agent follows a hint and gets "unknown tool".

### Codegen pipeline

The TS catalog (`packages/tool-catalog/src/error-codes.ts`) is the **single source of truth**. The codegen step at `packages/tool-catalog/scripts/codegen.mjs`:

1. Runs `packages/tool-catalog/src/codegen/error-codes.ts` to emit `dist/error-codes.json` from the frozen map.
2. Mirrors `dist/error-codes.json` to `packages/nats-client-py/src/klodi_nats_client/error_codes.json` (vendored at build time).
3. Cross-language drift is gated by `packages/tool-catalog/tests/error-codes-cross-language.test.ts` — scans `envelope.py` / `guards.py` (Python) and `envelope.rs` / `guards.rs` / `tools.rs` (Rust) for literal `error: "<code>"` occurrences and asserts every code is in the TS catalog.

Rust does NOT yet consume `dist/error-codes.rs` — the drift test covers the gap. The full Rust artifact codegen is a deferred follow-up (see Consequences).

## Alternatives considered

1. **Bespoke-per-adapter envelopes (do nothing).** Rejected — the founder's success signal requires identical error codes and recovery hints across adapters. Today's status divergence is the exact bug.

2. **Generate guards from a YAML guard spec.** Rejected — codegen wins at ≥5 implementations or when guards change weekly; three hand-written helpers (TS/Py/Rust) with a shared test fixture is cheaper and more readable. The cross-language drift gate replaces the codegen safety net.

3. **Push every guard into the catalog as middleware.** Compelling for `args_well_formed` (JSON Schema validation at the catalog boundary) but rejected because (a) the catalog is a pure data package; injecting runtime logic balloons what `pnpm codegen` produces; (b) `creds_present` and `connection_ready` are inherently adapter-local (filesystem layout, client lifecycle differ).

4. **Monkey-patch zeroclaw's exact code into the shared Rust host.** Already done — that's `packages/klodi-rust-host`. The risk for moltis/ironclaw was in **distinguishing** them from zeroclaw, not unifying them. Zeroclaw-specific guards (gateway bearer, telegram pairing) live outside the shared host on purpose; the parity surface is `klodi-rust-host`.

5. **Reuse `NextAction` as the entire envelope.** Considered, but `NextAction` is a *recommendation* ("what should the agent do next"); it doesn't carry the offending input or the structured `details`. Composing `{error, message, details, recovery_hint: NextAction | null}` keeps the existing vocabulary load-bearing without requiring the agent to learn two action schemas.

6. **Preserve server-passthrough codes verbatim as `error` values.** The first dev round implemented this (R2 contradiction P2.1 in review round 1). Rejected on round 2 — the closed-vocabulary invariant is structurally undermined if every adapter emits server codes unfiltered. The `marketplace_error` collapse with `details.marketplace_error_code` preserves the server's information without breaking R2.

7. **Add `regex` as a per-language dependency to validate UUID-v4.** Rejected — the catalog's UUID-v4 pattern is small, fixed, and reused only by `guard_args`. A hand-rolled match per language costs ~40 lines total; pulling `regex` adds 200KB to the openclaw bundle and a Rust compile-time dependency. The hand-rolled paths are guarded by the same parity test (golden fixture `invalid_request` arms exercise them).

## Security implications

- **Guards fail before any I/O.** A guard rejection does not open a NATS connection, does not read any other file, does not issue any marketplace request. An unauthenticated caller (no creds) cannot probe the network from any adapter.
- **Envelope serialisation is deterministic.** The four-key shape with explicit `null` for absent optional fields means a malicious server cannot trick the agent by omitting `recovery_hint` and triggering a parse error on the agent side. Every envelope deserialises to the same TypeScript type, Python TypedDict, or Rust struct.
- **No exception data leaks to the agent verbatim.** The `internal_error` envelope carries `details.exception_class` (the type name) and `message` (a one-line summary) — but not the full traceback. Operators read tracebacks in stderr; the agent gets the bounded information it needs to recover.
- **Per-host CLI substitution is mandatory.** Every production caller passes the CLI name through `envelope_from_klodi_err_with_cli` / per-language equivalents. The no-cli variant `envelope_from_klodi_err` defaults to `klodi-zeroclaw-register` — a deliberate tripwire. If that string ever surfaces to an operator running moltis or ironclaw, it means a caller bypassed the wrapper; the visible mismatch is the alarm.

## Consequences

**Positive.**

- The founder's success signal is met: an agent calling any guarded tool against any adapter receives the same `error` code and `recovery_hint` template zeroclaw returns for the same failure (modulo per-host CLI string).
- 661 tests (Rust 90 lib + 8 envelope_parity + 4 e2e_envelope + 2 zeroclaw mcp_envelope_e2e + openclaw 273 + tool-catalog 90 + hermes 92 + nanobot 60 + nats-client-py 42) gate parity at the wire and the catalog at the source.
- The skill bundle (`skill/references/error_envelopes.md`) is the agent's documentation; the cross-link audit at `tests/skill-coverage.test.ts` catches **error-code** drift in either direction (catalog code without doc, doc reference without code). A second, distinct direction — a `klodi_`-prefixed token in the bundle that names a **tool** the catalog doesn't ship (a "ghost tool") — was originally caught *only downstream* in klodi-stage's `every_klodi_token_in_bundle_exists_in_catalog`, which runs against the **packed tarball**, so a ghost token went green in klodi-plugin CI and only reddened in the sibling. The `skill bundle ↔ catalog tool symmetry` block in the same `skill-coverage.test.ts` now mirrors that check at source level (identical regex `/\bklodi_[a-z][a-z0-9_]*\b/g`, intersected with `TOOL_NAMES ∪ LOCAL_TOOL_NAMES`), so tool-token drift fails in-repo. Tool-shaped error-code literals that are received-not-called (e.g. the R2 code `klodi_home_missing`) are deliberately allowlisted in a local `KNOWN_NON_TOOLS` rather than promoted to a shared catalog export — two entries do not justify the coupling; promote on the third (card `fix-skill-error-envelopes-catalog-drift-ghost-tool`, Q1).

**Negative / deferred.**

- **No Rust artifact codegen yet.** `dist/error-codes.rs` does not exist; Rust hand-maintains its envelope-helper string literals. The drift gate at `error-codes-cross-language.test.ts` covers this — the full codegen lands when a second Rust adapter (or shared crate beyond `klodi-rust-host`) needs the vocabulary.
- **Marketplace-side error vocabulary is collapsed to `marketplace_error`.** The finer-grained `unauthorized` / `not_found` / `conflict` / `validation_failed` / `rate_limited` codes are defined in R2 but the adapter does not yet remap server codes into them (the marketplace's error vocabulary is server-side and not enumerated in this repo). The agent loses finer recovery granularity on server errors until that mapping lands.
- **`recovery_hint` for server-side rejections is `null` by default.** A hostile-or-malformed agent prompt against a marketplace `unauthorized` response gets `recovery_hint: null` rather than a structured `klodi_<resource>_mine` hint. The conservative-default rationale (open Q2) is that adapters MUST NOT synthesise hints for codes they don't recognise.
- **Long-running agent sessions need a restart.** CLAUDE.md "no backwards compatibility" was applied — openclaw's `formatError`/`errorResult`/`requireCreds` and the Rust dispatcher's `map_klodi_err` are deleted, not shimmed. Sessions running pre-card adapters that pattern-match on the flat string break on first failure response.

## Open questions

1. **`klodi_unavailable` vs `connection_not_ready`.** The Python path emits `connection_not_ready` directly now; `klodi_unavailable` was never load-bearing post-card. The deprecation alias was considered (founder open Q4) but rejected on the dev pair side — no production agent code depended on the old string. The alias does not exist.
2. **Server-code → recovery_hint mapping table.** Architect open Q2 + PO open Q2. Deferred to an ADR amendment once real session data shows where agents get stuck on marketplace passthrough errors. The conservative `recovery_hint: null` ships today.
3. **Rate-limit `details.retry_after_seconds`.** The R2 vocabulary defines `rate_limited` but no adapter currently emits it — the marketplace does not surface this code today. Forward-looking; the parity test fixture has no `rate_limited` row.

## References

- **Catalog (single source of truth):** `packages/tool-catalog/src/error-codes.ts`
- **Wire-format oracle:** `packages/tool-catalog/tests/fixtures/envelope-golden.json`
- **Cross-language drift gate:** `packages/tool-catalog/tests/error-codes-cross-language.test.ts`
- **Codegen pipeline:** `packages/tool-catalog/scripts/codegen.mjs`, `packages/tool-catalog/src/codegen/error-codes.ts`
- **Rust envelope + guards:** `packages/klodi-rust-host/src/mcp/envelope.rs`, `packages/klodi-rust-host/src/mcp/guards.rs`, `packages/klodi-rust-host/src/mcp/tools.rs::envelope_for` (line 568)
- **Python envelope + guards:** `packages/nats-client-py/src/klodi_nats_client/envelope.py`, `packages/nats-client-py/src/klodi_nats_client/guards.py`
- **TS envelope + guards:** `adapters/openclaw/src/lib/envelope.ts`, `adapters/openclaw/src/lib/guards.ts`, `adapters/openclaw/src/lib/tool-result.ts`
- **Per-host CLI defaults:** `adapters/zeroclaw/src/bin/mcp.rs:57`, `adapters/moltis/src/bin/mcp.rs:49`, `adapters/ironclaw/src/bin/mcp.rs:48`
- **Agent-facing skill doc:** `skill/references/error_envelopes.md`
- **NextAction discriminated union:** `packages/klodi-rust-host/src/setup_status.rs:46`
- **Related:** [[0006-direct-to-storage-photo-uploads]] — the photo-upload stage error codes that fold into this ADR's `upload_failed`. [[0010-zeroclaw-browser-pairing-shim]] — zeroclaw's gateway-bearer flow (deliberately out of the envelope contract — host-specific, not adapter-portable). [[0012-tool-request-payload-parity]] — sibling parity ADR for the request/input path (same pattern, opposite direction of the call).
