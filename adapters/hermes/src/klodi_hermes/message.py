"""``klodi_message_user`` — the outbound escalation tool (Piece 3) + the
operator-target resolver + the turn-less delivery seam.

This is how a klodi agent actively reaches its human operator when a
marketplace decision is reserved for the human (negotiation_style.md
``## Always Ask Me First`` / ``## Escalation When Unknown`` / a
security.md hard rule). It runs INSIDE the isolated
``hermes chat --session klodi:<entity_id>`` wake turn, so it must reach
the operator's *separate* live session without running an agent turn
there (the Piece-3 no-hijack requirement).

Control flow (deliver-then-persist — devops [MED]):

    resolve target (most-recently-active GENUINE operator session, else
    the configured fallback, else a surfaced no-target failure) →
    ``_deliver`` (turn-less) → ON SUCCESS ``record_pending`` keyed off the
    bridge-set ``KLODI_WAKE_ENTITY_*`` env (the keystone) → non-error
    envelope.

Every call terminates in exactly one observable disposition — delivered
XOR surfaced-failure (BR-2 / INV-1). A silent no-op is the one forbidden
outcome: a silently-undelivered escalation strands a marketplace action
forever invisibly. Persist happens ONLY after a successful deliver, so a
failed send never leaves a dangling decision the operator never saw.

Two host seams sit behind one function each, both PROBE-GATED (merge
gate, stacked on #32):

  * ``_active_sessions_path`` — the host's ``active_sessions.json``
    operator-session registry (assumed schema; the real binding is the
    merge-gate).
  * ``_deliver`` — the host's turn-less delivery primitive (a
    ``hermes send``-style CLI preferred over importing the internal
    ``standalone_sender_fn``). Unbound until the probe lands → it raises,
    so every escalation surfaces a loud failure rather than delivering
    nowhere (safe-by-default).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from klodi_nats_client.envelope import make_envelope

from .bridge import (
    KLODI_WAKE_ENTITY_ID_ENV,
    KLODI_WAKE_ENTITY_TYPE_ENV,
    KLODI_WAKE_EVENT_ID_ENV,
)
from .pending_decisions import record_pending
from .wake_handlers import WAKE_SESSION_NAMESPACE

log = logging.getLogger("klodi_hermes.message")

# The host's operator-session registry (devops Probe 2). $HERMES_HOME is a
# new env dependency — the adapter only ever resolved $KLODI_HOME before.
# Default ~/.hermes per the plugin-clone path; the real path is merge-gated.
_HERMES_HOME_ENV = "HERMES_HOME"
_RUNTIME_SUBDIR = "runtime"
_ACTIVE_SESSIONS_FILE = "active_sessions.json"

# Assumed registry schema (probe-gated): a JSON array of session records.
# If the real host schema differs, the parse AND the test fixtures move
# together — the merge-gate contract.
_SESSION_FIELD = "session"
_PLATFORM_FIELD = "platform"
_CHAT_ID_FIELD = "chat_id"
_LAST_ACTIVE_FIELD = "last_active_at"

# Net-new hermes fallback-channel config (devops Probe 2): hermes has no
# native operator pairing today (TELEGRAM_CHAT_ID is a zeroclaw/rust
# concept). Unset → no fallback → the cold path is a surfaced no-target
# failure, never a silent drop. The final config key is a merge-gate call.
_FALLBACK_PLATFORM_ENV = "KLODI_FALLBACK_PLATFORM"
_FALLBACK_CHAT_ID_ENV = "KLODI_FALLBACK_CHAT_ID"
_DEFAULT_FALLBACK_PLATFORM = "telegram"

_MESSAGE_USER_DESCRIPTION = (
    "Actively reach the human operator when a marketplace decision is"
    " reserved for them by policy (negotiation_style.md `Always Ask Me"
    " First` / `Escalation When Unknown`, or a security.md hard rule)."
    " Delivers a real-time, self-contained message into the operator's"
    " live session and records a pending-decision so their reply drives"
    " the right action. Do NOT use for decisions the policy authorizes"
    " you to handle alone, nor for purely informational updates."
)


@dataclass(frozen=True)
class DeliveryTarget:
    """Where an escalation is delivered. Compared by value (frozen) so the
    resolver's result can be asserted against an expected target."""

    platform: str
    chat_id: str


def resolve_operator_target(
    *, fallback: DeliveryTarget | None = None
) -> DeliveryTarget | None:
    """Resolve where a klodi escalation is delivered. Precedence:
    (1) the most-recently-active GENUINE operator session, (2) the
    configured ``fallback`` channel, (3) ``None`` (→ surfaced failure
    upstream). NEVER raises — a fresh-install cold path (no registry, no
    fallback) is the common case and a crash here would strand every
    escalation.

    The whole ``klodi:`` wake-session family is excluded (BR-3): an
    isolated wake session is the bot's own transcript, so self-addressing
    it means the human never sees the message and can never reply — the
    highest product risk this resolver exists to prevent.
    """
    target = _most_recent_operator(_load_active_sessions())
    return target if target is not None else fallback


def configured_fallback() -> DeliveryTarget | None:
    """The net-new hermes fallback-channel target, or ``None`` when unset.
    A module-level seam the handler calls and tests monkeypatch —
    probe-gated (devops Probe 2): the final config key is a merge-gate
    decision."""
    chat_id = os.environ.get(_FALLBACK_CHAT_ID_ENV)
    if not chat_id:
        return None
    platform = os.environ.get(_FALLBACK_PLATFORM_ENV, _DEFAULT_FALLBACK_PLATFORM)
    return DeliveryTarget(platform=platform, chat_id=chat_id)


def handle_message_user(args: dict[str, Any], **_kwargs: Any) -> str:
    """``klodi_message_user`` — escalate a marketplace decision to the
    operator. Deliver-then-persist; exactly one disposition (delivered
    XOR surfaced-failure), never a silent no-op (BR-2 / INV-1)."""
    text = args.get("text")
    if not isinstance(text, str) or not text:
        return json.dumps(
            make_envelope(
                error="invalid_request",
                message=(
                    "klodi_message_user requires a non-empty `text` — the"
                    " self-contained message to the operator."
                ),
                details={"field": "text"},
                recovery_hint=None,
            )
        )

    target = resolve_operator_target(fallback=configured_fallback())
    if target is None:
        log.error(
            "klodi_message_user_no_target — escalation undeliverable:"
            " no operator session and no configured fallback channel"
        )
        return json.dumps(
            make_envelope(
                error="no_operator_target",
                message=(
                    "No active operator session and no configured fallback"
                    " channel — the escalation could not be delivered. The"
                    " human was NOT reached."
                ),
                details=None,
                recovery_hint={
                    "kind": "tool",
                    "tool": "klodi_setup_status",
                    "message": (
                        "No delivery target — start an operator session or"
                        " configure a fallback channel, then retry."
                    ),
                },
            )
        )

    try:
        _deliver(target.platform, target.chat_id, text)
    except Exception as err:  # noqa: BLE001 — boundary: surface, never swallow
        log.error(
            "klodi_message_user_delivery_failed platform=%s error=%s",
            target.platform,
            err,
        )
        return json.dumps(
            make_envelope(
                error="delivery_failed",
                message=(
                    f"Delivery to the operator failed: {err}. The escalation"
                    " was not sent and no pending-decision was recorded."
                ),
                details={"platform": target.platform},
                recovery_hint=None,
            )
        )

    record = record_pending(
        entity_type=os.environ.get(KLODI_WAKE_ENTITY_TYPE_ENV, ""),
        entity_id=os.environ.get(KLODI_WAKE_ENTITY_ID_ENV, ""),
        event_id=os.environ.get(KLODI_WAKE_EVENT_ID_ENV, ""),
        question=text,
        asked_at=_now_iso(),
        platform=target.platform,
        chat_id=target.chat_id,
    )
    log.info(
        "klodi_message_user_delivered entity_type=%s entity_id=%s platform=%s",
        record.entity_type,
        record.entity_id,
        record.platform,
    )
    return json.dumps(
        {
            "delivered": True,
            "platform": target.platform,
            "chat_id": target.chat_id,
            "entity_id": record.entity_id,
            "pending_status": record.status,
        }
    )


def register_message_tools(ctx: Any) -> int:
    """Register ``klodi_message_user`` on the host tool surface. Host-local
    (no NATS subject) — NOT a cross-language catalog tool (ADR-0014)."""
    from .tools import tool_emoji

    ctx.register_tool(
        name="klodi_message_user",
        toolset="klodi",
        schema={
            "name": "klodi_message_user",
            "description": _MESSAGE_USER_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": (
                            "The self-contained message to the operator —"
                            " name the listing / counterparty, the question,"
                            " and the options so a natural-language reply is"
                            " interpretable hours later with no wake context."
                        ),
                    },
                },
                "required": ["text"],
                "additionalProperties": False,
            },
        },
        handler=handle_message_user,
        check_fn=None,
        requires_env=[],
        is_async=False,
        description=_MESSAGE_USER_DESCRIPTION,
        emoji=tool_emoji("klodi_message_user"),
    )
    return 1


def _deliver(platform: str, chat_id: str, text: str) -> None:
    """Turn-less delivery seam — push a real-time message into the
    operator's ``(platform, chat_id)`` WITHOUT running an agent turn in
    their session (the Piece-3 no-hijack requirement).

    PROBE-GATED (merge gate, stacked on #32). The host's turn-less
    delivery primitive is hermes-internal and UNCONFIRMED here: no
    ``hermes`` binary / wiki to run ``hermes send --help`` or import
    ``gateway.delivery.standalone_sender_fn``. We deliberately do NOT
    shell a *guessed* command or import a *guessed* symbol — that could
    deliver into the wrong transcript (silent loss) or no-op. Until the
    binding is confirmed this raises, so every escalation surfaces a loud
    no-delivery failure (BR-2 / INV-1: surfaced, never silent). The
    confirmed binding (a ``hermes send``-style CLI preferred over the
    internal import) goes HERE. Tests replace this seam wholesale.
    """
    raise RuntimeError(
        "klodi_message_user delivery is not bound: the hermes turn-less"
        " sender is probe-gated (card merge-gate). No message was sent."
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _active_sessions_path() -> Path:
    home = os.environ.get(_HERMES_HOME_ENV)
    base = Path(home) if home else Path.home() / ".hermes"
    return base / _RUNTIME_SUBDIR / _ACTIVE_SESSIONS_FILE


def _load_active_sessions() -> list[dict[str, Any]]:
    try:
        raw = _active_sessions_path().read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _most_recent_operator(
    sessions: list[dict[str, Any]],
) -> DeliveryTarget | None:
    candidates = [s for s in sessions if _is_operator_session(s)]
    if not candidates:
        return None
    newest = max(candidates, key=lambda s: str(s.get(_LAST_ACTIVE_FIELD, "")))
    return DeliveryTarget(
        platform=str(newest[_PLATFORM_FIELD]),
        chat_id=str(newest[_CHAT_ID_FIELD]),
    )


def _is_operator_session(session: dict[str, Any]) -> bool:
    """A genuine operator session: a well-formed registry entry whose name
    is NOT in the ``klodi:`` wake-session family (BR-3). Filtering on
    well-formedness here means a malformed newest entry can never shadow a
    valid older operator session."""
    name = session.get(_SESSION_FIELD)
    if not isinstance(name, str) or name.startswith(WAKE_SESSION_NAMESPACE):
        return False
    platform = session.get(_PLATFORM_FIELD)
    chat_id = session.get(_CHAT_ID_FIELD)
    return (
        isinstance(platform, str)
        and bool(platform)
        and isinstance(chat_id, str)
        and bool(chat_id)
    )


__all__ = [
    "DeliveryTarget",
    "configured_fallback",
    "handle_message_user",
    "register_message_tools",
    "resolve_operator_target",
]
