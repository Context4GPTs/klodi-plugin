"""Bounded wake-completion marker store — the durable, klodi-owned proof that
a wake turn actually completed (subprocess exit 0), keyed by the wake's
``event_id``.

Why this exists: hermes v0.17.0's one-shot ``hermes chat -q … -Q`` create path
silently drops ``--source`` (and ``HERMES_SESSION_SOURCE``) and persists the
default ``source='cli'`` on the new ``sessions`` row; ``SessionDB`` exposes no
source setter, so klodi cannot back-fill it. A completed wake session is
therefore byte-indistinguishable from a genuine operator CLI session at the
host store, and ``sessions.source='klodi'`` can no longer mark "a wake turn
completed". The klodi-stage AC1 DELIVERED gate reads THIS marker instead (a
lockstep card, sequenced after this one, moves the gate's assertion onto it).

Written ONLY from the bridge's ``inject_message`` exit-0 branch: a nonzero exit
raises ``WakeInjectFailed`` and a timeout is swallowed — both record nothing —
so the marker can never false-green the gate on an inject that produced no turn
(exactly the failure AC1 exists to catch).

BOUNDED by construction: a single rolling JSON list holding at most
:data:`_MAX_COMPLETIONS` newest markers (a ring), NOT one file per wake. Per-wake
files would reintroduce the unbounded-growth class the bridge's inject-lock TODO
already guards; the ring caps disk use regardless of the daemon's lifetime wake
volume. The gate injects one wake and reads immediately, so eviction never
races a marker it is about to read.

Cross-process shape mirrors :mod:`klodi_hermes.pending_decisions`: the writer is
the single long-lived bridge process (writes serialized by the ctx's
``_inject_lock``); readers are separate processes (the klodi-stage gate
``docker exec``-ing the store). So every write is write-temp + ``os.replace``
(atomic rename) and every read tolerates a missing dir / torn file without
raising. A marker write that fails on I/O NEVER raises — the wake turn DID
complete, and a bookkeeping failure must not turn a success into a failure.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from klodi_nats_client.paths import default_klodi_home

log = logging.getLogger("klodi_hermes.wake_completions")

_COMPLETIONS_SUBDIR = "wake"
_COMPLETIONS_FILE = "completions.json"
_TEMP_SUFFIX = ".tmp"

# Bounded ring: keep at most this many newest completion markers. Caps the store
# at a few tens of KB regardless of the daemon's lifetime wake volume, so it can
# never grow unbounded (the class the bridge inject-lock TODO guards). Read
# dynamically on every write so the bound stays a single source of truth.
_MAX_COMPLETIONS = 512


def record_wake_completion(*, event_id: str, session: str, role: str) -> None:
    """Record a completion marker for a wake turn that exited 0, keyed by
    ``event_id``, atomically and boundedly.

    Idempotent on ``event_id`` (a redelivered wake — JetStream ``max_deliver``
    — rewrites its key, never a duplicate). A wake with no ``event_id`` cannot
    be correlated by the gate, so it records nothing (the store is keyed, not a
    raw turn counter). NEVER raises: the turn already completed, so an I/O
    failure writing this bookkeeping artifact degrades to a WARNING rather than
    failing an otherwise-successful wake.
    """
    if not event_id:
        return
    try:
        entries = [e for e in _read() if e.get("event_id") != event_id]
        entries.append(
            {
                "event_id": event_id,
                "session": session,
                "role": role,
                "completed_at": _now_iso(),
            }
        )
        _atomic_write(entries[-_MAX_COMPLETIONS:])
    except OSError as err:
        log.warning("wake_completion_write_failed event_id=%s error=%s", event_id, err)


def _store_path() -> Path:
    """``${KLODI_HOME}/wake/completions.json`` — the marker store. Resolved
    dynamically so a ``KLODI_HOME`` override is always honoured (and the
    klodi-stage gate reads the same path)."""
    return default_klodi_home() / _COMPLETIONS_SUBDIR / _COMPLETIONS_FILE


def _read() -> list[dict[str, Any]]:
    """The current marker list. A missing dir, an unreadable file, a torn
    write, or a non-list payload all degrade to ``[]`` — never raise."""
    try:
        raw = _store_path().read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


def _atomic_write(entries: list[dict[str, Any]]) -> None:
    """Write the whole marker list via write-temp + ``os.replace`` (atomic
    rename on the same filesystem), so a concurrent reader (the gate) never
    globs a torn ``*.json`` store. The ``.tmp`` sidecar is renamed away, never
    left behind. Mirrors ``pending_decisions._atomic_write`` (incl. the 0700
    dir)."""
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.parent / f"{path.name}{_TEMP_SUFFIX}"
    tmp.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


__all__ = ["record_wake_completion"]
