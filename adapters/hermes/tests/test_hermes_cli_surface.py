"""AC-3 / AC-5 / AC-7 — validate the wake-inject argv against the REAL shipped
hermes CLI surface, never a stub literal that restates the author's assumption.

The crux (card fix-hermes-wake-inject-session-flag-argv, AC-3): the original
``test_bridge`` baked the broken flag into an exact-argv literal, so it could
only ever confirm the author's assumption — it asserted a flag (the rejected
session flag) that NO hermes version accepts, and the live subprocess exited 2
on every wake. Here we parse the recognized option tokens out of a checked-in,
version-stamped capture of the real ``hermes chat`` help and assert every flag
the bridge emits is one the real binary recognizes. A flag the shipped hermes
rejects (the defect) FAILS — permanently closing the door on it.

Fixture: ``fixtures/hermes_chat_help_v2026.6.19.txt`` — a real capture of the
``chat`` help from ``nousresearch/hermes-agent:v2026.6.19`` (Hermes v0.17.0).
Re-capture when the pinned image tag changes.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from klodi_hermes.bridge import BridgeCtx

# The corrected source tag the bridge must add (the card's fixed contract:
# argv == [hermes, "chat", "-q", text, "-Q", "--source", "klodi"]).
_EXPECTED_SOURCE = "klodi"

# The defective flag the fix removes. Assembled from fragments so this very
# test file leaves ZERO literal occurrences of the rejected flag — the AC-7
# grep gate (no hits for that flag across adapters/hermes/{src,tests}) would
# otherwise flag the very test that exists to forbid it.
_REJECTED_SESSION_FLAG = "--" + "session"

# Operator-session resume flags a wake must NEVER carry: resuming or polluting
# the human's own live session re-opens the self-addressing hazard (ADR-0019/
# 0020). A dedicated --source-tagged session is fine; an operator resume is not.
_OPERATOR_RESUME_FLAGS = (
    _REJECTED_SESSION_FLAG,
    "--continue",
    "-c",
    "--resume",
    "-r",
)

_FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "hermes_chat_help_v2026.6.19.txt"
)
_BRIDGE_SRC = Path(__file__).resolve().parents[1] / "src" / "klodi_hermes" / "bridge.py"
_TESTS_DIR = Path(__file__).resolve().parent

# A flag token: a single ``-x`` or a long ``--word`` (hyphens allowed inside).
_FLAG_RE = re.compile(r"(?<![\w-])(--?[A-Za-z][A-Za-z0-9-]*)")


def _recognized_options() -> set[str]:
    """The option tokens the REAL pinned hermes ``chat`` accepts, parsed from
    the captured help BODY only — ``#`` header lines are skipped so the
    explanatory header can never pollute the recognized set."""
    text = _FIXTURE.read_text(encoding="utf-8")
    body = "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )
    return set(_FLAG_RE.findall(body))


class _RecordingRunner:
    """Stub ``subprocess.run``; captures the spawned argv. No hermes binary
    is ever touched."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str], **_kwargs: Any) -> Any:
        self.calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout="", stderr="")


def _wake_inject_argv(text: str = "wake text") -> list[str]:
    """The argv the bridge spawns for one wake inject — driven through the
    REAL ``BridgeCtx`` with a stub runner. ``text`` is chosen to not start
    with ``-`` so a value never masquerades as a flag."""
    runner = _RecordingRunner()
    ctx = BridgeCtx(hermes_bin="/opt/hermes/.venv/bin/hermes", runner=runner)
    ctx.inject_message(text, role="system", session="klodi:listing-1")
    assert len(runner.calls) == 1
    return runner.calls[0]


def _emitted_flags(argv: list[str]) -> list[str]:
    """Flag-looking tokens (start with ``-``) the bridge emits in the argv."""
    return [tok for tok in argv if tok.startswith("-")]


# ── Fixture sanity: it really is the captured real surface ────────────


def test_fixture_is_the_real_captured_chat_surface() -> None:
    """Guard the fixture against silent rot: it must be a real ``hermes chat``
    help capture exposing ``--source``/``-Q``/``-q`` and — crucially — NOT the
    rejected session flag (its absence in the real surface is the whole bug)."""
    text = _FIXTURE.read_text(encoding="utf-8")
    assert "usage: hermes chat" in text, "fixture is not a hermes chat help capture"
    opts = _recognized_options()
    assert "--source" in opts
    assert "-Q" in opts and "-q" in opts
    assert _REJECTED_SESSION_FLAG not in opts, (
        "the real hermes chat surface must not define the defective flag"
    )


# ── AC-3: every emitted flag is recognized by the real hermes ─────────


def test_every_wake_inject_flag_is_recognized_by_real_hermes() -> None:
    """AC-3: each ``-``/``--`` token the bridge emits must be an option the
    REAL pinned hermes accepts. The defect (the rejected session flag) is not
    in the real surface, so this FAILS until the bridge drops it — no stub
    literal can ever wave a non-existent flag through review again."""
    recognized = _recognized_options()
    emitted = _emitted_flags(_wake_inject_argv())
    unrecognized = [flag for flag in emitted if flag not in recognized]
    assert unrecognized == [], (
        f"bridge emits flag(s) no shipped hermes accepts: {unrecognized}; "
        f"recognized options: {sorted(recognized)}"
    )


# ── AC-5: isolation — corrected flag, never an operator-session resume ─


def test_wake_inject_tags_source_and_never_resumes_operator_session() -> None:
    """AC-5: the wake turn is tagged ``--source klodi`` (so the outbound
    resolver can exclude it by source) and NO flag resumes or pollutes the
    operator's own live session."""
    argv = _wake_inject_argv()
    assert "--source" in argv, f"wake inject must tag --source: {argv}"
    assert argv[argv.index("--source") + 1] == _EXPECTED_SOURCE, (
        f"--source value must be {_EXPECTED_SOURCE!r}: {argv}"
    )
    for flag in _OPERATOR_RESUME_FLAGS:
        assert flag not in argv, (
            f"wake inject must never carry an operator-resume flag {flag!r}: {argv}"
        )


# ── AC-7: no rejected session-flag residue (bridge source + test files) ─


def test_bridge_source_carries_no_rejected_session_flag() -> None:
    """AC-7: the bridge must contain no rejected-session-flag literal (neither
    in the argv nor its docstrings). RED until the implementation fix lands."""
    src = _BRIDGE_SRC.read_text(encoding="utf-8")
    assert _REJECTED_SESSION_FLAG not in src, (
        "bridge.py still references the defective session flag"
    )


def test_hermes_test_files_carry_no_rejected_session_flag() -> None:
    """AC-7: no hermes test file may bake the rejected session flag back in
    either — a stub literal restating the broken assumption is the exact
    anti-pattern this card removes. Regression guard against re-introduction."""
    offenders = [
        path.name
        for path in sorted(_TESTS_DIR.rglob("*.py"))
        if _REJECTED_SESSION_FLAG in path.read_text(encoding="utf-8")
    ]
    assert offenders == [], (
        f"test files still carry the defective session flag: {offenders}"
    )
