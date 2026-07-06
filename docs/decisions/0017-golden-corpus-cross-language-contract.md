---
id: 0017-golden-corpus-cross-language-contract
title: Golden corpus is the cross-language wake-event contract (Decision 7) — fixtures mirror the publisher wire body, not the enriched event
tags: [golden, contract, drift, cross-language, events, codegen, nats, gate, fixtures]
commit: 720077a
updated_at: 2026-06-25
---

# ADR-0017 — Golden corpus is the cross-language wake-event contract (Decision 7)

## Status

Accepted (2026-06-25). Consolidates the previously un-ADR'd "Decision 7" cross-language wake-event contract that is referenced by inline anchors across all three language clients and the two `tool-catalog` gate scripts, but had no dedicated decision record. Surfaced when ~6 weeks of field-level fixture↔shape drift (`search.match` `delivery_method`/`location_area` → `fulfillment[]`; `channel.message` `sequence`) sat undetected because the drift gate is structurally blind to it.

Affects the wake-event contract shared by `packages/tool-catalog/src/events.ts` (TS source of truth), the shared fixtures under `packages/tool-catalog/tests/golden/`, the three contract suites (`nats-client-{ts,py,rs}/tests/contract/golden.*`), and the codegen'd Python/Rust models. Sibling in spirit to [[0014-tool-symmetry-axes]]: both record a drift class that survived because *a gate meant to catch it was structurally blind and wired into no CI*.

## Context

Every wake delivered on the notifications or channels consumer carries a payload of one of the shapes in `events.ts`, which declares itself the authoritative source of truth; the Python and Rust adapters mirror those shapes via codegen. A single shared fixture corpus (`tests/golden/<kind>.json`) is parsed by a contract suite in each of the three languages, so a shape change must land in `events.ts`, the fixtures, and all three suites in one lockstep change.

Two non-obvious properties of this contract are *not* discoverable from reading any one file, and both were the proximate cause of this bug:

1. **The fixtures mirror the publisher's *wire body*, not the consumer-enriched event.** `channel.message.json` carries **no `sequence`** field — JetStream assigns the stream sequence server-side, and the consumer injects it post-parse from `msg.info().stream_sequence`. So the canonical event *type* has `sequence`, but the canonical *fixture* legitimately omits it. A contributor who "fixes a failing test" by adding `sequence` to the fixture makes the corpus lie about the wire format and diverges it from Rust's green suite. The assertion, not the fixture, was wrong.

2. **The drift gate `check-golden-coverage.mjs` is presence-only, and CI-invisible.** It walks each `kind:` discriminator in `events.ts` and confirms a `<kind>.json` exists — nothing more. It cannot see a renamed field, a flat→discriminated-union migration, or an optional flipped to required. It is also wired into **no** CI workflow or Makefile (only its own `package.json` script references it). Both facts together are why migration commit `88012ac` (2026-05-09) could update `events.ts` + the fixtures + only the Rust suite in lockstep, leave the TS and Python suites asserting the dead schema, and have nobody notice for ~6 weeks. The gate is additionally already broken on a clean tree (it false-fails the `transaction.*_confirmed` sub-kinds that share representative fixtures and flags the `search-schemas.json` SC-contract snapshot as an orphan), so it is a fail-open no-op in practice.

## Decision

**`events.ts` is the single cross-language source of truth for wake-event shapes; the golden fixtures are canonical and mirror the publisher wire body; the Python/Rust models mirror `events.ts` via codegen; and all three contract suites assert the same corpus at equivalent strength.** When a shape and a fixture conflict, the fixture (which mirrors the real wire body) and `events.ts` are authoritative — stale assertions are corrected to match, never the other way around.

Consequences a future agent must respect:

- **Never edit a golden fixture to make an assertion pass.** Fix the assertion. The fixture mirrors the wire body; if it parses correctly in Rust's green suite, the TS/Python failure is a stale assertion, not bad data.
- **`sequence` on `channel.message` is consumer-injected metadata, absent from the body.** The Python model models this as a `total=False` subclass (`ChannelMessageEvent(_ChannelMessageBody, total=False)`), Rust as `#[serde(default)] sequence: u64`, and all three contract suites assert `sequence` *absent* from the parsed body. (The Python `total=False`-subclass form — rather than a bare `NotRequired[int]` — is load-bearing under `from __future__ import annotations`: PEP 563 stringizes the annotation and CPython files a stringized `NotRequired` wrapper under `__required_keys__`, silently re-breaking runtime optionality. The WHY lives inline at `events.py`.)
- **A shape change is a four-place change:** `events.ts`, the fixture(s), and all three contract suites, in one commit. Rust is the de-facto oracle for assertion strength — mirror `golden.rs` when writing the TS/Python assertions (e.g. `search.match` asserts ≥1 `DeliveryOffer`, a `method` discriminator in `{pickup,ship,digital}`, pickup `location.{lat,lng,area}`, ship `from.country` + non-empty `shipsTo`).
- **The presence-only gate does not protect you.** Until it is hardened (see the follow-up below), passing `check:golden` proves only that a fixture file exists per kind — not that its fields conform. Treat the three contract suites, not the gate, as the real drift detector.

## Alternatives considered

1. **Treat the fixture as the laggard and add the missing fields back.** Rejected — the fixtures already speak the live schema; they mirror the real publisher body, which provably omits `sequence` and replaced the flat `(delivery_method, location_area)` pair with `fulfillment: DeliveryOffer[]` in the `delivery.ts` redesign (commit `88012ac`). Re-adding either would make the corpus lie about the wire format and break Rust's green suite.

2. **Change the `events.ts` shapes to match the stale assertions.** Rejected — `events.ts` is the declared source of truth and already matched the fixtures for both fields (15/17 assertions passed against it). The drift was entirely on the test/model side.

3. **Fix only the TS suite, leave Python red.** Rejected — Python reads the *same* shared corpus and was failing the identical two cases. The contract is cross-language by construction; a one-language fix leaves a known-red mirror and the same drift class live.

4. **Harden the gate to field-level conformance in this same change.** Deferred to a follow-up, not rejected. Layering TypeBox `Value.Check` onto a gate whose presence semantics are already broken on a clean tree (and which runs in no CI) is a distinct design change, not "a few lines": it requires first repairing the per-kind-vs-per-variant fixture policy and excluding the non-`kind` snapshot file, then guarding the TypeBox import so a fresh-worktree resolution miss can't hard-block CI, then wiring it into CI at all. The cross-language contract is in lockstep across all three languages without it.

## Security implications

- **No new agent-reachable sink and no trust-boundary change.** This consolidates an existing contract and corrects test/model assertions against a static fixture corpus; no runtime, network, or cross-process path is altered. The marketplace remains the authoritative validator of every wake payload.
- **The fail-open gate is the security-relevant smell, named here, not closed here.** A drift gate that passes silently on the exact drift it names in its own header is a fail-open consistency check. Documenting the weakness (and the follow-up to make it fail-closed + CI-wired) is the correct direction; the contract suites are the interim real detector.

## References

- **Source of truth:** `packages/tool-catalog/src/events.ts` (header: "Authoritative source of truth … mirrored via codegen").
- **Canonical fixtures:** `packages/tool-catalog/tests/golden/*.json` — mirror the publisher wire body (`channel.message.json` omits `sequence`; `search.match.json` carries `listing_summary.fulfillment`).
- **The three mirror suites:** `packages/nats-client-ts/tests/contract/golden.test.ts`, `packages/nats-client-py/tests/contract/test_golden.py`, `packages/nats-client-rs/tests/contract/golden.rs` — each headers itself "Cross-language contract test … Decision 7". The Rust suite is the de-facto strength oracle (`golden.rs:333-352` `fulfillment`; `:405-420` `sequence`-absent).
- **The blind gate:** `packages/tool-catalog/scripts/check-golden-coverage.mjs` (header: "Drift gate for the golden corpus (Decision 7)") — presence-only, CI-unwired, already broken on a clean tree.
- **The `sequence` consumer-injection model:** `packages/nats-client-py/src/klodi_nats_client/events.py` (`ChannelMessageEvent` `total=False` subclass + inline PEP-563 WHY), `packages/nats-client-rs/src/events.rs` (`#[serde(default)] sequence`).
- **The `fulfillment` redesign rationale:** `packages/tool-catalog/src/delivery.ts` header (the `DeliveryOffer` discriminated union that replaced the flat `delivery_method`/`location_area` pair).
- **Migration that introduced the drift:** commit `88012ac` (2026-05-09) — updated `events.ts` + fixtures + only the Rust suite, leaving TS/Python stale.
- **Sibling drift-class ADR:** [[0014-tool-symmetry-axes]] — same lesson (a gate blind to the drift it names, wired into no CI).
