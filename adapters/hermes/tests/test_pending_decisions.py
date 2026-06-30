"""RED spec — the durable pending-decision store (Piece 4 substrate).

This is the correlation source of truth for the outbound wake round-trip
(card ``wake-outbound-roundtrip-message-and-correlation``). When the agent
escalates a marketplace decision to the operator via ``klodi_message_user``,
klodi persists a **pending-decision** keyed to the marketplace entity. The
operator's later reply (in a *different* session) is correlated back to the
right action by reading these records — never by trusting the fragile
continuity of the isolated wake session.

These tests pin the store contract BEFORE the implementation exists
(``klodi_hermes.pending_decisions``). They are the specification; the
implementation serves them.

The store is the pure, host-dependency-free layer: it reads/writes under
``${KLODI_HOME}/pending/`` (the ONLY boundary mocked here — a tmp
``KLODI_HOME``), keyed by ``entity_id``. No NATS, no hermes host.

Schema (architect handoff, In-Dev TDD step 1) — the persisted record is a
typed POINTER, never a marketplace-state snapshot::

    {entity_type, entity_id, event_id, question, asked_at, platform,
     chat_id, status}

Covers:
  * AC-7   — record_pending persists the entity-keyed record; it survives.
  * AC-10  — kernel: the record is a POINTER (entity_type/entity_id/
             question), NOT a snapshot — so the reply turn MUST re-ground
             live state (BR-5) rather than act on cached marketplace data.
  * AC-11  — resolve-exactly-once + idempotent record (no duplicate on a
             redelivered same-entity+question trigger) (BR-6).
  * P1     — path-traversal guard (review round 1, code-quality-guardian):
             entity_id flows UNVALIDATED from marketplace event data into an
             on-disk path. A traversal / absolute / empty id must be REFUSED
             before it becomes a filename, and nothing may be written outside
             ${KLODI_HOME}/pending/ — mirrors watch.py::_validate_slug.
  * P2     — the pending/ dir is created 0o700 like watch.py's buy/ dir
             (_ensure_buy_dir) — defense in depth.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

import pytest

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from klodi_hermes.pending_decisions import (  # noqa: E402 — after sys.path bootstrap
    open_pending,
    record_pending,
    resolve_pending,
)

# The exact pointer schema the persisted record is allowed to carry. The
# AC-10 kernel is that this is a POINTER, so any field that would let the
# agent skip re-grounding (a cached marketplace snapshot) is forbidden.
_ALLOWED_KEYS = frozenset({
    "entity_type",
    "entity_id",
    "event_id",
    "question",
    "asked_at",
    "platform",
    "chat_id",
    "status",
})

# Fields that would smuggle a marketplace-state SNAPSHOT into the record —
# their presence would defeat BR-5 (re-ground before acting). The store
# must never persist any of these.
_FORBIDDEN_SNAPSHOT_KEYS = frozenset({
    "amount",
    "price",
    "asking_price",
    "offer_id",
    "listing_summary",
    "content",
    "terms",
    "current_status",
    "counterparty_last_message",
})

_LISTING_ID = "11111111-1111-4111-8111-111111111111"
_EVENT_ID = "a1b2c3d4-0007-4000-8000-000000000007"


def _record(
    *,
    entity_id: str = _LISTING_ID,
    entity_type: str = "listing",
    event_id: str = _EVENT_ID,
    question: str = "Buyer @bob offered 4000c on the keyboard. Accept, counter, or pass?",
    asked_at: str = "2026-06-29T12:00:00Z",
    platform: str = "telegram",
    chat_id: str = "999",
) -> Any:
    return record_pending(
        entity_type=entity_type,
        entity_id=entity_id,
        event_id=event_id,
        question=question,
        asked_at=asked_at,
        platform=platform,
        chat_id=chat_id,
    )


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every test gets a throwaway ``${KLODI_HOME}`` so the store never
    touches the real home. ``default_klodi_home`` honours ``KLODI_HOME``
    first, so setting the env is the whole isolation."""
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    return tmp_path


def _pending_file(home: Path, entity_id: str) -> Path:
    return home / "pending" / f"{entity_id}.json"


# ── AC-7: record persists, keyed by entity_id, and survives ───────────


def test_record_pending_persists_open_record(_isolated_home: Path) -> None:
    """AC-7: a recorded decision lands as an open record keyed by entity_id
    and is readable back (survives the turn that wrote it)."""
    _record()

    open_now = open_pending()
    assert len(open_now) == 1, "exactly one open decision expected after one record"
    rec = open_now[0]
    assert rec.entity_id == _LISTING_ID
    assert rec.entity_type == "listing"
    assert rec.status == "open"
    assert rec.platform == "telegram"
    assert rec.chat_id == "999"


def test_record_pending_writes_entity_keyed_file_with_full_schema(
    _isolated_home: Path,
) -> None:
    """AC-7: the on-disk record is keyed by entity_id and carries the full
    pointer schema with ``status=open``. Asserting the file directly pins
    the durable, cross-process wire shape the reply process reads."""
    _record()

    path = _pending_file(_isolated_home, _LISTING_ID)
    assert path.is_file(), f"record must persist at {path}"
    on_disk = json.loads(path.read_text(encoding="utf-8"))

    assert set(on_disk) == _ALLOWED_KEYS, (
        "persisted record must carry exactly the pointer schema, got "
        f"{sorted(on_disk)}"
    )
    assert on_disk["entity_id"] == _LISTING_ID
    assert on_disk["entity_type"] == "listing"
    assert on_disk["event_id"] == _EVENT_ID
    assert on_disk["asked_at"] == "2026-06-29T12:00:00Z"
    assert on_disk["status"] == "open"
    assert on_disk["question"]  # non-empty


# ── AC-10 kernel: the record is a POINTER, never a marketplace snapshot ─


def test_record_is_a_pointer_not_a_marketplace_snapshot(_isolated_home: Path) -> None:
    """AC-10 kernel (BR-5): the store persists a POINTER
    (entity_type/entity_id/question), NOT a cached snapshot of marketplace
    state. If the offer amount / listing price / channel content leaked into
    the record, the reply turn could act on stale data instead of
    re-grounding. The kernel guard: no snapshot field is ever persisted."""
    _record()

    on_disk = json.loads(_pending_file(_isolated_home, _LISTING_ID).read_text())
    leaked = _FORBIDDEN_SNAPSHOT_KEYS & set(on_disk)
    assert not leaked, (
        f"pending record leaked marketplace-snapshot fields {sorted(leaked)} —"
        " it must stay a pointer so the reply turn re-grounds live state (BR-5)"
    )


# ── AC-11: resolve exactly once; record is idempotent (BR-6) ──────────


def test_resolve_pending_closes_exactly_once(_isolated_home: Path) -> None:
    """AC-11/BR-6: the first resolve closes the decision (returns truthy);
    a second resolve is an idempotent no-op (returns falsy). A later
    unrelated 'yes' must never re-fire an already-closed decision."""
    _record()
    assert open_pending(), "precondition: one open decision"

    first = resolve_pending(_LISTING_ID)
    assert first, "first resolve must report it closed a decision"
    assert open_pending() == [], "resolved decision must drop out of open set"

    second = resolve_pending(_LISTING_ID)
    assert not second, "second resolve must be an idempotent no-op (already closed)"


def test_resolve_unknown_entity_is_a_safe_noop(_isolated_home: Path) -> None:
    """AC-11 adversarial: resolving an entity that has no open decision must
    not raise and must report nothing was closed."""
    assert not resolve_pending("no-such-entity-id")


def test_resolved_decision_stays_closed_when_other_entities_recorded(
    _isolated_home: Path,
) -> None:
    """AC-11/BR-6: closing is terminal. Recording an UNRELATED entity's
    decision afterwards must not resurrect the closed one."""
    _record()
    resolve_pending(_LISTING_ID)

    other = "22222222-2222-4222-8222-222222222222"
    _record(entity_id=other, entity_type="channel")

    open_ids = {rec.entity_id for rec in open_pending()}
    assert open_ids == {other}, (
        "only the new unrelated decision is open; the resolved one stays closed"
    )


def test_duplicate_trigger_same_entity_and_question_does_not_duplicate(
    _isolated_home: Path,
) -> None:
    """AC-11/BR-6: a redelivered/duplicate outbound trigger for the SAME
    entity + question creates no duplicate record (idempotent outreach —
    mirrors the inbound event_id/LRU dedup discipline)."""
    _record()
    _record()  # identical entity_id + question — a redelivery

    open_now = open_pending()
    assert len(open_now) == 1, (
        f"duplicate same-entity+question trigger must not fan out: {open_now}"
    )

    # And it must be ONE file on disk, not two.
    pending_dir = _isolated_home / "pending"
    files = sorted(p.name for p in pending_dir.glob("*.json"))
    assert files == [f"{_LISTING_ID}.json"], f"expected one record file, got {files}"


# ── open_pending tolerance: missing dir / malformed file never raise ──


def test_open_pending_tolerates_missing_pending_dir(_isolated_home: Path) -> None:
    """A fresh install has no pending/ dir yet. Listing must return [] and
    never raise — the reply turn scans this on EVERY operator turn (AC-12),
    so it has to be cheap and crash-free."""
    assert open_pending() == []


def test_open_pending_skips_malformed_record_without_raising(
    _isolated_home: Path,
) -> None:
    """A corrupt/half-written record must not crash the scan: skip it,
    surface the valid ones. Cross-process writers make a torn read possible
    (the writer is a different OS process than this reader)."""
    _record()
    pending_dir = _isolated_home / "pending"
    (pending_dir / "garbage.json").write_text("{not valid json", encoding="utf-8")

    open_now = open_pending()
    assert {rec.entity_id for rec in open_now} == {_LISTING_ID}


# ── P1: unsafe entity_id is REFUSED before it becomes a filename ───────
#
# code-quality-guardian review round 1 (P1, blocker): ``entity_id`` flows
# UNVALIDATED from marketplace event data
# (``wake_handlers.derive_wake_entity`` → ``KLODI_WAKE_ENTITY_ID`` env →
# ``record_pending``) into ``${KLODI_HOME}/pending/<entity_id>.json``. The
# repo already defends the analogous write (``watch.py::_validate_slug`` +
# ``_ensure_buy_dir``); the pending store must apply the same guard. These
# tests pin the OUTCOME (refused + nothing escapes the home), not the name
# of any private helper.

# Components that must be refused: ``/`` separators, ``..`` parent refs, a
# leading dot, and bare ``.``/``..`` — every shape ``_validate_slug``'s
# ``^[a-z0-9][a-z0-9._-]*$`` allow-list rejects.
_UNSAFE_IDS = [
    "../../evil",
    "../escape",
    "a/b",
    "foo/../bar",
    "..",
    ".",
    ".hidden",
]

# The real id shapes the round-trip uses — these MUST keep working so the
# P1 fix can't over-reject and strand a legitimate escalation.
_LEGITIMATE_IDS = [
    "11111111-1111-4111-8111-111111111111",        # marketplace UUID
    "vintage-camera",                               # search_slug
    "wake-a1b2c3d4-0007-4000-8000-000000000007",    # ephemeral fallback
    "listing_42.v2",                                # [a-z0-9._-] slug
]


@pytest.fixture
def _nested_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A ``${KLODI_HOME}`` nested under ``tmp_path`` so a ``..`` traversal
    escapes the home but stays *inside* ``tmp_path`` — checkable, and never
    pollutes the real filesystem. Overrides the autouse isolated home."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("KLODI_HOME", str(home))
    return home


@pytest.mark.parametrize("bad_id", _UNSAFE_IDS)
def test_record_pending_rejects_unsafe_entity_id(
    _nested_home: Path, tmp_path: Path, bad_id: str
) -> None:
    """P1: an unsafe path component is refused (raises ValueError, the same
    disposition watch.py::_validate_slug uses) and NO file is written
    anywhere — not inside pending/, not outside it."""
    with pytest.raises(ValueError):
        _record(entity_id=bad_id)
    assert list(tmp_path.rglob("*.json")) == [], (
        f"unsafe id {bad_id!r} produced an on-disk file"
    )


def test_record_pending_traversal_writes_nothing_outside_home(
    _nested_home: Path, tmp_path: Path
) -> None:
    """P1 (the core invariant): a ``../..`` id must not let _atomic_write
    create dirs / write a record OUTSIDE ${KLODI_HOME}/pending/ — outside the
    0700 protection of the home. ``home/pending/../../evil.json`` resolves to
    ``tmp_path/evil.json`` (one level above the home)."""
    escape_target = tmp_path / "evil.json"
    with pytest.raises(ValueError):
        _record(entity_id="../../evil")
    assert not escape_target.exists(), (
        "record escaped ${KLODI_HOME} via .. traversal"
    )
    pending = _nested_home / "pending"
    outside = [p for p in tmp_path.rglob("*.json") if pending not in p.parents]
    assert outside == [], f"wrote files outside pending/: {outside}"


def test_record_pending_rejects_absolute_entity_id(
    _nested_home: Path, tmp_path: Path
) -> None:
    """P1: an ABSOLUTE id is the sharpest escape — ``Path(pending) / '/x'``
    discards the pending prefix entirely (pathlib join resets on an absolute
    right-hand side). It must be refused, and the absolute target must not be
    written. (Target kept inside tmp_path so the test never touches /.)"""
    abs_id = str(tmp_path / "abs_escape")
    with pytest.raises(ValueError):
        _record(entity_id=abs_id)
    assert not (tmp_path / "abs_escape.json").exists(), (
        "absolute id escaped the pending store"
    )


def test_record_pending_rejects_empty_entity_id(_nested_home: Path) -> None:
    """P1: an empty id (the degenerate empty-env keystone fallthrough) must
    be refused, not written as ``pending/.json`` — mirrors _validate_slug's
    non-empty check."""
    with pytest.raises(ValueError):
        _record(entity_id="")


@pytest.mark.parametrize("good_id", _LEGITIMATE_IDS)
def test_record_pending_accepts_legitimate_id_shapes(
    _nested_home: Path, good_id: str
) -> None:
    """P1 companion: the guard must ACCEPT every real id shape (UUID,
    search_slug, ``wake-<uuid>`` ephemeral, ``[a-z0-9._-]`` slug) so it can't
    over-reject and strand a legitimate escalation."""
    rec = _record(entity_id=good_id)
    assert rec.entity_id == good_id
    assert (_nested_home / "pending" / f"{good_id}.json").is_file()


@pytest.mark.parametrize("bad_id", _UNSAFE_IDS)
def test_resolve_pending_rejects_unsafe_entity_id(
    _nested_home: Path, bad_id: str
) -> None:
    """P1: ``resolve_pending`` also takes an entity_id and builds a path from
    it — the same guard must refuse a traversal id before it constructs the
    on-disk target (the finding names _record_path explicitly, shared by both
    record and resolve)."""
    with pytest.raises(ValueError):
        resolve_pending(bad_id)


# ── P2: the pending/ dir is created 0o700 like watch.py's buy/ dir ────


def test_pending_dir_created_with_0700_perms(_nested_home: Path) -> None:
    """P2 (review round 1): ``_atomic_write`` mkdir's pending/ with no chmod,
    unlike ``watch.py::_ensure_buy_dir`` (0o700). A loose umask is forced so
    the dir would default to 0o755 — the explicit chmod is what must land it
    on 0o700 (mirrors test_local_tools' policies-dir perm test)."""
    if sys.platform == "win32":
        pytest.skip("POSIX mode bits not enforced on Windows")
    prev_umask = os.umask(0o022)
    try:
        _record()
    finally:
        os.umask(prev_umask)
    pending = _nested_home / "pending"
    mode = stat.S_IMODE(pending.stat().st_mode)
    assert mode == 0o700, f"pending dir mode is {oct(mode)} (expected 0o700)"
