---
id: 0019-wake-inject-failure-disposition
title: Wake-inject failure disposition by class — timeout is swallowed-and-ACKed; a deterministic nonzero exit is a loud correlated alarm, never NAK/redeliver/dead-letter
tags: [wake, error-handling, observability, alarm, consumer, ack, adapters, parity, hermes, nats]
card: wake-inject-failures-silent-and-lost-hermes
commit: e0c9a45
updated_at: 2026-06-29
updated_by_card: wake-inject-failures-silent-and-lost-hermes
---

# ADR-0019 — Wake-inject failure disposition by failure class

## Status

Accepted (2026-06-29). Affects the hermes adapter's wake path
(`adapters/hermes/src/klodi_hermes/bridge.py`, `wake_handlers.py`) and the shared
consumer ACK seam (`packages/nats-client-py/src/klodi_nats_client/consumers.py`).

Member of the wake-path family with **[[0016-wake-log-correlator-contract]]** (the
`event_id`/`kind` the alarm echoes), **[[0001-persistent-websocket-connection]]** (the
transport the wake rides), and **[[0011-adapter-exception-envelope]]** (the *outbound*
tool-call error contract — distinct axis: that governs what a failed **tool call**
returns to the agent; this governs how a failed **inbound wake inject** is disposed of).
The invariants below are written adapter-portable: the sibling card
`audit-all-adapters-for-silent-wake-inject-failure` (epic `wake-inject-swallow-2026-06`)
holds every adapter (openclaw TS, nanobot, moltis/ironclaw/zeroclaw Rust) to this same
split. Hermes is the reference implementation.

## Context

A marketplace wake lands on a JetStream consumer; the hermes bridge shells out
`hermes chat … -Q` to inject the `[klodi] …` system message. When that subprocess failed
fast with `exit=1` and an empty stderr, the bridge logged a WARNING and *fell through* —
the handler returned, the message ACKed, JetStream's `max_deliver: 5` never fired, and the
wake was gone. Over 26 days two wakes were eaten this way and the only way it surfaced was
by asking. The harm is **silence**, not the loss of one datum.

Two non-obvious facts force the design:

1. **`hermes chat -Q` (quiet) writes its error/usage/traceback to *stdout*, leaving
   stderr empty.** The original code captured both streams but logged only `stderr[-500:]`,
   so the one field explaining `exit=1` was captured and discarded. A failure surface that
   omits stdout is unexplainable (INV-2).
2. **A timeout and a fast deterministic nonzero exit demand opposite dispositions.** A
   timeout is a transient hung LLM turn — redelivering just re-hangs, so swallow-and-ACK is
   correct and paging on it is noise. A fast nonzero exit is a *misconfiguration that fails
   identically on every wake* — swallowing it silently eats every notification forever. The
   two cannot share a disposition.

## Decision

**Dispose of a wake-inject failure by its class:**

- **Transient (timeout / hung chat)** → `wake_inject_timeout` WARNING, swallow, ACK, do
  **not** redeliver. Disposition unchanged from before.
- **Deterministic (fast nonzero exit)** → surface a **loud, correlated, operator-visible
  ERROR alarm** (`wake_inject_deterministic_failure`) carrying `exit`/`stdout`/`stderr`
  (stdout included — closes fact 1) plus `kind`/`event_id`. The message is **still ACKed —
  never NAK'd, redelivered, or dead-lettered.** Silence is the only forbidden outcome; the
  alarm, not redelivery, is the surface.

The invariants, held adapter-portable:

- **INV-1** — a wake must never be *silently* lost. It terminates in exactly one observable
  disposition: delivered (`wake_inject_complete`) or surfaced-failure.
- **INV-2** — every failure surface must be *explainable* → it MUST include stdout.
- **INV-3** — the surface is determined by failure *class* (transient WARNING-swallow vs
  deterministic ERROR-alarm), and the deterministic alarm MUST be loud and distinct from the
  routine timeout WARNING (operators demonstrably did not watch WARNING over 26 days).

**Where each step lives (this split is load-bearing):**

- *Classification* lives at the subprocess boundary — `bridge.inject_message` — the **only**
  site holding both the `TimeoutExpired` and the `returncode` signal. A nonzero exit raises a
  typed `WakeInjectFailed(returncode, stdout, stderr)`; a timeout keeps the WARNING+return.
- *The alarm* lives at the wake handler — `wake_handlers._inject` — the **only** site holding
  the wake correlation (`kind`/`event_id`). A dedicated `except WakeInjectFailed` arm is placed
  **before** the broad `except BaseException`, so the typed failure is never downgraded to the
  best-effort WARNING; it emits the ERROR alarm and **returns normally** (so the consumer still
  ACKs — `consumers.py` ACKs on handler return, NAKs only on raise). `event_id` is echoed
  verbatim per [[0016-wake-log-correlator-contract]] (never minted; may be `""` for a
  locally-originated wake).

## Alternatives considered

- **NAK → redeliver via `max_deliver: 5` — rejected.** A deterministic failure fails
  identically on every attempt, so redelivery burns all 5 in ~2.5s and drops anyway —
  converting a silent 1× drop into a silent 5× drop. Surfaces nothing. (The chosen ACK-stays
  is the opposite of the instinctive "fix": re-raising into the NAK path is the regression the
  integration test `test_dispatch_acks_deterministic_failure_and_never_naks` guards against.)
- **Dead-letter store for the dropped wake — rejected (out of required scope).** A durable
  replay buffer is heavier than a config error warrants; the wake's underlying state stays
  re-queryable from the marketplace ([[0012-tool-request-payload-parity]]) once the operator
  fixes the cause, so no replay buffer is needed to recover. Revisit only if a wake ever carries
  the *sole* copy of a datum.
- **Treat all nonzero exits as transient (swallow) — rejected.** That is the original bug.
- **Bridge asserts/creates a channel-bound session before inject — rejected and now moot.** It
  would couple the bridge to hermes's session-storage and channel-binding internals it
  explicitly disclaims owning (`bridge.py` module docstring). Piece 2 removes the dependency
  entirely by running every wake in a dedicated session keyed off the event — **per
  conversation**, not the operator's, and **namespaced under `klodi:`**: `klodi:<channel_id>`
  for channel.*, `klodi:<listing_id>` for offer.*/comment.*/listing.*, `klodi:<transaction_id>`
  for transaction.*, `klodi:<search_slug>` for search.match, and an ephemeral
  `klodi:wake-<event_id>` fallback when the key field is absent — always without `--continue`.
  The `klodi:` namespace is load-bearing: the sibling outbound card
  (`wake-outbound-roundtrip-message-and-correlation`) resolves the operator's active session from
  `active_sessions.json` and excludes the wake-session family by this prefix — a bare entity id
  (esp. a `search_slug` like `vintage-camera`) is otherwise indistinguishable from an operator
  session. (Superseding the earlier single shared `klodi-wake` session, which grew unbounded for
  the daemon's lifetime; see `wake_handlers.derive_wake_session`. The colon namespace is distinct
  from the retired `klodi-wake` hyphen literal. A conversation's terminal event triggers a
  best-effort, probe-gated `drain_session` on the same namespaced key.) There is nothing on the
  operator side to assert.
- **Emit the alarm inside `bridge.inject_message` directly — rejected.** The bridge has
  `exit`/`stdout`/`stderr` but **not** `kind`/`event_id`, so it cannot emit one correlated line;
  one ERROR at the handler beats a bridge diag line + a handler correlation line.

## Assumption (founder may override)

All nonzero exits are treated as **deterministic** → alarm. The observed failure is
deterministic and the cost is asymmetric: a spurious ERROR on a rare transient nonzero is cheap
and informative; silently swallowing a deterministic one loses every notification. If a distinct
class of *transient* nonzero exits later emerges, bounded redelivery is the right tool for that
subclass only.

## Security implications

The alarm surfaces the subprocess `stdout`/`stderr` at ERROR, truncated to `_DIAG_TAIL` (500
chars) so a runaway traceback stays bounded. The diagnostic carries the CLI's own error text
(which may name a session/channel) but **no marketplace payload** — the event body rides the
wake *text* to the agent (per [[0012-tool-request-payload-parity]]), never the operator alarm
line. A future change must not widen the alarm to echo a redacted field
(`payload`/`body`/`content`/`terms`).

## References

- **Classifier:** `adapters/hermes/src/klodi_hermes/bridge.py` — `WakeInjectFailed` class +
  `BridgeCtx.inject_message` (timeout → WARNING+return; nonzero → raise; module docstring
  "Failure modes" block). `_DIAG_TAIL = 500` is the shared truncation bound.
- **Alarm:** `adapters/hermes/src/klodi_hermes/wake_handlers.py` — `_inject`'s
  `except WakeInjectFailed` arm (placed before the broad `except`; emits the correlated ERROR,
  no re-raise). `event_id` threaded up from `handle_notification`/`handle_channel_message`;
  the alarm also carries the resolved per-conversation `session` key (so an operator can see
  which conversation's wake failed).
- **ACK seam:** `packages/nats-client-py/src/klodi_nats_client/consumers.py` —
  `_dispatch_message` ACKs on handler return, NAKs on raise. Unchanged: the disposition is chosen
  in the adapter, not the consumer.
- **Correlator contract:** [[0016-wake-log-correlator-contract]] (`event_id` echo, never mint).
- **Sibling audit card:** `audit-all-adapters-for-silent-wake-inject-failure`
  (epic `wake-inject-swallow-2026-06`) — holds every adapter to INV-1/2/3.
- **Related:** [[0001-persistent-websocket-connection]] (transport),
  [[0011-adapter-exception-envelope]] (outbound tool-call error axis),
  [[0012-tool-request-payload-parity]] (payload rides the wake text).
