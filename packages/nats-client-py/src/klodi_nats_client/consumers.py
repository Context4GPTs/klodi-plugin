"""Durable JetStream consumer wiring + dedup LRU.

Two consumers per user, attached to host-wake handlers via KlodiClient:

  * ``klodi-notifications-<user_id>`` on ``P2P_NOTIFICATIONS``
    ``filter_subject = p2p.v1.notifications.<user_id>`` (fixed)

  * ``klodi-channels-<user_id>`` on ``P2P_CHANNELS``
    ``filter_subjects = []`` (server-managed by the marketplace)

Library responsibilities (per the shared-contracts doc):

  * Create the consumer if absent, with the pinned config below; never
    mutate ``filter_subjects`` on the channels consumer.
  * Pull-fetch in a background loop, parse JSON, dedup on ``event_id``,
    invoke the handler, ack on success / nak on exception.
  * Stop cleanly when the caller calls ``ActiveSubscription.stop()``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from nats.aio.msg import Msg
from nats.errors import TimeoutError as NatsTimeoutError
from nats.js import JetStreamContext
from nats.js.errors import NotFoundError

from klodi_nats_client.backoff import BackoffPolicy
from klodi_nats_client.events import (
    ChannelMessageEvent,
    NotificationEvent,
)
from klodi_nats_client.metrics import MutableMetrics


class KlodiSetupError(Exception):
    """Raised when a server-managed durable consumer is missing.

    Per **D § D5 + D7** the per-user JWT no longer carries
    ``CONSUMER.CREATE``; consumers are provisioned server-side by the
    marketplace at user registration. If the client subscribes before
    the marketplace's provisioning pass has run, this exception
    surfaces with a stable code so the host adapter can map it to a
    ``klodi_setup_status`` issue (``consumer_missing``) and prompt the
    user to re-register.

    Stable codes:
      * ``notifications_consumer_missing``
      * ``channels_consumer_missing``
    """

    __slots__ = ("code",)

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code

log = logging.getLogger("klodi_nats_client.consumers")

NOTIFICATIONS_STREAM = "P2P_NOTIFICATIONS"
CHANNELS_STREAM = "P2P_CHANNELS"

# Shared durable-consumer config from the pinned shared-contracts doc.
ACK_WAIT_SECONDS = 30.0
MAX_ACK_PENDING = 1
MAX_DELIVER = 5

# In-memory dedup window per consumer.
DEDUP_LRU_SIZE = 1_000

# Pull-fetch tunables — match TS client behavior.
_FETCH_BATCH = 1
_FETCH_TIMEOUT_SECONDS = 5.0


NotificationHandler = Callable[[NotificationEvent], Awaitable[None]]
ChannelHandler = Callable[[ChannelMessageEvent], Awaitable[None]]
ErrorSink = Callable[[BaseException], None]
Sleeper = Callable[[float], Awaitable[None]]


class _EventIdLru:
    """Bounded ordered set keyed by ``event_id``.

    Restart-induced duplicates are rare and benign (the agent's
    idempotency handling absorbs double-wakes), so we keep this in
    memory and lose state on plugin restart.

    ``has()`` and ``remember()`` BOTH refresh recency on a hit so an
    actively-redelivered ``event_id`` is never evicted while still in
    flight. Mirrors the TS ``Map``-backed equivalent and the Rust
    `lru::LruCache::get`-on-read pattern.
    """

    __slots__ = ("_seen",)

    def __init__(self) -> None:
        self._seen: OrderedDict[str, None] = OrderedDict()

    def has(self, event_id: str) -> bool:
        if event_id not in self._seen:
            return False
        self._seen.move_to_end(event_id)
        return True

    def remember(self, event_id: str) -> None:
        if event_id in self._seen:
            self._seen.move_to_end(event_id)
            return
        self._seen[event_id] = None
        if len(self._seen) > DEDUP_LRU_SIZE:
            self._seen.popitem(last=False)


@dataclass
class ActiveSubscription:
    """Handle to a running pull-fetch loop. ``stop()`` is idempotent."""

    _task: asyncio.Task[None]
    _stop_event: asyncio.Event

    async def stop(self) -> None:
        if self._stop_event.is_set():
            return
        self._stop_event.set()
        try:
            await self._task
        except asyncio.CancelledError:
            return

    def get_last_event_at(self) -> None:
        """Mirror of the TS ``ActiveSubscription.getLastEventAt`` surface.

        The Python consume loop does not yet track per-event timestamps;
        the field is reserved so the cross-language ``WakePump.health``
        surface stays uniform. Returns ``None`` until the loop populates
        it (follow-up tracked alongside ``MutableMetrics``).
        """
        return None

    def get_inactive_threshold_ms(self) -> None:
        """Mirror of TS ``ActiveSubscription.getInactiveThresholdMs``."""
        return None


async def _assert_consumer_exists(
    js: JetStreamContext,
    stream: str,
    durable: str,
    missing_code: str,
) -> Any:
    """Defensive ``consumer_info`` check.

    Per **D § D5 + D7** the per-user JWT does not carry
    ``CONSUMER.CREATE``; consumers are server-managed. The client
    treats absence as a setup-phase failure rather than silently
    fixing it — a missing consumer means either the user never
    finished registration, the marketplace didn't run its
    provisioning pass, or a manual operator intervention deleted it.
    All three need a human fix.

    Returns the ``ConsumerInfo`` so callers can seed observability
    fields (``num_pending``) on subscribe. Raises :class:`KlodiSetupError`
    with ``code=missing_code`` if the consumer is missing.
    """
    try:
        return await js.consumer_info(stream, durable)
    except NotFoundError as exc:
        raise KlodiSetupError(
            missing_code,
            f"{missing_code}: durable={durable} stream={stream}. "
            "Consumers are server-managed (D5/D7) — re-run klodi_register or contact support.",
        ) from exc


def _redelivery_of(msg: Msg) -> int:
    """Read "this is the Nth redelivery" off a JetStream message.

    ``msg.metadata.num_delivered`` is 1-based (first delivery = 1, second
    delivery = 2 …) — so the redelivery count is ``num_delivered - 1``.
    Mirrors the TS / Rust accessors so the cross-language counter values
    are comparable. Returns 0 when metadata is missing or non-numeric
    (legacy / mocked tests, non-JetStream messages).
    """
    try:
        delivered = msg.metadata.num_delivered
    except Exception:  # noqa: BLE001 — non-JetStream msg or missing metadata
        return 0
    if not isinstance(delivered, int) or isinstance(delivered, bool):
        return 0
    return delivered - 1 if delivered > 1 else 0


def _pending_of(msg: Msg) -> int | None:
    """Read per-message pending count for the live ``pending_count`` gauge."""
    try:
        pending = msg.metadata.num_pending
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(pending, int) or isinstance(pending, bool):
        return None
    return pending if pending >= 0 else None


async def _dispatch_message(
    msg: Msg,
    lru: _EventIdLru,
    handler: Callable[[Any], Awaitable[None]],
    on_error: ErrorSink,
    metrics: MutableMetrics | None = None,
) -> None:
    """Parse, dedup, dispatch, ack/nak — single message path.

    ``metrics`` is optional so existing direct callers (tests, contract
    harness) keep working; the production consume loop always passes
    one.
    """
    if metrics is not None:
        metrics.inc_consumed()
        metrics.add_redelivery(_redelivery_of(msg))
        pending = _pending_of(msg)
        if pending is not None:
            metrics.set_pending(pending)
    try:
        payload = json.loads(msg.data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        on_error(
            RuntimeError(
                f"consumer_parse_failed subject={msg.subject} error={err}"
            )
        )
        # Malformed payloads can never succeed — ack so we don't loop.
        await msg.ack()
        if metrics is not None:
            metrics.inc_acked()
        return

    event_id = payload.get("event_id") if isinstance(payload, dict) else None
    if isinstance(event_id, str) and lru.has(event_id):
        await msg.ack()
        if metrics is not None:
            metrics.inc_dedup_hit()
            metrics.inc_acked()
        return

    try:
        await handler(payload)
    except BaseException as err:  # noqa: BLE001 — surface to error sink
        on_error(err)
        await msg.nak()
        if metrics is not None:
            metrics.inc_naked()
        return

    if isinstance(event_id, str):
        lru.remember(event_id)
    await msg.ack()
    if metrics is not None:
        metrics.inc_acked()


async def _bind_pull_subscription(
    js: JetStreamContext,
    stream: str,
    durable: str,
    missing_code: str,
) -> Any:
    """Bind a pull subscription, mapping a deleted durable to a typed
    setup error.

    A ``NotFoundError`` on (re-)bind means the server-managed durable
    (D5/D7) is gone — a human fix, not a transient flap. Surface it as
    :class:`KlodiSetupError` so the loop ends loudly instead of spinning
    forever on a hard-down consumer (the re-bind-storm failure mode).
    """
    try:
        return await js.pull_subscribe_bind(consumer=durable, stream=stream)
    except NotFoundError as exc:
        raise KlodiSetupError(
            missing_code,
            f"{missing_code}: durable={durable} stream={stream} deleted "
            "server-side (D5/D7) during a transport flap — re-run "
            "klodi_register or contact support.",
        ) from exc


async def _consume_loop(
    js: JetStreamContext,
    stream: str,
    durable: str,
    handler: Callable[[Any], Awaitable[None]],
    on_error: ErrorSink,
    stop_event: asyncio.Event,
    metrics: MutableMetrics | None = None,
    *,
    missing_code: str = "consumer_missing",
    sleep: Sleeper | None = None,
    backoff: BackoffPolicy | None = None,
) -> None:
    """Reconnect-resilient pull-fetch loop. Exits when ``stop_event`` set.

    A transport flap (``nats: unexpected EOF`` / 502) drops the bound
    pull subscription; nats-py reconnects the WS, but the bound
    subscription's deliver inbox can go stale and never resume. So on a
    transport-level fetch error we discard the stale ``sub``, back off
    exponentially (the cross-language ``BackoffPolicy``, not a flat 1s),
    and re-bind IN PLACE — emitting ``consumer_resubscribe`` so a
    never-resuming loop is visible rather than a silent wedge (INV-1).

    Load-bearing invariant: the dedup ``_EventIdLru`` is created ONCE and
    preserved across re-binds. A durable consumer resumes from its last
    ack, so a wake delivered-but-unacked during the blip is redelivered;
    the surviving LRU recognises it (``has`` → ack + dedup) and never
    double-injects. Tearing the loop down to re-subscribe would reset the
    LRU and reintroduce the double-wake — hence in-place re-bind only.

    ``sleep``/``backoff`` are injectable seams for deterministic tests;
    production uses a stop-aware sleep so a pending stop interrupts the
    backoff instead of blocking for the full cap.
    """
    policy = backoff if backoff is not None else BackoffPolicy()

    async def _stop_aware_sleep(delay: float) -> None:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay)
        except (asyncio.TimeoutError, TimeoutError):
            return

    sleep_fn = sleep if sleep is not None else _stop_aware_sleep

    lru = _EventIdLru()
    sub: Any = None
    bound_once = False
    try:
        while not stop_event.is_set():
            if sub is None:
                try:
                    sub = await _bind_pull_subscription(
                        js, stream, durable, missing_code
                    )
                except (KlodiSetupError, asyncio.CancelledError):
                    raise
                except BaseException as err:  # noqa: BLE001 — bind flap, retry
                    on_error(err)
                    await sleep_fn(policy.next_delay())
                    continue
                if bound_once:
                    if metrics is not None:
                        metrics.inc_resubscribe()
                    log.info(
                        "consumer_resubscribe durable=%s stream=%s attempt=%d",
                        durable, stream, policy.attempt,
                    )
                bound_once = True
            try:
                msgs = await sub.fetch(
                    batch=_FETCH_BATCH,
                    timeout=_FETCH_TIMEOUT_SECONDS,
                )
            except NatsTimeoutError:
                # Normal — no messages waiting. Healthy poll → reset cursor.
                policy.reset()
                continue
            except asyncio.CancelledError:
                raise
            except BaseException as err:  # noqa: BLE001 — transport drop
                on_error(err)
                # Drop the (presumed-dead) sub WITHOUT awaiting an
                # unsubscribe that could hang on a broken connection; the
                # server-side durable is untouched. Re-bind next iteration.
                sub = None
                await sleep_fn(policy.next_delay())
                continue
            policy.reset()
            for msg in msgs:
                await _dispatch_message(msg, lru, handler, on_error, metrics)
    finally:
        if sub is not None:
            try:
                await sub.unsubscribe()
            except BaseException as err:  # noqa: BLE001 — best-effort
                on_error(err)


def _seed_pending_from_info(info: Any, metrics: MutableMetrics | None) -> None:
    """Best-effort: read ``num_pending`` from ConsumerInfo and seed metrics."""
    if metrics is None or info is None:
        return
    pending = getattr(info, "num_pending", None)
    if pending is None:
        # nats-py exposes a nested ``ConsumerInfo`` whose ``num_pending``
        # may live on a sub-attribute depending on the python-nats
        # release; treat absence as "leave the gauge alone".
        return
    if isinstance(pending, int) and pending >= 0:
        metrics.set_pending(pending)


async def subscribe_notifications(
    js: JetStreamContext,
    user_id: str,
    handler: NotificationHandler,
    on_error: ErrorSink,
    metrics: MutableMetrics | None = None,
) -> ActiveSubscription:
    """Attach a handler to the per-user notifications consumer.

    Library creates the durable consumer if absent and starts a
    background pull loop. Each delivered event is parsed, deduped on
    ``event_id``, and passed to the handler. Resolved → ack. Raised → nak.

    Per **R § P2-12**: the handler is invoked directly without any
    intermediate ``_wrapped`` wrapper — the typed
    ``NotificationHandler`` signature is the contract.
    """
    durable = f"klodi-notifications-{user_id}"
    info = await _assert_consumer_exists(
        js,
        NOTIFICATIONS_STREAM,
        durable,
        "notifications_consumer_missing",
    )
    _seed_pending_from_info(info, metrics)

    stop_event = asyncio.Event()

    async def _runner() -> None:
        await _consume_loop(
            js,
            NOTIFICATIONS_STREAM,
            durable,
            handler,
            on_error,
            stop_event,
            metrics,
            missing_code="notifications_consumer_missing",
        )

    task = asyncio.create_task(
        _runner(),
        name=f"klodi-notifications-{user_id}",
    )
    return ActiveSubscription(_task=task, _stop_event=stop_event)


async def subscribe_channels(
    js: JetStreamContext,
    user_id: str,
    handler: ChannelHandler,
    on_error: ErrorSink,
    metrics: MutableMetrics | None = None,
) -> ActiveSubscription:
    """Attach a handler to the per-user channels consumer.

    ``filter_subjects`` is server-managed — the marketplace mutates it
    on channel create/close. This library never sets or modifies it.

    Per **R § P2-12**: the handler is invoked directly without any
    intermediate ``_wrapped`` wrapper.
    """
    durable = f"klodi-channels-{user_id}"
    info = await _assert_consumer_exists(
        js,
        CHANNELS_STREAM,
        durable,
        "channels_consumer_missing",
    )
    _seed_pending_from_info(info, metrics)

    stop_event = asyncio.Event()

    async def _runner() -> None:
        await _consume_loop(
            js,
            CHANNELS_STREAM,
            durable,
            handler,
            on_error,
            stop_event,
            metrics,
            missing_code="channels_consumer_missing",
        )

    task = asyncio.create_task(
        _runner(),
        name=f"klodi-channels-{user_id}",
    )
    return ActiveSubscription(_task=task, _stop_event=stop_event)


__all__ = [
    "ACK_WAIT_SECONDS",
    "ActiveSubscription",
    "CHANNELS_STREAM",
    "ChannelHandler",
    "DEDUP_LRU_SIZE",
    "ErrorSink",
    "KlodiSetupError",
    "MAX_ACK_PENDING",
    "MAX_DELIVER",
    "NOTIFICATIONS_STREAM",
    "NotificationHandler",
    "subscribe_channels",
    "subscribe_notifications",
]
