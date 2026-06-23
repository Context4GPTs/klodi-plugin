---
id: 0016-wake-log-correlator-contract
title: wake_enqueued correlator — echo the producer's event_id, never mint one; the contract is codegen'd into 3 loggers but emitter-satisfied only in openclaw
tags: [logging, correlator, wake, observability, catalog, contracts, adapters, parity, openclaw]
card: add-event-correlator-to-wake-enqueued-log
commit: a608937
updated_at: 2026-06-23
updated_by_card: add-event-correlator-to-wake-enqueued-log
---

# ADR-0016 — `wake_enqueued` correlator: echo the producer's `event_id`, never mint one; contract codegen'd into all three loggers but emitter-satisfied only in openclaw

## Status

Accepted (2026-06-23). Affects the openclaw adapter's wake path
(`adapters/openclaw/src/service/wake.ts`, `wake-handlers.ts`,
`tools/register-poller.ts`) and the shared `wake_handler` log-site contract
(`packages/tool-catalog/src/logging.ts:73-78`).

Member of the catalog-parity family with **[[0011-adapter-exception-envelope]]**
(response/error-envelope axis) and **[[0012-tool-request-payload-parity]]**
(request-payload axis): same structural pattern — the catalog declares one
contract, the three language stacks consume it, and "one adapter behaves like all
adapters" is an assumption, not a fact. This ADR names the **structured-log-field**
axis of that family. Sibling to **[[0015-gateway-runtime-load-vs-armed-axis]]**,
which governs whether the wake-pump *arms* (a wake fires at all); this ADR governs
what a wake, once fired, *logs* so it can be correlated back to its wire event.

## Context

`wake_enqueued` exists so an operator can tie a *wake* (the local act of waking the
agent) back to the *wire event* that caused it. Before this card the openclaw
emitter (`wake.ts`, the only `wake_enqueued` emitter in the whole repo) logged
`{ reason, sessionKey, ...store-diag }` — no `event_id`, and `kind` only smuggled
in through the overloaded `reason`. Two same-kind wakes to one persona were
indistinguishable, and the line violated a contract that *already existed*:
`REQUIRED_FIELDS_BY_SITE.wake_handler = ["event_id", "kind"]`
(`logging.ts:74`).

Two non-obvious facts forced the design and are the reason this ADR exists:

1. **The correlator is an *echo*, not an *identity mint*.** `event_id` is owned by
   the marketplace gateway (the event producer) and is the same id the agent-side
   dedup keys on against JetStream `max_deliver: 5` (`events.ts:10-11`). If the
   plugin minted a fresh id per wake, (a) redelivered duplicates of one notification
   would look like distinct events, and (b) the operator log id would not match the
   dedup id, breaking a *single* correlation id across the whole lifecycle
   (producer → JetStream → wake → agent dedup). So the plugin must lift
   `event.event_id` verbatim and never generate one.

2. **The contract is codegen'd into all three loggers but enforced by no runtime
   and satisfied by only one emitter.** `REQUIRED_FIELDS_BY_SITE` is codegen'd into
   `logger-py` and `logger-rs` (`packages/logger-py/src/klodi_logger/schemas.json`,
   the rust codegen in `tool-catalog/src/codegen/rust-types.ts`). But the loggers
   **do not reject** calls missing required fields — the `logging.ts:68-71` docstring
   is explicit: a contract *test* is meant to fail CI instead. Two gaps follow that a
   future contributor must not assume away:
   - **No `wake_enqueued` emitter exists outside openclaw.** The hermes wake handlers
     (`adapters/hermes/src/klodi_hermes/ns.py`) and every Rust adapter emit no
     `wake_enqueued` line at all. So "the contract is in the catalog" does **not**
     mean any non-openclaw wake is correlatable — there is simply no line to carry
     the fields yet. Bringing those adapters' wake paths into compliance is sibling
     work, not done here.
   - **The integration test the contract docstring points at
     (`tests/integration/log-contract.test.ts`) is absent from the repo.** The
     openclaw emitter is locked instead by its own unit suite
     (`wake.test.ts`). The contract is therefore enforced for openclaw at unit tier
     and for no other adapter at any tier.

## Decision

**`wake_enqueued` carries a `WakeCorrelator { kind: string; event_id: string | null }`
spread into the line. `event_id` is echoed verbatim from the triggering wire event
and is `null` — never `undefined`, never minted — for locally-originated wakes that
point at no wire event. `kind` is a first-class discriminator, distinct from the
overloaded `reason`.**

- **`null`, not `undefined`, for local wakes.** The five `register-poller.ts`
  synthetic callers pass `{ kind: <origin>, event_id: null }`. `null` keeps the key
  *present* in the emitted object; `undefined` would drop the key via the spread and
  fail the `wake_handler` required-field contract. The unit test asserts
  `"event_id" in ctx === true && ctx.event_id === null` precisely to guard this.
- **`kind` is its own field, not derived from `reason`.** `reason` stays overloaded
  (free-form for synthetic wakes; mangled to `hook:klodi:<reason>` for the heartbeat
  at `wake.ts`). Re-parsing `kind` out of `reason` would be fragile and wrong for
  non-wire wakes. The handlers pass `kind` explicitly. For wire wakes `kind` and
  `reason` coincide in value today but are semantically distinct fields.
- **Optional param, nullable field.** `wakeAgent(api, text, reason, correlator?)`
  keeps the 3-arg heartbeat/store-diagnostic callers compiling and emitting
  byte-identically (`...undefined` adds nothing). The correlator rides *alongside*
  `reason`/`sessionKey`/`store_*` — additive only, no existing field dropped.

## Alternatives considered

- **Mint a fresh correlation id per wake — rejected.** Breaks the agent-side dedup
  (`events.ts:10-11`) and makes redeliveries look distinct. The id must be the
  producer's.
- **Thread the id through `wake-pump.ts` / `nats-client-ts` — rejected.** The pump
  is event-agnostic; the handler already holds `event.event_id`. (This was the
  card's provisional guess; Discovery overturned it.)
- **Make the correlator required — rejected.** Breaks the five synthetic
  `register-poller.ts` callers at build time; they legitimately have no wire id.
  Optional param + nullable field instead.
- **Tighten only the cross-repo (klodi-stage) assertion — rejected.** Leaves the
  `wake_handler` contract violated and the wakes uncorrelatable. The plugin must
  emit the field.

## Security implications

The correlator carries no payload: `kind` is an enum value, `event_id` an opaque
UUID. Neither is in `REDACTED_FIELD_NAMES` (`logging.ts`), so both surface at INFO
in the clear — safe for operator log aggregation. The fix must not widen the log to
echo any redacted field (`payload`/`body`/`content`/`terms`) into the correlator;
the event payload already rides the wake *text* to the agent (per
[[0012-tool-request-payload-parity]]) and must not leak into the operator line.

## References

- **Correlator type + inline WHY:** `adapters/openclaw/src/service/wake.ts`
  `WakeCorrelator` doc-comment (nullability rationale, echo-not-mint,
  null-not-undefined) — the canonical site-local explanation.
- **Wire-event callers:** `adapters/openclaw/src/service/wake-handlers.ts`
  (`makeNotificationHandler`, `makeChannelHandler`).
- **Local-wake callers:** `adapters/openclaw/src/tools/register-poller.ts`
  (five synthetic origins, `event_id: null`).
- **The contract:** `packages/tool-catalog/src/logging.ts:73-78`
  (`REQUIRED_FIELDS_BY_SITE.wake_handler`) and its codegen into `logger-py` /
  `logger-rs`. Note the loggers do **not** enforce it (`logging.ts:68-71`).
- **`event_id` semantics:** `packages/tool-catalog/src/events.ts:10-11` (per-wire
  UUID v4, the consumer-side dedup key against `max_deliver: 5`).
- **Unit lock:** `adapters/openclaw/src/__tests__/service/wake.test.ts`.
- **Sibling axes:** [[0011-adapter-exception-envelope]],
  [[0012-tool-request-payload-parity]] (parity family);
  [[0015-gateway-runtime-load-vs-armed-axis]] (does the pump arm at all);
  [[0001-persistent-websocket-connection]] (the wake-event transport).
- **Out of scope (sibling cards):** hermes/nanobot/rust wake paths emit no
  `wake_enqueued` line yet; the referenced `tests/integration/log-contract.test.ts`
  is absent.
