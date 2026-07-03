"""RED net — the terminal-delivery contract on the wake surface.

Card: ``relay-wake-turn-never-delivers-to-operator``. A relay wake runs a
full agent turn, the agent ends with plain assistant prose (".. What should
I do?") and never calls ``klodi_message_user``; the bridge captures that
final text and discards it on exit 0, so the operator is never reached.

The fix is a guidance/contract change across four plugin-owned surfaces.
This file is the DETERMINISTIC (non-LLM) regression net that asserts the
changed *artefacts* — not emergent agent behaviour. The behavioural ACs
(AC1-AC4) are the expert-developer's klodi-stage e2e job; the negative
"does NOT ping" half of AC3/AC4 is only made checkable here by U2.

Assertions target the SEMANTIC contract, not exact prose (a real
regression must fail, but a re-worded-but-correct fix must pass) — the
same "pin the contract, not the wording" style as
``test_skill_outbound_policy.py``.

Coverage (from the card's "Architect-added — deterministic net"):
  * U1 — ``format_channel_wake`` / ``format_notification_wake`` on a
          delivery-warranting wake (``channel.opened`` / ``channel.message``)
          carry an explicit terminal-disposition instruction: end in a
          marketplace/in-channel action or a ``klodi_message_user`` delivery,
          and closing plain assistant text is NOT delivered to anyone. This
          also encodes AC6's core invariant deterministically (a report for
          the human reaches a delivery-bearing path, never terminal prose).
  * U2 — a purely-informational status/lifecycle wake (``listing.created`` /
          ``listing.status_changed`` / ...) carries NO "reach the operator"
          directive and does NOT arm the ping tool. STANDING GUARD (green
          today) — it fails only if a fix arms every wake to ping; the
          deterministic half of the AC3/AC4 over-ping risk.
  * U3 — the ``klodi_message_user`` registration authorizes the "wake needs
          the operator's decision/input and cannot be resolved autonomously"
          case and drops the absolute "not for purely informational updates"
          exclusion, while still steering policy-authorized decisions and
          purely-FYI wakes away from a ping.
  * I1 — a ``channel.message`` wake dispatched through the full path
          (``handle_channel_message`` -> ``_inject`` -> ``BridgeCtx.
          inject_message`` with a stub runner) carries the contract into the
          captured inject subprocess argv — it survives the seam and reaches
          the wake turn in production.
  * AC5 (deterministic half) — a genuinely-absent operator surfaces a LOUD
          ``no_operator_target`` (logged at ERROR), never a silent drop. The
          "never self-addressed" half is already pinned by
          ``test_message.py::test_resolver_never_self_addresses_*``.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from klodi_hermes import message, wake_handlers
from klodi_hermes.bridge import BridgeCtx
from klodi_hermes.message import (
    handle_message_user,
    register_message_tools,
)

_GOLDEN_DIR = (
    Path(__file__).resolve().parents[3]
    / "packages" / "tool-catalog" / "tests" / "golden"
)


def _golden(kind: str) -> dict[str, Any]:
    """Load the canonical wire shape for a wake ``kind`` from the catalog
    golden fixtures so the event fields never drift from the contract."""
    return json.loads((_GOLDEN_DIR / f"{kind}.json").read_text())


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    """Wake handlers stash the bound ctx in a module-global. Restore the
    pre-test value so cases don't leak into each other."""
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


# ── Contract-shape helpers (semantic, not exact-prose) ────────────────


def _framing_outside_json(text: str) -> str:
    """The plugin-authored framing — the wake text with the untrusted
    ```json ... ``` event body stripped out.

    The terminal-disposition instruction MUST live here (plugin framing),
    never inside the JSON a counterparty controls: the card's risk section
    requires the instruction stay "plugin-authored framing wrapping the
    untrusted payload ... placed outside the untrusted JSON body" so a
    prompt-injection (the Wake-B class) can't forge or suppress it.
    """
    fence = "```json"
    if fence not in text:
        return text
    before, _, rest = text.partition(fence)
    _, _, after = rest.partition("```")  # everything after the closing fence
    return before + after


def _names_delivery_tool(framing: str) -> bool:
    """The delivery-bearing egress is named as the way to reach the operator."""
    return "klodi_message_user" in framing


# The closing prose is NOT an egress — the inverse of the prod defect. Any of
# these renderings satisfies the semantic; the fix picks the wording.
_CLOSING_NOT_DELIVERED_FRAGMENTS = (
    "not delivered",
    "isn't delivered",
    "is not delivered",
    "not be delivered",
    "won't be delivered",
    "will not be delivered",
    "discarded",
    "reaches no one",
    "reach no one",
    "goes to no one",
    "no one sees",
    "not seen",
)


def _states_closing_text_undelivered(framing: str) -> bool:
    low = framing.lower()
    return any(frag in low for frag in _CLOSING_NOT_DELIVERED_FRAGMENTS)


# A directive that steers the agent to actively reach/ping the operator. An
# informational wake must carry NONE of these (U2, the over-ping guard).
_REACH_OPERATOR_DIRECTIVE_FRAGMENTS = (
    "reach the operator",
    "reach your operator",
    "reach out to the operator",
    "message the operator",
    "ping the operator",
    "notify the operator",
    "alert the operator",
)


# ── U1 + AC6 core invariant: delivery-warranting wakes carry the contract ─


def _render(kind: str) -> str:
    """Render a wake through the SAME formatter its handler uses:
    ``channel.message`` -> ``format_channel_wake``; everything else ->
    ``format_notification_wake``."""
    event = _golden(kind)
    if kind == "channel.message":
        return wake_handlers.format_channel_wake(event)
    return wake_handlers.format_notification_wake(event)


@pytest.mark.parametrize("kind", ["channel.opened", "channel.message"])
def test_delivery_warranting_wake_carries_terminal_disposition_contract(
    kind: str,
) -> None:
    """U1 (+ AC6 core invariant): a delivery-warranting wake's rendered text
    carries an explicit terminal-disposition instruction — end in a
    marketplace/in-channel action or a ``klodi_message_user`` delivery, AND
    it states that closing plain assistant text is NOT delivered to anyone
    (the direct inverse of the prod defect). The instruction must live in the
    plugin framing, OUTSIDE the untrusted JSON body (anti-injection)."""
    framing = _framing_outside_json(_render(kind))

    assert _names_delivery_tool(framing), (
        f"{kind}: the wake must name klodi_message_user as the delivery-bearing"
        " egress in the plugin framing (outside the JSON body) — otherwise a"
        " correct relay turn has no sanctioned path to reach the operator"
    )
    assert _states_closing_text_undelivered(framing), (
        f"{kind}: the wake contract must state that the turn's closing plain"
        " assistant text is NOT delivered (discarded on exit 0) — the core"
        " invariant / inverse of the prod defect (AC6). The agent ended on a"
        " bare question precisely because nothing told it the prose reaches"
        " no one"
    )


# ── U2: informational status wakes must NOT arm a ping (over-ping guard) ─

# The unambiguous status/lifecycle bucket — no counterparty waiting, no
# pending decision. These must NEVER carry a reach-the-operator directive
# (the deterministic guard behind AC3/AC4's non-deterministic negative).
_INFORMATIONAL_KINDS = [
    "listing.created",
    "listing.relisted",
    "listing.status_changed",
    "listing.sold",
    "listing.withdrawn",
    "listing.expired",
]


@pytest.mark.parametrize("kind", _INFORMATIONAL_KINDS)
def test_informational_status_wake_carries_no_reach_operator_directive(
    kind: str,
) -> None:
    """U2 (STANDING GUARD — behind AC3/AC4 over-ping risk): a purely-
    informational status/lifecycle wake must NOT arm the ping tool and must
    carry NO "reach the operator" directive. ``format_notification_wake``
    also renders ``channel.opened`` (which DOES warrant the contract per U1),
    so a naive fix that appends the instruction unconditionally arms every
    wake to ping — this guard fails exactly then, forcing the fix to
    differentiate delivery-warranting kinds from informational ones."""
    framing = _framing_outside_json(wake_handlers.format_notification_wake(_golden(kind)))
    low = framing.lower()

    assert "klodi_message_user" not in framing, (
        f"informational {kind} wake must NOT name klodi_message_user — arming"
        " the ping tool on lifecycle status events degrades the high-signal"
        " operator channel (the primary over-ping regression, AC3/AC4)"
    )
    assert not any(frag in low for frag in _REACH_OPERATOR_DIRECTIVE_FRAGMENTS), (
        f"informational {kind} wake must carry no reach-the-operator directive"
        " — it maps to the Informational (default: off) tier, not Decisions"
    )


# ── U3: klodi_message_user description authorizes the "stuck" case ────────

# Authorizes reaching out when the turn cannot resolve autonomously / needs
# the human. NONE of these appears in the current escalation-only framing, so
# their absence is the RED signal. The fix picks the wording.
_AUTHORIZES_STUCK_FRAGMENTS = (
    "cannot resolve",
    "can't resolve",
    "cannot be resolved",
    "cannot handle",
    "can't handle",
    "cannot decide",
    "can't decide",
    "cannot proceed",
    "can't proceed",
    "cannot act",
    "can't act",
    "resolve on your own",
    "resolve autonomously",  # in the negative "cannot resolve autonomously"
    "needs the operator",
    "need the operator",
    "needs the human",
    "need the human",
    "needs a human",
    "needs your decision",
    "needs your input",
    "unresolved",
    "stuck",
    "uncertain",
)

# The keep-steering guard: policy-authorized decisions stay the agent's to
# handle (must not be lost when the exclusion is relaxed).
_HANDLE_YOURSELF_FRAGMENTS = (
    "handle alone",
    "handle yourself",
    "handle it yourself",
    "authorizes you to handle",
    "authorize you to handle",
    "handle autonomously",
    "resolve yourself",
)


def _assert_description_contract(desc: str, *, where: str) -> None:
    low = desc.lower()
    # (1) authorizes the "cannot resolve autonomously / needs the human" case.
    assert any(frag in low for frag in _AUTHORIZES_STUCK_FRAGMENTS), (
        f"{where}: klodi_message_user must AUTHORIZE reaching the operator when"
        " the wake needs the human's decision/input and cannot be resolved"
        " autonomously — the escalation-only framing is why the agent"
        " self-censored the call"
    )
    # (2) drops the absolute "not for purely informational updates" exclusion.
    assert "informational updates" not in low, (
        f"{where}: the absolute 'not for purely informational updates'"
        " exclusion must be gone — it wrongly reads first-contact / a"
        " needs-the-human wake as informational and suppresses the call"
    )
    # (3) still steers policy-authorized decisions away from a ping.
    assert any(frag in low for frag in _HANDLE_YOURSELF_FRAGMENTS), (
        f"{where}: relaxing the exclusion must NOT drop the 'handle"
        " policy-authorized decisions yourself' steer — that guards against"
        " over-escalating what the agent is allowed to decide alone"
    )


def test_message_user_module_description_authorizes_stuck_and_drops_absolute_exclusion() -> None:
    """U3 (Lever C, source constant): the module-level description that seeds
    both the tool description and the schema description must satisfy the
    reframed contract."""
    _assert_description_contract(message._MESSAGE_USER_DESCRIPTION, where="_MESSAGE_USER_DESCRIPTION")


def test_message_user_registration_carries_reframed_description_in_schema() -> None:
    """U3 (Lever C, registration surface): registering the tool must thread
    the reframed contract into BOTH the top-level description and the schema
    description the model actually reads at call time."""

    class _RecordingToolCtx:
        def __init__(self) -> None:
            self.tools: list[dict[str, Any]] = []

        def register_tool(self, **kwargs: Any) -> None:
            self.tools.append(kwargs)

    ctx = _RecordingToolCtx()
    count = register_message_tools(ctx)

    assert count == 1 and len(ctx.tools) == 1, "exactly one tool registered"
    tool = ctx.tools[0]
    assert tool["name"] == "klodi_message_user"
    _assert_description_contract(tool["description"], where="registration description")
    _assert_description_contract(tool["schema"]["description"], where="schema.description")


# ── I1: the contract survives dispatch into the inject subprocess argv ────


class _RecordingRunner:
    """Stub ``subprocess.run``: captures the spawned argv (and kwargs) and
    returns a clean exit-0 result. No real ``hermes`` binary is touched."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> Any:
        self.calls.append({"cmd": cmd, **kwargs})
        return SimpleNamespace(returncode=0, stdout="", stderr="")


@pytest.mark.asyncio
async def test_channel_message_dispatch_carries_contract_into_inject_argv() -> None:
    """I1: a ``channel.message`` wake driven through the real handler ->
    real ``BridgeCtx`` -> stub runner must land the terminal-disposition
    contract in the captured ``hermes chat -q <text>`` argv — proving the
    contract survives the ``wake_handlers`` <-> ``bridge`` seam and reaches
    the wake turn in production, not just the pure formatter."""
    runner = _RecordingRunner()
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    wake_handlers.bind_ctx(ctx)

    await wake_handlers.handle_channel_message(_golden("channel.message"))

    assert len(runner.calls) == 1, f"expected exactly one inject, got {runner.calls}"
    cmd = runner.calls[0]["cmd"]
    # argv shape: [hermes, chat, -q, <text>, -Q, --source, klodi]
    assert cmd[:3] == ["/usr/bin/hermes", "chat", "-q"], f"unexpected argv head: {cmd}"
    injected_text = cmd[3]
    framing = _framing_outside_json(injected_text)

    assert _names_delivery_tool(framing), (
        "the inject argv must carry the delivery-bearing egress"
        " (klodi_message_user) into the wake turn — the contract was dropped"
        " somewhere on the handler -> bridge path"
    )
    assert _states_closing_text_undelivered(framing), (
        "the inject argv must carry the 'closing prose is not delivered'"
        " contract into the wake turn (AC6 core invariant survives dispatch)"
    )


# ── AC5 (deterministic half): a genuinely-absent operator is LOUD ─────────


def test_no_operator_target_is_surfaced_loudly_never_silent(
    monkeypatch: pytest.MonkeyPatch, caplog: Any,
) -> None:
    """AC5 (deterministic half): when no operator session resolves, a
    ``klodi_message_user`` call from the wake turn must surface a LOUD,
    correlated ``no_operator_target`` — a structured error envelope AND an
    ERROR log — never a silent drop. (The "never self-addressed" half is
    pinned in test_message.py's resolver tests.)

    This is a STANDING GUARD: the loud path exists today; it must not regress
    to a swallow when the egress is broadened by this card's fix."""
    monkeypatch.setattr(message, "resolve_operator_target", lambda: None)

    with caplog.at_level("ERROR", logger="klodi_hermes.message"):
        out = handle_message_user({"text": "Buyer @bob is waiting — accept, counter, or pass?"})

    obj = json.loads(out)
    assert obj.get("error") == "no_operator_target", f"must surface no-target: {out}"
    assert any(
        r.levelname == "ERROR" and "no_target" in r.message
        for r in caplog.records
    ), "an absent operator must be LOUD (ERROR log), never a silent drop"
