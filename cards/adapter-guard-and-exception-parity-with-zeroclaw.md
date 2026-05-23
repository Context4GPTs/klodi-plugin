---
type: card
title: Adapter guard and exception parity with zeroclaw
slug: adapter-guard-and-exception-parity-with-zeroclaw
work_type: feature
tiers: [unit, integration, e2e]
status: discovery
agents: [solutions-architect, product-owner]
priority: 2
created: 2026-05-23
updated: 2026-05-23
base_branch: main
worktree: /Users/knitlybak/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-adapter-guard-and-exception-parity-with-zeroclaw
branch: card/adapter-guard-and-exception-parity-with-zeroclaw
pr: null
merged_commit: null
---

## Intent (founder)

**Problem:** Of klodi-plugin's six adapters, only zeroclaw — the most recently built — wraps transaction-affecting tools (`klodi_transactions_accept`, `klodi_assets_withdraw`, and the rest of that family) in a complete guard set, and only zeroclaw returns a structured exception envelope that tells the calling agent what failed, why, and how to recover. The other five adapters (openclaw, hermes, nanobot, moltis, ironclaw) either lack the guards or surface failures as opaque messages, so agent behaviour diverges across hosts and recovery logic isn't portable.

**Goal:** openclaw, hermes, nanobot, moltis, and ironclaw expose the same guarded tool surface as zeroclaw — identical tool names, identical guard semantics (pre-call validation, post-call invariants, host-side authorisation checks) — adapted only where a host's binding model genuinely differs (e.g., Python typed dict vs Rust struct, MCP vs custom transport). Every rejection or runtime error returns the same structured exception envelope zeroclaw returns: error code, human-readable message, machine-readable cause, and a recovery hint the agent can act on. Discovery distills zeroclaw's pattern into a shared contract so future adapters inherit parity by default.

**Success signal:** A shared adversarial test matrix — one fixture per guarded tool × per failure mode — runs against all six adapters and produces equivalent exception envelopes (modulo host-driven binding flavour), and an agent calling `klodi_transactions_accept` against any adapter receives the same error code and recovery hint zeroclaw returns for the same failure.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — solutions-architect, product-owner

### Premise reconciliation — solutions-architect

The founder's intent names `klodi_transactions_accept` and `klodi_assets_withdraw` as zeroclaw's guarded tools. **Neither exists in the catalog today** (`packages/tool-catalog/src/index.ts`):

- The transaction tool family is `klodi_tx_confirm` / `klodi_tx_cancel` / `klodi_tx_rate` / `klodi_tx_status` (subjects `p2p.v1.transactions.{confirm,cancel,rate,status}`, catalog lines 604–668).
- The asset tool was `klodi_assets_upload_url`, which is being removed by the in-flight sibling card `fold-uploads-into-listing-tools` (PR #2; folded into `klodi_list_create` / `klodi_list_update`). The withdrawal of an asset is not a real catalog tool — listings are withdrawn via `klodi_list_withdraw` (`p2p.v1.listings.withdraw`).

Treating the founder's names as **illustrative** of the irreversible / transaction-affecting class. The actual guarded surface this card addresses (confirmed by code inspection) is the irreversible-effect family: `klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_tx_rate`, `klodi_list_withdraw`, `klodi_list_create`, `klodi_list_update`, `klodi_list_relist`, `klodi_offer_create`, `klodi_offer_respond`, `klodi_channel_message` (direct JetStream publish), and `klodi_unwatch` (irreversible per its existing description). Any tool that mutates marketplace state OR durable on-disk state (sell/buy files) is in-scope. ASSUMPTION — founder may override the in-scope tool list.

Second premise correction: there are **no zeroclaw-specific guards in the codebase today**. The Rust trio (zeroclaw, moltis, ironclaw) all delegate to `packages/klodi-rust-host/src/mcp/tools.rs::dispatch` (line 194) and inherit identical error handling via `map_klodi_err` (line 484). zeroclaw has no per-tool wrapping, no pre-call validation distinct from the other Rust adapters, and no recovery-hint field — what zeroclaw "has" that openclaw/hermes/nanobot don't is the consequence of riding on the shared host's existing `KlodiError::Marketplace` → `{error, message, details}` envelope mapping. The shared host is the parity surface, not zeroclaw the adapter.

### Approach + alternatives ruled out — solutions-architect

**Chosen approach.** Define a single cross-language **adapter guard contract** and a single **exception envelope shape** that every adapter materialises identically. The envelope already exists structurally in TS and Python (`KlodiRequestError {code, message, details}` at `packages/nats-client-ts/src/client.ts:128` and `packages/nats-client-py/src/klodi_nats_client/client.py:81`) and in Rust (`KlodiError::Marketplace {code, message, details}` at `packages/nats-client-rs/src/error.rs:60`). The work is:

1. **Promote envelope to a structured tool-result.** Every adapter returns the envelope as a structured object the agent can parse (`{error, message, details, recovery_hint?}`), not a flat string. Today openclaw returns flat strings via `formatError` (`adapters/openclaw/src/lib/tool-result.ts:80`); hermes/nanobot return JSON-encoded `{error, message}` (e.g. `adapters/hermes/src/klodi_hermes/tools.py:106`); the Rust trio returns `McpError::invalid_request(message, Some({error, message, details}))` (`packages/klodi-rust-host/src/mcp/tools.rs:486`). The contract is `{error: <stable code>, message: <human>, details: <machine cause | null>, recovery_hint: <NextAction | null>}` — `recovery_hint` reusing the existing `NextAction` discriminated-union schema from `packages/klodi-rust-host/src/setup_status.rs:46` (`{kind: cli | tool | shell | dialog, ...}`).
2. **Define the guard set.** A guard is a pre-call function that runs before the NATS request and either returns the typed args or returns a rejection envelope. Today's `requireCreds` (openclaw) is the prototype but it's a string-returning side-channel. The contract:
   - `creds_present` — credentials and config both exist (today's `hasCredentials` / hermes's `klodi_unavailable` mapping); rejection carries `recovery_hint: {kind: "tool", tool: "klodi_setup_status"}`.
   - `connection_ready` — the NATS client is connected; rejection carries `recovery_hint: {kind: "tool", tool: "klodi_setup_status"}`.
   - `args_well_formed` — every tool's required JSON-Schema fields are present and well-typed before dispatch (some adapters skip this today because the host's schema validator runs upstream, but the parity contract is that every adapter checks the same shape). Rejection has stable code `invalid_request` and `details: {missing_field | wrong_type, field, expected}`.
   - `host_authorization` — only meaningful for adapters whose host model can deny a tool call independently (zeroclaw has the gateway bearer; the others don't). Out-of-scope for the parity contract; reserved as an optional pre-flight hook for future host work.
3. **Land the contract as a small adapter-local helper per language.** TS: `adapters/openclaw/src/lib/guards.ts` (new) + `adapters/openclaw/src/lib/envelope.ts` (new). Python: `packages/nats-client-py/src/klodi_nats_client/guards.py` + `envelope.py` (shared by hermes + nanobot via existing `klodi_nats_client` dependency). Rust: extend `packages/klodi-rust-host/src/mcp/tools.rs::map_klodi_err` + add a `guards.rs` sub-module. **No new shared package.** The TS contract lives adapter-local because openclaw is the only TS adapter; if a second TS adapter ships, factor up then.
4. **Single failure-mode error-code table** lives in `docs/decisions/0011-adapter-exception-envelope.md` (NEW ADR). The catalog (`packages/tool-catalog/src/index.ts`) gains an `errorCodes` export: a frozen object mapping stable code → human description. All three languages consume it via codegen (`dist/error-codes.{json,rs}`), the same pipeline that already serves `schemas.json` and `rust-types.rs`.

**Alternatives ruled out.**

1. **Bespoke-per-adapter envelope (do nothing).** Rejected — the founder's success signal requires identical error codes and recovery hints across adapters. Today's status divergence is the exact bug.
2. **Generate guards from spec.** Tempting (lift a YAML guard spec, codegen TS/Py/Rust skeletons). Rejected — three callers don't pay for codegen overhead. Codegen wins at ≥5 implementations or when guards change weekly; neither holds. Three hand-written helpers with a shared test fixture set is cheaper and more readable.
3. **Push every guard into the catalog as middleware.** Compelling for `args_well_formed` (JSON Schema validation at catalog boundary) but rejected because (a) the catalog is currently a pure data package (schemas + descriptions + subjects); injecting runtime logic moves it from a schema source to a runtime, balooning what `pnpm codegen` produces; (b) `creds_present` and `connection_ready` are inherently adapter-local (filesystem layout, client lifecycle differ). Better to have one local guard layer per adapter that each iterates a small declarative guard list.
4. **Monkey-patch zeroclaw's exact code into the shared Rust host.** Already done — that's `packages/klodi-rust-host`. The risk for moltis/ironclaw is in **distinguishing** them from zeroclaw, not unifying them. Zeroclaw-specific guards (gateway bearer, telegram pairing) live outside the shared host on purpose; the parity surface is `klodi-rust-host` and that's already shared.
5. **Reuse `NextAction` as the entire envelope.** Considered, but `NextAction` is a recommendation ("what should the agent do next"); it doesn't carry the offending input or the structured `details`. Composing `{error, message, details, recovery_hint: NextAction | null}` keeps the existing `NextAction` vocabulary load-bearing and prevents agents from having to learn two action schemas.

**Coordination with the sibling card.** `fold-uploads-into-listing-tools` (`/Users/knitlybak/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-fold-uploads-into-listing-tools/cards/fold-uploads-into-listing-tools.md`) has a Review round 1 FAIL with P2.2 explicitly flagging the same cross-language envelope divergence (line 487 of that card). Per the brief's instruction, this card treats their resolution as canonical. Two possible outcomes:

- If the fold-uploads dev pair lifts openclaw to `{error, message, path}` JSON (recommended in P2.2), this card adopts and **extends** that shape with `details` (formalising `path` as `details: {path}`) and `recovery_hint`. The fold-uploads work covers `klodi_list_create`/`klodi_list_update` photo-resolution errors; this card covers the full marketplace error surface plus pre-call guard rejections.
- If fold-uploads normalises to a plain string everywhere, this card **overrides** that choice (since the founder's intent explicitly requires "error code, human-readable message, machine-readable cause, and a recovery hint"). The fold-uploads PR would be revised forward. Capture as an open question for the founder if that scenario lands first.

Practically, we don't depend on fold-uploads merge ordering. The two PRs touch overlapping files (`packages/tool-catalog/src/index.ts`, `adapters/openclaw/src/tools/listings.ts`, the per-adapter tools files). Merge conflicts get resolved in whichever lands second; the **contract** in this card is the union of both PRs' error surfaces, and the implementation simply applies the same envelope shape to every error site.

### Affected files / surfaces — solutions-architect

**Shared contract.**

- `docs/decisions/0011-adapter-exception-envelope.md` — NEW ADR. Defines envelope shape, error-code vocabulary, recovery-hint composition rules, guard contract. INDEX row added at top of `docs/decisions/INDEX.md`.
- `packages/tool-catalog/src/error-codes.ts` — NEW. Frozen `errorCodes` map: stable code → `{description, recovery_kind: "tool" | "cli" | "shell" | "dialog" | "none"}`. Initial set: `not_registered`, `klodi_unavailable`, `connection_not_ready`, `invalid_request`, `notifications_consumer_missing`, `channels_consumer_missing`, plus the per-tool marketplace codes the server returns (passed through unchanged; the catalog only catalogues the ones the agent reasons about — adapter-side ones).
- `packages/tool-catalog/scripts/codegen.mjs` — emit `dist/error-codes.json` (consumed by Python via `klodi_nats_client`) and `dist/error-codes.rs` (consumed by Rust via embed-in-include).
- `packages/nats-client-py/src/klodi_nats_client/error_codes.py` — NEW, embeds `dist/error-codes.json`. Re-exported from `klodi_nats_client.__init__`.
- `packages/nats-client-rs/src/error_codes.rs` — NEW, includes `dist/error-codes.rs` at compile time.

**openclaw (TS).**

- `adapters/openclaw/src/lib/envelope.ts` — NEW. `class KlodiToolEnvelope` (or `interface ToolResultEnvelope`) — `{error, message, details, recovery_hint}`. Re-exports `KlodiRequestError` mapping helper. Replaces the flat-string return path in `formatError`.
- `adapters/openclaw/src/lib/guards.ts` — NEW. `guardCreds(): Envelope | null`, `guardConnection(): Envelope | null`, `validateRequiredFields(params, schema): Envelope | null`. Each runs in order; first non-null short-circuits.
- `adapters/openclaw/src/lib/tool-result.ts` — REWRITE `formatError`, `errorResult`, `requireCreds`. Returns structured envelopes via `jsonResult({ ok: false, ...envelope })` rather than `{content: [{type:"text", text: message}], isError: true}` with a flat string. Keep `isError: true` set, but the content is now a JSON-stringified envelope (the agent parses it back).
- `adapters/openclaw/src/tools/{transactions,listings,offers,negotiation,discovery,identity,setup,register-poller}.ts` — EACH UPDATED. Per-tool change pattern: replace
  ```ts
  const err = requireCreds(); if (err) return errorResult(err);
  try { ... } catch (e) { return errorResult(formatError(e)); }
  ```
  with
  ```ts
  const guarded = await runGuards(["creds", "connection", "args"], params, tool.schema);
  if (guarded) return guarded;
  try { ... } catch (e) { return envelopeFromError(e); }
  ```
- `adapters/openclaw/src/__tests__/lib/envelope.test.ts` and `guards.test.ts` — NEW.
- `adapters/openclaw/src/__tests__/tools/*.test.ts` — extend each to assert the envelope shape on the existing error paths (creds-missing was already tested in a flat-string form; promote those assertions to envelope-shape).

**hermes (Python).**

- `packages/nats-client-py/src/klodi_nats_client/envelope.py` — NEW. `class ToolEnvelope` (TypedDict or dataclass) + `envelope_from_error(err)` + `format_envelope(env) -> str` (JSON serialisation). Imported by both hermes and nanobot.
- `packages/nats-client-py/src/klodi_nats_client/guards.py` — NEW. `guard_creds(klodi_home)`, `guard_connection(client)`, `guard_args(params, schema)`. Returns `ToolEnvelope | None` (None = pass).
- `adapters/hermes/src/klodi_hermes/tools.py` — REWRITE `build_request_handler` (line 84). Today returns `json.dumps({"error": "klodi_unavailable", "message": "..."})`. Replace with the structured envelope path: `json.dumps(envelope(error="klodi_unavailable", message=..., details=None, recovery_hint={"kind": "tool", "tool": "klodi_setup_status"}))`. Add an explicit pre-call guard pass.
- `adapters/hermes/src/klodi_hermes/local_tools.py` — same treatment for `_handle_setup_status` and any other local-tool error paths.
- `adapters/hermes/tests/test_tools.py` — extend with envelope-shape assertions.

**nanobot (Python).**

- `adapters/nanobot/nanobot_tools.py` — REWRITE the error-envelope sites at lines 172, 178, 181, 192, 196, 204, 209, 213. Adopt `klodi_nats_client.envelope`.
- `adapters/nanobot/nanobot_local_tools.py` — same.
- `adapters/nanobot/tests/test_tools.py` — extend.

**moltis / ironclaw / zeroclaw (Rust) — work lives in the shared host.**

- `packages/klodi-rust-host/src/mcp/envelope.rs` — NEW. `ToolEnvelope { error: String, message: String, details: Option<Value>, recovery_hint: Option<NextAction> }`. Implements `From<KlodiError>`.
- `packages/klodi-rust-host/src/mcp/guards.rs` — NEW. Same shape as the Python/TS guards. Note: the rmcp `ServerHandler` interface already validates JSON Schema upstream for the catalog tools, so `args_well_formed` mostly degenerates to "no-op for passthrough; full check for local tools".
- `packages/klodi-rust-host/src/mcp/tools.rs` — `map_klodi_err` (line 484) becomes `envelope_from_klodi_err` and returns a `CallToolResult` carrying a structured envelope in `structured` AND a JSON-stringified envelope in `content[0].text` (matches the existing `structured_with_text` pattern). Existing tests at line 502 extend with envelope-shape assertions.
- `packages/klodi-rust-host/src/mcp/handler.rs` — `klodi_client` (line 66) currently returns `McpError::internal_error` on connect failure; replace with `envelope_from_klodi_err`-equivalent (the surface here is also a guard).
- `adapters/{moltis,ironclaw,zeroclaw}/src/bin/mcp.rs` — **no change**. They inherit from the shared host.

**Bundled skill (instructs the agent how to interpret envelopes).**

- `skill/references/error_envelopes.md` — NEW. Describes the envelope shape, lists stable error codes the agent sees, and explains `recovery_hint`. Cross-linked from `skill/SKILL.md` and `skill/references/tool_inventory.md`.
- `skill/SKILL.md` — add a `## Errors` sub-section pointing at `error_envelopes.md`.

**Docs (public).**

- `docs/decisions/0011-adapter-exception-envelope.md` — NEW ADR (see above).
- `docs/decisions/INDEX.md` — row added; sorted to top by `updated_at`.
- `docs/specs/hosts/{openclaw,hermes,nanobot,moltis,ironclaw,zeroclaw}.md` — each adapter spec gets a one-paragraph "Error envelope" subsection cross-linking the ADR. Today's specs don't document error handling per host; the parity contract is the right time to add it once.

**Build artefacts.**

- `packages/tool-catalog/dist/error-codes.{json,d.ts,rs}` — regenerated by `pnpm codegen` post-source-change.

### Risks / failure modes — solutions-architect

- **Cross-language drift on the envelope shape.** Three languages each serialise the envelope to JSON. Field order is fine (JSON object), but type semantics differ: TS distinguishes `undefined` vs `null` and the runtime stringifier drops `undefined`; Python's `json.dumps` distinguishes `None`; Rust serde with `Option<T>` and `skip_serializing_if = "Option::is_none"` drops absent fields. *Mitigation:* fix on the wire: every field is **always present**, missing details/recovery_hint serialise as `null` (not absent). A single golden-fixture JSON document under `packages/tool-catalog/tests/fixtures/envelope-golden.json` is read by every adapter's test suite as the parity oracle.
- **`recovery_hint` proliferation.** The agent's prompt has to learn each `NextAction` variant. If every guard rejection invents its own `kind`, the agent's reasoning surface grows uncontrollably. *Mitigation:* the ADR locks the initial `recovery_hint` vocabulary to the existing `NextAction` enum (`cli | tool | shell | dialog`). New kinds require an ADR amendment. For most guard failures, `recovery_hint: null` is the right answer (the agent reads `error` + `message` and decides) — only the *most common* failures (no creds, no connection, missing required field) carry a hint.
- **Error-code stability across catalog versions.** The catalog's `errorCodes` map becomes a stable contract. Renaming `not_registered` to `klodi_not_registered` would break every agent in flight. *Mitigation:* the ADR states the codes are *append-only without renames*. CI gate: a test in `packages/tool-catalog/tests/error-codes-stability.test.ts` reads a frozen fixture of historical codes and asserts every one is still present.
- **Pre-call guard duplication with marketplace-side validation.** The marketplace's `auth.ts` rejects unknown user-id and the rmcp library validates schemas upstream. Adapter-side guards risk double-checking, occasionally with different rules. *Mitigation:* the guard contract scopes adapter-side to **adapter-only concerns** (filesystem state, client lifecycle, parameter shape that the adapter can check faster than a round-trip). Server-side rejections continue to flow through the existing `KlodiError::Marketplace → envelope` mapping. Guards never duplicate a server check.
- **Existing `KlodiRequestError` consumers (in tests, in tool-result helpers) break on the rewrite.** *Mitigation:* the type stays exported with the same shape; the change is in how it's converted to a `ToolResult`. Adapter-level handlers still `catch (e: KlodiRequestError)`. The `errorResult(formatError(e))` flat-string path is what gets replaced.
- **Test parity vs implementation language idioms.** A test in vitest naturally asserts `expect(result).toEqual({...})`. A test in pytest asserts `assert result == {...}`. A test in cargo asserts `assert_eq!(result, json!({...}))`. The structural assertion is identical; the syntax differs. *Mitigation:* the parity test fixture is a JSON document; each adapter's test reads it and compares post-deserialise. The contract is shape, not syntax.
- **Setup-time and runtime guards conflate.** `creds_present` is a setup-state check (file exists at $KLODI_HOME); `connection_ready` is a runtime check (client is connected). Conflating them risks the agent receiving "not registered" when in fact registration is fine but the network is down. *Mitigation:* the guard contract names them distinctly, with distinct `error` codes (`not_registered` vs `connection_not_ready`) and distinct `recovery_hint`s (`klodi_register` CLI vs `klodi_setup_status` tool).
- **Channel-message JetStream publish has no marketplace envelope.** `klodi_channel_message` doesn't go through request/reply; failures surface as `ValueError` or transport errors (`adapters/nanobot/nanobot_tools.py:177`, `adapters/hermes/src/klodi_hermes/tools.py:163`). *Mitigation:* the envelope contract is the surface; these sites already produce structured `{error, message}` in Python — extend them with `details` and `recovery_hint: null`. openclaw's `klodi_channel_message` lives in the rust-host's `dispatch_channel_message` and inherits.
- **Sibling card merge ordering with `fold-uploads-into-listing-tools`.** Whichever PR merges second resolves conflicts in `packages/tool-catalog/src/index.ts`, `adapters/openclaw/src/tools/listings.ts`, the Python adapter handlers. *Mitigation:* this card's dev pair runs `git fetch origin && git merge origin/main` after the sibling PR merges; the conflicts are mechanical because both PRs touch the same lines but with non-overlapping intent (delete a tool vs. promote envelope shape). Explicit dev-pair note: do not start until fold-uploads is either merged or paused — landing two in-flight PRs that touch the same files simultaneously is the only scenario that produces non-mechanical conflicts.
- **The Rust trio bins (moltis/ironclaw/zeroclaw) themselves are not exercised by the host's unit tests.** The sibling card's review (P3.2 line 496) flagged this: the binaries are thin wrappers around `run_mcp_server` but their `bail!` paths (lines 47–58 of `adapters/moltis/src/bin/mcp.rs`) still produce *legacy* string errors. *Mitigation:* in scope for this card — the three bin files each get a one-line replacement of the `bail!` text with an envelope-shaped JSON payload (still printed to stderr; the binary aborts but the operator sees the structured envelope).

### Product framing — product-owner

**What "parity" means from the agent's perspective.** Parity is not a code property; it is a *behavioural* one. An agent that has learned to recover from a failure on adapter A must succeed at recovery on adapter B without retraining, retraining-by-prompt, or branching on adapter identity. Concretely, four things must hold simultaneously:

1. **Identical tool names.** The state-mutating surface the agent reasons over is the same string on every adapter — exactly the keys of `klodiTools` in `packages/tool-catalog/src/index.ts`. If any of the five lagging adapters has historically drifted to a different name (`klodi_transaction_confirm` vs `klodi_tx_confirm`, `klodi_accept_offer` vs `klodi_offer_respond`), rename to the catalog string. Aligns with R7 below; the architect's tool inventory in Affected-files is the canonical scope. **The founder's intent named `klodi_transactions_accept` and `klodi_assets_withdraw`; neither exists today** — the architect's premise reconciliation above resolves these as illustrative references to the irreversible-effect family, with `klodi_offer_respond` and `klodi_list_withdraw` being the existing equivalents.

2. **Identical guard semantics.** Every state-mutating tool runs the same pre-call validation chain in the same order: `creds_present` → `connection_ready` → `args_well_formed`. Guards fail fast with the structured envelope below; they never silently fall through, never partially execute, and never produce side effects before validating.

3. **Identical exception envelope.** Every failure — guard rejection, transport failure, marketplace `{error, message, details}`, unexpected internal error — surfaces to the agent as the *same shape* on every adapter: `{ error, message, details, recovery_hint }`. The agent never has to detect "which adapter am I talking to" to parse the response. (Architect locked the shape in R1 below.)

4. **Identical recovery hints.** The `recovery_hint` field is agent-actionable, not human-prose: it points the agent at a *named tool* or a *named CLI* it can invoke next. The same failure mode produces the same `recovery_hint` discriminated-union value across all six adapters. Zeroclaw's hints are the canonical vocabulary; the other five mirror them verbatim.

**Coverage scope.** This card targets the **state-mutating + lifecycle** surface (the architect's list in Affected-files is authoritative). Read-only tools (`klodi_*_status`, `klodi_*_get`, `klodi_*_mine`, `klodi_search`, `klodi_whoami`, `klodi_ratings`, `klodi_channel_history`, `klodi_channel_mine`, `klodi_list_comments`, `klodi_searches_list`) still produce envelope parity on the failure path (transport / setup / marketplace error), but only run the `creds_present` and `connection_ready` guards — not `args_well_formed` (the catalog schema is the validator for read-only inputs, no host-side check needed). The two **local diagnostic** tools (`klodi_setup_status`, `klodi_health`) are exempt by R5 — they are the *target* of recovery hints, not a failure surface.

### Business rules — parity invariants (product-owner)

The following invariants hold across all six adapters once this card lands. They are the rules tests assert against and the rules code-quality-guardian holds the diff to. They formalise the architect's engineering choices into agent-facing contracts.

**R1 — Envelope shape is invariant across adapters.** Every error result surfaced to the agent is structurally:

```
{
  "error":          "<code>",                  // member of the canonical set (R2)
  "message":        "<human-prose>",           // for log/operator surface; agent does not pattern-match
  "details":        { ... | null },            // machine-readable cause; nullable when no detail applies
  "recovery_hint":  { ... NextAction | null }  // structured action; agent-actionable
}
```

Field names, JSON casing (`snake_case`), and the rule "all four keys are *always present*; `details` and `recovery_hint` are explicit `null` when absent" are part of the contract. Adapter-language idioms (Python `None`, Rust `Option::None`, TS `undefined`) do not leak to the wire — they all serialise to `null`. This pins R1 to the architect's golden fixture at `packages/tool-catalog/tests/fixtures/envelope-golden.json`.

**R2 — Error code vocabulary is closed.** Every `error` value is drawn from a fixed, append-only set maintained in `packages/tool-catalog/src/error-codes.ts`. The agent never sees a code outside this set — adapters that catch an unrecognised marketplace code fall back to `marketplace_error` with the original code preserved in `details.marketplace_error_code`. Initial vocabulary (architect's list, with the marketplace-passthrough subset I'm naming below for the failure-mode parity criteria):

| Code | Trigger | Stage | Recovery target |
|---|---|---|---|
| `not_registered` | Creds file missing/unreadable | Pre-call guard | `cli: klodi-<host>-register` |
| `klodi_home_missing` | `${KLODI_HOME}` directory absent/unwritable for tools with on-disk side effects | Pre-call guard | `tool: klodi_setup_status` |
| `connection_not_ready` | NATS client not connected; canonical code (`klodi_unavailable` is the deprecated Py alias — see architect open Q1) | Pre-call guard | `tool: klodi_setup_status` |
| `consumer_missing` | Server-managed durable consumer absent (`notifications_consumer_missing` / `channels_consumer_missing` mapped) | Dispatch | `tool: klodi_setup_status` |
| `invalid_request` | Args fail JSON Schema (missing/wrong-type/empty); the adapter's guard rejects before NATS | Pre-call guard | `null` (agent re-calls with corrected args) |
| `unauthorized` | Marketplace error indicates user does not own the target resource | Marketplace | `tool: klodi_<resource>_mine` (`null` if no such tool) |
| `not_found` | Marketplace error indicates target id does not exist | Marketplace | `tool: klodi_<resource>_mine` (`null` if no such tool) |
| `conflict` | Marketplace error indicates state-transition conflict (tx already confirmed, listing already sold) | Marketplace | `tool: klodi_tx_status` / `klodi_<resource>_status` |
| `validation_failed` | Marketplace rejected request shape (server-side schema) | Marketplace | `null` (agent re-calls with corrected args; `details.field` names the bad field) |
| `rate_limited` | Marketplace throttled the request | Marketplace | `null` (agent waits `details.retry_after_seconds`) |
| `marketplace_error` | Marketplace error not in the more-specific subset above | Marketplace | `tool: klodi_<resource>_status` (resource inferred from tool name; `null` if no inference possible) |
| `upload_failed` | Photo upload step failed (carries over from `card/fold-uploads-into-listing-tools`) | Adapter internal | `null` (agent retries; `details.path` names the failing file) |
| `internal_error` | JSON decode failure, panic, unexpected adapter exception | Adapter internal | `null` (agent retries once; `details.trace_id` if available) |

The agent never receives a code outside this table. New codes require an ADR amendment (architect's R6 stability gate enforces this).

**R3 — Recovery-hint vocabulary is closed.** `recovery_hint` is either `null` or a value of the existing `NextAction` discriminated union (`{kind: "cli" | "tool" | "shell" | "dialog", ...}`, defined at `packages/klodi-rust-host/src/setup_status.rs:46`). The agent has *already learned* `NextAction` from `klodi_setup_status`; reusing it here means the agent has zero new vocabulary to learn. New `kind`s require an ADR amendment.

**R4 — Guards fail before any I/O.** Every pre-call guard (`not_registered`, `klodi_home_missing`, `connection_not_ready`, `invalid_request`) returns the envelope without opening a NATS connection, reading any other file, or issuing any marketplace request. A failure of a later guard does not depend on a successful earlier guard's side effects (no read-modify-write within the guard stack). Guard order is fixed: `not_registered` → `klodi_home_missing` (only for tools with on-disk side effects) → `connection_not_ready` → `invalid_request`. First failure short-circuits.

**R5 — `klodi_setup_status` and `klodi_health` are exempt.** These two tools are the *target* of recovery hints; they MUST always return their diagnostic payload (even when degraded — `klodi_health` already does this at `packages/klodi-rust-host/src/mcp/tools.rs:266`, returning `{ok: false, issue: ...}` on transport failure). They never return the failure envelope. If an agent receives the envelope from these tools, the contract is broken.

**R6 — Read-only tools share the envelope contract.** `klodi_whoami`, `klodi_search`, `klodi_*_get`, `klodi_*_mine`, `klodi_*_status` (non-local), `klodi_ratings`, `klodi_list_comments`, `klodi_channel_history`, `klodi_channel_mine`, `klodi_searches_list`: run the `not_registered` and `connection_not_ready` guards (skip `klodi_home_missing` and `invalid_request`), surface marketplace failures through the same envelope.

**R7 — Tool names are catalog-canonical.** The published tool name on every adapter exactly matches the key in `klodiTools` (i.e. the keys in `packages/tool-catalog/src/index.ts`). Local tools (`klodi_setup_status`, `klodi_health`, `klodi_channel_message`, `klodi_watch`, `klodi_unwatch`) use the same five names on every adapter that exposes them. Any historical drift is corrected by this card.

**R8 — `recovery_hint` references only tools that exist on the same adapter.** If `recovery_hint.kind = "tool"` and `recovery_hint.tool = "klodi_X"`, then `klodi_X` is in the registered tool list of the same adapter that produced the envelope. (Closes the failure mode where an agent follows the hint and gets `unknown tool`.)

### Acceptance criteria — solutions-architect (engineering-side)

product-owner appends behaviour-framed Given/When/Then criteria below. These are the engineering invariants the dev pair tests.

**Envelope shape parity.**

- `[unit]` Given a `KlodiError::Marketplace { code, message, details }` (Rust) / `KlodiRequestError(envelope)` (TS/Py) is raised, when the adapter formats the tool result, then the agent-visible body deserialises to exactly `{error: string, message: string, details: object | null, recovery_hint: object | null}` — all four fields present, no extra fields, `details` and `recovery_hint` either an object or `null` (never `undefined` / absent).
- `[unit]` Given the catalog's `errorCodes` map, when any adapter raises an error using a code not in the map, then a CI test in `packages/tool-catalog/tests/error-codes-coverage.test.ts` fails (whitelist of allowed codes is the catalog map; server-passthrough codes are listed explicitly).

**Guard pre-call contract.**

- `[unit]` Given `${KLODI_HOME}/nats.creds` is missing, when any guarded tool is invoked, then the envelope returned has `error: "not_registered"`, a clear message, `details: null`, and `recovery_hint: {kind: "cli", command: "klodi-<host>-register", message: <human>}` (where `<host>` is the adapter's host name).
- `[unit]` Given creds exist but the NATS client is not connected (e.g. transport down), when any guarded tool is invoked, then the envelope has `error: "connection_not_ready"` (TS/Py) or `error: "klodi_unavailable"` (current alias kept for Py back-compat — flagged for normalisation; the catalog map lists one canonical code with the other as an alias) and `recovery_hint: {kind: "tool", tool: "klodi_setup_status", message: <human>}`.
- `[unit]` Given a guarded tool whose JSON Schema requires `transaction_id: string`, when invoked with `{transaction_id: 42}` or `{}` or `{transaction_id: ""}`, then the envelope has `error: "invalid_request"`, `details: {field: "transaction_id", problem: "missing" | "wrong_type" | "empty"}`, and `recovery_hint: null`. (One assertion per problem variant.)

**Per-adapter guard installation.**

- `[unit]` Given any guarded tool in openclaw, when the tool is invoked without creds, then `guardCreds` is reached before any NATS request. (Tested by mocking the NATS client and asserting the mock was never called.)
- `[unit]` Same as above for hermes (`build_request_handler`'s guards run before `client.request`).
- `[unit]` Same as above for nanobot.
- `[integration]` Given a fresh `KlodiMcpHandler` with creds present but `KlodiClient::new` configured to fail on connect, when the agent calls any guarded tool via the shared Rust host, then the guard layer returns the `connection_not_ready` envelope without panicking and without spamming the trace log with the same error per-call.

**Cross-language parity at the wire.**

- `[integration]` Given the same input that produces a `not_registered` rejection, when invoked through openclaw, hermes, nanobot, and the shared Rust host (representing the trio), then all four adapters produce envelopes that deserialise to the same JSON document (after sorting object keys). Pinned by `packages/tool-catalog/tests/fixtures/envelope-golden.json` consumed by each adapter's suite.
- `[integration]` Given the marketplace returns `{error: "listing_not_owned_by_caller", message: "...", details: {listing_id: "..."}}`, when a tool dispatches through any adapter, then the agent-visible envelope is `{error: "listing_not_owned_by_caller", message: <server's>, details: {listing_id}, recovery_hint: null}` — passthrough preserves server fields and adds `recovery_hint: null` (since adapters cannot conjure a recovery for server-side rejections without ADR-authorised mappings).

**Marketplace error passthrough.**

- `[integration]` Given the marketplace returns an error code with no recovery semantics defined in the catalog, when the adapter formats the envelope, then `recovery_hint: null` and the message is the server's verbatim. (Adapter never invents a hint for a server code it doesn't recognise.)

**Channel-message and local-tools envelope.**

- `[unit]` Given `klodi_channel_message` is invoked with an empty `content`, when the adapter responds, then the envelope is `{error: "invalid_request", message: "content must be a non-empty string", details: {field: "content", problem: "empty"}, recovery_hint: null}`. Identical across hermes, nanobot, and the rust-host's `dispatch_channel_message`.

**Catalog stability gate.**

- `[unit]` Given a historical fixture of error codes (committed at this card's merge), when the catalog regenerates, then every code in the historical fixture is still present in the new catalog. (Renames must be done via deprecation + ADR amendment; the test catches accidental renames in PRs.)

**Skill documents the envelope.**

- `[unit]` Given the bundled skill (`skill/references/error_envelopes.md`), when the agent reads it, then it lists every stable error code in the catalog with a human description and the canonical `recovery_hint` shape. A grep test in `packages/tool-catalog/tests/skill-coverage.test.ts` asserts every code in `errorCodes` is named in the skill doc.

**Cross-adapter behavioural parity (the founder's success signal).**

- `[e2e]` Given the same input that triggers `not_registered`, when invoked through each of the six adapters (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw), then each produces an envelope deserialising to the same JSON document (golden fixture). The harness boots a minimal session per adapter; the shared Rust host's three bins inherit and run via one e2e instance each.

**Tier frontmatter.** Union of tiers used above is `[unit, integration, e2e]`. Frontmatter `tiers:` updated to that set.

### Open questions (if any) — solutions-architect

1. **`klodi_unavailable` vs `connection_not_ready`.** Today hermes returns `klodi_unavailable` for connection failures (`adapters/hermes/src/klodi_hermes/tools.py:107`). The TS adapter doesn't have a parallel code. The catalog's canonical code should be `connection_not_ready` (precise, naming the state); `klodi_unavailable` lives as a deprecated alias for the in-flight Python agents that pattern-match on it. Founder may want to skip the alias and break those agents on next deploy — flag.
2. **`recovery_hint` for marketplace-side rejections.** Should the adapter conjure a `recovery_hint` for known server codes (e.g. server returns `listing_not_owned_by_caller` → suggest `{kind: "tool", tool: "klodi_list_mine"}`)? Or always pass through with `recovery_hint: null` and trust the agent to decide? Conservative choice (always-null for server codes) shipped in the initial criteria above; a follow-up ADR amendment can introduce a server-code→hint table later. Founder may prefer the server-code mapping from day one — flag.
3. **In-scope tool list (the premise reconciliation up top).** The card lists "transaction-affecting tools" and names `klodi_transactions_accept` / `klodi_assets_withdraw` (neither in the catalog). I treat the irreversible-effect family as in-scope — confirmed list above. If the founder meant only the four `klodi_tx_*` tools, the affected-files list narrows materially; flag.
4. **Whether `args_well_formed` is a real guard for passthrough tools.** rmcp validates JSON Schema upstream for Rust; the TS plugin SDK and Python tool frameworks may or may not. If the host validator already rejects malformed args before the tool's `execute` runs, the adapter guard is dead code. *My take:* the parity test fixture still has to assert envelope shape on malformed input, so the adapter must produce the envelope — meaning the validator must run somewhere the test can reach. The simplest place is in the guard layer, where it's tested directly. Flagging in case the dev pair finds a cleaner upstream hook.

### → Handoff to In Dev (next agents: expert-developer, qa-developer) — solutions-architect

product-owner will append the behaviour-side handoff guidance below. From the architecture side:

**Adapter sequencing (do not parallelise — cross-language parity is the chief risk).**

1. **Catalog first.** Land `packages/tool-catalog/src/error-codes.ts`, run codegen, regenerate `dist/error-codes.{json,rs}` and the vendored Python copy. Add the catalog-stability test (`tests/error-codes-stability.test.ts`) and the golden envelope fixture (`tests/fixtures/envelope-golden.json`). No adapter changes yet — this slice is destructive only by introducing the new module.
2. **klodi-rust-host second.** The Rust trio's behaviour is determined here. Add `envelope.rs` + `guards.rs`, rewrite `map_klodi_err` to `envelope_from_klodi_err`. Update the three bin files' `bail!` paths to emit envelope JSON. `cargo test -p klodi-rust-host` and `cargo build -p klodi-moltis -p klodi-ironclaw -p klodi-zeroclaw` clean. **Why Rust before TS/Py:** the shared host produces the canonical envelope serialisation; the Python and TS implementations match it byte-for-byte. Doing TS first risks the Rust serialisation being slightly different and forcing a TS revision in the same card.
3. **Python pair third.** `packages/nats-client-py/src/klodi_nats_client/{envelope,guards}.py` first (shared module), then hermes's `tools.py` + `local_tools.py`, then nanobot's `nanobot_tools.py` + `nanobot_local_tools.py`. The two Python adapters' rewrites are structurally identical — copy hermes's pattern into nanobot. Confirm both `uv run pytest` clean.
4. **openclaw last.** TS rewrite of `lib/{envelope,guards}.ts` + tool-by-tool migration. Pull rebase after the sibling `fold-uploads-into-listing-tools` PR merges (if not yet, abort and wait for it — see Risks). `pnpm test` and `pnpm build` clean.
5. **Skill + docs.** Once every adapter is green, write `skill/references/error_envelopes.md`, edit `skill/SKILL.md`, edit the six host specs. Regenerate the openclaw bundled skill via `pnpm -C adapters/openclaw build`.

**What's shared vs per-adapter.**

- **Shared (single source of truth):**
  - `packages/tool-catalog/src/error-codes.ts` — the error-code vocabulary.
  - `packages/tool-catalog/tests/fixtures/envelope-golden.json` — the wire-format oracle.
  - `packages/klodi-rust-host/src/mcp/{envelope,guards}.rs` — Rust trio inherits.
  - `packages/nats-client-py/src/klodi_nats_client/{envelope,guards}.py` — hermes + nanobot share via existing `klodi_nats_client` dependency.
  - The ADR (`docs/decisions/0011-adapter-exception-envelope.md`).
- **Per-adapter (language flavour):**
  - openclaw's `src/lib/{envelope,guards}.ts` — TypeScript-only adapter helper (no second TS adapter exists; factor up only when a second arrives).
  - Per-tool registration call-site changes in each adapter — mechanical pattern replacement.
- **Per-binary (Rust trio thin wrappers):**
  - `adapters/{moltis,ironclaw,zeroclaw}/src/bin/mcp.rs` `bail!` text → envelope JSON. Three trivial changes; the binaries don't otherwise participate.

**Constraints.**

- **No backwards compatibility on tool-result shape.** Per `CLAUDE.md`. Old agents that parse openclaw's flat string break. The skill documents the new envelope; long-running agent sessions need a restart (same migration story as the sibling card's tool-removal flow).
- **Function caps.** The guard list per tool is a 3-element array; the per-tool wrapper stays at ≤10 lines. The envelope helper is ≤50 lines per language.
- **Strict types.** No `any` in TS (the envelope type is `Readonly<{error: string; message: string; details: object | null; recovery_hint: NextAction | null}>`). Python uses TypedDict with `None`-typed fields. Rust uses `Option<T>` with explicit serde annotations.
- **Card-branch only.** No commits to `main`. First push from this worktree uses `git push -u origin card/adapter-guard-and-exception-parity-with-zeroclaw`.

**Test strategy.**

- **Per-adapter unit tests** for each guard (creds, connection, args) — every adapter independently. Cheap.
- **Per-adapter integration tests** that the guard runs before NATS request (mock the client, assert no `request` call when a guard fires).
- **Cross-language parity test** powered by `packages/tool-catalog/tests/fixtures/envelope-golden.json`. Each adapter test suite loads the fixture and asserts the envelope it produces under matching conditions deserialises to the same JSON. Six adapters × ~6 failure modes = ~36 parity assertions, but only 6 fixtures (one per failure mode) — each fixture is reused six times.
- **One e2e** per language stack (`cargo test --test e2e_envelope` for Rust, a vitest e2e file for openclaw, a pytest e2e for one of hermes/nanobot — the other Python adapter is structurally proven by its unit suite). E2E boots a minimal session against a wiremock'd NATS gateway, triggers each failure mode, asserts envelope shape on the wire.

**Definition-of-done checklist for the dev pair.**

- [ ] `packages/tool-catalog/dist/error-codes.{json,rs}` regenerated; vendored Python copy in sync; CI catalog-stability test green.
- [ ] `cargo test -p klodi-rust-host` green (62/62 including new envelope tests).
- [ ] `cargo build -p klodi-moltis -p klodi-ironclaw -p klodi-zeroclaw` green; each bin produces envelope JSON on `bail!` paths.
- [ ] `uv run pytest` clean in hermes (~95+) and nanobot (~75+).
- [ ] `pnpm -C adapters/openclaw test` green (~260+); `pnpm -C adapters/openclaw build` clean; bundled skill copy contains `error_envelopes.md`.
- [ ] Parity test pinned via `envelope-golden.json` — every adapter passes the same fixture.
- [ ] `live-verification` run on at least one openclaw flow that triggers an envelope (e.g. `klodi_tx_confirm` with bad `transaction_id`); envelope renders correctly in the agent's tool-result view.
- [ ] `code-quality-guardian` verdict ≥ REVIEW.
- [ ] Distillation pass adds ADR-0011 + INDEX row; cross-link from `docs/specs/hosts/*.md`; inline `// See ADR-0011` references at the envelope/guard sites.
- [ ] `grep -rln 'errorResult(formatError' adapters/openclaw/src/` returns zero matches.
- [ ] Cross-link audit: every error-code in the catalog map appears in `skill/references/error_envelopes.md`.

**Conflict-handling with the sibling card.**

- If `fold-uploads-into-listing-tools` merges first: `git merge origin/main`, resolve the per-tool error-handling diffs by adopting this card's envelope shape (it supersedes the sibling's plain-string-or-JSON choice). The sibling's photo-resolution-error stages (`absolute_path`, `not_readable`, `sensitive_dir`, `oversize`, `over_count`, `content_type`, `mint_failed`, `put_failed`) become `details: {stage: ..., path: ...}` under `error: "invalid_request"` (validation stages) or `error: "upload_failed"` (network stages). Adding those codes to the catalog map is part of this card.
- If this card merges first: the sibling adopts the envelope on rebase; the sibling's P2.2 closes structurally.
- If both PRs are open simultaneously past a certain point: pause this card's dev pair, escalate to founder. Two PRs touching `packages/tool-catalog/src/index.ts` and `adapters/openclaw/src/tools/listings.ts` with overlapping intent is a coordination cost.

### → Handoff to Stand-by (next agents: expert-developer, qa-developer)

<!-- product-owner appends final stage flip; the architect's handoff guidance is the last edit on this stage. The dispatcher routes to Stand By once status flips to `stand-by`. -->


## In Dev — <agents>

<!-- implementation + test notes -->

### → Handoff to Review (next agent: code-quality-guardian)

<!-- what to pay attention to, known smells -->

## Review round 1 — code-quality-guardian

<!-- verdict + issues; runs against the open PR's diff (PR was opened by expert-developer at the in-dev → review transition) -->

### → Handoff back to In Dev (if FAIL/REVIEW)

<!-- fix list -->

## Distillation — solutions-architect

<!-- Runs in the worktree on the card branch after Review PASS. Pushes to the same PR. Per the `distillation` skill: SEARCH docs/ INDEX files first; edit existing docs rather than creating duplicates. Captures land at smallest viable scope: inline WHY comments, docs/decisions/, docs/knowledge/, docs/product/, or CLAUDE.md. Then flips status to pr-ready. -->

## PR Ready

<!-- PR url; founder notification fires here -->

<!-- Abandoned section: appended by /board-close. Records date, reason, PR state at close, worktree teardown. Heading is "## Abandoned — founder". -->
