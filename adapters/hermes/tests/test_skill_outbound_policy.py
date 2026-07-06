"""RED spec — Piece 5: persona policy carries the outbound round-trip.

The tool +
correlation store are useless if the persona never (a) reaches out at the
right moment and (b) scans for replies. Per devops [HIGH]: an operator's
free-text reply has no payload to trigger correlation — the agent only
correlates if the SKILL policy tells it to scan the pending store on every
operator turn. Without that instruction the reply is silently never
correlated (the outbound twin of the inbound silent-loss this epic exists to
kill). So the policy content is load-bearing, not polish — and it is a
required unit-tier check (the architect tagged AC-6/AC-12 as unit skill
content + persona; the unit half is pinned here).

The assertions target the CANONICAL skill source ``klodi-skill/`` at the repo
root — the tracked source of truth that the hermes adapter bundles at build
time (the adapter-local ``skills/klodi/`` copy is gitignored). Piece 5's edits
must land here to be committed.

Covers the automatable (content) half of:
  * AC-6 / BR-1  — reach out only when policy reserves the decision for the
                   human; the playbook + the negotiation template name
                   ``klodi_message_user`` and a ``## Reaching Out`` preference.
  * AC-12        — the agent scans open pending-decisions on every operator
                   turn (``klodi_pending_decisions``) so a reply is correlated.
  * BR-7         — the outbound message must be self-contained (names the
                   listing / counterparty / question / options).
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SKILL_MD = _REPO_ROOT / "klodi-skill" / "SKILL.md"
_NEGOTIATION_TEMPLATE = (
    _REPO_ROOT / "klodi-skill" / "templates" / "negotiation_style.template.md"
)


@pytest.fixture()
def skill_md() -> str:
    assert _SKILL_MD.is_file(), f"canonical SKILL.md missing at {_SKILL_MD}"
    return _SKILL_MD.read_text(encoding="utf-8")


@pytest.fixture()
def negotiation_template() -> str:
    assert _NEGOTIATION_TEMPLATE.is_file(), (
        f"negotiation_style template missing at {_NEGOTIATION_TEMPLATE}"
    )
    return _NEGOTIATION_TEMPLATE.read_text(encoding="utf-8")


# ── AC-6 / BR-1: reach out only when policy reserves the decision ─────


def test_skill_documents_the_message_user_tool(skill_md: str) -> None:
    """AC-6/BR-1: the playbook must name ``klodi_message_user`` as the way to
    actively reach the operator when a decision is reserved for the human —
    otherwise the agent never calls it and escalations stall."""
    assert "klodi_message_user" in skill_md, (
        "SKILL.md must document klodi_message_user (the reach-out tool)"
    )


def test_negotiation_template_adds_reaching_out_preference(
    negotiation_template: str,
) -> None:
    """AC-6/BR-1: the negotiation-style template gains a ``## Reaching Out``
    preference block referencing ``klodi_message_user`` — the operator-tunable
    threshold for when the agent actively pings vs. handles autonomously."""
    assert "## Reaching Out" in negotiation_template, (
        "negotiation_style template must add a '## Reaching Out' block"
    )
    assert "klodi_message_user" in negotiation_template, (
        "the Reaching Out block must reference klodi_message_user"
    )


def test_skill_gates_reach_out_on_the_human_decision_policy(skill_md: str) -> None:
    """AC-6/BR-1: reach-out is policy-gated — the playbook ties calling the
    tool to a decision reserved for the human (``Always Ask Me First`` /
    escalation), not to every wake. Pin the gating link, not exact prose."""
    lowered = skill_md.lower()
    assert "always ask me first" in lowered or "escalation" in lowered
    assert "reach out" in lowered or "reaching out" in lowered


# ── AC-12: scan open pending-decisions on every operator turn ─────────


def test_skill_directs_scanning_pending_decisions_on_operator_turns(
    skill_md: str,
) -> None:
    """AC-12 (devops [HIGH]): the playbook must direct the agent to scan open
    pending-decisions on every operator turn (via ``klodi_pending_decisions``)
    so a free-text reply is correlated back to its decision. Without this the
    reply is silently never correlated."""
    assert "klodi_pending_decisions" in skill_md, (
        "SKILL.md must instruct scanning klodi_pending_decisions on operator turns"
    )


# ── BR-7: the outbound message must be self-contained ─────────────────


def test_skill_requires_self_contained_outbound_message(skill_md: str) -> None:
    """BR-7: the operator reads the ping in their normal chat, possibly hours
    later, with zero isolated-session context — so the message must be
    self-contained (name what / who / what's asked / the options). Pin that
    the playbook states this requirement."""
    assert "self-contained" in skill_md.lower(), (
        "SKILL.md must require the klodi_message_user message to be self-contained"
        " (names the listing/counterparty/question/options) per BR-7"
    )
