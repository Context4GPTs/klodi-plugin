"""Hermes wake handlers — surface notifications + channel messages.

Per 0012, every wake delivered on either consumer carries the FULL
event payload. The agent does not need a follow-up tool call to learn
what woke it: the message body / offer terms / listing summary —
whatever the event carries — is in the wake itself.

Each handler renders a system-message string that summarizes the event
plus the JSON body, then injects it into the running Hermes session
via ``ctx.inject_message(text, role="system")``. The format mirrors
``klodi-plugin/adapters/openclaw/src/service/wake-handlers.ts`` so
agents see the same shape regardless of host.

Each wake runs in a session scoped to its CONVERSATION. ``_inject``
derives the session key off ``event.kind`` (see
``derive_wake_session``) and threads it down into the bridge ctx's
``inject_message``, so per-conversation history stays bounded instead
of one shared session growing unbounded for the daemon's lifetime. On a
conversation's terminal event (channel closed, listing sold/withdrawn/
expired, transaction completed/cancelled) the handler issues a
best-effort ``drain_session`` to reclaim it.

Hermes's daemon is long-running; the connection lives for the
daemon's lifetime, and consumer pull loops live on a dedicated
asyncio thread (see ``client.py``). The bridge ctx's
``inject_message`` blocks on a ``hermes chat --session <key>``
subprocess for the agent turn's duration, so the inject is dispatched
off the loop via ``asyncio.to_thread``. Otherwise the running
subprocess freezes the second consumer's pull-fetch and the nats-py WS
heartbeat, and the WS reconnect can't run until after the chat
exits — at which point the consumer is dead and silently stops
delivering wakes.

Failure surface (the no-silent-drop contract): a fast deterministic
inject failure raises :class:`klodi_hermes.bridge.WakeInjectFailed`,
which ``_inject`` turns into a loud, correlated ERROR alarm
(``wake_inject_deterministic_failure``) carrying the subprocess
diagnostics plus ``kind``/``event_id``. A timeout stays a swallowed
WARNING in the bridge. Anything else stays a best-effort WARNING here.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import uuid
from typing import Any

from klodi_hermes.bridge import _DIAG_TAIL, WakeInjectFailed

log = logging.getLogger("klodi_hermes.wake")

_CTX: Any = None


def bind_ctx(ctx: Any) -> None:
    """Capture the Hermes registration context so wake handlers can
    reach the running session via ``inject_message``."""
    global _CTX
    _CTX = ctx


# Per-domain session-key field — the conversation a wake belongs to.
# FINAL, verified against the tool-catalog golden fixtures. Keyed by the
# kind's DOMAIN prefix (``kind.split(".")[0]``), NOT "first id present":
# several kinds carry more than one id (``offer.accepted`` has both
# ``listing_id`` and ``transaction_id``; ``channel.*`` and
# ``transaction.*`` also carry ``listing_id``), so only the prefix is
# authoritative. ``offer.*`` / ``comment.*`` / ``listing.*`` all scope to
# the LISTING (the negotiation's subject); ``transaction.*`` to the
# transaction; ``channel.*`` to the channel thread; ``search.match`` to
# the standing search.
_SESSION_KEY_FIELD_BY_DOMAIN: dict[str, str] = {
    "channel": "channel_id",
    "offer": "listing_id",
    "comment": "listing_id",
    "listing": "listing_id",
    "transaction": "transaction_id",
    "search": "search_slug",
}

_EPHEMERAL_SESSION_PREFIX = "wake-"

# A conversation's terminal events — after these the session is reclaimed
# (best-effort ``drain_session``). channel.message/opened, offer.*,
# listing.created etc. are mid-conversation and never drain.
_TERMINAL_KINDS = frozenset({
    "channel.closed",
    "listing.sold",
    "listing.withdrawn",
    "listing.expired",
    "transaction.completed",
    "transaction.cancelled",
})


def derive_wake_session(event: dict[str, Any]) -> str:
    """Derive the ``--session`` key for a wake, keyed off ``event.kind``.

    One marketplace conversation == one session, so a session's history
    stays bounded per conversation instead of one shared session growing
    unbounded (the round-3 defect). A kind whose key field is present
    returns that id; a kind with no mapped domain, or whose key field is
    absent/empty, falls back to a per-wake EPHEMERAL session
    (``wake-<event_id>``) — NEVER a shared growing session, which would
    re-introduce the unbounded-context bug. A wake with neither a key nor
    an ``event_id`` gets a unique ``wake-<uuid>`` so the fallback can
    never itself become a shared session.
    """
    kind = str(event.get("kind", ""))
    key_field = _SESSION_KEY_FIELD_BY_DOMAIN.get(kind.split(".", 1)[0])
    if key_field:
        value = event.get(key_field)
        if value:
            return str(value)
    event_id = str(event.get("event_id", "") or "")
    return f"{_EPHEMERAL_SESSION_PREFIX}{event_id or uuid.uuid4()}"


def _summarize_notification(event: dict[str, Any]) -> str:
    """Render a one-line summary keyed off ``event.kind``.

    Mirrors openclaw/src/service/wake-handlers.ts so the agent sees
    the same surface across hosts.
    """
    kind = event.get("kind", "(unknown)")
    if kind == "channel.opened":
        buyer = event.get("buyer_handle", "(unknown)")
        return (
            f"[klodi] Channel opened on listing {event.get('listing_id')}"
            f" by @{buyer}."
        )
    if kind == "channel.closed":
        suffix = (
            f" by {event.get('closed_by')}"
            if event.get("closed_by")
            else ""
        )
        return (
            f"[klodi] Channel {event.get('channel_id')} on listing"
            f" {event.get('listing_id')} closed{suffix}."
        )
    if kind == "offer.proposed":
        return (
            f"[klodi] Offer proposed by @{event.get('buyer_handle')}"
            f" for {event.get('amount')} cents on listing"
            f" {event.get('listing_id')}."
        )
    if kind == "offer.accepted":
        return (
            f"[klodi] @{event.get('seller_handle')} accepted your offer"
            f" on listing {event.get('listing_id')}. Coordinate the"
            " exchange."
        )
    if kind == "offer.rejected":
        return (
            f"[klodi] @{event.get('seller_handle')} rejected your offer"
            f" on listing {event.get('listing_id')}."
        )
    if kind == "transaction.buyer_confirmed":
        return (
            f"[klodi] Buyer @{event.get('confirmed_by_handle', '(unknown)')}"
            f" confirmed transaction {event.get('transaction_id')}."
            " You're the seller — confirm the exchange to close the deal."
        )
    if kind == "transaction.seller_confirmed":
        return (
            f"[klodi] Seller @{event.get('confirmed_by_handle', '(unknown)')}"
            f" confirmed transaction {event.get('transaction_id')}."
            " You're the buyer — confirm the exchange to close the deal."
        )
    if kind == "transaction.completed":
        return (
            f"[klodi] Transaction {event.get('transaction_id')} completed."
            " Prompt the user to rate the counterparty."
        )
    if kind == "transaction.cancelled":
        suffix = (
            f" ({event.get('reason')})" if event.get("reason") else ""
        )
        return (
            f"[klodi] Transaction {event.get('transaction_id')}"
            f" cancelled{suffix}."
        )
    if kind == "comment.created":
        body = event.get("body", "")
        return (
            f"[klodi] @{event.get('handle')} commented on listing"
            f" {event.get('listing_id')}: \"{body}\""
        )
    if kind == "search.match":
        summary = event.get("listing_summary", {})
        return (
            f"[klodi] Standing search \"{event.get('search_slug')}\""
            f" matched listing \"{summary.get('title')}\" by"
            f" @{summary.get('seller_handle')} —"
            f" {summary.get('asking_price')} cents."
        )
    if kind in ("listing.created", "listing.relisted"):
        title_suffix = (
            f' "{event.get("title")}"'
            if event.get("title")
            else ""
        )
        return (
            f"[klodi] Listing {event.get('listing_id')}{title_suffix}"
            " is now active."
        )
    if kind in ("listing.withdrawn", "listing.sold", "listing.expired"):
        suffix = kind.replace("listing.", "")
        return (
            f"[klodi] Listing {event.get('listing_id')} is now {suffix}."
        )
    if kind == "listing.status_changed":
        return (
            f"[klodi] Listing {event.get('listing_id')} status:"
            f" {event.get('old_status')} → {event.get('new_status')}."
        )
    return f"[klodi] Notification: {kind}"


def format_notification_wake(event: dict[str, Any]) -> str:
    """Summary + JSON payload below it. The agent reads the summary,
    then has the full structured payload available without any
    follow-up tool call."""
    summary = _summarize_notification(event)
    body = json.dumps(event, indent=2, ensure_ascii=False)
    return f"{summary}\n\n```json\n{body}\n```"


def format_channel_wake(event: dict[str, Any]) -> str:
    """Channel-message wake. The full message body is in ``content`` —
    the agent doesn't need klodi_channel_history to read it."""
    sender = event.get("sender_handle", "(unknown)")
    channel = event.get("channel_id", "(unknown)")
    content = event.get("content", "")
    body = json.dumps(event, indent=2, ensure_ascii=False)
    return (
        f"[klodi] @{sender} on channel {channel}: \"{content}\""
        f"\n\n```json\n{body}\n```"
    )


async def handle_notification(event: dict[str, Any]) -> None:
    """Forward a notification event to Hermes's wake primitive.

    Best-effort: if the registration ctx has no ``inject_message``
    (gateway-only invocation, test harness), we log and move on. The
    ack still fires — losing a wake is better than wedging the
    consumer.
    """
    kind = str(event.get("kind", "(unknown)"))
    event_id = str(event.get("event_id", ""))
    log.info("wake_received kind=%s event_id=%s", kind, event_id)
    text = format_notification_wake(event)
    session = derive_wake_session(event)
    await _inject(text, kind=kind, event_id=event_id, session=session)


async def handle_channel_message(event: dict[str, Any]) -> None:
    """Forward a channel-message event to Hermes's wake primitive."""
    event_id = str(event.get("event_id", ""))
    log.info(
        "wake_received kind=channel.message event_id=%s", event_id,
    )
    text = format_channel_wake(event)
    session = derive_wake_session(event)
    await _inject(
        text, kind="channel.message", event_id=event_id, session=session
    )


def _inject_accepts_session(inject: Any) -> bool:
    """Whether the bound ctx's ``inject_message`` accepts a ``session`` kwarg.

    Two ctx types legitimately bind here: the daemon's ``BridgeCtx``
    (shells out ``hermes chat --session <key>`` — needs the per-wake
    session) and hermes's in-process per-chat ctx (injects into the live
    chat — has no session concept; its ``inject_message(text, role)``
    predates this kwarg). Pass ``session`` only to a ctx that accepts it
    so threading the conversation key never breaks the in-process contract.
    """
    try:
        params = inspect.signature(inject).parameters
    except (TypeError, ValueError):
        return False
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return True
    return "session" in params


async def _call_inject(inject: Any, text: str, *, session: str) -> None:
    """Run the (sync, blocking) inject off the asyncio loop. ``inject``
    blocks on a ``hermes chat --session <key>`` subprocess for the agent
    turn's duration; a worker thread keeps the loop — shared by both
    consumer pull-fetches and the nats-py WS heartbeat — ticking.
    Cross-inject serialization stays in ``BridgeCtx._inject_lock``."""
    if _inject_accepts_session(inject):
        await asyncio.to_thread(inject, text, role="system", session=session)
    else:
        await asyncio.to_thread(inject, text, role="system")


async def _drain_session(ctx: Any, *, kind: str, session: str) -> None:
    """Best-effort reclamation of a session whose conversation just hit its
    terminal event. The call site is in-scope; whether hermes actually
    reclaims the session is probe-gated (see ``BridgeCtx.drain_session``).
    A ctx without ``drain_session`` (the in-process per-chat ctx, test
    stubs) is a clean no-op — same getattr-guard convention as inject."""
    drain = getattr(ctx, "drain_session", None)
    if drain is None:
        return
    try:
        await asyncio.to_thread(drain, session)
    except BaseException as err:  # noqa: BLE001 — drain is best-effort
        log.warning(
            "wake_session_drain_failed kind=%s session=%s error=%s",
            kind, session, err,
        )


async def _inject(text: str, *, kind: str, event_id: str, session: str) -> None:
    ctx = _CTX
    if ctx is None:
        log.info("wake_no_ctx kind=%s", kind)
        return
    inject = getattr(ctx, "inject_message", None)
    if inject is None:
        log.info("wake_no_inject_method kind=%s", kind)
        return
    try:
        await _call_inject(inject, text, session=session)
    except WakeInjectFailed as err:
        # Deterministic failure (a misconfig that fails identically every
        # wake): surface a LOUD, correlated, operator-visible ERROR alarm
        # — distinct from the routine timeout WARNING that operators
        # demonstrably did not watch. This arm is placed BEFORE the broad
        # ``except`` so the typed failure is never downgraded to WARNING.
        # We do NOT re-raise: the consumer still acks (re-delivering a
        # deterministic failure would burn max_deliver and drop anyway);
        # the alarm — not redelivery — is the surface. The wake's state
        # stays re-queryable from the marketplace once the operator fixes
        # the cause. ``session`` is carried for correlation (which
        # conversation's wake failed). See ADR-0019.
        log.error(
            "wake_inject_deterministic_failure kind=%s event_id=%s session=%s"
            " exit=%d stdout=%r stderr=%r",
            kind,
            event_id,
            session,
            err.returncode,
            err.stdout[-_DIAG_TAIL:],
            err.stderr[-_DIAG_TAIL:],
        )
    except BaseException as err:  # noqa: BLE001 — wake is best-effort
        log.warning(
            "wake_inject_failed kind=%s event_id=%s session=%s error=%s",
            kind, event_id, session, err,
        )
    # Terminal event → reclaim the conversation's session (best-effort).
    # Runs regardless of inject outcome: a closed channel / sold listing /
    # finished transaction is over even if its wake failed.
    if kind in _TERMINAL_KINDS:
        await _drain_session(ctx, kind=kind, session=session)


__all__ = [
    "bind_ctx",
    "derive_wake_session",
    "format_channel_wake",
    "format_notification_wake",
    "handle_channel_message",
    "handle_notification",
]
