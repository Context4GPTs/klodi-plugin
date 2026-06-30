---
id: 0019-wake-inject-failure-disposition
title: Wake-inject failure disposition by class — timeout is swallowed-and-ACKed; a deterministic nonzero exit is a loud correlated alarm, never NAK/redeliver/dead-letter
tags: [wake, error-handling, observability, alarm, consumer, ack, adapters, parity, hermes, nats]
card: wake-inject-failures-silent-and-lost-hermes
commit: 611750d
updated_at: 2026-06-30
updated_by_card: audit-all-adapters-for-silent-wake-inject-failure
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

### Wake session model — per-conversation, `klodi:`-namespaced

Every wake also runs in a **dedicated session keyed off the event** (no `--continue`, never the
operator's session): marketplace reasoning never pollutes the human's live chat, and no single
session grows unbounded for the daemon's lifetime. The key is derived in one typed function
(`wake_handlers.derive_wake_session`), **prefix-keyed off the kind's domain** — not "first id
present", because several kinds carry >1 id (`offer.accepted` has both `listing_id` **and**
`transaction_id`; `channel.*`/`transaction.*` also carry `listing_id`):

| Wake kind | `--session` key |
|---|---|
| `channel.opened` / `channel.message` / `channel.closed` | `klodi:<channel_id>` |
| `offer.*` · `comment.created` · `listing.*` | `klodi:<listing_id>` |
| `transaction.*` | `klodi:<transaction_id>` |
| `search.match` | `klodi:<search_slug>` |
| kind missing its key field | `klodi:wake-<event_id>` (or `klodi:wake-<uuid4>` if `event_id` is also absent) |

**Why the `klodi:` namespace is load-bearing, not cosmetic.** The sibling outbound card
`wake-outbound-roundtrip-message-and-correlation` (same epic) resolves the operator's active
session from `runtime/active_sessions.json` and must **exclude the wake-session family** — but a
bare entity id is syntactically indistinguishable from a session the human operator owns
(sharpest: a `search_slug` like `vintage-camera`). The `klodi:` prefix is the only filter that
separates the two; the colon also distinguishes it from the retired single shared `klodi-wake`
(hyphen) session. `:` in a session id is **already established in this epic** — openclaw uses
`agent:<id>:main` and this adapter namespaces its skill `klodi:klodi` — the prior art the
merge-gate `:`-acceptance probe leans on.

**This keying scheme is the frozen epic template.** The sibling audit card
`audit-all-adapters-for-silent-wake-inject-failure` makes hermes the reference the 5 other
adapters (openclaw, zeroclaw, nanobot, moltis, ironclaw) mirror — per-conversation,
`klodi:`-namespaced sessions, never one shared session. A conversation's terminal event
(`channel.closed`; `listing.sold/withdrawn/expired`; `transaction.completed/cancelled`) issues a
best-effort, probe-gated `drain_session` on the same namespaced key (call site ships; hermes
reclamation is merge-gated).

## Cross-adapter realization (audit `audit-all-adapters-for-silent-wake-inject-failure`)

The audit confirmed this disposition is the **family contract**, not a hermes quirk, and
applied it across the five non-hermes adapters in three languages. The split is identical
everywhere: a *deterministic* relay failure (one that fails identically on redelivery) emits
**one distinct ERROR** carrying the diagnostic in a field **not** in `REDACTED_FIELD_NAMES`
plus `kind`+`event_id`, and ACKs (redelivery can't help — the alarm is the surface); a
*transient* failure stays WARN and keeps its existing redeliver/NAK disposition. Each
adapter's event name lives in its own `klodi_*` / `*_publish_*` / `wake_*` family so
dashboards stay per-host legible, but the shape is the same.

| Adapter (site) | Deterministic ERROR event | Non-redacted diagnostic field | Disposition |
|---|---|---|---|
| zeroclaw `packages/klodi-rust-host/src/operator_session.rs` | `klodi_zeroclaw_chat_turn_deterministic_failure` | `error` (+`kind`/`event_id`) | **post-ACK alarm only** — NATS ACKs at *dispatch* (`adapters/zeroclaw/src/bin/daemon.rs`), so redelivery is structurally impossible and the ERROR is the only surface. Moving the ACK post-turn is the **ruled-out anti-fix** (breaks the daemon's <50ms ack contract). |
| moltis + ironclaw (shared `packages/klodi-rust-host/src/forwarder.rs`, const `WAKE_FORWARD_DETERMINISTIC_FAILURE`) | `klodi_wake_forward_deterministic_failure` | `response_body` (NOT `body` — `body` ∈ `REDACTED_FIELD_NAMES`) | 4xx → ERROR + **ACK** (`Ok`, stop futile redeliver-then-drop); 5xx / transport / timeout → WARN + **NAK** (`Err`). One edit fixes both adapters. |
| nanobot `adapters/nanobot/nanobot_daemon.py` (const `_DETERMINISTIC_ALARM`) | `nanobot_publish_deterministic_failure` | `stdout`+`stderr` (logging `stdout` closes the Bug-1 diagnostic-loss gap) | deterministic → ERROR + ACK (typed `PublishOutcome`, no raise); transient (timeout) → raise → NAK. |
| openclaw `adapters/openclaw/src/service/wake.ts` | `wake_failed` (ERROR, `stage:"enqueue"`) and `wake_dead_session` (ERROR) | `sessionKey` + best-effort store snapshot | enqueue deterministic → ERROR + **ACK** (early `return`, no heartbeat); dead-session → ERROR **additive** to the INFO `wake_enqueued` line. |

**Known deviation (one).** openclaw's two ERROR alarms (`wake_failed` `wake.ts:84`,
`wake_dead_session` `wake.ts:107`) **omit** the `kind`/`event_id` correlator the other four
deterministic alarms carry — even though the adjacent `wake_enqueued` INFO line already spreads
it via `...correlator` (`wake.ts:96`). The alarms still fire loudly at ERROR with `sessionKey`
plus the diagnostic; only the cross-adapter correlation field is missing. Spread `...correlator`
into both payloads with the follow-up below (`null` for a local-origin wake is fine).

**Deferred follow-ups (epic `wake-inject-swallow-2026-06`).**

- **Bug-3 per-conversation session keying** (openclaw `resolveAgentSessionKey`, zeroclaw session
  resume). The audit shipped only the *alarm surfacing* — an alarm fires when a wake resolves to a
  confirmed-dead session — which is keying-independent. The FINAL fix must mirror the merged hermes
  per-conversation keying (the *Wake session model* table above), now **unblocked** since hermes
  Piece-2 (`derive_wake_session`) merged on `main`.
- **rust-http ERROR-severity test.** `HttpStructuredHandler::with_sink` (default `StdSink`) now
  exists, so the deferred 4xx→one-ERROR-on-`response_body` vs 5xx/transport→WARN-only severity
  assertion is writable. The load-bearing `Ok`/`Err` disposition is already tested; zeroclaw +
  nanobot already assert ERROR severity on sibling seams.

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
  would couple the bridge to hermes's session-storage and channel-binding internals it explicitly
  disclaims owning (`bridge.py` module docstring). The per-conversation session model (see *Wake
  session model* above) removes the operator-session dependency entirely — there is nothing on the
  operator side to assert.
- **One shared `klodi-wake` session for all wakes — rejected (was the first cut, superseded).** A
  single session collapsed every marketplace conversation together and grew unbounded for the
  daemon's lifetime (no cleanup), and a bare name is unfilterable by the outbound resolver. The
  per-conversation `klodi:`-namespaced model replaces it; no back-compat shim was kept.
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
- **Session keyer:** `adapters/hermes/src/klodi_hermes/wake_handlers.py` — `derive_wake_session`
  (the single `klodi:`-prefixing site; `_WAKE_SESSION_NAMESPACE = "klodi:"` constant) and the
  terminal-kind `drain_session` call at the dispatch seam (probe-gated, log-only).
- **ACK seam:** `packages/nats-client-py/src/klodi_nats_client/consumers.py` —
  `_dispatch_message` ACKs on handler return, NAKs on raise. Unchanged: the disposition is chosen
  in the adapter, not the consumer.
- **Correlator contract:** [[0016-wake-log-correlator-contract]] (`event_id` echo, never mint).
- **Sibling audit card:** `audit-all-adapters-for-silent-wake-inject-failure`
  (epic `wake-inject-swallow-2026-06`) — holds every adapter to INV-1/2/3 **and** mirrors the
  per-conversation `klodi:`-namespaced session scheme (the frozen epic template).
- **Sibling outbound card:** `wake-outbound-roundtrip-message-and-correlation`
  (epic `wake-inject-swallow-2026-06`) — **consumes** the `klodi:` namespace: it excludes the
  wake-session family from operator-session resolution in `active_sessions.json` by the prefix.
- **Related:** [[0001-persistent-websocket-connection]] (transport),
  [[0011-adapter-exception-envelope]] (outbound tool-call error axis),
  [[0012-tool-request-payload-parity]] (payload rides the wake text).
