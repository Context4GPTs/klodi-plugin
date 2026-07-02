---
id: 0020-operator-escalation-delivery-binding
title: Operator escalation (`klodi_message_user`) binds to the host's cron-standalone sender + SQLite session store — turn-less, live-operator-resolved, no default channel
tags: [escalation, message-user, delivery, operator-resolution, sessiondb, channel-directory, hermes, wake, outbound]
card: bind-message-user-delivery-and-operator-resolver
commit: e03cae5
updated_at: 2026-07-02
updated_by_card: distinguish-wake-sessions-from-operator-sessions
---

# ADR-0020 — Operator escalation binds to the host's own primitives

## Status

Accepted (2026-06-30). Affects the hermes adapter's outbound escalation path
(`adapters/hermes/src/klodi_hermes/message.py`).

This is the **outbound** half of the wake round-trip and the sibling of
**[[0019-wake-inject-failure-disposition]]** (the *inbound* wake-inject axis — how a
failed wake *into* the agent is disposed of). It also sits on the same axis as
**[[0011-adapter-exception-envelope]]** (the tool-call error envelope a failed delivery
returns to the agent). The `klodi:`-namespaced wake-session model that 0019 froze is what
this resolver *consumes* to exclude the bot's own sessions (see Decision).

## Context

`klodi_message_user` is how a klodi agent actively reaches its human operator when a
marketplace decision is policy-reserved (negotiation_style.md / a security.md hard rule).
It runs **inside** the isolated `hermes chat … --source klodi` wake turn, so it
must reach the operator's *separate* live session **without running an agent turn there**
(the Piece-3 no-hijack requirement).

The v0.3.5 outbound epic shipped both seams **probe-gated** because the dev env could not
confirm Hermes's host primitives: `_deliver` raised `RuntimeError("… not bound …")`, and
`resolve_operator_target` read an **assumed** `$HERMES_HOME/runtime/active_sessions.json`
against a guessed schema. Every escalation therefore failed. Probing the real runtime
(`docker exec` against the staging image `klodi-hermes-live:local`, hermes-agent 0.11.0)
disproved both guesses and surfaced two non-obvious facts that force the design:

1. **The in-gateway `gateway.delivery.DeliveryRouter` is the wrong primitive for a wake
   subprocess.** Its `deliver()` needs `adapters: Dict[Platform, <live adapter>]` — instances
   the long-running `hermes gateway` process constructs at boot. A separate `hermes chat`
   wake subprocess holds none, so `DeliveryRouter` there yields empty adapters →
   `ValueError: No adapter configured`. Hermes already solved this exact gateway-not-running
   case in its **cron** runner (`cron/scheduler.py::_deliver_result`), which calls the
   adapter-free standalone sender `tools.send_message_tool._send_to_platform` instead.
2. **The operator registry is SQLite, not a JSON file, and its shape is counter-intuitive.**
   `hermes_state.SessionDB.list_sessions_rich()` returns rows where **`source` *is* the
   platform** (`telegram`/`signal`/`cli`/…). The assumed `active_sessions.json` never
   existed. Three sub-facts bite: (a) the SQL orders by `started_at DESC`, **not**
   `last_active`, so recency must be re-ranked by the **numeric** `last_active` in Python
   (this also kills the prior lexical-`max`-over-a-string bug); (b) wake sessions are
   excluded **by source** via `exclude_sources=["klodi"]` — each wake runs
   `hermes chat --source klodi`, persisting `source=klodi` on the session row, so the query
   filters the whole family server-side *(this **supersedes** the v0.3.6 design, which set no
   source tag and so could only exclude by an id/title-prefix guard on `klodi:<entity_id>` —
   see the 2026-06-30 amendment. **Both are since superseded — `--source` does NOT persist on
   hermes v0.17.0's one-shot `-q` create, so a wake lands `source='cli'`, not `klodi`; see
   Amendment (2026-07-02).**)*; (c) the row carries **no `chat_id`** — the
   deliverable `(platform, chat_id)` is recovered from
   `gateway.channel_directory.load_directory()["platforms"][source]`.

## Decision

Bind both seams to the host's own primitives — the way Hermes's cron path itself does it:

- **Turn-less delivery** — `_deliver(platform, chat_id, text)` →
  `tools.send_message_tool._send_to_platform(Platform(platform), pconfig, chat_id, text)`
  over a `gateway.config.load_gateway_config()` platform config (must be `enabled`), driven
  via `_run_send` (the cron runner's `asyncio.run`-with-thread-fallback so a possibly-async
  tool caller never reenters a live loop). Platform-agnostic, needs no live gateway adapter.
- **Operator resolution** — `resolve_operator_target()` over
  `SessionDB.list_sessions_rich(exclude_sources=["klodi"])`, re-ranked newest-first by numeric
  `last_active`, the wake family excluded **by source** at the query (each wake runs
  `--source klodi`), the chosen session's `source` mapped to a deliverable `chat_id` via
  `gateway.channel_directory`. First reachable session wins.
- **No default fallback channel** (founder decision). The target is *always* a resolved live
  operator; a genuinely-absent operator surfaces a loud `no_operator_target` envelope — never
  a silent drop, never a configured default. The retired `KLODI_FALLBACK_*` env contract and
  the assumed `active_sessions.json` loader are **deleted**, not shimmed.
- **Deliver-then-persist** (BR-9): the pending-decision is recorded *only after* a successful
  deliver, so a failed send never leaves a dangling decision the operator never saw. A
  delivery failure raises typed `DeliveryError` → a surfaced `delivery_failed` envelope.

Host modules (`hermes_state`, `gateway.*`, `tools.send_message_tool`) ship only inside the
Hermes runtime image, never in the `klodi-hermes` wheel — so every host import is **lazy**
and importing the adapter never requires Hermes. The unit suite drives the two boundaries
(`_list_operator_sessions` / `_resolve_chat_id`, `_deliver`) as seams; the live stage
exercises the real bindings.

## Alternatives considered

- **`gateway.delivery.DeliveryRouter`** (the card's original hint) — rejected: needs the
  gateway's live platform-adapter instances a wake subprocess does not hold (fact 1).
- **Assumed `$HERMES_HOME/runtime/active_sessions.json`** — rejected: the file does not exist;
  the registry is `SessionDB` (fact 2). The whole assumed-schema loader was deleted.
- **A configured default channel (`KLODI_FALLBACK_*`)** — rejected by founder: the robust
  design resolves the live operator; a default would silently misdirect an escalation.
- **`hermes chat … -Q --source klodi`** (the verb the inbound bridge uses) — rejected: it runs
  an agent turn in the target session — the opposite of the no-hijack requirement.
- **Telegram Bot API direct** (porting `klodi-rust-host/src/telegram.rs`) — rejected by
  founder: single-platform patchwork re-implementing transport the host already owns.

## Consequences — accepted residuals (recorded, not reworked)

- **Integration tier is seam-driven, not a real `state.db`.** `hermes_state` / `gateway.*`
  are image-only and not importable in the adapter's `uv run pytest` venv, so the
  unit/integration tests feed the host boundaries real-shaped dicts rather than seeding a
  genuine `SessionDB`. The real boundary was exercised in manual live-verification; the true
  e2e (operator physically receives the message) is deferred to the `klodi-stage` Docker
  suite with creds + an inference provider. Revisit a real-`state.db` integration test only
  if the host modules are ever vendored for tests.
- **The two resolver seams swallow their import error silently** (`_list_operator_sessions`,
  `_resolve_chat_id`). Fail-soft to `[]`/`None` is correct (cold-start is the common path; a
  crash there strands every escalation), but a future host-module *rename* would surface as a
  *misleading* `no_operator_target` with no diagnostic of the real cause. The inner
  store/directory failures `log.warning`; only the import path is silent.
- **`_run_send`'s `_SEND_TIMEOUT_SECONDS` bound is softer than it reads.** On the
  running-loop branch the `.result(timeout=…)` raises, but `ThreadPoolExecutor.__exit__`'s
  `shutdown(wait=True)` blocks on the still-running future — so a truly-hung send is bounded
  by the host sender's own network timeout, not by `_SEND_TIMEOUT_SECONDS`. Acceptable (the
  sender has network timeouts; this mirrors the cron runner) but not the hard bound implied.
- **Couples to the host-private `tools.send_message_tool._send_to_platform`** (underscore).
  Inherent to standalone delivery and mirrors what the cron runner itself uses; residual
  upgrade-brittleness to monitor against the pinned `hermes-agent` version.

## Security implications

No default channel means an escalation can never be misdirected to a statically-configured
chat — the resolver only ever targets a *live* operator session, and self-addressing into the
bot's own isolated wake transcript (the highest product risk: the human would never see the
message) is prevented by the resolver's positive `(platform, chat_id)` identification — a wake
`cli` row maps to no messaging chat *(as of Amendment (2026-07-02) this is the load-bearing
guard; the source exclusion is a recency-window optimisation only — a wake no longer persists
`source='klodi'`)*. The
adapter reads the host-owned `state.db` and
channel directory **read-only**; it owns neither. No marketplace payload rides the delivery
metadata — only the operator-authored escalation `text`.

## Amendment (2026-06-30) — card `fix-hermes-wake-inject-session-flag-argv`

> **Superseded 2026-07-02.** This amendment's core premise — that a wake session persists a
> `klodi` source tag the resolver can exclude on — does **not** hold on hermes v0.17.0: the
> one-shot `hermes chat -q … -Q` create path silently drops `--source`, so a wake lands
> `source='cli'`. The source-based exclusion, the `_is_wake_session` deletion rationale, and
> the pin caveat below are all superseded. See **Amendment (2026-07-02)**.

The inbound bridge's wake-inject argv was found to use a `session`-named flag that **no
hermes version defines** — every wake `sys.exit(2)`'d with `unrecognized arguments`, so the
relay had been fully down. The fix runs each wake as a fresh isolated session tagged
`hermes chat … -Q --source klodi` (the inbound card's [[0019-wake-inject-failure-disposition]]
amendment carries the rationale). Because a wake session is now created **with a `klodi` source
tag**, the outbound exclusion this ADR depends on changed shape:

- **Fact 2(b) is superseded.** It is no longer true that a wake session "cannot be excluded via
  `exclude_sources`". It now **is** — `resolve_operator_target` filters the family at the store
  query with `SessionDB.list_sessions_rich(exclude_sources=["klodi"])`, and the title-prefix
  `_is_wake_session` guard was **deleted** (a fresh wake session is untitled, so the old guard
  no longer matched it anyway). Source-based exclusion is strictly better: it also keeps the
  `_SESSION_SCAN_LIMIT` recency window from filling with wake sessions and crowding out a
  genuine operator.
- **Self-addressing safety is preserved** (the highest product risk): the `klodi`-sourced wake
  session is filtered at the query, and as defence in depth `klodi` is not a messaging platform
  in `gateway.channel_directory`, so it resolves to no `chat_id` regardless.
- **Pin caveat (residual).** `exclude_sources` and `--source` were confirmed on hermes v0.17.0
  (`nousresearch/hermes-agent:v2026.6.19`); prod-alice pins v0.11.0 (`v2026.4.23`). On a host
  that does not honour `exclude_sources`, `_list_operator_sessions` degrades to `[]` (the call
  raises → the existing `except` → cold path), surfacing a loud `no_operator_target` rather than
  self-addressing — safe-by-default. Re-confirm on the deployed pin or bump it (klodi-stage
  Dockerfile-pin discipline).

## Amendment (2026-07-02) — card `distinguish-wake-sessions-from-operator-sessions`

A wake session is **no longer distinguished by `source`**, because hermes session `source` is
not durable through the wake spawn path. On hermes v0.17.0 (`nousresearch/hermes-agent:v2026.6.19`)
the one-shot `hermes chat -q … -Q` *create* path silently **drops `--source`** (and the
`HERMES_SESSION_SOURCE` env) and persists the default `source='cli'` on the new `sessions` row;
`SessionDB` exposes no source setter, so klodi cannot back-fill it. Confirmed live in-container —
every variation (flag before *and* after `-q`, `HERMES_SESSION_SOURCE` from process start) lands
`source='cli'`. A completed wake session is therefore **byte-identical to a genuine operator CLI
session** at the store, and the `source='klodi'` tag the 2026-06-30 amendment relied on never
lands. This **supersedes fact 2(b), the whole 2026-06-30 amendment, and its pin caveat.**

Two durable, version-independent klodi-plugin mechanisms replace the single `source='klodi'`
distinguisher — one per consumer of the old tag:

- **Resolver (self-addressing safety) — positive identification, backed by a class-level
  exclusion.** `_list_operator_sessions` now queries
  `exclude_sources=[HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE]` (`['cli','klodi']`, `message.py:331`) —
  forward-compat in **both** directions: it excludes wakes whether hermes drops `--source` (→ `cli`,
  today) or a future host ever honours it (→ `klodi`). The load-bearing guard against
  self-addressing is **not** this exclusion but `resolve_operator_target`'s positive
  `(platform, chat_id)` identification: a `cli` row maps to no `channel_directory` chat and is not
  a messaging `Platform`, so it can never be a *deliverable* operator. The class exclusion only
  keeps wakes from crowding the `_SESSION_SCAN_LIMIT` recency window (fact 2(b)'s real purpose).
  `--source klodi` stays in the bridge argv as declared intent / forward-compat, documented
  **inert** on v0.17.0 `-q` (`bridge.KLODI_WAKE_SOURCE`).
- **AC1 gate (proof-of-turn) — a klodi-owned completion marker.** The bridge writes an
  `event_id`-keyed marker on subprocess **exit 0** to `${KLODI_HOME}/wake/completions.json`
  (`wake_completions.record_wake_completion`), a **bounded rolling JSON ring** (`_MAX_COMPLETIONS`
  newest retained, atomic write-temp + `os.replace`, never one file per wake). It fires **only** on
  a completed turn — the nonzero path raises `WakeInjectFailed`, a timeout is swallowed, neither
  records — so it can never false-green on an inject that produced no turn. This is the durable
  substitute for `sessions.source='klodi'` as the "a wake turn completed" signal.

**Why not make `source` stick / set it via `SessionDB`** — needs a change to hermes itself or a
nonexistent setter; version-fragile, the exact objection confirmed dead by the live table.
**Why not a per-session wake marker** — unbuildable: klodi cannot obtain or set the wake's hermes
session id (`--continue <name>` errors on first contact, `-Q` prints nothing) or title (the `-q`
session is untitled), so a wake `cli` row and an operator `cli` row are byte-identical at the
store. Class-level `cli` exclusion is the only available axis, and it is sufficient because a `cli`
session is never a *deliverable* operator.

**Cross-repo lockstep (epic `hermes-wake-relay-2026-06`).** The klodi-stage
`integration/hosts/hermes/wake.test.ts` AC1 DELIVERED gate keyed on a new `source='klodi'` session
appearing after the wake. It **re-points onto `${KLODI_HOME}/wake/completions.json`** in lockstep —
on the existing klodi-stage gate card, sequenced **after** this card lands the marker. The
DELIVERED semantic (the operator physically receives the escalation) never weakens; only the
source-proxy assertion moves. Marker-first ordering is mandatory: flip the assertion before the
artifact exists and AC1 has nothing to key on; land the marker before the flip and AC1 stays RED on
the stale `source='klodi'` reason.

## References

- **Delivery seam:** `adapters/hermes/src/klodi_hermes/message.py` — `_deliver`, `_run_send`
  (mirrors `cron/scheduler.py::_deliver_result`).
- **Resolver:** `message.py` — `resolve_operator_target`, `_list_operator_sessions`
  (sets `exclude_sources=["cli","klodi"]`; see Amendment 2026-07-02), `_resolve_chat_id`,
  `_last_active`.
- **Proof-of-turn marker:** `adapters/hermes/src/klodi_hermes/wake_completions.py` —
  `record_wake_completion` (the bounded ring at `${KLODI_HOME}/wake/completions.json`); wired in
  `bridge.py`'s `inject_message` exit-0 branch.
- **Spec:** `docs/specs/hosts/hermes.md` §4a (binding), §7 (`$HERMES_HOME` layout), §9 (env).
- **Inbound sibling:** [[0019-wake-inject-failure-disposition]] (the `klodi:` wake-session
  model this resolver excludes; the inbound failure-disposition axis).
- **Error envelope:** [[0011-adapter-exception-envelope]] (the `delivery_failed` /
  `no_operator_target` envelope shape a failed escalation returns to the agent).
