---
type: card
title: Wake outbound round-trip (hermes) — klodi_message_user + reply correlation
slug: wake-outbound-roundtrip-message-and-correlation
work_type: feature        # feature | bug | refactor | chore | docs
tiers: [unit, integration]   # solutions-architect: union of required automated tiers (Pieces 3/4/5). No required e2e — real-hermes delivery, active_sessions.json schema, and agent reply-reasoning are probe/persona-gated (mirrors the sibling card)
status: stand-by          # review round 1 = REVIEW (one P1); bounced back to In Dev
agents: []                # cleared on bounce; stand-by routing re-spawns the dev pair
priority: 2               # 1 = drop-everything, 2 = normal, 3 = nice-to-have
created: 2026-06-29
updated: 2026-06-29
base_branch: main         # the branch this card's worktree was cut from and the PR will target
worktree: /home/ioannis/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-wake-outbound-roundtrip-message-and-correlation
branch: card/wake-outbound-roundtrip-message-and-correlation
pr: https://github.com/Context4GPTs/klodi-plugin/pull/33  # set by expert-developer at in-dev → review
merged_commit: null       # set by /board-tick on PR-merge detection
epic_id: wake-inject-swallow-2026-06
---

## Intent (founder)

**Scope.** The **outbound half** of the klodi wake round-trip for the hermes adapter — pieces 3–5 of the robust wake design. The inbound half (resilient transport · isolated wake session · no silent drop) is the sibling card **`wake-inject-failures-silent-and-lost-hermes`** (same epic `wake-inject-swallow-2026-06`). This card adds the way a klodi wake reaches the operator, and the way the operator's reply *deterministically* drives the right marketplace action. It depends on Piece 2 (isolated session) from the inbound card — the outbound notify only makes sense once the wake turn no longer runs in the operator's own session.

**Piece 3 — `klodi_message_user(text)` outbound tool.** A new tool the agent calls *only when its `.md` says it needs the human*. It must:
- **Resolve the target:** read `$HERMES_HOME/runtime/active_sessions.json` → the most-recently-active operator session → its `(platform, chat_id)`; if none, the predefined fallback channel from config (today: telegram + `TELEGRAM_CHAT_ID`). Multi-app falls out for free — resolution works across whatever is in the registry.
- **Deliver** via `standalone_sender_fn` (`gateway/delivery.py`) — a real-time message *into that session*. It does **not** run a turn in the operator's session, so nothing is hijacked.

**Piece 4 — pending-decision reply correlation (the part that must be robust, not a v1).** The genuine weak spot of the isolated-session model is correlating the operator's reply back to the right marketplace action — the reply lands in the operator's normal session, a *different* transcript from the isolated wake turn. Plain ZeroClaw leans on requery + `sessions_history` (the "v1" we rejected). To make it deterministic and authoritative:
- When `klodi_message_user` fires, klodi persists a **pending-decision record** keyed to the marketplace entity (channel / offer / listing id + the question asked).
- The operator's reply arrives on their session → the gateway runs a normal klodi-toolset turn → the agent reads the open pending-decision(s) and re-grounds via klodi read tools, so it knows exactly what "yes, counter at 40" answers and acts on the right channel.
- Marketplace state is the source of truth — the round-trip is authoritative without injecting into, or depending on, the fragile continuity of the live session. This is the robustness upgrade over plain ZeroClaw and must **not** ship as best-effort.

**Piece 5 — SOUL.md / policies.** Persona guidance: when to reach out and call the tool, and how to handle the operator's reply (the reply-handling expectation that closes the round-trip).

## Epic notes (provisional — sibling Discovery owns the verdict)

> Epic `wake-inject-swallow-2026-06`. Inbound sibling: `wake-inject-failures-silent-and-lost-hermes` (resilient transport · isolated session · no silent drop). This card owns the **outbound round-trip**. Authored from the parent orchestrator — these notes are a shallow, read-only starting hint, **not** a spec; Discovery runs in full and may revise or discard them.

**Likely change sites / new surfaces (shallow guess — confirm in Discovery):**
- New `adapters/hermes/src/klodi_hermes/message.py` (or similar) — the `klodi_message_user` tool: active-session resolution + fallback + `standalone_sender_fn` delivery.
- New correlation store — pending-decision records keyed to a marketplace entity id + the question; written on outbound, read on the operator's reply turn.
- `gateway/delivery.py` — `standalone_sender_fn`, the delivery primitive (built for cross-process cron delivery).
- `$HERMES_HOME/runtime/active_sessions.json` — the session registry the resolver reads.
- `SOUL.md` / persona policies — when to reach out + reply-handling expectations.

**Confirm before coding (Discovery probes — pull from /cclank/hermes-wiki source pages or a ~30s container probe; do NOT guess):**
1. `standalone_sender_fn` — exact signature, and that it is callable from the bridge's process (it was built for cross-process cron delivery, so almost certainly yes).
2. `active_sessions.json` — schema / timestamps, for the "most-recently-active" selection.
3. Headless isolated session (shared with the inbound card's Piece 2) — how `hermes chat` names/persists a non-user session so the wake turn does not surface in `active_sessions.json` or the operator's view (`hermes chat --help`; inspect `gateway/delivery.py` + `runtime/active_sessions.json`).

**Acceptance (provisional Given/When/Then — Discovery owns the final set):**
1. Given the agent's `.md` calls `klodi_message_user(text)`, when there is an active operator session, then the message is delivered into that session's `(platform, chat_id)` via `standalone_sender_fn` in real time, and no turn is run in the operator's session.
2. Given no active operator session, when `klodi_message_user` fires, then it falls back to the configured channel (telegram + `TELEGRAM_CHAT_ID`).
3. Given `klodi_message_user` fired and persisted a pending-decision for a marketplace entity, when the operator replies on their session, then the normal klodi-toolset turn reads the open pending-decision, re-grounds via klodi read tools, and applies the operator's answer to the correct channel/offer/listing — without depending on session continuity.
4. Given multiple apps/channels in the registry, when resolving the target, then resolution works across whatever is registered (multi-app), not telegram-only.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — product-owner, solutions-architect, devops-engineer

<!-- Filled jointly by product-owner and solutions-architect. -->

### Product identity, flows & business rules — product-owner (2026-06-29)

**What this is, in one line.** The round-trip that lets an autonomous klodi agent *escalate a
marketplace decision to its human operator and act on the human's answer* — turning the
previously **passive** escalation model (agent replies "checking with owner", appends to the
sell-file `## Open Questions`, and the human only sees it on their *next* session) into an
**active push + deterministic reply loop**. Piece 2 (sibling card) moves the wake turn into an
isolated `klodi-wake` session, so the old "surfaces on your next session" no longer interleaves
with the operator's live chat — that is exactly the gap this card closes.

**Why it must exist (premise check).** Without it, an isolated autonomous agent that hits an
`## Always Ask Me First` decision (e.g. accept an offer below asking) has *no way to reach the
human in time* — the counterparty waits, the decision rots, and the operator finds out by
asking. This is the outbound mirror of the inbound card's INV-1 ("a wake must never be silently
lost"): a decision that needs a human must never silently stall.

#### Flow A — outbound escalation (`klodi_message_user`, Piece 3)

- **Trigger:** mid isolated-wake-turn, the agent reaches a decision its policy reserves for the
  human (see BR-1).
- **Actor:** the agent, autonomously, on the operator's behalf.
- **Preconditions:** setup `phase == ready`; the decision genuinely requires the human.
- **Steps:** agent calls `klodi_message_user(text)` → host resolves the delivery target
  (most-recently-active *operator* session's `(platform, chat_id)`; else the configured fallback
  channel) → delivers a real-time message into that session via the host's standalone sender
  (no agent turn is run in the operator's session) → a durable **pending-decision** record is
  persisted, keyed to the marketplace entity + the question asked.
- **Outcome:** the operator sees a self-contained message in their normal chat; the marketplace
  action is paused, awaiting their reply; the pending-decision outlives the isolated turn.
- **Error states:** no operator session *and* no configured fallback; sender unreachable;
  ambiguous multi-app target; resolver would otherwise select the isolated wake session (BR-3).

#### Flow B — reply correlation (Piece 4)

- **Trigger:** the operator replies in their **own normal session** (a different transcript from
  the isolated wake turn) — e.g. "yes, counter at 40", "no, pass", "yes to the keyboard one".
- **Actor:** operator → agent, in a normal klodi-toolset turn.
- **Preconditions:** at least one open pending-decision exists.
- **Steps:** the turn loads the open pending-decision(s) → matches the reply to exactly one
  (BR-4) → **re-grounds** the entity's *current* state via klodi read tools (`klodi_offer_mine`,
  `klodi_channel_history`, `klodi_tx_status`, `klodi_list_get`) → applies the operator's answer to
  the correct entity (`klodi_offer_respond` with the right `offer_id`, `klodi_channel_message` on
  the right `channel_id`, …) → resolves/closes the pending-decision.
- **Outcome:** the right action fires on the right channel/offer/listing — authoritatively,
  without any dependence on session continuity with the isolated turn.
- **Error states:** reply maps to no open decision; multiple open decisions + ambiguous reply
  (BR-4); the entity moved on since the question (BR-5); a stale/closed decision is re-triggered
  (BR-6).

#### Business rules / invariants (discovered, adapter-portable)

- **BR-1 — reach out only when policy requires the human.** `klodi_message_user` is called when,
  and only when, the isolated turn hits a decision reserved for the human by the policy hierarchy
  (`negotiation_style.md` `## Always Ask Me First`, `## Escalation When Unknown`, or a
  `security.md` hard rule). It is **not** called for wakes the agent is authorized to handle
  autonomously, nor (by default) for purely informational wakes — that is what keeps the channel
  high-signal. (Informational push is a user preference; see Assumptions.)
- **BR-2 — an outbound escalation must never be _silently_ dropped (outbound INV-1).** Every
  `klodi_message_user` call terminates in exactly one observable disposition: **delivered** or
  **surfaced-failure** (a structured error the agent sees + a log line). A no-op return is the one
  forbidden outcome — a silently-undelivered escalation strands a marketplace action forever
  invisibly, the precise harm the inbound card forbids.
- **BR-3 — target resolution is deterministic and never self-addresses.** Precedence:
  (1) most-recently-active *genuine operator* session `(platform, chat_id)`; (2) configured
  fallback channel; (3) surfaced failure. The resolver MUST exclude the isolated `klodi-wake`
  session — delivering the message into the bot's own isolated transcript means the human never
  sees it and can never reply. **Hard dependency on Piece 2's isolation** (see cross-card note).
- **BR-4 — a reply maps to exactly one entity, or the agent disambiguates (never guesses).** A
  pending-decision is keyed to `(entity_type, entity_id, question, asked_at)`. On reply: exactly
  one open decision → bind; multiple → disambiguate via the entity identity carried in the
  original message or a re-prompt. Applying a human answer to a *guessed* entity is forbidden —
  this is what "authoritative, not best-effort" means on the correlation side.
- **BR-5 — re-ground against marketplace state before acting (marketplace is source of truth).**
  The pending-decision is a pointer, not the truth. Before applying the answer the agent re-reads
  the entity's current state; if it changed since the question (offer withdrawn/countered, channel
  closed, listing sold, transaction cancelled), the agent does NOT apply the stale instruction —
  it re-evaluates and informs the operator of what is now current. This is the robustness upgrade
  over plain requery-from-session-history.
- **BR-6 — a pending-decision resolves exactly once, then closes; outreach is idempotent.** Once
  applied (or rendered moot), the decision is closed so a later unrelated "yes" cannot re-fire it.
  A redelivered/duplicate trigger for an already-open decision (same entity+question) creates no
  duplicate record and no duplicate ping. (Mirrors the inbound `event_id`/LRU dedup discipline.)
- **BR-7 — the outbound message is self-contained and identifies the entity in human terms.** The
  operator reads it in their normal chat, possibly hours later, with zero isolated-session
  context. The text must name *what* (listing/title), *who* (handle), *what's asked*, and the
  options — enough that a natural-language reply ("yes", "counter at 40", "pass") is interpretable.

#### Piece 5 — persona-policy direction (SOUL.md / policies), behavior-level

Hermes's "SOUL" is the policy hierarchy already in place (`security.md` hard rules →
`negotiation_style.md` authorization → sell/buy files → `SKILL.md` playbook). Piece 5 extends it
along two axes; the *content* is specified here, the *file edits* are In-Dev work:

1. **When to reach out (the threshold lives in `negotiation_style.md`).** Add a `## Reaching Out`
   preference block: which decisions justify an active ping (default: every `## Always Ask Me
   First` item + unresolved `## Escalation When Unknown`), an optional notification preference for
   informational wakes (default **off** — next-session surface covers FYIs), tone/SLA, and
   optional quiet-hours. `SKILL.md` §3 (wake table) and §"Escalation When Unknown" gain: *when a
   decision is reserved for the human and the counterparty is waiting, call `klodi_message_user`
   in addition to the durable `## Open Questions` note* (belt-and-suspenders per BR-2).
2. **How to handle the reply (the loop-closing expectation, in `SKILL.md`).** Add to §2 (session
   start) and a new wake/reply section: *before "what would you like?", load open
   pending-decisions; when the operator's message answers one, re-ground via klodi read tools
   (BR-5) and act on the bound entity (BR-4), then resolve it.* Natural-language replies are
   expected; the agent maps them, it does not require a structured command.

Default-conservative carryover: if `negotiation_style.md` is empty, the agent still asks before
acting (SKILL.md §5) — so the safe default is "escalate (reach out) rather than act autonomously."

#### Assumptions (founder may override)

- ASSUMPTION: `klodi_message_user` is **required** only for human-decision escalations; pushing
  purely informational wakes (offer accepted, deal completed) is a *user preference*, default
  **off**, governed by the new `negotiation_style.md` `## Reaching Out` block. Because — keeps the
  reply-correlation machinery focused on decisions that get a reply and the channel high-signal; a
  user who wants more pings opts in. If the founder wants FYIs pushed by default, flip the default.
- ASSUMPTION: the **fallback channel** is a single configured operator destination
  `(platform, chat_id)` — today telegram + the configured chat id — read from config/env; if
  unset *and* no active operator session exists, the outbound is a surfaced failure (BR-2), not a
  silent drop. The exact config key (env var vs `config.json` field) is architecture/devops.
- ASSUMPTION: the pending-decision record is **durable** (survives the isolated turn) and keyed to
  `(entity_type, entity_id, question, asked_at, status)`. Product-preferred home: extend the
  existing human-readable sell-file `## Open Questions` / buy-file `## Active Negotiations` audit
  trail (which the reply turn *already* reads at session start, SKILL.md §2) with whatever
  structured key correlation needs — final storage shape is the architect's call.
- ASSUMPTION: "operator session" = a genuine human-facing session; the isolated `klodi-wake`
  session is excluded from resolution by name (BR-3). Depends on Piece 2 keeping the wake session
  out of the operator-session view; if isolation leaks, the resolver needs an explicit
  `klodi-wake` exclusion (coordinate with the sibling card / devops).

### Approach + alternatives ruled out — solutions-architect (2026-06-29)

**System shape — three klodi-owned components in-repo + two probe-gated hermes-host seams.** Klodi
owns: (1) the `klodi_message_user` tool, (2) the operator-target resolver, (3) the durable
pending-decision store + the reply-side read/resolve tool. The two host dependencies — the turn-less
sender and the `active_sessions.json` registry — are NOT in this repo (devops Probes 1/2 confirm);
each sits behind one thin seam so all in-repo logic is unit/integration-testable and the real binding
is the merge-gate probe.

**Keystone — the inbound wake-session key IS the outbound correlation key, threaded to the tool via
subprocess env (deterministic, no new probe, no LLM dependency).** The sibling's redesigned Piece 2
spawns the isolated turn as `hermes chat --session <entity_key> -Q`, where `entity_key` is derived by
one typed dispatch in `wake_handlers` off `event.kind` (channel.\*→`channel_id`,
offer/listing/comment→`listing_id`, transaction.\*→`transaction_id`, search.match→`search_slug`,
missing→`wake-<event_id>` — confirmed against `packages/tool-catalog/tests/golden/*.json`).
`klodi_message_user` runs *inside* that subprocess. To hand the tool the key deterministically, the
bridge — the site that already computes `entity_key` for `--session` — also sets
`KLODI_WAKE_ENTITY_ID`/`KLODI_WAKE_ENTITY_TYPE`/`KLODI_WAKE_EVENT_ID` on the spawn env
(`subprocess.run(env={**os.environ, …})`; the merged dict is mandatory — a bare dict strips PATH and
breaks the spawn). The tool reads `os.environ` → keys the pending-decision by the *same* id the wake
turn runs under. The key is **bridge-computed, not LLM-supplied** — exactly what "authoritative, not
best-effort" (BR-4/BR-6) requires — and adds zero host-probe surface (standard subprocess env
inheritance). *(Alternative M2 — read hermes's own exposed session id inside the handler — rejected as
primary because it adds a new "does hermes expose session_id to tool handlers?" probe; kept as the
no-bridge-change fallback.)*

**Cross-card contract (resolve now, while #32 is open) — namespace the wake sessions so the resolver
can exclude them.** Devops Probe 3 is correct: there is no single `klodi-wake` session any more, so
BR-3/AC-3's "exclude the `klodi-wake` session" is **stale** — the resolver must exclude the whole
*family* of per-entity wake sessions. Have the sibling spawn `--session klodi:<entity_key>` (namespace
prefix). Then "operator session or klodi wake session?" is decidable from `active_sessions.json` alone
(exclude `klodi:*`), while the bare `<entity_key>` (env, above) stays the pending-decision key. This
is the single most important coordination point with #32.

**Delivery seam — prefer a turn-less CLI over the internal import (devops [HIGH]).** Delivery lives
behind one `_deliver(platform, chat_id, text)` seam. Primary binding: a turn-less `hermes` subcommand
(`hermes send` / `hermes message --session … <text>`) if the probe finds one — preserving the
adapter's proven CLI-black-box contract (it imports no hermes internals today, `bridge_main.py:56-79`).
Fallback binding: importing `standalone_sender_fn` (first-ever hermes-internal import; private API, no
stability contract). Neither runs an agent turn in the operator's session (the Piece-3 hijack-prevention
requirement). Stub `_deliver` exactly as `BridgeCtx._run` is stubbed.

**Pending-decision store — structured JSON, atomic write, entity-keyed (correlation source of truth);
markdown `## Open Questions` stays a secondary human surface.** `${KLODI_HOME}/pending/<entity_id>.json`
carrying `{entity_type, entity_id, event_id, question, asked_at, platform, chat_id, status}`, written
**write-temp+rename** — the store is read in a *different* operator-session OS process than the wake
process that wrote it (devops [HIGH] cross-process race; only atomic rename is safe, no in-process lock
helps). The structured store is what `klodi_pending_decisions()` scans deterministically (cheap: one
dir listing); the human-readable `## Open Questions` / `## Active Negotiations` note the PO values is
maintained by SKILL.md as an *audit* surface, **not** the correlation substrate — LLM-authored markdown
is the best-effort path the card rejects (BR-4/BR-6).

**Control flow — deliver first, persist only on success (devops [MED]).** `handle_message_user`:
resolve target (exclude `klodi:*`; operator → fallback → no-target = surfaced failure, AC-5) →
`_deliver(...)` → **on success** `record_pending(...)` (atomic) → envelope. Persist-then-deliver would
leave a dangling decision the operator never saw. Reply side: `klodi_pending_decisions()` lists open
records → agent re-grounds via *existing* klodi read tools (BR-5) → acts on the bound entity (BR-4) →
`resolve_pending(entity_id)` closes it exactly once (BR-6).

**Alternatives ruled out:**
- *LLM-passed `entity_id` arg to `klodi_message_user(text, entity_id)`.* Rejected — an LLM-supplied key
  is best-effort (omittable/mistyped), the exact thing BR-4 forbids; the bridge-env key is deterministic
  and free (Piece 2 already computes it).
- *Markdown `## Open Questions` as the correlation substrate (PO-preferred home).* Rejected as the
  *substrate* — parsing LLM-authored markdown for entity_id+status is non-deterministic; kept as a
  *secondary* audit surface.
- *Import `standalone_sender_fn` as the primary delivery path.* Demoted to fallback — devops [HIGH]
  internal-API coupling; a turn-less CLI keeps the black-box contract.
- *Deliver by shelling `hermes chat` into the operator session.* Rejected — that runs an agent turn in
  the operator's session (hijack), the exact Piece-3 prohibition.
- *Session-history requery (ZeroClaw v1).* Rejected by the founder — depends on live-session continuity;
  the durable store + marketplace re-ground is the robustness upgrade.
- *Persist-then-deliver; auto-expire / re-ping stale decisions.* Rejected / out of scope — deliver-then-
  persist avoids dangling records; no auto re-ping (spam); the next-session `## Open Questions` surface is
  the safety net (PO open question).

### Affected files / surfaces — solutions-architect (2026-06-29)

> Canonical component map. The devops "Affected files (runtime/delivery lens)" subsection below is
> additive (env resolution, atomic-write site, schema specifics) and not repeated here.

NEW (klodi-owned, in-repo, no host internals):
- `adapters/hermes/src/klodi_hermes/message.py` — `klodi_message_user` handler + operator-target
  resolver + the `_deliver` seam + `register_message_tools(ctx)`. (May fold into `tools.py` per devops —
  dev's call.)
- `adapters/hermes/src/klodi_hermes/pending_decisions.py` — the entity-keyed store
  (`record_pending`/`open_pending`/`resolve_pending`, atomic write) + the `klodi_pending_decisions`
  read/resolve tool + `register_pending_tools(ctx)`.
- `adapters/hermes/tests/test_message.py`, `tests/test_pending_decisions.py`.

MODIFIED (klodi-owned — **shared edit surface with sibling #32; sequence after it**):
- `bridge.py::inject_message` — set `KLODI_WAKE_ENTITY_*` env on the spawn; spawn `--session
  klodi:<entity_key>` (the namespace contract). Same method #32 edits for per-key `--session`.
- `wake_handlers.py::_inject` — thread `entity_type`/`entity_id` from the sibling's typed key-dispatch
  (reuse, do **not** re-derive).
- `__init__.py::register()` — register the two new tools.
- `tools.py::_TOOL_EMOJIS` — emojis for the new tools.
- `skills/klodi/SKILL.md` + canonical `klodi-skill/` + `skills/klodi/templates/negotiation_style.template.md`
  — Piece 5.

Catalog: `klodi_message_user` / `klodi_pending_decisions` are **host-local** tools (no NATS subject),
like `klodi_setup_status` — NOT added to the cross-language tool-catalog; no symmetry-axis impact
([[0014-tool-symmetry-axes]]). (Answers devops' catalog-membership open question: no.)

PROBE-GATED (hermes-host, devops Probes 1–4; merge-gate stacked on #32): turn-less sender binding;
`active_sessions.json` path+schema+`$HERMES_HOME`; net-new hermes fallback-channel config; multi-platform
sender dispatch.

### Risks / failure modes

**Product / UX risks — product-owner (2026-06-29)** (architect appends technical risks below):

- **Self-addressing leak (highest product risk).** If Piece 2's isolation is imperfect and the
  `klodi-wake` session surfaces as the most-recently-active session, the resolver delivers the
  human's escalation into the bot's own transcript — the operator never sees it, never replies,
  and the marketplace action stalls *silently* (a BR-2 + BR-3 violation born of a cross-card seam).
  Mitigation: explicit `klodi-wake` exclusion in the resolver; coordinate the session name with the
  sibling card. This is the single most important coordination point.
- **Notification spam erodes trust.** Over-eager `klodi_message_user` (pinging on informational
  wakes, or re-pinging on redelivery) trains the operator to ignore the channel — defeating the
  purpose. Guarded by BR-1 (policy-gated reach-out) + BR-6 (idempotent outreach) + the default-off
  FYI preference.
- **Wrong-entity action (authority failure).** A reply applied to a guessed or stale entity is
  worse than no action — the agent could counter the wrong offer or message the wrong channel.
  Guarded by BR-4 (disambiguate, never guess) + BR-5 (re-ground before acting). The AC-9/AC-10
  tests are the load-bearing guards here.
- **Reply never arrives / decision rots.** The operator may never reply. The pending-decision must
  not block forever invisibly: it stays in the durable `## Open Questions` surface (visible next
  session) and SHOULD carry enough context that a stale-but-open decision is legible later. No
  auto-expiry is specced (a counterparty-side timeout closes the entity and BR-5 handles it on the
  eventual reply); flag if the founder wants an explicit operator-facing "still waiting on you" nudge.
- **Cross-session memory loss.** The reply turn has none of the isolated turn's reasoning. If the
  outbound message under-specifies the entity (BR-7 violated), the operator's reply is
  uninterpretable. The message text quality is a product requirement, not a nicety.

### Acceptance criteria

<!--
Each criterion is tagged with the test tier that verifies it. Format:

- `[tier] Given <state>, when <action>, then <outcome>`

tier ∈ {unit, integration, e2e}. The `tiers:` frontmatter is the union of tiers used here.
See .claude/skills/adversarial-testing/references/testing-tiers.md for tier definitions.
Both product-owner and solutions-architect are responsible for these — product-owner
frames the behavior, solutions-architect tags the tier.
-->

**Behaviour framed by product-owner (2026-06-29). _Suggested tier_ in italics is a non-authoritative
hint — solutions-architect sets the authoritative `[tier]` tags and the `tiers:` frontmatter.**
Maps the founder's 4 provisional ACs (noted) plus the boundary cases the flows imply.

**Outbound escalation (Piece 3):**

- **AC-1 — active-session delivery** _(founder 1)_. Given a ready, registered persona with an
  active operator session, when the agent calls `klodi_message_user(text)` during an isolated wake
  turn, then the message is delivered into that session's `(platform, chat_id)` in real time via
  the host's standalone sender, and **no** agent turn is run in the operator's session. *(suggested:
  integration)*
- **AC-2 — no-session fallback** _(founder 2)_. Given no active operator session, when
  `klodi_message_user` fires, then it delivers to the configured fallback channel (today: telegram
  + the configured chat id). *(suggested: integration)*
- **AC-3 — resolver never self-addresses the wake session** _(new; cross-card isolation
  invariant)_. Given the only recently-active session on disk is the isolated `klodi-wake` session,
  when the resolver picks a target, then it does **not** select the wake session — it falls through
  to the most-recent genuine operator session, or to the fallback channel if none exists.
  *(suggested: unit)*
- **AC-4 — multi-app resolution** _(founder 4)_. Given multiple apps/channels registered, when
  resolving the target, then resolution selects across whatever is registered (most-recently-active
  operator session wins), not telegram-only. *(suggested: unit)*
- **AC-5 — delivery failure is surfaced, not dropped** _(new; outbound INV-1 / BR-2)_. Given
  neither an active operator session nor a configured fallback resolves (or the sender errors),
  when `klodi_message_user` fires, then it returns a structured failure the agent can see (and logs
  it) — the agent learns the human was **not** reached; it is never a silent no-op. *(suggested:
  unit + integration)*
- **AC-6 — reach-out is policy-gated** _(new; BR-1)_. Given an isolated wake turn, when the wake
  hits a decision reserved for the human (`## Always Ask Me First` / unresolved `## Escalation When
  Unknown` / a `security.md` hard rule), then the agent calls `klodi_message_user`; and given a
  wake the policy authorizes the agent to handle autonomously, then it does **not** reach out (by
  default). *(suggested: e2e / persona-policy — architect to judge testability; partly a SKILL.md +
  policy-template spec, not only a code test)*

**Reply correlation (Piece 4):**

- **AC-7 — pending-decision persisted on outbound** _(new; substrate for founder 3)_. Given the
  agent reaches out for a human decision, when `klodi_message_user` fires, then a durable
  pending-decision record is persisted keyed to the marketplace entity (`channel_id` / `offer_id` /
  `listing_id` / `transaction_id`) and the question asked, with `open` status, and it survives the
  end of the isolated turn. *(suggested: unit + integration)*
- **AC-8 — single-decision reply re-grounds and acts on the right entity** _(founder 3)_. Given
  exactly one open pending-decision, when the operator replies on their normal session, then the
  normal klodi-toolset turn reads that pending-decision, re-grounds the entity's current state via
  klodi read tools, applies the operator's answer to the correct channel/offer/listing, and does
  not depend on session continuity with the isolated turn. *(suggested: integration / e2e)*
- **AC-9 — multiple open decisions → disambiguate, never guess** _(new; BR-4)_. Given more than one
  open pending-decision, when the operator's reply does not unambiguously identify one, then the
  agent disambiguates (matches on the entity identity carried in the original message, or
  re-prompts) and does **not** apply the answer to a guessed entity. *(suggested: integration /
  e2e)*
- **AC-10 — authoritative re-ground when the entity moved** _(new; BR-5 — the robustness upgrade)_.
  Given an open pending-decision whose entity changed since the question (offer
  withdrawn/countered, channel closed, listing sold, transaction cancelled), when the operator
  replies, then the agent detects the changed state on re-ground and does **not** blindly apply the
  stale instruction — it re-evaluates and informs the operator of the current state. *(suggested:
  integration / e2e)*
- **AC-11 — resolve exactly once; idempotent outreach** _(new; BR-6)_. Given a pending-decision
  already resolved/closed, when a later unrelated reply arrives, then it does not re-fire the closed
  decision; and given a redelivered/duplicate outbound trigger for an already-open decision (same
  entity + question), then no duplicate record and no duplicate ping are created. *(suggested: unit
  + integration)*

> **Tier tags + `tiers:` frontmatter PENDING solutions-architect.** Note for the architect: AC-6 /
> AC-8 / AC-9 / AC-10 have a persona-policy dimension (SKILL.md + `negotiation_style.md` content)
> that may be partly spec-verified rather than code-tested — please call which clauses land as
> `e2e`/persona vs. which reduce to a unit/integration test of the tool + correlation store, and
> coordinate the `klodi-wake` exclusion (AC-3) name with the sibling card.

**Test-tier tags — solutions-architect (2026-06-29).** Authoritative; `tiers:` frontmatter = union of
required automated tiers = `[unit, integration]`. Resolving the PO's flagged persona-policy split:
clauses that reduce to a tool/store/resolver contract are unit/integration; genuinely agent-reasoning
clauses are **persona/e2e and deliberately NOT a required automated tier** (no real `hermes`/LLM in
this env — the sibling card set the same precedent, gating real-host behavior on the PR, not on a
required tier).

- **AC-1 → `[integration]`.** Handler resolves the active operator session and invokes the stub
  `_deliver` with `(platform, chat_id, text)`; assert **no `hermes chat` subprocess is spawned** (the
  no-operator-turn guarantee). Real-host delivery is probe-gated e2e, not required.
- **AC-2 → `[unit]`.** Resolver over a temp `active_sessions.json` with no active operator session →
  returns the configured fallback target. *(Caveat per devops Probe 2: the hermes fallback config is
  net-new; if it stays unspecced, AC-2's "no fallback" branch folds into AC-5's surfaced failure.)*
- **AC-3 → `[unit]` — CORRECTED semantics.** Per devops Probe 3 the exclusion is the **wake-session
  family**, not one literal `klodi-wake`: given `active_sessions.json` contains only `klodi:*`-namespaced
  wake sessions, the resolver excludes all of them and falls through to operator session / fallback.
  (Load-bearing cross-card guard; depends on the `klodi:` prefix contract.)
- **AC-4 → `[unit]`.** Resolver over multiple platforms → most-recently-active operator session wins;
  not telegram-hardcoded.
- **AC-5 → `[unit, integration]`.** Unit: resolver yields no target → handler returns a structured
  failure envelope (ADR-0011 shape), never a no-op. Integration: `_deliver` raises → handler surfaces
  the failure + logs, and **does not persist a pending-decision** (deliver-then-persist ordering).
  Outbound INV-1 / BR-2 guard.
- **AC-6 → `[unit]` (skill/policy content) + persona (not a required automated tier).** Unit: assert
  SKILL.md + `negotiation_style.template.md` carry the reach-out gating guidance + the
  `klodi_message_user` name (mirror `test_skill_install`). Agent actually gating is persona/e2e.
- **AC-7 → `[unit, integration]`.** Unit: `record_pending` writes the entity-keyed record (full schema,
  atomic) and re-read returns it post-turn. Integration: `klodi_message_user` end-to-end persists with
  `entity_id` from the bridge env (the keystone), `status=open`, **only after** `_deliver` succeeds.
- **AC-8 → `[integration]` (store+tool substrate) + persona (agent re-ground/act).** Integration:
  `klodi_pending_decisions()` returns the single open record; `resolve_pending` closes it; second read
  excludes it. Agent re-ground+apply is persona/e2e.
- **AC-9 → `[integration]` (substrate) + persona.** Integration: two open decisions →
  `klodi_pending_decisions()` returns both, each carrying entity identity + question (disambiguation
  *possible*). Agent choosing is persona.
- **AC-10 → `[unit]` (kernel) + persona.** Unit kernel: the record stores a **pointer**
  (`entity_type`/`entity_id`/`question`), not a marketplace snapshot — so re-ground necessarily reads
  live state via existing tools. The not-applying-stale judgment is persona/e2e.
- **AC-11 → `[unit, integration]`.** Unit: `resolve_pending` closes exactly once (second is a no-op);
  `record_pending` dedupes same `entity_id`+question (no duplicate record). Integration: redelivered
  outbound trigger → no duplicate ping.
- **AC-12 (architect-added per devops [HIGH] reply-trigger) → `[unit]` (skill content) + persona.**
  Given any operator turn, the SKILL.md policy directs the agent to scan open pending-decisions *before*
  responding — without it the reply is silently never correlated (the outbound twin of the sibling's
  silent-loss). Unit: assert the SKILL.md §2 "check pending on every operator turn" instruction is
  present. Behavioral firing is persona/e2e.

No required `e2e`: every automated contract is the resolver (unit, temp file), the store (unit, tmp dir,
atomic write), the handler with a stub `_deliver` (integration), and skill content (unit). Real-host
delivery, the `active_sessions.json` schema, multi-platform dispatch, and agent reasoning are
probe/persona-gated and recorded — the card is not gated on an unrunnable e2e.

### Open questions (if any)

**Product open questions — product-owner (2026-06-29). None blocking** — each has a recorded
defensible assumption above; listed so the dev pair and founder can override:

- **FYI push default.** Should informational wakes (offer accepted, deal completed) push via
  `klodi_message_user` by default, or only human-decision escalations? *Assumed: only decisions;
  FYIs opt-in via `negotiation_style.md` `## Reaching Out`.* Founder flips the default if wrong.
- **Stale-decision nudge.** If the operator never replies, should the agent re-ping after some
  interval, or rely solely on the durable `## Open Questions` next-session surface? *Assumed: no
  auto re-ping (avoid spam); next-session surface is the safety net.* Founder may want an explicit
  "still waiting on you" nudge.

**Cross-seat coordination (not founder-blocking):**

- **→ solutions-architect:** owns final tier tags + `tiers:` frontmatter; the pending-decision
  store shape (product-preferred: extend sell/buy `## Open Questions` / `## Active Negotiations`,
  see Assumptions); whether `klodi_message_user` is a host-local registered tool (like
  `klodi_channel_message` in `tools.py`) and where the resolver/sender live.
- **→ devops-engineer:** the probe the sibling card already flags — confirm the host's standalone
  sender signature + the active-session registry schema (`active_sessions.json` is
  hermes-binary-internal, absent from this repo); confirm the fallback-channel config key. AC-1/AC-2
  delivery is only verifiable end-to-end against a real host.
- **→ sibling card `wake-inject-failures-silent-and-lost-hermes` (Piece 2):** lock the isolated
  session **name** (`klodi-wake`) and its non-appearance as an operator session — BR-3 / AC-3
  depend on it. If isolation can leak into the operator-session view, this card's resolver MUST
  carry an explicit `klodi-wake` exclusion.

### Runtime / delivery probe — devops-engineer (2026-06-29)

> My lens: where this actually runs, what is confirmable in this environment, and the ops failure
> modes. **Bottom line: every host primitive this card's outbound mechanism hinges on
> (`standalone_sender_fn` in `gateway/delivery.py`, `$HERMES_HOME/runtime/active_sessions.json`) is a
> hermes-_host_-internal that is NOT in this repo and CANNOT be probed in this environment** — no
> `hermes` binary on PATH, no `~/.hermes`, no `/cclank/hermes-wiki`, `$HERMES_HOME`/`$KLODI_HOME`
> unset, and `rg` finds zero in-repo references to any of these symbols. The sibling inbound card hit
> the identical wall (its Piece-2 `--session` flag is an un-runnable probe-gate carried on PR #32's
> merge-gate). Below: the most-defensible assumption per probe + the exact command that confirms it.
> The architect should assumption-gate these on the PR merge-gate, **stacked on the sibling's existing
> `--session` / session-drain merge-gate** (same epic, one real-hermes probe session clears all of them).

**Architectural fact that frames all four probes (CONFIRMED in-repo).** The hermes adapter treats the
hermes host as a **CLI black box** — it never does `import hermes.*`. The bridge daemon delivers wakes
by shelling out to `hermes chat` (`bridge.py:98-106`; binary resolved in `bridge_main.py:56-79` via
`KLODI_HERMES_BIN` / `which hermes` / `/opt/hermes/.venv/bin/hermes`). Every host-coupling surface today
is either the `hermes` CLI or the `ctx.register_tool/register_skill/inject_message` plugin API. **Calling
`gateway/delivery.py::standalone_sender_fn` would be the first time the adapter reaches into hermes
Python internals** — a new coupling to a private API with no stability contract (a hermes upgrade that
renames/moves it breaks outbound delivery with no compile-time signal in Python). This is the single most
important design input I can give: **prefer a turn-less-delivery CLI** (`hermes send` / `hermes message
--session <id> <text>`, if one exists — probe it) over importing the internal function. A CLI keeps the
proven black-box contract; an internal import only works in a process where `hermes` is importable.

**Probe 1 — `standalone_sender_fn` signature + callability → UNCONFIRMED (no source/binary/wiki in env).**
- *Confirmable now:* zero references in this repo; hermes-internal. The Epic-note premise ("callable from
  the bridge's process… almost certainly yes") rests on two unverified sub-claims: (a) the symbol/signature
  exists at `gateway/delivery.py`, and (b) `hermes` is importable in the calling process.
- *Runtime correction to "the bridge's process":* `klodi_message_user` is a **tool the agent calls**, so its
  handler runs **inside the `hermes chat --session <key>` subprocess** the sibling's redesigned Piece 2
  spawns for the isolated wake turn — NOT in the long-lived bridge daemon. That subprocess *is* the hermes
  process (plugin loaded via `register(per_chat_ctx)`), so import-ability holds far more strongly there than
  in the bridge daemon (a separate `klodi-hermes-bridge` console script that may not share hermes's venv).
  Register it exactly like the existing local tools (`tools.py::register_request_tools`, sync
  `handler(args, **kwargs) -> str`, ADR-0011 envelope on failure).
- *Most-defensible assumption (gate it):* a turn-less delivery primitive exists and is reachable from the
  tool handler's process; signature ≈ `standalone_sender_fn(platform: str, chat_id: str, text: str) -> None`
  (or a session-handle variant). Implement behind one thin `_deliver(platform, chat_id, text)` seam so the
  real call site is swappable once the probe lands.
- *Probe to confirm:* in a real hermes container — `python -c "import gateway.delivery as d;
  help(d.standalone_sender_fn)"` (exact module path TBD) **and** `hermes --help` / `hermes send --help`.

**Probe 2 — `active_sessions.json` schema + fallback → UNCONFIRMED (hermes-binary-internal file).**
- *Confirmable now:* does not exist anywhere in this repo (sibling card states the same). It lives under
  `$HERMES_HOME/runtime/` — a path the adapter does NOT reference today (the adapter only ever resolves
  `$KLODI_HOME`). So this introduces a **new env dependency** `$HERMES_HOME` (likely `~/.hermes` per the
  spec's plugin-clone path, but unconfirmed).
- *Most-defensible assumption (gate it):* a list/map of operator sessions each carrying ≥ `{platform,
  chat_id, last_active_at}` (or `updated_at`); "most-recently-active" = max timestamp; missing/empty/parse
  error → fallback channel.
- *Fallback-channel caveat (this sharpens the PO's Assumption + AC-2/AC-5):* `TELEGRAM_CHAT_ID` is currently
  a **zeroclaw/rust-host** concept only (`adapters/zeroclaw/src/bin/register.rs`, `${KLODI_HOME}/telegram.json`)
  — **hermes has no telegram pairing today.** So the hermes fallback is **net-new config**, not free: it needs
  its own bot-token + chat-id source (env `TELEGRAM_CHAT_ID` + token, or a `${KLODI_HOME}/telegram.json`
  mirrored from the rust hosts). The PO's "the exact config key is architecture/devops" → my answer: there is
  no existing hermes key; one must be created, OR the cold fallback is "loud failure until a session exists."
- *Probe to confirm:* real hermes container with ≥1 live operator chat — `cat
  $HERMES_HOME/runtime/active_sessions.json | jq` to read the real schema + timestamp field name.

**Probe 3 — headless isolated session → RESOLVED BY THE SIBLING; compose with its FINAL model (important
correction for BR-3 / AC-3).** The sibling card `wake-inject-failures-silent-and-lost-hermes` owns this and
has a **founder-locked redesign** (its In-Dev round 3, PR #32 held pre-merge for it): the isolated wake turn
runs `hermes chat -q <wake> --session <key> -Q` (no `--continue`), **keyed per marketplace entity** —
`channel_id` (channel.*), `listing_id` (offer.*/listing.*/comment.created), `transaction_id` (transaction.*),
`search_slug` (search.match), ephemeral `wake-<event_id>` fallback. **There is no single `klodi-wake` session
any more** — the founder explicitly rejected it as unbounded-context-growth.
- **⚠ Cross-card correction for BR-3 / AC-3 / the resolver:** the PO text and AC-3 still say "exclude the
  `klodi-wake` session" — that is **stale**. The resolver must exclude the **whole family of isolated wake
  sessions** (every per-entity-key session the sibling spawns), not one literal name. Practically: an operator
  session is one in `active_sessions.json` that is NOT one of klodi's per-key wake sessions. Cleanest
  composition — have the sibling tag/namespace its wake sessions (e.g. a `klodi:` session-name prefix on the
  per-key id) so the resolver excludes by prefix; coordinate that prefix as the shared contract. A bare-id
  per-key scheme with no namespace makes "is this an operator session or a klodi wake session?" undecidable
  from `active_sessions.json` alone — flag this to the sibling now, while #32 is still open.
- **Load-bearing composition:** the inbound wake session key and the outbound pending-decision key share the
  **same id space** (channel/listing/transaction/search ids). `klodi_message_user` runs *inside* the isolated
  `--session <entity_id>` turn, so key the pending-decision by that same entity id → the round-trip is
  id-consistent end to end. Reuse the sibling's typed key-dispatch (`wake_handlers`, beside
  `_summarize_notification`); do not re-derive a second keying scheme.
- *No new probe beyond the sibling's.* But **this card is blocked on the sibling landing** — it edits the same
  `bridge.py::inject_message` / `wake_handlers` surface #32 is mid-redesign on. Sequence outbound dev after
  #32 reaches pr-ready, or plan a hard merge-conflict resolution on those two files.

**Probe 4 — multi-app resolution → UNCONFIRMED, but free in the adapter if Probe 1/2 hold.** Resolution
generalizes across whatever is in `active_sessions.json` **iff** (a) the file enumerates non-telegram
platforms and (b) `standalone_sender_fn` dispatches by `platform` — both hermes-internal/unconfirmed. The
resolver is platform-agnostic by construction (reads `(platform, chat_id)`, passes `platform` to `_deliver`),
so multi-app is free *in the adapter*; the only constraint is whether the host file + sender support it.
*Probe:* same container read as Probe 2 — does `active_sessions.json` carry >1 platform, and how does the
sender branch on `platform`.

#### Affected files / surfaces (runtime / delivery lens — additive to the architect's list)

- **NEW** `adapters/hermes/src/klodi_hermes/message.py` (or fold into `tools.py`) — `klodi_message_user`
  handler: resolve target (Probe 2) → persist pending-decision (Piece 4) → deliver via the thin
  `_deliver(platform, chat_id, text)` seam wrapping `standalone_sender_fn` (Probe 1). Register host-local
  (like `klodi_channel_message`, `tools.py:426-444`), **hand-written schema** (NOT codegen'd from
  `packages/tool-catalog`) — confirm with architect whether it should still be added to the catalog for the
  epic-template / cross-adapter-parity concern.
- **NEW** pending-decision store — **fully in-repo-implementable, no hermes internals.** Two viable homes:
  (a) PO-preferred: extend the human-readable sell-file `## Open Questions` / buy-file `## Active
  Negotiations` (the reply turn already reads these at SKILL.md §2); (b) a structured
  `${KLODI_HOME}/pending/<entity_id>.json`. Either follows the existing on-disk pattern — `watch.py:214`
  writes `${KLODI_HOME}/buy/<slug>.md` via `_buy_path(slug).write_text(...)`, `_klodi_home()` from
  `local_tools.py:46`. **Write must be atomic** (write-temp+rename, as `klodi_secret_write` already does) —
  see the cross-process-race risk below. Not creds → no 0600 needed; the 0700 home suffices.
- **NEW env dependency `$HERMES_HOME`** (for `active_sessions.json`) — resolve with env override + `~/.hermes`
  default, mirroring `bridge_main.py::_resolve_klodi_home` / `_resolve_hermes_bin` (`bridge_main.py:45-79`).
  No magic path (CLAUDE.md).
- `bridge.py` + `wake_handlers.py` — **shared edit surface with sibling #32** (per-key `--session` +
  `WakeInjectFailed` alarm). Outbound mostly *reads* the entity key the sibling computes; coordinate to avoid
  conflict on #32.
- `skills/klodi/policies/` + `templates/negotiation_style.template.md` + `SKILL.md` (Piece 5) — per the PO's
  spec. See the [HIGH] reply-trigger risk below — the "check pending on every operator turn" policy is
  load-bearing for Piece 4, not polish.

#### Risks / failure modes (runtime / ops — technical risks the PO invited "architect appends below")

- **[HIGH] Internal-API coupling to `standalone_sender_fn`** (see framing fact). First hermes-internal import
  in the adapter; private API, no stability contract, silent break on hermes upgrade. Mitigation: one
  `_deliver` seam + a boot/smoke check that the symbol imports; strongly prefer a turn-less CLI if the probe
  finds one.
- **[HIGH] The operator reply turn has no automatic trigger to read pending-decisions.** A wake carries a
  payload; an operator's free-text reply does not. The agent only correlates if Piece 5's policy tells it to
  scan the pending store on operator turns. **If the policy doesn't fire, the reply is silently never
  correlated** — the exact silent-loss class the sibling card spent itself eliminating, now reborn on the
  outbound side. Make "check pending on every operator turn" an acceptance criterion (the PO's AC-8 assumes
  it; pin it explicitly), and keep the store cheap to scan (one dir listing / one file section read).
- **[HIGH] Cross-process write/read race on the pending store.** Written inside the isolated wake
  `hermes chat --session <entity_id>` subprocess; read inside a DIFFERENT operator-session subprocess,
  possibly concurrent. Two separate OS processes on the same files → no in-process lock helps. Needs atomic
  write-temp+rename and a reader that tolerates "file not there yet."
- **[MED] Double-cold path returns "nowhere to deliver."** Fresh container: `$HERMES_HOME`/`active_sessions.json`
  absent AND the net-new fallback config (Probe 2) also unset → no target. First-wake-before-any-operator-chat
  is the *common* fresh-install case. Disposition must be a **loud surfaced failure** (reuse the sibling's
  `wake_inject_deterministic_failure` alarm shape), never a swallow — this is the PO's AC-5 made concrete.
- **[MED] Turn-less delivery has no in-band ack to the agent.** `standalone_sender_fn` pushes and returns; the
  wake turn ends. If delivery fails *after* the pending-decision is persisted, you get a dangling decision the
  operator never saw. **Order the writes: attempt delivery first, persist pending-decision only on delivery
  success** (or persist with `delivered: bool` + a retry surface). Don't persist-then-deliver.
- **[MED] Pending-decision GC.** No terminal event cleans these up. The sibling's per-key session-drain hooks
  (`channel.closed` / `listing.sold` / `transaction.completed`) are the natural cleanup seam — drain the
  pending-decision for that entity at the same terminal event. Otherwise records accumulate unbounded under
  `${KLODI_HOME}/pending/` (safe, because the agent re-grounds live per BR-5, but messy).
- **[LOW] Most-recently-active multi-app picks one of N active platforms.** Acceptable heuristic for v1;
  document it.

#### Open questions (runtime / delivery — each with the probe that closes it; none founder-blocking)

1. `standalone_sender_fn` module path + signature + import-ability from the tool-handler process. Probe:
   `python -c "import …; help(standalone_sender_fn)"` + `hermes send --help`. *(PR merge-gate, stacked on #32.)*
2. `active_sessions.json` real schema + the "most-recently-active" timestamp field + `$HERMES_HOME` resolution.
   Probe: `cat $HERMES_HOME/runtime/active_sessions.json | jq` with ≥1 live operator chat.
3. Does hermes expose a turn-less delivery CLI (`hermes send` / `hermes message`)? If yes, prefer it over the
   internal import. Probe: `hermes --help`.
4. The hermes fallback-channel config — there is no existing hermes telegram key; decide with the architect:
   net-new env / `telegram.json`, or no fallback (loud failure) until a session exists.
5. **Sibling-card contract (do this now, while #32 is open):** ask the sibling to **namespace/prefix its
   per-key wake session names** (e.g. `klodi:<entity_id>`) so this card's resolver can exclude the wake-session
   family by prefix (BR-3 / AC-3). A bare per-key id is undecidable-vs-operator-session from `active_sessions.json`.
6. Sequencing vs #32 — outbound shares `bridge.py` / `wake_handlers.py`; start outbound dev only after #32
   reaches pr-ready, or plan the merge-conflict resolution on the per-key `--session` keying.

### → Handoff to In Dev (next agents: expert-developer, qa-developer) — solutions-architect (2026-06-29)

**HARD PREREQUISITE — sequence after sibling #32.** This card edits the same `bridge.py::inject_message`
+ `wake_handlers.py::_inject` surface the sibling `wake-inject-failures-silent-and-lost-hermes` is
mid-redesign on (PR #32, held pre-merge for the founder's per-entity-key model). Reuse its typed
key-dispatch + `inject_message(..., session)` signature — do **not** re-derive keying. Start outbound
dev only after #32 reaches pr-ready, or plan a hard merge-conflict resolution on those two files.

**Cross-card contract to lock now (while #32 is open):** the sibling spawns `--session klodi:<entity_key>`
(namespace prefix) and the bridge sets `KLODI_WAKE_ENTITY_ID`/`_TYPE`/`_EVENT_ID` env on the spawn. This
card's resolver excludes `klodi:*` sessions (BR-3/AC-3); this card's store keys by the bare `<entity_key>`
from env. If #32 ships bare per-key session names with no namespace, the resolver cannot tell an operator
session from a wake session — raise it on #32 immediately.

**TDD order (qa-developer RED first, expert-developer GREEN):**
1. **Pending-decision store (pure, no host deps — unblocks everything).** `pending_decisions.py`: atomic
   `record_pending`/`open_pending`/`resolve_pending` under `${KLODI_HOME}/pending/`, keyed by `entity_id`.
   RED: AC-7 (record+re-read), AC-11 (resolve-once + dedupe), AC-10 kernel (pointer not snapshot). Mirror
   the on-disk pattern (`watch.py:214` buy-file writes; `klodi_secret_write`-style atomic rename;
   `default_klodi_home()`).
2. **Resolver (pure over temp file + config).** `message.py`: read `active_sessions.json`, exclude
   `klodi:*`, most-recently-active operator wins, fallback, else no-target. RED: AC-2, AC-3 (family
   exclusion), AC-4. Assumed schema; safe-by-default (missing/unparseable → fallback, never raise).
3. **`klodi_message_user` handler + `_deliver` seam.** Resolve → `_deliver` → on success `record_pending`
   (entity from `os.environ["KLODI_WAKE_ENTITY_ID"]`). RED: AC-1 (resolve→deliver, **no chat spawn**),
   AC-5 (no-target/raise → surfaced failure, no persist), AC-7 integration. Stub `_deliver` like
   `BridgeCtx._run`.
4. **Bridge env-thread (composes with #32's `inject_message`).** `env={**os.environ, KLODI_WAKE_ENTITY_*}`
   + `--session klodi:<key>`; thread `entity_type`/`entity_id` from the sibling's key-dispatch through
   `_inject`. RED: bridge sets the merged env; key matches the per-kind table. **Merged env mandatory**
   (a bare dict strips PATH).
5. **Reply read tool + register wiring.** `klodi_pending_decisions()` (local tool, mirror
   `klodi_setup_status`); register both tools in `__init__.py::register()`; emojis in `tools.py`. RED:
   AC-8/AC-9 substrate.
6. **Piece 5 — SKILL.md + `negotiation_style.template.md`.** Reach-out gating (BR-1), reply loop incl.
   **"check pending on every operator turn"** (AC-12 / devops [HIGH]), self-contained message text (BR-7).
   RED: AC-6 + AC-12 content assertions (mirror `test_skill_install`). Update canonical `klodi-skill/`
   **and** the bundled `skills/klodi/` copy.

**Constraints (CLAUDE.md):** strict types (typed store schema — dataclass/TypedDict, no `any`); no magic
strings (the `KLODI_WAKE_ENTITY_*` names, the `klodi:` prefix, the fallback config key are named
constants, shared with #32 where applicable); no back-compat shims; **fail-fast loud** on
delivery/no-target (BR-2/AC-5 — never silent; reuse the sibling's deterministic-alarm discipline /
ADR-0019). Host-local tools NOT in the tool-catalog ([[0014-tool-symmetry-axes]]). Per-adapter:
`cd adapters/hermes && uv run pytest`; `ruff check adapters/hermes`.

**Merge gates (carry on the PR, stacked on #32's existing gates — one real-hermes session clears all):**
(a) turn-less sender binding (prefer CLI; else `standalone_sender_fn` import path/signature);
(b) `active_sessions.json` path+schema+`$HERMES_HOME`; (c) net-new hermes fallback-channel config;
(d) the `klodi:` session-namespace contract agreed in #32. Safe-by-default if any is wrong: loud surfaced
failure, never silent.

**Live-verification (probe-gated, deferred to whoever has a real host):** boot hermes + paired operator,
fire an escalating wake, confirm the message lands in the operator's chat (not the wake transcript),
reply, confirm the right marketplace action fires and the decision resolves. The automated suite covers
every in-repo contract.

## In Dev — qa-developer (RED), expert-developer (GREEN)

### RED test-spec — qa-developer (2026-06-29)

Four new test files under `adapters/hermes/tests/`, committed + pushed on `card/…` (first
in-dev commit, created `origin/card/wake-outbound-roundtrip-message-and-correlation`). The card
`.md` is gitignored — not committed. **39 RED test nodes**; the suite fails RED for the right
reason (no implementation), confirmed via
`PYTHONPATH=<worktree>/packages/nats-client-py/src uv run --with pytest --with pytest-asyncio pytest`.
All four files are `ruff`-clean.

| Test file | Locks | AC / BR |
|---|---|---|
| `tests/test_pending_decisions.py` (9) | entity-keyed durable store: persist+survive; **pointer-not-snapshot kernel**; resolve-exactly-once; idempotent same-entity+question record; missing-dir / torn-read tolerance | AC-7, AC-10 (kernel), AC-11 / BR-6, BR-5 |
| `tests/test_message.py` (19) | operator-target **resolver** (most-recent operator; fallback; **klodi: family exclusion + never-self-address even when a wake session is the most recent**; multi-app; malformed-registry tolerance); **`klodi_message_user` handler** (turn-less delivery + **no `hermes chat` spawn**; env-keyed persist *after* delivery; no-target & deliver-raises → surfaced ADR-0011 failure, no persist); INV-1 single-disposition; **`klodi_pending_decisions`** reply tool | AC-1, AC-2, AC-3, AC-4, AC-5, AC-7, AC-8, AC-9, INV-1 / BR-2, BR-3, BR-4 |
| `tests/test_wake_outbound_env.py` (6) | **the keystone** — driving the real `BridgeCtx` through the real wake handler: spawn sets merged `KLODI_WAKE_ENTITY_*` env; `"klodi:" + env[KLODI_WAKE_ENTITY_ID] == --session`; entity_type = entity domain (offer→`listing`); **merged `{**os.environ,…}` (PATH + sentinel survive)** | env keystone, BR-4/BR-6 determinism |
| `tests/test_skill_outbound_policy.py` (5) | Piece-5 content on canonical `klodi-skill/`: `klodi_message_user` documented; `## Reaching Out` block in `negotiation_style.template.md`; reach-out gated on the human-decision policy; scan `klodi_pending_decisions` on operator turns; self-contained message | AC-6 / BR-1, AC-12, BR-7 |

**Current RED breakdown:** 11 assertion-level failures (env keystone + skill content; files import fine, fail on the missing behavior/content) + 28 nodes blocked on `ModuleNotFoundError` for the two not-yet-existing modules (`klodi_hermes.pending_decisions`, `klodi_hermes.message`) — the import error IS the correct RED. No required `e2e` (real-host delivery, the `active_sessions.json` schema, multi-platform dispatch, and agent reply-reasoning stay probe/persona-gated per the architect's tier ruling).

### → Handoff to expert-developer (GREEN) — qa-developer (2026-06-29)

Make all 39 nodes green **without weakening a single assertion** (tests are the spec; QA owns any
test change). Build the modules to the contracts the tests already pin. Run recipe (fresh worktree):
`cd adapters/hermes && PYTHONPATH=<worktree>/packages/nats-client-py/src uv run --with pytest --with pytest-asyncio pytest` (the documented `uv run pytest` fails on a missing dev extra + unresolved `klodi_nats_client` — env gap, not a regression).

**1. NEW `src/klodi_hermes/pending_decisions.py` — the correlation store + reply tool.**
- Typed record `PendingDecision` (dataclass; attrs `entity_type, entity_id, event_id, question, asked_at, platform, chat_id, status`) — strict, no loose dict.
- `record_pending(*, entity_type, entity_id, event_id, question, asked_at, platform, chat_id) -> PendingDecision` → writes `${KLODI_HOME}/pending/<entity_id>.json` **atomically** (write-temp + `os.replace`, à la `klodi_secret_write` — the reader is a *different* OS process, cross-process race per devops [HIGH]), `status="open"`. Idempotent on `(entity_id, question)` — a redelivery writes no second file. **Persist ONLY the pointer schema** (the test asserts the on-disk key set is *exactly* those 8 keys and contains none of `amount/price/offer_id/listing_summary/content/terms/…` — AC-10 kernel: it's a pointer, the reply turn re-grounds live).
- `open_pending() -> list[PendingDecision]` — open records only; missing dir → `[]`; a malformed/torn file is skipped, never raised.
- `resolve_pending(entity_id) -> bool` — close exactly once (first truthy, second falsy); unknown id → falsy; close is terminal.
- `handle_pending_decisions(args, **kwargs) -> str` → JSON array of open records (each a dict carrying full identity + question) + `register_pending_tools(ctx)`.

**2. NEW `src/klodi_hermes/message.py` — tool + resolver + delivery seam.**
- `DeliveryTarget` typed (`.platform`, `.chat_id`; `DeliveryTarget(platform=…, chat_id=…)` keyword ctor — the tests compare by value, so a `NamedTuple`/`@dataclass(frozen=True)` with `__eq__` is required).
- `resolve_operator_target(*, fallback: DeliveryTarget | None = None) -> DeliveryTarget | None` — reads `${HERMES_HOME}/runtime/active_sessions.json`; **most-recently-active genuine operator session wins**; **exclude every `klodi:`-prefixed session** (reuse `wake_handlers._WAKE_SESSION_NAMESPACE`); no operator → `fallback`; missing/empty/malformed/non-list → `fallback`, **never raise**. ⚠ **Assumed schema is probe-gated:** the tests pin a top-level JSON **array** of `{session, platform, chat_id, last_active_at}` — that is the merge-gate contract; if the real host schema differs, the resolver parse **and** these fixtures move together (QA updates the test).
- `configured_fallback() -> DeliveryTarget | None` — the net-new hermes fallback config seam (devops: no existing hermes telegram key; returns None when unset). Tests monkeypatch it — keep it a module-level function the handler calls.
- `_deliver(platform, chat_id, text) -> None` — turn-less delivery seam (prefer a `hermes send`-style CLI; fallback `standalone_sender_fn` import — merge-gated). **Must not run an agent turn** (the test patches `subprocess.run` and asserts it is never called). Stub-shaped like `BridgeCtx._run`.
- `handle_message_user(args, **kwargs) -> str` + `register_message_tools(ctx)` — resolve `= resolve_operator_target(fallback=configured_fallback())`; **deliver-then-persist**: no target → ADR-0011 failure envelope (4-key), no `_deliver`, no persist; `_deliver` raises → failure envelope, no persist; success → `record_pending(entity_* from os.environ["KLODI_WAKE_ENTITY_ID|_TYPE"], event_id from KLODI_WAKE_EVENT_ID, question=args["text"], asked_at=now, platform/chat_id from target)` then a non-error envelope. **Never a silent no-op** (INV-1).

**3. MODIFY `bridge.py` + `wake_handlers.py` — the keystone (shared #32 surface; compose, don't re-derive).**
- `BridgeCtx.inject_message` must spawn with `env={**os.environ, KLODI_WAKE_ENTITY_ID: entity_id, KLODI_WAKE_ENTITY_TYPE: entity_type, KLODI_WAKE_EVENT_ID: event_id}` — the **merged dict is mandatory** (a bare dict strips PATH; the test asserts a sentinel env var + PATH survive). Thread `entity_type/entity_id/event_id` in from `_inject`, derived from the event via the sibling's typed key-dispatch (`_SESSION_KEY_FIELD_BY_DOMAIN`) — entity_id = `derive_wake_session(event)` minus the `klodi:` prefix; entity_type = the key field's **entity domain** (`listing_id`→`listing`, `channel_id`→`channel`, `transaction_id`→`transaction`, `search_slug`→`search`). Cover both `handle_notification` and `handle_channel_message`. Keep the `_inject_accepts_session`-style guard working for the in-process per-chat ctx (no session/entity concept).
- Name the three env-var strings + the `klodi:` prefix as shared constants (no magic strings; coordinate with #32 where the prefix already lives).

**4. Register wiring + emojis.** `__init__.py::register()` → call `register_message_tools` + `register_pending_tools`; add both names to `tools.py::_is_local_tool` + an emoji each in `_TOOL_EMOJIS`. Host-local tools — **NOT** added to the cross-language tool-catalog ([[0014-tool-symmetry-axes]]).

**5. Piece 5 content — canonical `klodi-skill/` (the bundled `skills/klodi/` copy is build-time/gitignored, so the tracked source is what the test reads).** SKILL.md: document `klodi_message_user` + reach-out gating (tie to `Always Ask Me First`/escalation + "reach out"), `klodi_pending_decisions` scan on every operator turn (§2), self-contained message requirement (BR-7). `templates/negotiation_style.template.md`: add a `## Reaching Out` block referencing `klodi_message_user`.

**Do not** touch the test files to make them pass — if a test looks wrong, push back to qa-developer. Open the PR (in-dev → review) once green + live-verification deferred-probe notes are recorded; coordinate the merge-gate stack on #32 (turn-less sender, `active_sessions.json` schema/`$HERMES_HOME`, fallback config, the `klodi:` namespace contract).

### GREEN implementation — expert-developer (2026-06-29)

All 39 RED nodes green; full hermes suite **226 passed**, no assertion weakened.
`ruff check` + `ruff format --check` clean on the new/owned source; `ty check`
clean on all four touched source files. Run recipe (fresh worktree, qa's env gap):
`cd adapters/hermes && PYTHONPATH=<worktree>/packages/nats-client-py/src uv run --with pytest --with pytest-asyncio pytest`.

**What landed (Pieces 3/4/5):**

- **NEW `pending_decisions.py`** — pure, host-dependency-free store. Frozen
  `PendingDecision` dataclass = exactly the 8-key pointer schema (no marketplace
  snapshot fields — AC-10 kernel). `record_pending` writes
  `${KLODI_HOME}/pending/<entity_id>.json` via write-temp + `os.replace` (atomic,
  cross-process safe — devops [HIGH]); idempotent on `(entity_id, question)`
  (returns the existing record, no second file — BR-6). `open_pending` filters
  `status=open`, tolerates a missing dir (`[]`) and torn files (skip, never raise).
  `resolve_pending` is **remove-on-close** → close-exactly-once falls out for free
  (first unlink truthy, second falsy) AND it GCs the resolved record (closes the
  devops [MED] GC gap); the human-readable `## Open Questions` stays the audit
  surface. `handle_pending_decisions` + `register_pending_tools`.
- **NEW `message.py`** — frozen value-typed `DeliveryTarget`. `resolve_operator_target`
  reads `${HERMES_HOME}/runtime/active_sessions.json` (assumed schema, **probe-gated**),
  excludes the whole `klodi:` wake-session family via the imported
  `wake_handlers.WAKE_SESSION_NAMESPACE` (BR-3 — never self-addresses, even when a
  wake session is the single most-recent), most-recent **valid** operator wins
  (well-formedness filtered *before* the max so a malformed newest can't shadow a
  valid older one), missing/empty/malformed/non-list → fallback, **never raises**.
  `configured_fallback` is a net-new env seam (`KLODI_FALLBACK_CHAT_ID/_PLATFORM`;
  unset → None). `handle_message_user` is **deliver-then-persist**: resolve →
  `_deliver` → on success `record_pending` keyed off the bridge-set
  `KLODI_WAKE_ENTITY_*` env → non-error envelope; no-target / `_deliver` raises →
  ADR-0011 4-key failure envelope + ERROR log, **no persist** (INV-1 / BR-2 — every
  call is delivered XOR surfaced-failure, never a silent no-op).
- **MODIFY `bridge.py` + `wake_handlers.py` (the keystone)** — `inject_message` now
  spawns with `env={**os.environ, KLODI_WAKE_ENTITY_ID/_TYPE/_EVENT_ID: ...}` (merged
  dict mandatory — a bare dict strips PATH). New `WakeEntity` + `derive_wake_entity`
  in `wake_handlers`; `derive_wake_session` now *delegates* to it
  (`session == "klodi:" + entity_id` by construction, so the inbound wake-session key
  IS the outbound correlation key — for the ephemeral-uuid fallback the entity is
  derived once per wake so session/id never diverge). entity_type = the key field's
  domain (`listing_id→listing`, etc.). Both `handle_notification` and
  `handle_channel_message` thread it.
- **`_inject_accepts_session` → `_supported_inject_kwargs`** — the old single-kwarg
  guard generalised to a signature-filtered kwargs dict, so the bridge ctx receives
  `session`+`entity_*`+`event_id` while hermes's in-process per-chat ctx (and the
  drain-test ctx, which accepts `session` but NOT the entity kwargs) receives only
  what its signature declares. This was the load-bearing decision: passing the new
  entity kwargs unconditionally would `TypeError` the in-process and drain ctxs.
- **Register wiring** — `__init__.register()` calls both new registrars; both names
  added to `tools._is_local_tool` + `_TOOL_EMOJIS` (📣 / 📌; the two registrars read
  the central map via a function-local `from .tools import tool_emoji` so the store
  module stays a pure leaf). Host-local, **NOT** in the cross-language tool-catalog.
- **Piece 5 (canonical `klodi-skill/` only — the bundled `skills/klodi/` copy is
  gitignored/build-generated, never edited)** — SKILL.md §2 (scan
  `klodi_pending_decisions` every operator turn + re-ground BR-5 + disambiguate BR-4),
  new §3a (`klodi_message_user` reach-out gating BR-1 + self-contained BR-7),
  `negotiation_style.template.md` `## Reaching Out` block, tool_inventory row.

**Deliberate trade-offs / deviations:**
- `resolve_pending` removes the file rather than flipping `status` in place. Both pass
  the tests; remove-on-close is simpler, makes "exactly once" structural, and GCs.
  `status` on disk is therefore always `open` (still asserted by the schema test) and
  `open_pending` keeps the `status==open` filter as defensive depth.
- Emoji NOT registered via a hardcoded inline literal — pulled from `tools._TOOL_EMOJIS`
  through a function-local import, to keep `pending_decisions` import-pure (the store
  test imports it standalone) while staying single-source.
- `bridge.py` / `wake_handlers.py` carried **pre-existing** `ruff format` drift from
  #32 (100-col vs ruff's 88 default; no ruff config in-repo). I did NOT reformat those
  files (out-of-scope churn); my added lines are already conformant. New files are
  `ruff format`-clean.

### → Handoff to Review (next agent: code-quality-guardian)

**Scrutinise:**
- **The keystone equality** (`test_wake_outbound_env.py`): `"klodi:" + env[KLODI_WAKE_ENTITY_ID] == --session`, merged `{**os.environ,…}` (PATH + sentinel survive). The whole round-trip's determinism (BR-4/BR-6) rests here. `derive_wake_entity` is computed once per wake so the ephemeral-uuid branch can't make session ≠ entity_id.
- **`_supported_inject_kwargs`** — the signature-filter that lets the bridge ctx get the entity kwargs while the in-process/drain ctxs get only what they declare. If a future ctx grows `**kwargs`, it gets everything (intended). This replaced `_inject_accepts_session`; the pre-existing wake-session + drain tests still pass.
- **`resolve_operator_target` never raises + never self-addresses** — the `klodi:` family exclusion (BR-3, highest product risk) reuses `wake_handlers.WAKE_SESSION_NAMESPACE` (I promoted it from `_WAKE_SESSION_NAMESPACE` to a public constant — the shared cross-module contract; no test imported the old private name).
- **Deliver-then-persist ordering + INV-1** — failure paths surface an ADR-0011 4-key envelope and persist nothing; success returns a non-`error` dict. `make_envelope` guarantees the 4-key shape the AC-5 test asserts.

**Known smells / deliberate:**
- Importing `record_pending` from a sibling module and `WAKE_SESSION_NAMESPACE` across modules is intentional intra-package coupling (the architect-sanctioned shared contract), now via a *public* constant.
- `handle_message_user` keys the pending-decision off `os.environ` with `""` defaults if the keystone env is absent. By construction the tool only runs inside the wake subprocess where the bridge sets these; no guard added (no test, and a guard would break deliver-then-persist on the delivered path). Flagged.

**Probe-gated merge-blockers (stacked on #32's existing gates — one real-hermes session clears all; SAFE-BY-DEFAULT = loud surfaced failure, never silent):**
1. **`_deliver` binding** — UNBOUND: the real turn-less sender (prefer a `hermes send`-style CLI over importing `gateway.delivery.standalone_sender_fn`) is hermes-internal, unconfirmable here. It currently **raises**, so every escalation surfaces a no-delivery failure until the founder binds the confirmed primitive. The whole unit/integration tier mocks this seam; the live send is the e2e gate.
2. **`active_sessions.json` schema + `$HERMES_HOME`** — the resolver pins an assumed top-level JSON array of `{session, platform, chat_id, last_active_at}` under `${HERMES_HOME}/runtime/`. If the real host schema differs, the parse AND the qa fixtures move together (QA owns the test).
3. **Fallback-channel config** — net-new `KLODI_FALLBACK_CHAT_ID`/`_PLATFORM` (hermes has no native telegram key today). Final key is a merge-gate call; unset → loud no-target failure.
4. **The `klodi:` session-namespace contract** — depends on #32 spawning `--session klodi:<entity_key>` (it does, in this branch).

**Live-verification:** deferred — both host seams (`_deliver`, `active_sessions.json`) are not runnable headless (no `hermes` binary / `$HERMES_HOME`). The unit/integration tier (mocked seams) is the required gate and is fully green; boot-a-real-hermes is the founder's merge-time e2e.

## Review round 1 — code-quality-guardian

**Verdict: REVIEW (contains one P1) → bounce to In Dev.** The implementation is, on the
whole, strong: strict types (frozen dataclasses, full annotations, zero `any`), all magic
strings hoisted to named constants (the `KLODI_WAKE_*` env keys, the `klodi:` namespace, the
fallback config keys), deliver-then-persist ordering correct, INV-1 single-disposition holds,
the keystone equality (`"klodi:" + env[KLODI_WAKE_ENTITY_ID] == --session`) is real and tested
across the golden kinds, atomic cross-process write is correct (`write-temp` + `os.replace`),
and both host seams fail LOUD (the unbound `_deliver` **raises**; the resolver **never raises**
but degrades to a surfaced `no_operator_target` envelope — verified, no silent path). Gates:
`uv run pytest` **226 passed**; `ruff check` on every file this card changed is **clean**.

The one blocker is a security-consistency regression, not a logic bug: a new on-disk write path
keyed by a marketplace-supplied id skips the path-component validation the codebase already
applies to the analogous write. Fix is ~10 lines mirroring an existing helper; bouncing rather
than deferring keeps the security posture honest before pr-ready.

**Verified gates (from the worktree, QA's documented recipe):**
- `cd adapters/hermes && PYTHONPATH=…/packages/nats-client-py/src uv run --with pytest --with pytest-asyncio pytest` → **226 passed**.
- `ruff check` on the 10 changed files → **All checks passed!** (5 `ruff` errors exist under `adapters/hermes` but ALL are in pre-existing untouched files — `test_local_tools.py`, `test_register.py`, `test_search_payload_parity.py`, `test_skill_install.py` — not this card's diff; recorded as pre-existing tech-debt, not a blocker here.)
- Seam-fails-loud confirmed: `message.py:279-282` `_deliver` raises `RuntimeError`; `message.py:104-120` `resolve_operator_target` returns `None` → handler emits ADR-0011 `no_operator_target` envelope + ERROR log (`message.py:154-177`). No silent no-op path exists.

### Findings

**P1 — `entity_id` is used to build a filesystem path with no path-component validation (path traversal).**
`pending_decisions.py:190-191` (`_record_path`) and `:220-227` (`_atomic_write`) construct and
`mkdir -p`+write `${KLODI_HOME}/pending/<entity_id>.json`, where `entity_id` flows **unvalidated**
from marketplace event data: `wake_handlers.derive_wake_entity` (`wake_handlers.py:139-160`) sets
`entity_id = str(event[key_field])` for `listing_id`/`channel_id`/`transaction_id`/`search_slug`,
threaded via the `KLODI_WAKE_ENTITY_ID` env to `message.py:201` → `record_pending(entity_id=…)`.
The repo **already** defends this exact class for the sibling write: `watch.py:68-78` `_validate_slug`
enforces `_SLUG_PATTERN.fullmatch([a-z0-9][a-z0-9._-]*)` + a max length before writing `buy/<slug>.md`,
and `watch.py:56-62` `_ensure_buy_dir` `chmod`s the dir `0o700`. The pending store applies **neither**:
a traversal-laden id (`../../…`) would let `_atomic_write` create dirs and write a `.json` file outside
`pending/` — and outside the `0700` protection of `${KLODI_HOME}`.
Severity rationale (why P1, not auto-FAIL-trivial, but not P2-defer): in the documented trust model the
id fields are **server-assigned UUIDs over signed NATS frames**, so the realistic precondition is a
*compromised marketplace server* (THREAT_MODEL T5) — not a counterparty free-text path. That bounds live
exploitability, but the codebase already decided this write-class must be validated; shipping a sibling
write that silently skips that control is a security-posture regression that belongs fixed on the branch,
not documented downstream. Security-first + a ~10-line fix = bounce.

**P2 — pending dir created without the `0o700` the analogous `buy/` dir gets.**
`pending_decisions.py:221` `_atomic_write` does `path.parent.mkdir(parents=True, exist_ok=True)` with no
`os.chmod(…, 0o700)`, unlike `watch.py:56-62`. Today it inherits protection from the `0700` `${KLODI_HOME}`
parent, so this is defense-in-depth — but pair it with the P1 fix (if traversal escapes the home, the
0700 parent no longer protects). Match `_ensure_buy_dir`.

**P3 — empty-env keystone fallthrough writes `pending/.json`.**
`message.py:199-207` keys the record off `os.environ.get(KLODI_WAKE_ENTITY_ID_ENV, "")`. The klodi toolset
is registered on *all* sessions (`__init__.py:76-79`), incl. the operator's normal session, where the
`KLODI_WAKE_*` env is absent → `entity_id=""` → a record at `pending/.json`. Delivery still succeeds so
INV-1 holds, but the correlation pointer is degenerate and collides across calls. Author flagged this
deliberately (handoff "Known smells"). Acceptable to ship, but either guard with a synthesized id or pin
"`klodi_message_user` is wake-only" in the tool description/SKILL so the agent never calls it bare.

**P3 — one open decision per entity; a second *different* question silently overwrites.**
`record_pending` (`pending_decisions.py:85-99`) keys one file per `entity_id` and only short-circuits on an
*identical* `question`; a different question for the same still-open entity overwrites the prior record.
The operator saw both messages (deliver-then-persist), so no escalation is lost — only the older correlation
pointer is dropped (the `## Open Questions` audit surface is the safety net). Worth a one-line WHY comment or
a distillation note, since it's a non-obvious consequence of the entity-keyed model.

**P3 — lexicographic timestamp ordering is schema-fragile.**
`message.py:315` `max(candidates, key=lambda s: str(s.get(_LAST_ACTIVE_FIELD, "")))` orders sessions by
string compare of `last_active_at`. Correct **only** if the probe-confirmed schema uses a fixed-width,
single-timezone ISO-8601 form. It's already probe-gated (the schema is an explicit assumption), so this is
acceptable — but when the real `active_sessions.json` schema lands, confirm the timestamp format (or parse to
a datetime) before trusting string order.

**P3 — delivery-failure log omits `exc_info`/error type.**
`message.py:182-186` logs the failure with the message + platform but no stack trace (`exc_info=True`) or
explicit error type. It matches the repo's existing `%`-style `event key=value` house pattern and the error
is fully surfaced to the agent in the envelope (not swallowed), so this is minor — add `exc_info=True` when
the real `_deliver` binding lands so a probe-time failure is debuggable.

**Not findings (verified clean):** types/strict (frozen dataclasses, no `any`); no back-compat shims
(`_inject_accepts_session`→`_supported_inject_kwargs` is a clean replacement, not a shim — old private name
imported nowhere); no hardcoded values (all keys/prefixes named); function caps (all new functions well under
100 lines / cx 8); deliver-then-persist + INV-1; atomic write; keystone determinism; tests are behavior-first
with no assertion weakening (226 pass). Probe-gated merge-blockers (`_deliver` binding, `active_sessions.json`
schema, fallback config, `klodi:` namespace) are correctly out of automated-tier scope and fail-safe — NOT
penalized, per the deferral contract.

### → Handoff back to In Dev (if FAIL/REVIEW)

Prioritized fix list for the dev pair (qa-developer adds the RED guard first; expert-developer GREENs):

1. **[P1 — blocker] Validate `entity_id` as a safe path component before it ever becomes a filename.**
   Add a `_validate_entity_id(entity_id: str) -> str` to `pending_decisions.py` mirroring
   `watch.py:68-78 _validate_slug` (non-empty, max-length, a `fullmatch` allow-list — entity ids are UUIDs or
   `[a-z0-9._-]` slugs / `wake-<uuid>`, so reuse a compatible pattern), and call it at the top of
   `record_pending` (and `resolve_pending`/`_record_path`). Reject `/`, `..`, and absolute paths. RED first:
   a test that `record_pending(entity_id="../../evil", …)` raises/refuses and writes **nothing** outside
   `${KLODI_HOME}/pending/`. Belt-and-suspenders: also validate in `wake_handlers.derive_wake_entity` so a
   malformed server id is rejected at the boundary, not just at the store.
2. **[P2] `chmod 0o700` the `pending/` dir** in `_atomic_write` (or a `_ensure_pending_dir` helper), matching
   `watch.py:56-62 _ensure_buy_dir`.
3. **[P3, optional this round] Guard the empty-env keystone** (`message.py:200-202`): if
   `KLODI_WAKE_ENTITY_ID` is absent, either refuse with a surfaced failure or synthesize a bounded id, and/or
   document `klodi_message_user` as wake-only in the tool description. Don't break the delivered-path persist.
4. **[P3, optional this round] One-line WHY comment** on the entity-keyed single-open-decision overwrite
   (`record_pending`), and `exc_info=True` on the `message.py:182` delivery-failure log.

P3 items (3, 4) and the schema/timestamp note are non-blocking — fold them in if cheap, otherwise leave them
recorded for the architect at distillation. Only item 1 (P1) and ideally item 2 (P2) gate the next review.
Tests are the spec: do not weaken any of the 226 assertions; add the new RED guard for item 1.

## Distillation — solutions-architect

<!-- Runs in the worktree on the card branch after Review PASS. Pushes to the same PR. Per the `distillation` skill: SEARCH docs/ INDEX files first; edit existing docs rather than creating duplicates. Captures land at smallest viable scope: inline WHY comments, docs/decisions/, docs/knowledge/, docs/product/, or CLAUDE.md. Then flips status to pr-ready. -->

## PR Ready

<!-- PR url; founder notification fires here -->

<!-- Abandoned section: appended by /board-close. Records date, reason, PR state at close, worktree teardown. Heading is "## Abandoned — founder". -->
