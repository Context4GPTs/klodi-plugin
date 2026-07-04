"""``klodi_message_user`` — the outbound escalation tool (Piece 3) + the
operator-target resolver + the turn-less delivery seam, bound to Hermes's
own host primitives.

This is how a klodi agent actively reaches its human operator when a
marketplace decision is reserved for the human (negotiation_style.md
``## Always Ask Me First`` / ``## Escalation When Unknown`` / a
security.md hard rule). It runs INSIDE the isolated
``hermes chat … --source klodi`` wake turn, so it must reach
the operator's *separate* live session without running an agent turn
there (the Piece-3 no-hijack requirement).

Control flow (deliver-then-persist — BR-9):

    resolve target (most-recently-active GENUINE operator session, else a
    surfaced no-operator failure) → ``_deliver`` (turn-less) → ON SUCCESS
    ``record_pending`` keyed off the bridge-set ``KLODI_WAKE_ENTITY_*``
    env (the keystone) → non-error envelope.

Every call terminates in exactly one observable disposition — delivered
XOR surfaced-failure (BR-2 / INV-1). A silent no-op is the one forbidden
outcome: a silently-undelivered escalation strands a marketplace action
forever invisibly. Persist happens ONLY after a successful deliver, so a
failed send never leaves a dangling decision the operator never saw.

Both host seams are bound to the runtime Hermes ships (confirmed by
``docker exec`` against the staging image ``klodi-hermes-live:local``,
hermes-agent 0.11.0). There is NO default fallback channel (founder
decision): the target is always the resolved live operator, and a
genuinely-absent operator surfaces a loud ``no_operator_target``.

  * ``resolve_operator_target`` reads the host session store
    (``hermes_state.SessionDB.list_sessions_rich``) and returns the
    most-recently-active session whose ``source`` is a reachable messaging
    platform — that positive ``(platform, chat_id)`` identification is the
    load-bearing self-addressing guard. A completed wake turn lands
    ``source='cli'`` (hermes v0.17.0's one-shot ``-q`` create silently drops
    ``--source klodi`` and persists the default ``cli``), so it maps to no
    messaging chat and can never be picked. The store query additionally
    excludes the ``cli`` and ``klodi`` source classes up front
    (``exclude_sources=[HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE]``) so wake
    sessions never crowd a genuine operator out of the recency window; the
    deliverable ``chat_id`` is then recovered from ``gateway.channel_directory``.
  * ``_deliver`` pushes the message turn-lessly via the SAME standalone
    sender Hermes's cron runner uses when the gateway process is not in
    this process (``tools.send_message_tool._send_to_platform`` over a
    ``gateway.config.load_gateway_config`` platform config) — NOT the
    in-gateway ``DeliveryRouter``, which needs the gateway's live
    platform adapters that a ``hermes chat`` wake subprocess does not
    hold. See ADR-0020 for the full rationale.

The host modules above ship only inside the Hermes runtime, never in the
``klodi-hermes`` wheel's own environment, so every host import is LAZY
(inside the function that needs it). Importing this module therefore
never requires Hermes to be installed, and the unit suite drives the two
host boundaries (``_list_operator_sessions`` / ``_resolve_chat_id`` and
``_deliver``) as seams while the live stage exercises the real bindings.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from klodi_nats_client.envelope import make_envelope

from .bridge import (
    KLODI_WAKE_ENTITY_ID_ENV,
    KLODI_WAKE_ENTITY_TYPE_ENV,
    KLODI_WAKE_EVENT_ID_ENV,
    KLODI_WAKE_SOURCE,
)
from .pending_decisions import record_pending

log = logging.getLogger("klodi_hermes.message")

# $HERMES_HOME is the host runtime's data root (``/opt/data`` in the
# stage/prod image). The SQLite session store lives at its top level.
_HERMES_HOME_ENV = "HERMES_HOME"
_STATE_DB_FILE = "state.db"

# The default ``source`` hermes writes on a one-shot ``hermes chat -q`` create.
# A COMPLETED WAKE lands here: hermes v0.17.0's ``-q`` path silently drops
# ``--source klodi`` (see ``bridge.KLODI_WAKE_SOURCE``) and persists ``cli``, so
# a wake session is byte-identical to a genuine operator CLI session at the
# store. It is excluded as a CLASS at the recency-window query — a ``cli``
# session is never a *deliverable* operator (no channel-directory chat_id, not a
# messaging ``Platform``), so excluding the class drops no reachable operator
# yet keeps a flood of wake ``cli`` rows from crowding a genuine operator out of
# the ``_SESSION_SCAN_LIMIT`` window before positive-id ever ranks it.
HERMES_CLI_SOURCE = "cli"

# How many recent sessions to scan when resolving the operator. The host
# query orders by ``started_at`` DESC; we re-rank the window by
# ``last_active`` ourselves (a recently-active operator is effectively
# always within a small window of recent starts).
_SESSION_SCAN_LIMIT = 50

# A turn-less send must not block the wake turn indefinitely when it has
# to run on a dedicated thread (already-async caller); bound it.
_SEND_TIMEOUT_SECONDS = 30

_MESSAGE_USER_DESCRIPTION = (
    "Actively reach the human operator from an isolated wake turn — where your"
    " closing chat text reaches no one — when the wake cannot be resolved"
    " autonomously and needs the operator's decision or input: a decision"
    " reserved for them by policy (negotiation_style.md `Always Ask Me First` /"
    " `Escalation When Unknown`, or a security.md hard rule), a live"
    " counterparty left waiting, or an inbound you declined to act on. Being"
    " unsure or stuck is a decision for the human, not an informational note."
    " Delivers a real-time, self-contained message into the operator's live"
    " session and records a pending-decision so their reply drives the right"
    " action. Do NOT ping for decisions the policy authorizes you to handle"
    " alone, nor for a purely-informational status wake where no counterparty"
    " is waiting and no decision is open."
)


class DeliveryError(Exception):
    """A turn-less delivery attempt failed deterministically — an unknown
    or disabled platform, or a non-empty error from the host sender. Carries
    a contextual message so the handler can surface a loud ``delivery_failed``
    envelope (BR-2/INV-1: surfaced, never silent)."""


@dataclass(frozen=True)
class DeliveryTarget:
    """Where an escalation is delivered. Compared by value (frozen) so the
    resolver's result can be asserted against an expected target."""

    platform: str
    chat_id: str


def resolve_operator_target() -> DeliveryTarget | None:
    """Resolve where a klodi escalation is delivered: the most-recently-active
    GENUINE operator session that maps to a reachable ``(platform, chat_id)``,
    or ``None`` (→ a surfaced ``no_operator_target`` upstream). There is NO
    default fallback channel (founder decision) — the target is always a live
    operator. NEVER raises: a fresh-install cold path (no sessions, no
    directory) is the common case and a crash here would strand every
    escalation.

    Recency comes from the numeric ``last_active`` field (BR-6), not the
    host query's ``started_at`` ordering, so a long-lived but freshly-active
    operator session still wins. The load-bearing self-addressing guard (BR-4)
    is positive identification: only a session whose ``source`` maps to a
    reachable messaging ``(platform, chat_id)`` is ever returned. A completed
    wake turn lands ``source='cli'`` — hermes v0.17.0's one-shot ``-q`` create
    silently drops ``--source klodi`` and persists the default ``cli``
    (``SessionDB`` exposes no source setter, so klodi cannot back-fill it),
    leaving a wake row byte-identical to an operator CLI session — and ``cli``
    maps to no messaging chat, so a wake is never a delivery target. The store
    query additionally excludes the ``cli`` and ``klodi`` source classes
    (``exclude_sources=[HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE]`` in
    ``_list_operator_sessions``) so wake sessions cannot crowd a genuine
    operator out of the recency window under wake volume — a defence-in-depth
    optimisation, not the safety guard.
    """
    sessions = _list_operator_sessions()
    for session in sorted(sessions, key=_last_active, reverse=True):
        platform = session.get("source")
        if not isinstance(platform, str) or not platform:
            continue
        chat_id = _resolve_chat_id(platform)
        if chat_id:
            return DeliveryTarget(platform=platform, chat_id=chat_id)
    return None


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

    target = resolve_operator_target()
    if target is None:
        log.error(
            "klodi_message_user_no_target — escalation undeliverable: no"
            " active operator session resolves to a reachable channel"
        )
        return json.dumps(
            make_envelope(
                error="no_operator_target",
                message=(
                    "No active operator session resolves to a reachable"
                    " channel — the escalation could not be delivered. The"
                    " human was NOT reached."
                ),
                details=None,
                recovery_hint={
                    "kind": "human",
                    "message": (
                        "Message the bot from your operator chat (Telegram,"
                        " Discord, …) so a live session exists, then retry."
                    ),
                },
            )
        )

    try:
        _deliver(target.platform, target.chat_id, text)
    except Exception as err:  # noqa: BLE001 — boundary: surface, never swallow
        log.error(
            "klodi_message_user_delivery_failed platform=%s chat_id=%s error=%s",
            target.platform,
            target.chat_id,
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
    delivery (turn-less send + disk persist, no NATS subject) — but a
    first-class cross-language catalog tool: ``LOCAL_TOOLS.klodi_message_user``
    in ``packages/tool-catalog`` (D4 — a tool that ships must exist in the
    catalog). Its params/result MUST stay byte-faithful to that entry."""
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


# ── Host boundaries (lazy imports — Hermes runtime only) ──────────────


def _list_operator_sessions() -> list[dict[str, Any]]:
    """Host boundary: the recent sessions from Hermes's SQLite session store
    (``hermes_state.SessionDB.list_sessions_rich``), with the ``cli`` and
    ``klodi`` source classes filtered out server-side
    (``exclude_sources=[HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE]``) so wake
    sessions cannot crowd a genuine operator out of the recency window. A
    completed wake turn lands ``source='cli'`` (hermes v0.17.0's ``-q`` create
    drops ``--source klodi`` to the default ``cli``), so ``cli`` is the class
    that actually matches a wake today; ``klodi`` is kept forward-compat for a
    future hermes that ever honours ``--source``. Neither class is a
    deliverable operator (``cli`` maps to no channel-directory chat and is not a
    messaging ``Platform``), so excluding the classes drops no reachable
    operator — the resolver's positive ``(platform, chat_id)`` identification
    remains the self-addressing safety guard. Returns the host's own row dicts
    (keys incl. ``id``, ``source``, ``title``, ``last_active``). A missing
    store / unavailable host module degrades to ``[]`` — the cold-start path is
    common and must never raise. Driven as a seam by the unit suite; exercised
    for real in the live stage."""
    try:
        from hermes_state import SessionDB  # ty: ignore[unresolved-import]
    except Exception:  # noqa: BLE001 — host module absent (non-runtime env)
        return []
    try:
        db = SessionDB(db_path=_state_db_path())
        return list(
            db.list_sessions_rich(
                limit=_SESSION_SCAN_LIMIT,
                exclude_sources=[HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE],
            )
        )
    except Exception as err:  # noqa: BLE001 — store missing/locked → cold path
        log.warning("operator_session_scan_failed error=%s", err)
        return []


def _resolve_chat_id(platform: str) -> str | None:
    """Host boundary: recover a deliverable ``chat_id`` for ``platform`` from
    Hermes's channel directory (``gateway.channel_directory.load_directory``),
    the same map the cron delivery path consults. Returns the first reachable
    chat for the platform, or ``None`` when the directory has no entry (→ the
    resolver tries the next session, else surfaces no-target). Driven as a
    seam by the unit suite; exercised for real in the live stage."""
    try:
        from gateway import channel_directory  # ty: ignore[unresolved-import]
    except Exception:  # noqa: BLE001 — host module absent (non-runtime env)
        return None
    try:
        directory = channel_directory.load_directory()
    except Exception as err:  # noqa: BLE001 — unreadable directory → no target
        log.warning("channel_directory_load_failed platform=%s error=%s", platform, err)
        return None
    entries = directory.get("platforms", {}).get(platform, [])
    for entry in entries:
        chat_id = entry.get("id")
        if chat_id:
            return str(chat_id)
    return None


def _deliver(platform: str, chat_id: str, text: str) -> None:
    """Turn-less delivery seam — push a real-time message into the operator's
    ``(platform, chat_id)`` WITHOUT running an agent turn in their session
    (the Piece-3 no-hijack requirement).

    Bound to ``tools.send_message_tool._send_to_platform`` over a
    ``gateway.config.load_gateway_config`` platform config — the SAME
    one-shot standalone sender Hermes's cron runner uses to deliver job
    output to a chat when the gateway process is elsewhere (``cron/
    scheduler.py::_deliver_result``). It is platform-agnostic (Telegram,
    Discord, Signal, …) and needs no live gateway adapter, which is why the
    in-gateway ``DeliveryRouter`` (adapter-bound) is the wrong primitive for
    a ``hermes chat`` wake subprocess. Raises :class:`DeliveryError` on an
    unknown/disabled platform or a non-empty sender error so the handler
    surfaces a loud ``delivery_failed`` (BR-2 / INV-1); returns ``None`` on
    success. Tests replace this seam wholesale."""
    from gateway.config import (  # ty: ignore[unresolved-import]
        Platform,
        load_gateway_config,
    )
    from tools.send_message_tool import (  # ty: ignore[unresolved-import]
        _send_to_platform,
    )

    try:
        plat = Platform(platform)
    except ValueError as err:
        raise DeliveryError(f"unknown delivery platform {platform!r}") from err

    config = load_gateway_config()
    pconfig = config.platforms.get(plat)
    if pconfig is None or not getattr(pconfig, "enabled", False):
        raise DeliveryError(
            f"hermes platform {platform!r} is not configured or not enabled"
            " — cannot deliver the escalation"
        )

    result = _run_send(lambda: _send_to_platform(plat, pconfig, chat_id, text))
    if isinstance(result, dict) and result.get("error"):
        raise DeliveryError(
            f"hermes sender failed delivering to {platform}:{chat_id}:"
            f" {result['error']}"
        )


def _run_send(make_coro: Callable[[], Any]) -> Any:
    """Drive the async send coroutine resiliently from a possibly-async
    caller — mirrors the cron runner's standalone-send dispatch. When this
    thread has no running loop, ``asyncio.run`` is safe; when a loop is
    already running (the tool ran inside one), the send runs on a dedicated
    thread+loop so it never reenters the live loop. The coroutine is built
    lazily in the chosen branch so it is awaited exactly once."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(make_coro())
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(make_coro())).result(
            timeout=_SEND_TIMEOUT_SECONDS
        )


def _state_db_path() -> Path:
    home = os.environ.get(_HERMES_HOME_ENV)
    base = Path(home) if home else Path.home() / ".hermes"
    return base / _STATE_DB_FILE


def _last_active(session: dict[str, Any]) -> float:
    """The session's last-activity timestamp as a float for recency ranking.
    A missing / non-numeric value sorts oldest (``0.0``) — a malformed row can
    never shadow a well-formed operator session by sorting newest."""
    try:
        return float(session.get("last_active") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


__all__ = [
    "DeliveryError",
    "DeliveryTarget",
    "handle_message_user",
    "register_message_tools",
    "resolve_operator_target",
]
