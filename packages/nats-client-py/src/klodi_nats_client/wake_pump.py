"""Host-agnostic wake pump (Python port).

Mirror of ``klodi-plugin/packages/nats-client-ts/src/wake-pump.ts``. The
pump composes the two underlying subscribe calls (notifications +
channels) on a ``KlodiClient``-shaped client into one cohesive lifecycle
(start / stop / health) and singletonises per ``user_id`` so the same
persona never accidentally runs two competing pumps inside the same
process.

Per ``docs/plans/2026-04-28-host-agnostic-wake-pump.md``: this module
moves subscribe ownership out of each adapter's lifecycle wiring into the
shared library so adapters shrink to handler wiring (~20 lines).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

log = logging.getLogger("klodi_nats_client.wake_pump")

OnNotification = Callable[[dict[str, Any]], Awaitable[None]]
OnChannelEvent = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class WakePumpHealth:
    """Diagnostic snapshot of pump state."""

    running: bool
    user_id: str
    notifications_last_event_at: datetime | None
    channels_last_event_at: datetime | None
    notifications_inactive_threshold_ms: int | None
    channels_inactive_threshold_ms: int | None


@runtime_checkable
class _ActiveSubscriptionLike(Protocol):
    """Narrow surface the pump needs from an inner subscription."""

    async def stop(self) -> None: ...

    def get_last_event_at(self) -> datetime | None: ...

    def get_inactive_threshold_ms(self) -> int | None: ...


@runtime_checkable
class WakePumpClient(Protocol):
    """Minimal client surface the pump depends on."""

    @property
    def is_connected(self) -> bool: ...

    async def subscribe_notifications(
        self, handler: OnNotification,
    ) -> _ActiveSubscriptionLike: ...

    async def subscribe_channels(
        self, handler: OnChannelEvent,
    ) -> _ActiveSubscriptionLike: ...


_DEFAULT_MAX_START_ATTEMPTS = 5


def _default_retry_delay_seconds(attempt: int) -> float:
    """Linear backoff capped at 30s (matches the TS port)."""
    return min(float(attempt), 30.0)


_registry: dict[str, "WakePump"] = {}


class WakePump:
    """Host-agnostic wake pump.

    Construct via :func:`create_wake_pump`; the registry de-dupes
    instances per ``user_id``.
    """

    __slots__ = (
        "_client",
        "_user_id",
        "_on_notification",
        "_on_channel_event",
        "_retry_delay_seconds",
        "_max_attempts",
        "_running",
        "_notifications_sub",
        "_channels_sub",
    )

    def __init__(
        self,
        client: WakePumpClient,
        user_id: str,
        on_notification: OnNotification,
        on_channel_event: OnChannelEvent,
        *,
        retry_delay_seconds: Callable[[int], float],
        max_start_attempts: int,
    ) -> None:
        self._client: WakePumpClient = client
        self._user_id: str = user_id
        self._on_notification: OnNotification = on_notification
        self._on_channel_event: OnChannelEvent = on_channel_event
        self._retry_delay_seconds: Callable[[int], float] = retry_delay_seconds
        self._max_attempts: int = max_start_attempts
        self._running: bool = False
        self._notifications_sub: _ActiveSubscriptionLike | None = None
        self._channels_sub: _ActiveSubscriptionLike | None = None

    async def start(self) -> None:
        """Attach both consumers. Idempotent — re-call is a no-op when
        the pump is already running."""
        if self._running:
            return
        self._notifications_sub = await self._attach_with_retry(
            self._client.subscribe_notifications,
            self._on_notification,
            label="notifications",
        )
        try:
            self._channels_sub = await self._attach_with_retry(
                self._client.subscribe_channels,
                self._on_channel_event,
                label="channels",
            )
        except Exception:
            # Notifications attached but channels failed — tear
            # notifications down so the pump never half-starts.
            if self._notifications_sub is not None:
                await _safe_stop(self._notifications_sub)
                self._notifications_sub = None
            raise
        self._running = True
        log.info(
            "wake_pump_started user_id=%s",
            self._user_id,
        )

    async def stop(self) -> None:
        """Detach both consumers and release the registry slot.

        Idempotent — second call is a no-op.
        """
        if (
            not self._running
            and self._notifications_sub is None
            and self._channels_sub is None
        ):
            _registry.pop(self._user_id, None)
            return
        if self._notifications_sub is not None:
            await _safe_stop(self._notifications_sub)
            self._notifications_sub = None
        if self._channels_sub is not None:
            await _safe_stop(self._channels_sub)
            self._channels_sub = None
        self._running = False
        _registry.pop(self._user_id, None)
        log.info("wake_pump_stopped user_id=%s", self._user_id)

    def health(self) -> WakePumpHealth:
        return WakePumpHealth(
            running=self._running,
            user_id=self._user_id,
            notifications_last_event_at=(
                self._notifications_sub.get_last_event_at()
                if self._notifications_sub is not None
                else None
            ),
            channels_last_event_at=(
                self._channels_sub.get_last_event_at()
                if self._channels_sub is not None
                else None
            ),
            notifications_inactive_threshold_ms=(
                self._notifications_sub.get_inactive_threshold_ms()
                if self._notifications_sub is not None
                else None
            ),
            channels_inactive_threshold_ms=(
                self._channels_sub.get_inactive_threshold_ms()
                if self._channels_sub is not None
                else None
            ),
        )

    async def _attach_with_retry(
        self,
        attach: Callable[
            [Callable[[dict[str, Any]], Awaitable[None]]],
            Awaitable[_ActiveSubscriptionLike],
        ],
        handler: Callable[[dict[str, Any]], Awaitable[None]],
        *,
        label: str,
    ) -> _ActiveSubscriptionLike:
        last_err: BaseException | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await attach(handler)
            except Exception as err:
                last_err = err
                if attempt >= self._max_attempts:
                    break
                delay = self._retry_delay_seconds(attempt)
                if delay > 0:
                    await asyncio.sleep(delay)
        raise RuntimeError(
            f"wake_pump_{label}_attach_failed: {last_err}",
        )


async def _safe_stop(sub: _ActiveSubscriptionLike) -> None:
    """Best-effort stop — never raises; the inner consume loop's error
    sink already surfaced the underlying issue."""
    try:
        await sub.stop()
    except BaseException as err:  # noqa: BLE001 — best-effort
        log.warning("wake_pump_inner_stop_failed error=%s", err)


def create_wake_pump(
    client: WakePumpClient,
    user_id: str,
    on_notification: OnNotification,
    on_channel_event: OnChannelEvent,
    *,
    retry_delay_seconds: Callable[[int], float] | None = None,
    max_start_attempts: int = _DEFAULT_MAX_START_ATTEMPTS,
) -> WakePump:
    """Construct (or reuse) the pump for ``user_id``.

    Subsequent calls with the same ``user_id`` return the existing
    instance unchanged; the second caller's handlers are silently
    discarded so two adapter wirings for the same persona can never
    interleave on the same JetStream consumer.
    """
    existing = _registry.get(user_id)
    if existing is not None:
        return existing
    pump = WakePump(
        client,
        user_id,
        on_notification,
        on_channel_event,
        retry_delay_seconds=(
            retry_delay_seconds
            if retry_delay_seconds is not None
            else _default_retry_delay_seconds
        ),
        max_start_attempts=max_start_attempts,
    )
    _registry[user_id] = pump
    return pump


def __reset_wake_pump_registry_for_tests() -> None:
    """Test escape hatch — clear the singleton registry so a fresh
    ``create_wake_pump`` call returns a new instance between tests."""
    _registry.clear()


__all__ = [
    "OnChannelEvent",
    "OnNotification",
    "WakePump",
    "WakePumpClient",
    "WakePumpHealth",
    "__reset_wake_pump_registry_for_tests",
    "create_wake_pump",
]
