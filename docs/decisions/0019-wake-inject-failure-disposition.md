---
id: 0019-wake-inject-failure-disposition
title: Wake-inject failure disposition by class — timeout is swallowed-and-ACKed; a deterministic nonzero exit is a loud correlated alarm, never NAK/redeliver/dead-letter
tags: [wake, error-handling, observability, alarm, consumer, ack, adapters, parity, hermes, nats]
commit: 709dd7c
updated_at: 2026-07-02
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
The invariants below are written adapter-portable: the cross-adapter audit
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

### Wake session model — per-conversation key, fresh `--source klodi` session per wake

> **Corrected 2026-06-30**: the original design
> below shelled `hermes chat` with a `session`-named flag, but **no hermes version defines one**
> and `hermes chat` cannot mint a session by name (`--continue <name>` errors on first contact).
> Each wake now runs a **fresh isolated session** tagged `hermes chat … -Q --source klodi`. The
> per-conversation key in the table is still derived — it keys the outbound pending-decision (via
> the spawn env) and correlates the wake's log line — but it is **no longer a CLI argument**. See
> the amendment at the foot of this ADR.

Every wake also runs in a **dedicated, isolated session** (never the operator's session): marketplace
reasoning never pollutes the human's live chat, and — because each wake is single-turn — no session
grows unbounded for the daemon's lifetime. The per-conversation key is derived in one typed function
(`wake_handlers.derive_wake_session`), **prefix-keyed off the kind's domain** — not "first id
present", because several kinds carry >1 id (`offer.accepted` has both `listing_id` **and**
`transaction_id`; `channel.*`/`transaction.*` also carry `listing_id`):

| Wake kind | wake-session key (env-keyed + log-correlated) |
|---|---|
| `channel.opened` / `channel.message` / `channel.closed` | `klodi:<channel_id>` |
| `offer.*` · `comment.created` · `listing.*` | `klodi:<listing_id>` |
| `transaction.*` | `klodi:<transaction_id>` |
| `search.match` | `klodi:<search_slug>` |
| kind missing its key field | `klodi:wake-<event_id>` (or `klodi:wake-<uuid4>` if `event_id` is also absent) |

**Why the `klodi:` key namespace is load-bearing, not cosmetic.** The key namespaces every wake's
outbound pending-decision id and its log/alarm correlation line under `klodi:`, keeping it
distinguishable through the round-trip; the colon also distinguishes it from the retired single
shared `klodi-wake` (hyphen) session, so the "no shared session" assertion stays meaningful.
**Outbound exclusion no longer leans on this prefix** (corrected 2026-06-30): the outbound resolver
(`message.resolve_operator_target`, per [[0020-operator-escalation-delivery-binding]]) excludes the
wake-session family **by source** — `SessionDB.list_sessions_rich(exclude_sources=["klodi"])`, since
each wake now runs `--source klodi`. The earlier id/title-prefix guard (`_is_wake_session`) was
**deleted**: a fresh `--source`-tagged wake session is untitled, so the prefix never lands on it.

**This keying scheme is the frozen cross-adapter template.** The cross-adapter audit makes hermes the reference the 5 other
adapters (openclaw, zeroclaw, nanobot, moltis, ironclaw) mirror — per-conversation,
`klodi:`-namespaced sessions, never one shared session. A conversation's terminal event
(`channel.closed`; `listing.sold/withdrawn/expired`; `transaction.completed/cancelled`) issues a
best-effort, probe-gated `drain_session` on the same namespaced key (call site ships; hermes
reclamation is merge-gated).

## Cross-adapter realization

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
| openclaw `adapters/openclaw/src/service/wake.ts` | `wake_failed` (ERROR, `stage:"enqueue"`) — carries `kind`/`event_id` via `...correlator` | `sessionKey` + diagnostic (+ `kind`/`event_id`) | enqueue deterministic → ERROR + **ACK** (early `return`, no heartbeat). The `wake_dead_session` ERROR this row originally carried was **removed** — see the *2026-06-30 amendment* below (OQ-2): under per-conversation keying a no-entry session is legitimate first-contact, so the enqueue-time gate only ever false-fired. `entry_exists`/`store_*` survive as INFO on `wake_enqueued`. |

**Correlator deviation — CLOSED (2026-06-30, see amendment below).** openclaw's deterministic
ERROR alarm formerly omitted the `kind`/`event_id` correlator the other four adapters carry. PR #35 spread `...correlator` into the
`wake_failed` enqueue ERROR **and** the heartbeat-stage WARN (`null` for a local-origin wake is
fine — INV per [[0016-wake-log-correlator-contract]]). openclaw is now at full cross-adapter
correlation parity.

**Realized follow-ups.** Both items the audit deferred shipped
in PR #35 — see the amendment below:

- ✅ **Bug-3 per-conversation session keying** (openclaw + zeroclaw). Both now mirror the hermes
  *Wake session model* table above: openclaw `deriveWakeSessionKey`
  (`adapters/openclaw/src/service/wake-session.ts`) keys `agent:<agentId>:klodi:<entity_id>`;
  zeroclaw `derive_wake_session` (`packages/klodi-rust-host/src/wake_session.rs`) keys
  `klodi:<entity_id>` per turn. No shared session.
- ✅ **rust-http ERROR-severity test.** Landed in `packages/klodi-rust-host/src/forwarder.rs` via
  `HttpStructuredHandler::with_sink(CaptureSink)`: 4xx → exactly one ERROR on `response_body`,
  5xx/transport → WARN-only, zero ERROR.

**Still-deferred follow-up (cross-adapter).**

- **The `wake-<event_id>` ephemeral fallback is not re-validated for traversal** — faithful to the
  frozen hermes "safe by construction" claim (`event_id` is host-minted; `wake_handlers.py:188-189`).
  In the openclaw + zeroclaw sinks the residual risk is lower than hermes' wake-session-key +
  pending-filename sink (openclaw → `enqueueSystemEvent({sessionKey})`; rust →
  `percent_encode_session` onto a WS query param, where `/`→`%2F`), so it was deliberately NOT
  hardened in PR #35 (doing so would diverge from the frozen scheme that change was mandated to
  mirror). Revisit the "safe by construction" assumption for `event_id` across all three adapters
  in one pass if it is ever sunk into a filesystem path.

### Amendment (2026-06-30) — PR #35

Two behaviours this ADR documented as shipped by the audit (PR #34) changed; recorded here
rather than silently rewritten so the #34 → #35 sequence stays auditable.

1. **openclaw + zeroclaw now realize the per-conversation keying** (the *Wake session model*
   table above), closing the audit's deferred Bug-3. They are independent ports of the frozen
   hermes scheme — no shared code across TS/Rust/Python is possible — each citing this ADR +
   `_SESSION_KEY_FIELD_BY_DOMAIN` at its keying site. A deliberate **per-language BR-4 asymmetry**
   was kept: openclaw `deriveWakeSessionKey` **throws** on a poisoned id; rust `derive_wake_session`
   (a `-> String` that cannot raise) folds it into the safe `klodi:wake-<event_id>` ephemeral
   fallback. Both satisfy "a poisoned id never becomes a session key" — do **not** "unify" them.

2. **openclaw's `wake_dead_session` ERROR alarm was REMOVED** (a clean delete, no shim — OQ-2).
   The audit shipped it to surface a wake landing on a confirmed-no-entry session. Under
   per-conversation keying that failure mode is **structurally eliminated**: the wake now lands on
   its own conversation's key by construction, and a no-entry session is *always* legitimate
   first-contact (the heartbeat runtime creates the session on enqueue). No single enqueue-time
   store snapshot can distinguish a brand-new per-entity session from a reaped one, so any surviving
   gate would only ever false-fire — paging on every new negotiation. `entry_exists`/`store_*` stay
   as INFO diagnostics on `wake_enqueued`. INV-1 (never *silently* lost) is unaffected: the enqueue
   failure ERROR (`wake_failed`) remains the loud surface for a genuine deterministic failure.

### Amendment (2026-06-30) — hermes wake session flag

The hermes realization of the *Wake session model* above shelled `hermes chat` with a
`session`-named flag (`hermes chat -q <text> <flag> <key> -Q`), but **no hermes version defines
one**: every wake `sys.exit(2)`'d with
`unrecognized arguments`, the bridge raised `WakeInjectFailed`, and (per INV-1 above) ACKed — so
the relay had been silently down on prod alice. Confirmed three ways: the live error on both pins
(`v2026.4.23`=v0.11.0, `v2026.6.19`=v0.17.0), the captured `hermes chat --help` argparse surface,
and the in-image parser source (only `--resume`/`--continue` exist). The founder's `--continue
klodi:<id>` candidate was **ruled out at source level**: hermes resolves `--continue <name>` against
`SessionDB` and `sys.exit(1)`s on an unknown name (error-on-unknown-name, *not* create-on-first-use),
so every first-contact wake — the common case — would fail; `--resume <id>` shares that resolver and
also reintroduces per-entity session-id state.

**The fix:** each wake runs a **fresh isolated session** via `hermes chat -q <text> -Q --source klodi`
(`bridge.KLODI_WAKE_SOURCE`). The per-conversation key (table above) survives only as the
env-keying + log-correlation id, not a CLI argument. The `--source klodi` tag also unblocked the
cleaner outbound exclusion (`exclude_sources=["klodi"]`) — see
[[0020-operator-escalation-delivery-binding]]'s 2026-06-30 amendment. **Scope is hermes-only:** this
ADR's per-conversation keying *template* is unchanged, and openclaw/zeroclaw realize it through their
own session APIs (not a hermes CLI), so they are unaffected by this defect. Residual: `--source` is
re-confirmed on v0.17.0 but not on the prod-alice v0.11.0 pin — re-confirm or bump (klodi-stage
Dockerfile-pin discipline). The `drain_session` probe-gate is now also resolvable
(`hermes sessions delete <id>` is confirmed) but, since each wake is single-turn under this fix, is
left as a separate simplification decision.

**Why this can't silently recur — a reusable testing rule.** The defect reached prod because the
bridge's argv test asserted a **hand-written literal** (`[…, <session-flag>, …]`) — a stub that can
only ever confirm the author's assumption, never that a shipped hermes actually accepts the flag. The
corrected guard (`adapters/hermes/tests/test_hermes_cli_surface.py`) instead asserts every flag the
bridge emits against the recognized-option set parsed from a **checked-in, version-stamped capture of
the real `hermes chat --help`** (`fixtures/hermes_chat_help_v2026.6.19.txt`), and fails on any flag
that surface does not define; `test_hermes_test_files_carry_no_rejected_session_flag` additionally
forbids re-introducing the rejected flag anywhere in the hermes test tree. The general rule for **any
adapter that spawns a host CLI** (the cross-adapter audit is
the propagation vehicle): validate the argv against the shipped binary's captured surface, never a
literal that restates the author's belief — a stub literal *is* the contract with your own assumption,
not with the tool.

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
- **Cross-adapter audit:** holds every adapter to INV-1/2/3 **and** mirrors the
  per-conversation `klodi:`-namespaced session scheme (the frozen cross-adapter template).
- **Outbound wake round-trip:** **consumes** the `klodi:` namespace — it excludes the
  wake-session family from operator-session resolution (over `hermes_state.SessionDB`, by the
  id/title prefix). The delivery + resolution binding is [[0020-operator-escalation-delivery-binding]].
- **Related:** [[0001-persistent-websocket-connection]] (transport),
  [[0011-adapter-exception-envelope]] (outbound tool-call error axis),
  [[0012-tool-request-payload-parity]] (payload rides the wake text).
