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

Hermes's daemon is long-running; the connection lives for the
daemon's lifetime, and consumer pull loops live on a dedicated
asyncio thread (see ``client.py``).
"""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger("klodi_hermes.wake")

_CTX: Any = None


def bind_ctx(ctx: Any) -> None:
    """Capture the Hermes registration context so wake handlers can
    reach the running session via ``inject_message``."""
    global _CTX
    _CTX = ctx


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
    _inject(text, kind=kind)


async def handle_channel_message(event: dict[str, Any]) -> None:
    """Forward a channel-message event to Hermes's wake primitive."""
    event_id = str(event.get("event_id", ""))
    log.info(
        "wake_received kind=channel.message event_id=%s", event_id,
    )
    text = format_channel_wake(event)
    _inject(text, kind="channel.message")


def _inject(text: str, *, kind: str) -> None:
    ctx = _CTX
    if ctx is None:
        log.info("wake_no_ctx kind=%s", kind)
        return
    inject = getattr(ctx, "inject_message", None)
    if inject is None:
        log.info("wake_no_inject_method kind=%s", kind)
        return
    try:
        inject(text, role="system")
    except BaseException as err:  # noqa: BLE001 — wake is best-effort
        log.warning("wake_inject_failed kind=%s error=%s", kind, err)


__all__ = [
    "bind_ctx",
    "format_channel_wake",
    "format_notification_wake",
    "handle_channel_message",
    "handle_notification",
]
