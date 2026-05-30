---
id: 0012-tool-request-payload-parity
title: Tool→service request-payload parity (raw catalog pass-through)
tags: [parity, payload, adapters, catalog, search, request-path]
card: tool-service-search-parity-verification
commit: f198e85
updated_at: 2026-05-29
updated_by_card: tool-service-search-parity-verification
---

# ADR-0012 — Tool→service request-payload parity (raw catalog pass-through)

## Status

Accepted (2026-05-29). Affects every adapter (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw) and the shared `klodi-rust-host` crate.

Sibling to [[0011-adapter-exception-envelope]]: that ADR locks parity on the **response / error** path (one envelope shape and one error vocabulary across adapters); this ADR locks parity on the **request / input** path. Same structural pattern — the catalog is the single source of truth, the three language stacks consume it, a golden fixture oracles the wire, and a per-stack parity test gates drift — applied to the opposite direction of the call. They are deliberately two ADRs: error-envelope parity and request-payload parity are distinct topics that happen to share a parity mechanism, and folding the request-path invariant into ADR-0011 (titled and themed entirely around the *exception* envelope) would make that ADR's scope incoherent.

## Context

`klodi` has no human search UI. The agent is the only caller, so parity is judged at the agent-facing wire: the same query issued through `klodi_search` and directly against `p2p.v1.listings.search` must reach the marketplace as the **same payload**, on every adapter. The marketplace's upgraded ranking (semantic / multilingual / fuzzy) is exactly the surface most sensitive to "empty query string" vs "absent query field" — so any adapter that silently transforms the request before sending it breaks parity *unobservably* from the outside (a response-only parity check would still pass, because a faithful pass-through tool faithfully transmits whatever the service returns).

Three stacks had different request-payload-construction behavior for `klodi_search`:

- **openclaw (TS)** ran `compactPayload(params)` in `registerSearch` — dropping `undefined` / `null` / `""` values and stripping adapter-internal flags. `klodi_search({ query: "", category: null })` became `{}` on the wire.
- **klodi-rust-host** sent `Value::Object(args)` verbatim from `dispatch_passthrough` — no transform.
- **hermes / nanobot (Python)** passed `args` raw to `client.request(subject, args)` — no transform.

So `{query: "", category: null}` arrived as `{}` on openclaw and as `{query: "", category: null}` on every other stack — divergence on the exact edge the new ranker cares about. Separately, openclaw was the only stack that did **not** register `klodi_searches_create` as a standalone catalog tool (it was reachable only through the `klodi_watch` composite); every other stack exposed it directly via catalog passthrough.

This is the same failure class ADR-0011 was filed to disprove ("one adapter behaves like all adapters" is an assumption, not a fact) — surfacing here on the request path instead of the response path.

## Decision

**The tool layer forwards the raw catalog-shaped payload to the marketplace subject unchanged. Adapter-side payload compaction (e.g. openclaw's `compactPayload`) is forbidden on the catalog `klodi_search` / `klodi_searches_create` path. `klodi_search` and `klodi_searches_create` are the sole entry points to their NATS subjects (`p2p.v1.listings.search`, `p2p.v1.searches.create`).**

Corollaries:

1. **The catalog defines the wire shape; the marketplace defines the meaning.** The tool layer decides neither. It is not the tool's business to decide what "empty" means on the service's behalf — `compactPayload` deciding that `query: ""` should become absent is exactly the overreach this ADR forbids. Empty-string, `null`, and omitted are three distinct inputs the agent may issue; the service is the authoritative interpreter of each.
2. **Catalog tools are pass-through; composite tools may transform.** `compactPayload` stays alive inside `runOneShotSearch` (the `klodi_watch` composite), because there the strip-fields `persist` / `action_on_match` / `target_price` are genuinely adapter-internal composite params, **not** catalog fields — they must not reach the marketplace. The line is: catalog field → forward unchanged; composite-internal flag → strip before the catalog call.
3. **Single entry point per subject.** Exactly one catalog tool maps to `p2p.v1.listings.search` and exactly one to `p2p.v1.searches.create`. No parallel search path may wrap either subject. A second tool wrapping the subject is a parity hazard (it could diverge from the canonical tool) and is structurally rejected by the fixture validator.
4. **Every adapter exposes both tools directly.** `klodi_searches_create` is a first-class catalog tool on every stack; agents register a standing search with their own slug without routing through `klodi_watch`.

### Wire-format oracle and gate

The request-payload oracle is `packages/tool-catalog/tests/fixtures/search-payload-golden.json` — a fixed input matrix (one entry per case shape: empty-query, null-category, pickup-with-radius, ship-with-to, digital, any, cursor-set, limit-set, minimal, fully-populated), each pairing an `input` (catalog params) with the `expected_wire_payload` that must arrive on the NATS subject. It is the request-path analogue of ADR-0011's `envelope-golden.json`. Each language stack's parity suite reads this fixture, drives the tool's registered handler, captures the `(subject, payload)` it would have sent (intercepting at the NATS-client request boundary — no live broker), and asserts byte-equality per case:

- openclaw — `adapters/openclaw/src/__tests__/tools/search-payload-parity.test.ts` (vitest)
- hermes — `adapters/hermes/tests/test_search_payload_parity.py` (pytest)
- nanobot — `adapters/nanobot/tests/test_search_payload_parity.py` (pytest)
- klodi-rust-host (serving moltis / ironclaw / zeroclaw) — `packages/klodi-rust-host/tests/search_payload_parity.rs` (cargo, `--features mcp`)

A frozen schema snapshot at `packages/tool-catalog/tests/golden/search-schemas.json` (gated by `packages/tool-catalog/tests/search-schema-snapshot.test.ts`) holds the no-breaking-change line: the `params` / `result` shapes of both tools may only change additively (no removed / renamed / retyped fields, no `Type.Optional` → required promotions). The single-entry-point invariant is asserted in `packages/tool-catalog/tests/search-payload-golden.test.ts`.

The headline end-to-end parity proof (same query through the tool and through `p2p.v1.listings.search` yields identical ranked results) lives in the `klodi-stage` sibling repo against the golden eval dataset — a separate card consuming this fixture as its contract. This ADR governs the per-stack request-payload tier that proves no stack mutates the payload before it leaves the tool layer.

## Alternatives considered

1. **Extend ADR-0011 with an input-parity section instead of a new ADR.** Recommended by the card's dev + review handoffs, and seriously considered. Rejected: ADR-0011's title, framing, and every section govern the *exception envelope* and pre-call guards (the response/error path). Request-payload parity is the opposite direction of the call with its own oracle fixture; appending it would dilute ADR-0011's single topic and make its title misdescribe its contents. The two are siblings, cross-linked, not one decision. (Per the `distillation` skill's "one topic per doc" rule.)

2. **Assert parity on the response shape only, not the request payload.** Rejected — a faithful pass-through tool faithfully transmits service drift, so response-only parity passes silently even when an adapter mangles the request. The request payload is the one place the tool layer can transform input and break parity unobservably from outside. Both are checked (response equality end-to-end in klodi-stage; request payload here), but the request tier is where the architectural risk lives.

3. **Keep `compactPayload` on the `klodi_search` arm and "normalise" empty inputs.** Rejected — that hardcodes the tool layer's opinion of what "empty" means, which is the marketplace's call. Empty-string vs omitted is semantically meaningful to the upgraded ranker.

4. **Run the full eval harness through all six adapters for the per-stack tier.** Rejected as bloat — ~5 min/case × hundreds of cases × 6 adapters. The integration-tier golden fixture catches payload-shape divergence mechanically without a broker; the e2e tier needs only one representative adapter to prove the round-trip.

5. **Push the parity assertion into per-adapter unit suites with no shared fixture.** Rejected — three test runners (vitest / pytest / cargo) sharing one JSON fixture is the precedent ADR-0011's envelope-golden file established. The shared fixture *is* the contract; per-adapter assertions are mechanical against it.

## Security implications

- **No new agent-reachable sink.** The change *removes* a transform (openclaw's compaction) rather than adding one; the marketplace remains the authoritative validator of every field. `klodi_searches_create`'s new openclaw registration runs the same pre-call guard chain as every other tool (a `non_empty_string` guard on the catalog-required `slug`, then ADR-0011's envelope on failure), so it inherits the guard-before-I/O and closed-envelope guarantees rather than opening a new unguarded path.
- **Forwarding raw input is safe because the server is the trust boundary.** Parity does not weaken validation — the service validates every payload regardless of which adapter sent it. Parity guarantees the agent's recovery behavior is identical across adapters (the same input produces the same server-side outcome everywhere), which is the same agent-portability property ADR-0011 secures for the error path.

## References

- **Decision sites (inline `// See ADR-0012` anchors):**
  - openclaw `compactPayload` removal + `registerSearchesCreate`: `adapters/openclaw/src/tools/discovery.ts` (`registerSearch`, `registerSearchesCreate`)
  - Rust pass-through helper: `packages/klodi-rust-host/src/mcp/tools.rs` (`payload_for_passthrough`, `tool_input_schema_for`)
  - Rust module visibility: `packages/klodi-rust-host/src/mcp/mod.rs` (`pub mod tools`)
- **Request-payload oracle:** `packages/tool-catalog/tests/fixtures/search-payload-golden.json`
- **Schema snapshot + gate:** `packages/tool-catalog/tests/golden/search-schemas.json`, `packages/tool-catalog/tests/search-schema-snapshot.test.ts`
- **Single-entry-point + fixture-shape validator:** `packages/tool-catalog/tests/search-payload-golden.test.ts`
- **Per-stack parity suites:** `adapters/openclaw/src/__tests__/tools/search-payload-parity.test.ts`, `adapters/hermes/tests/test_search_payload_parity.py`, `adapters/nanobot/tests/test_search_payload_parity.py`, `packages/klodi-rust-host/tests/search_payload_parity.rs`
- **Catalog source of truth:** `packages/tool-catalog/src/index.ts:353` (`klodi_search`), `:379` (`klodi_searches_create`)
- **Related:** [[0011-adapter-exception-envelope]] — sibling parity ADR for the response/error path (same pattern, opposite direction).
