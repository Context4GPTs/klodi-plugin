"""Durable pending-decision store — the outbound wake round-trip's
correlation source of truth (Piece 4).

When the agent escalates a marketplace decision to its operator via
``klodi_message_user`` (see ``message.py``), klodi persists a
*pending-decision* keyed to the marketplace entity. The operator's later
reply lands in a DIFFERENT session than the isolated wake turn, so the
reply is correlated back to the right action by scanning these records —
never by trusting the fragile continuity of the wake session.

The record is a typed POINTER, never a marketplace-state snapshot: it
carries the entity identity + the question asked, nothing that would let
the reply turn act on cached state. Before applying the operator's answer
the agent re-grounds the entity's CURRENT state via the klodi read tools
(BR-5). Persisting a price / amount / terms snapshot here would defeat
that — hence the deliberately narrow schema.

Cross-process safety (devops [HIGH]): the writer runs inside the isolated
``hermes chat --session klodi:<entity_id>`` wake subprocess; the reader
runs inside a DIFFERENT operator-session subprocess, possibly
concurrently. Two OS processes on the same files mean no in-process lock
helps — every write is write-temp + ``os.replace`` (atomic rename) and
every read tolerates a missing dir or a torn file without raising.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from klodi_nats_client.paths import default_klodi_home

log = logging.getLogger("klodi_hermes.pending_decisions")

_PENDING_SUBDIR = "pending"
_RECORD_SUFFIX = ".json"
_TEMP_SUFFIX = ".tmp"
_STATUS_OPEN = "open"

_PENDING_DECISIONS_DESCRIPTION = (
    "List the open human-in-the-loop decisions awaiting the operator's"
    " reply. Scan at the start of every operator turn: when their message"
    " answers one, re-ground the entity's current state via the klodi read"
    " tools, act on the bound entity, then the decision is resolved."
)


@dataclass(frozen=True)
class PendingDecision:
    """A pointer to an escalated marketplace decision awaiting the
    operator's reply. These are EXACTLY the fields persisted on disk —
    adding a marketplace-state field here would break the
    pointer-not-snapshot invariant the reply turn relies on (BR-5)."""

    entity_type: str
    entity_id: str
    event_id: str
    question: str
    asked_at: str
    platform: str
    chat_id: str
    status: str


def record_pending(
    *,
    entity_type: str,
    entity_id: str,
    event_id: str,
    question: str,
    asked_at: str,
    platform: str,
    chat_id: str,
) -> PendingDecision:
    """Persist an OPEN pending-decision keyed by ``entity_id``, atomically.

    Idempotent on ``(entity_id, question)``: a redelivered outbound
    trigger for the same entity + question rewrites nothing and returns
    the existing record — no duplicate file, no implied re-ping (BR-6).
    """
    path = _record_path(entity_id)
    existing = _read_record(path)
    if existing is not None and existing.question == question:
        return existing
    record = PendingDecision(
        entity_type=entity_type,
        entity_id=entity_id,
        event_id=event_id,
        question=question,
        asked_at=asked_at,
        platform=platform,
        chat_id=chat_id,
        status=_STATUS_OPEN,
    )
    _atomic_write(path, asdict(record))
    log.info(
        "pending_decision_recorded entity_type=%s entity_id=%s event_id=%s",
        entity_type,
        entity_id,
        event_id,
    )
    return record


def open_pending() -> list[PendingDecision]:
    """Every OPEN pending-decision. A missing dir → ``[]``; a torn/corrupt
    record is skipped, never raised — the reply turn scans this on EVERY
    operator turn (AC-12), so it must be cheap and crash-free."""
    pending_dir = _pending_dir()
    if not pending_dir.is_dir():
        return []
    records: list[PendingDecision] = []
    for path in sorted(pending_dir.glob(f"*{_RECORD_SUFFIX}")):
        record = _read_record(path)
        if record is not None and record.status == _STATUS_OPEN:
            records.append(record)
    return records


def resolve_pending(entity_id: str) -> bool:
    """Close a pending-decision exactly once. Returns ``True`` the first
    time it removes an open record, ``False`` if none was open (already
    resolved, or never existed) — so a later unrelated reply can never
    re-fire a closed decision (BR-6).

    Removing the record IS the close: the structured store holds only the
    open working set; the human-readable ``## Open Questions`` /
    ``## Active Negotiations`` audit trail lives in the sell / buy files.
    """
    path = _record_path(entity_id)
    if not path.is_file():
        return False
    try:
        path.unlink()
    except OSError as err:
        log.warning(
            "pending_decision_resolve_failed entity_id=%s error=%s",
            entity_id,
            err,
        )
        return False
    log.info("pending_decision_resolved entity_id=%s", entity_id)
    return True


def handle_pending_decisions(_args: dict[str, Any], **_kwargs: Any) -> str:
    """``klodi_pending_decisions`` — list every open pending-decision as a
    JSON array, each carrying full entity identity + question so the agent
    can disambiguate a reply on identity and never guess (BR-4). The agent
    scans this on every operator turn (see SKILL.md §2)."""
    return json.dumps([asdict(record) for record in open_pending()])


def register_pending_tools(ctx: Any) -> int:
    """Register ``klodi_pending_decisions`` on the host tool surface.
    Host-local (no NATS subject) — NOT a cross-language catalog tool
    (see ADR-0014 tool-symmetry axes)."""
    from .tools import tool_emoji

    ctx.register_tool(
        name="klodi_pending_decisions",
        toolset="klodi",
        schema={
            "name": "klodi_pending_decisions",
            "description": _PENDING_DECISIONS_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
        handler=handle_pending_decisions,
        check_fn=None,
        requires_env=[],
        is_async=False,
        description=_PENDING_DECISIONS_DESCRIPTION,
        emoji=tool_emoji("klodi_pending_decisions"),
    )
    return 1


def _pending_dir() -> Path:
    return default_klodi_home() / _PENDING_SUBDIR


def _record_path(entity_id: str) -> Path:
    return _pending_dir() / f"{entity_id}{_RECORD_SUFFIX}"


def _read_record(path: Path) -> PendingDecision | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return PendingDecision(
            entity_type=str(data["entity_type"]),
            entity_id=str(data["entity_id"]),
            event_id=str(data["event_id"]),
            question=str(data["question"]),
            asked_at=str(data["asked_at"]),
            platform=str(data["platform"]),
            chat_id=str(data["chat_id"]),
            status=str(data["status"]),
        )
    except KeyError:
        return None


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Temp sits beside the target (same filesystem → rename is atomic) and
    # ends in ``.tmp`` so a torn write is never globbed as a ``*.json``
    # record by a concurrent reader.
    tmp = path.parent / f"{path.name}{_TEMP_SUFFIX}"
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


__all__ = [
    "PendingDecision",
    "handle_pending_decisions",
    "open_pending",
    "record_pending",
    "register_pending_tools",
    "resolve_pending",
]
