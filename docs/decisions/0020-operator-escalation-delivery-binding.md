---
id: 0020-operator-escalation-delivery-binding
title: Operator escalation (`klodi_message_user`) binds to the host's cron-standalone sender + SQLite session store — turn-less, live-operator-resolved, no default channel
tags: [escalation, message-user, delivery, operator-resolution, sessiondb, channel-directory, hermes, wake, outbound]
card: bind-message-user-delivery-and-operator-resolver
commit: 709dd7c
updated_at: 2026-06-30
updated_by_card: bind-message-user-delivery-and-operator-resolver
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
It runs **inside** the isolated `hermes chat --session klodi:<entity_id>` wake turn, so it
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
   (this also kills the prior lexical-`max`-over-a-string bug); (b) a `klodi:` wake session
   **cannot** be excluded via `exclude_sources` — its `source` is the host CLI `source`
   (default `cli`), and the `klodi:<entity_id>` marker lands on the session **id/title** —
   so exclusion is an id/title-prefix guard; (c) the row carries **no `chat_id`** — the
   deliverable `(platform, chat_id)` is recovered from
   `gateway.channel_directory.load_directory()["platforms"][source]`.

## Decision

Bind both seams to the host's own primitives — the way Hermes's cron path itself does it:

- **Turn-less delivery** — `_deliver(platform, chat_id, text)` →
  `tools.send_message_tool._send_to_platform(Platform(platform), pconfig, chat_id, text)`
  over a `gateway.config.load_gateway_config()` platform config (must be `enabled`), driven
  via `_run_send` (the cron runner's `asyncio.run`-with-thread-fallback so a possibly-async
  tool caller never reenters a live loop). Platform-agnostic, needs no live gateway adapter.
- **Operator resolution** — `resolve_operator_target()` over `SessionDB.list_sessions_rich`,
  re-ranked newest-first by numeric `last_active`, the `klodi:` wake family excluded by
  id/title prefix (`_is_wake_session`), the chosen session's `source` mapped to a deliverable
  `chat_id` via `gateway.channel_directory`. First reachable session wins.
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
- **`hermes chat --session … -Q`** (the verb the inbound bridge uses) — rejected: it runs an
  agent turn in the target session — the opposite of the no-hijack requirement.
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
chat — the resolver only ever targets a *live* operator session, and the `klodi:` exclusion
prevents self-addressing into the bot's own isolated wake transcript (the highest product
risk: the human would never see the message). The adapter reads the host-owned `state.db` and
channel directory **read-only**; it owns neither. No marketplace payload rides the delivery
metadata — only the operator-authored escalation `text`.

## References

- **Delivery seam:** `adapters/hermes/src/klodi_hermes/message.py` — `_deliver`, `_run_send`
  (mirrors `cron/scheduler.py::_deliver_result`).
- **Resolver:** `message.py` — `resolve_operator_target`, `_list_operator_sessions`,
  `_resolve_chat_id`, `_is_wake_session`, `_last_active`.
- **Spec:** `docs/specs/hosts/hermes.md` §4a (binding), §7 (`$HERMES_HOME` layout), §9 (env).
- **Inbound sibling:** [[0019-wake-inject-failure-disposition]] (the `klodi:` wake-session
  model this resolver excludes; the inbound failure-disposition axis).
- **Error envelope:** [[0011-adapter-exception-envelope]] (the `delivery_failed` /
  `no_operator_target` envelope shape a failed escalation returns to the agent).
