"""Spec — the bounded, atomic, ``event_id``-keyed wake-completion marker.

Card: ``distinguish-wake-sessions-from-operator-sessions``. hermes v0.17.0's
one-shot ``hermes chat -q … -Q`` create path silently drops ``--source`` and
persists the default ``source='cli'`` on the new ``sessions`` row, so a
completed wake session is byte-indistinguishable from a genuine operator CLI
session at the host store. This module is the klodi-owned replacement proof
that a wake turn *completed*: written ONLY on subprocess exit 0, keyed by the
wake's ``event_id``, atomic, and BOUNDED (a single rolling ring file — never
one file per wake, the unbounded-growth class the bridge inject-lock TODO
guards).

The klodi-stage AC1 DELIVERED gate (a lockstep card, sequenced after this)
reads this marker instead of ``sessions.source='klodi'``.

This is the STORE-PRIMITIVE spec (``klodi_hermes.wake_completions``). The
BRIDGE WIRING — that ``inject_message`` records a completion ONLY on exit 0,
never on a nonzero exit or a timeout — is pinned in ``test_bridge.py``.

The module is imported LAZILY (``_wc()``) so that, while it does not yet
exist (the RED window), each test fails individually with a clear
``ImportError`` rather than aborting collection of the whole adapter suite.
It is deliberately NOT ``pytest.importorskip`` — a missing module must make
these tests FAIL (RED), never SKIP.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))


def _wc() -> ModuleType:
    """Lazily import the marker module. Kept out of module scope so a
    not-yet-created ``wake_completions`` fails only the asserting test (with a
    clear ImportError = 'build this module'), never the whole suite's
    collection."""
    from klodi_hermes import wake_completions  # noqa: PLC0415 — deferred by design

    return wake_completions


@pytest.fixture(autouse=True)
def _isolated_klodi_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point ``${KLODI_HOME}`` at a throwaway dir so a marker write never
    touches the real user home."""
    home = tmp_path / "klodi"
    monkeypatch.setenv("KLODI_HOME", str(home))
    return home


def _read_store() -> list[dict[str, Any]]:
    """Read the marker store exactly as the klodi-stage gate will — the raw
    on-disk JSON list at the module's documented path."""
    path = _wc()._store_path()
    if not path.is_file():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def test_records_marker_keyed_by_event_id() -> None:
    """A completion marker is written keyed by ``event_id``, carrying the
    session + role correlation fields and a completed-at timestamp."""
    _wc().record_wake_completion(
        event_id="ev-abc-123", session="klodi:listing-7", role="system"
    )

    store = _read_store()
    assert [e["event_id"] for e in store] == ["ev-abc-123"]
    assert store[0]["session"] == "klodi:listing-7"
    assert store[0]["role"] == "system"
    assert store[0]["completed_at"], "marker must carry a completed-at timestamp"


def test_empty_event_id_writes_nothing() -> None:
    """The store is KEYED, not a raw turn counter: a wake with no ``event_id``
    cannot be correlated by the gate, so it writes no marker (and never
    touches the filesystem)."""
    _wc().record_wake_completion(event_id="", session="klodi:listing-7", role="system")
    assert not _wc()._store_path().exists()
    assert _read_store() == []


def test_idempotent_on_event_id_no_duplicate() -> None:
    """A redelivered wake (JetStream ``max_deliver``) rewrites the same
    ``event_id`` key — one entry, never a duplicate."""
    _wc().record_wake_completion(event_id="ev-1", session="klodi:a", role="system")
    _wc().record_wake_completion(event_id="ev-1", session="klodi:a", role="system")

    store = _read_store()
    assert [e["event_id"] for e in store] == ["ev-1"]


def test_store_is_bounded_ring(monkeypatch: pytest.MonkeyPatch) -> None:
    """The store is BOUNDED by construction — at most ``_MAX_COMPLETIONS``
    newest entries, oldest evicted. This is the load-bearing anti-regression
    guard: per-wake files would reintroduce the unbounded-growth class the
    bridge inject-lock TODO explicitly removed."""
    monkeypatch.setattr(_wc(), "_MAX_COMPLETIONS", 3)
    for i in range(6):
        _wc().record_wake_completion(event_id=f"ev-{i}", session="s", role="system")

    store = _read_store()
    assert len(store) == 3, "the ring must cap at _MAX_COMPLETIONS"
    # Newest three retained, oldest three evicted.
    assert [e["event_id"] for e in store] == ["ev-3", "ev-4", "ev-5"]


def test_tolerates_missing_and_torn_store() -> None:
    """A missing dir or a torn/corrupt store is tolerated — a fresh marker
    write rebuilds the store rather than raising."""
    # Missing store → first write creates it.
    _wc().record_wake_completion(event_id="ev-1", session="s", role="system")
    # Corrupt the store on disk, then write again.
    _wc()._store_path().write_text("{ not json", encoding="utf-8")
    _wc().record_wake_completion(event_id="ev-2", session="s", role="system")

    store = _read_store()
    assert [e["event_id"] for e in store] == ["ev-2"], (
        "a torn store is discarded, not appended to"
    )


def test_write_leaves_no_temp_file() -> None:
    """The write is atomic (write-temp + ``os.replace``): no ``.tmp`` sidecar
    is left behind for a concurrent reader (the gate) to glob."""
    _wc().record_wake_completion(event_id="ev-1", session="s", role="system")

    store_dir = _wc()._store_path().parent
    leftovers = list(store_dir.glob("*.tmp"))
    assert leftovers == [], f"atomic write left a temp file: {leftovers}"


def test_marker_write_failure_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A completed wake DID complete — a bookkeeping marker-write failure
    (disk full, permission) must not turn it into a raised failure. The store
    swallows the OSError with a WARNING instead."""

    def _boom(_entries: list[dict[str, Any]]) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(_wc(), "_atomic_write", _boom)
    # Must not raise.
    _wc().record_wake_completion(event_id="ev-1", session="s", role="system")
