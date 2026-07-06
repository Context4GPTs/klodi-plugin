---
id: 0023-relay-wake-terminal-disposition-contract
title: A relay wake turn carries a terminal-disposition contract in the wake text itself (the only surface unconditionally in-context) so the agent reaches a delivery disposition instead of ending on discarded prose; four plugin surfaces must stay coherent, and "warrants operator delivery vs purely informational" is a hand-curated classification
tags: [wake, escalation, message-user, terminal-disposition, contract, guidance, skill, over-ping, classification, prompt-injection, hermes, openclaw, parity]
commit: 62c6f09
updated_at: 2026-07-03
---

# ADR-0023 — The relay wake carries a terminal-disposition contract so the agent actually delivers

A relay wake turn ends by taking a marketplace/in-channel action or calling `klodi_message_user` — never by leaving a report as closing assistant prose, because that prose is **captured and discarded on exit 0** and reaches no one. The plugin makes this reliable by riding a two-sentence terminal-disposition contract on the **wake text itself** (the only surface guaranteed in-context every turn), gated by a hand-curated "warrants delivery vs purely informational" classification, and keeping four plugin-owned surfaces coherent so none re-arms the old self-censor.

## Status

Accepted (2026-07-03). Affects the hermes adapter's wake surface
(`adapters/hermes/src/klodi_hermes/wake_handlers.py`), the `klodi_message_user`
tool description (`message.py`), and the canonical skill bundle (`klodi-skill/`).

This is the **third leg of the wake round-trip**, distinct from its two siblings:

- **[[0019-wake-inject-failure-disposition]]** — *inbound*: how a failed wake-inject
  *into* the agent is disposed of.
- **[[0020-operator-escalation-delivery-binding]]** — *outbound delivery mechanism*:
  how `klodi_message_user` is physically bound to the host's sender + session store
  once the agent **calls** it (turn-less, live-operator-resolved, no default channel).
- **This ADR** — *agent egress*: ensuring the agent **reaches a delivery disposition
  (calls the tool) at all**, and which wakes warrant it. ADR-0020's mechanism was
  confirmed working (PR #37); the failure this ADR fixes is strictly upstream of it.

## Context

On prod `alice` (klodi-hermes 0.3.8), marketplace wakes ran a full, correct turn but
the operator was never notified and the relay stalled: the agent ended with plain
prose ("…What should I do?") and **never called `klodi_message_user`**. Two
compounding plugin-owned gaps, either of which alone leaves the report undeliverable:

1. **No terminal-delivery contract anywhere the agent sees.** A wake runs in an
   isolated single-turn session. `BridgeCtx.inject_message` runs `hermes chat -q … -Q`
   with `capture_output=True`; on the **exit-0** branch (`bridge.py:285-299`) it logs
   `len(text)` (the *input* length) and records a completion marker — `result.stdout`
   (the agent's turn output) is captured at `bridge.py:278` but consumed **only** on the
   nonzero branch, so on success it is **dropped**. Nothing the agent saw told it that
   ending a turn with prose — its normal-chat mental model — reaches no one here.
2. **The one operator-egress tool was gated as narrow escalation.** `klodi_message_user`'s
   description said *"Do NOT use for … purely informational updates"*, and the skill /
   seeded `negotiation_style` framed reaching out as reserved-decision-only. A
   first-contact `channel.opened` or an ambiguous inbound maps to none of the affirmative
   triggers, and "I'm stuck / need the human" reads as *not-clearly-reserved* → the agent
   self-censors the call.

Result: a correct relay turn that reaches a "needs the human" state has no
guidance-sanctioned egress, falls back to prose, and the prose is discarded.

## Decision

A coherent multi-lever **guidance/contract** fix. No `bridge.py` change — the delivery
mechanism already works (ADR-0020); the agent just has to *call* the tool.

- **The wake text is the load-bearing surface.** The terminal-disposition contract
  (`wake_handlers._TERMINAL_DISPOSITION_CONTRACT`, 2 sentences) is appended to the
  rendered wake, because the wake text is the **only** surface guaranteed in-context on
  *every* turn — the skill / §3a may never be loaded in a given turn (prod Wake A read
  only `skill_view` + `klodi_list_get`), and the tool description is surfaced to the model
  only once the tool is already a call candidate. It states the closing prose is *not
  delivered* and steers to a real disposition (marketplace/in-channel action, or
  `klodi_message_user`), never a bare question.
- **It rides as plugin framing OUTSIDE the untrusted JSON body**, after the closing
  ```` ``` ```` fence, and is **static text** (never payload-derived). A Wake-B-class
  prompt-injection in the counterparty `content` therefore cannot forge or suppress it
  (THREAT_MODEL / SKILL §8). It is kept to two sentences because it rides *every*
  warranting wake — a verbose contract dilutes the event and inflates token cost.
- **A hand-curated classification gates it** —
  `wake_handlers._DELIVERY_WARRANTING_NOTIFICATION_KINDS` (a frozenset) is the
  notification-consumer half; `channel.message` is *always* warranting (a live
  counterparty is on the wire) and is handled directly in `format_channel_wake`. A wake
  **warrants operator delivery** when the turn cannot reach a resolved terminal state on
  its own: a live counterparty left waiting, or a decision reserved for the human is open,
  or the agent declined/couldn't act (an unsafe/prompt-injection inbound included — "I did
  not reply" is itself a decision the operator must know). A wake is **purely
  informational** (no contract line, no ping) only when it is a status/lifecycle event
  with no counterparty waiting and no open decision. **Per-kind membership rationale lives
  in the constant's docstring — it is the source of truth, not this ADR**; an
  unmapped/future kind defaults to informational (the conservative direction).
- **Four surfaces must stay coherent** — the wake text (Lever B), the tool description
  (`message.py:_MESSAGE_USER_DESCRIPTION`, used for *both* `description=` and
  `schema["description"]`), SKILL §3a, and the seeded `negotiation_style.template.md
  ## Reaching Out`. If any one still says "not for informational" while another says
  "call the tool when stuck," the agent gets contradictory guidance and re-self-censors.
  Editing any one of these surfaces in future **requires re-checking the other three.**

## Alternatives considered

- **Route/salvage the discarded bridge stdout (`bridge.py` output path)** — rejected.
  Raw `hermes chat -Q` stdout is tool-narration/reasoning, not the self-contained message
  the operator contract requires; auto-forwarding it re-introduces the conversation
  pollution the isolated-wake design exists to prevent and bypasses the deliver-then-persist
  round-trip so the operator's reply never correlates via `klodi_pending_decisions`. The
  fix must make the agent *call the tool*, not salvage dropped prose.
- **Skill-only (SKILL §3a alone)** — rejected: §3a is a reference the agent may never load
  in a given turn, so it cannot be the load-bearing lever.
- **Tool-description-only** — rejected: the description reaches the model only once the tool
  is a call candidate; it never fires the "you must reach a disposition" prompt for an agent
  about to end on prose.
- **A default fallback channel** — rejected (founder / ADR-0020): a genuinely-absent
  operator surfaces a loud `no_operator_target`, never a silent default.
- **Deriving the warranting set** (e.g. by event family) — rejected: the split is a product
  judgement (`offer.proposed` warrants, `offer.accepted` doesn't) that a heuristic gets
  wrong; a hand-curated frozenset with a documented rationale is auditable.

## Consequences

- **Adding a new wake `kind` is now a classification decision.** Whoever adds it must place
  it in `_DELIVERY_WARRANTING_NOTIFICATION_KINDS` (warranting) or deliberately leave it out
  (informational), and add the reasoning to the docstring. The unit guard `U2` pins the
  informational bucket, `U1` pins the warranting bucket.
- **The discard-on-exit-0 behavior is now load-bearing and must not be "fixed."** The
  terminal-disposition contract compensates for it; if a future change routes `stdout` on
  exit 0 (the rejected salvage path), it re-introduces conversation pollution and breaks the
  pending-decision round-trip. An inline anchor at `bridge.py`'s exit-0 branch points here.
- **openclaw parity is now DIVERGENT — follow-up owed.**
  `adapters/openclaw/src/service/wake-handlers.ts` mirrors the hermes wake text by design
  (`wake_handlers.py:9-13` cites the parity) but does **not** yet carry the contract. The two
  hosts diverge until a parity change ships. The durable fix is likely to **hoist the contract
  and classification into the shared `klodi-skill/` bundle** so both hosts inherit one source
  rather than duplicating per-host formatter text — but that is a design call for the
  follow-up change, not decided here.
- **Behavioral ACs are non-deterministic.** Whether the LLM pings on a given wake is
  emergent; the deterministic regression net is the artefact-level unit tests (contract
  present on warranting kinds, absent on informational, tool description reframed) plus the
  integration test that the contract survives dispatch into the `hermes chat` argv. Treat
  klodi-stage e2e as behavioral confirmation, not the sole gate.
- **A specific operator's `SOUL.md` can still suppress the ping** — out of scope, the
  operator's documented choice. The fix works through plugin-owned surfaces only.

## References

- **Load-bearing lever (Lever B):** `wake_handlers.py` — `_TERMINAL_DISPOSITION_CONTRACT`,
  `_DELIVERY_WARRANTING_NOTIFICATION_KINDS` (per-kind rationale in the docstring),
  `format_notification_wake`, `format_channel_wake`.
- **Discard site (root cause):** `bridge.py` `inject_message` exit-0 branch (`:285-299`) —
  `result.stdout` captured then dropped on success.
- **Tool description (Lever C):** `message.py` — `_MESSAGE_USER_DESCRIPTION`.
- **Skill (Lever A):** `klodi-skill/SKILL.md` §3 disposition line + §3a;
  `klodi-skill/references/tool_inventory.md` (the `klodi_message_user` row).
- **Seeded default (Lever E):** `klodi-skill/templates/negotiation_style.template.md`
  `## Reaching Out`.
- **Outbound delivery mechanism (sibling):** [[0020-operator-escalation-delivery-binding]].
- **Inbound wake-inject disposition (sibling):** [[0019-wake-inject-failure-disposition]].
