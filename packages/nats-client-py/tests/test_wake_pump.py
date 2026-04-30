"""Unit tests for the host-agnostic ``WakePump``
(per ``docs/plans/2026-04-28-host-agnostic-wake-pump.md``).

The pump owns subscribe ownership for both notification and channel
consumers and exposes a uniform start/stop/health surface that every
adapter (openclaw, hermes, future Rust daemon) plugs handlers into.
These tests pin the contract: idempotent start, deterministic dispatch,
throw-propagation so the inner consume loop can nak, idempotent stop,
per-``user_id`` singleton with registry release on stop,
retry-on-transient-subscribe-failure, and faithful health reporting
from the inner subscriptions.

Mirror of ``klodi-plugin/packages/nats-client-ts/tests/wake-pump.test.ts``
— the public surface and behavior must stay byte-comparable across the
TS and Python ports.

The implementation does not exist yet — running this suite is expected
to fail (RED phase of TDD).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from klodi_nats_client.wake_pump import (  # type: ignore[import-not-found]
    WakePump,
    WakePumpClient,
    __reset_wake_pump_registry_for_tests,
    create_wake_pump,
)


# ── Fakes ────────────────────────────────────────────────────────────


class _FakeInnerSub:
    """Minimal stand-in for ``ActiveSubscriptionLike``.

    The pump only consumes three methods. We expose mocks so each test
    can assert call counts and seed return values.
    """

    def __init__(
        self,
        last_event_at: datetime | None = None,
        inactive_threshold_ms: int | None = None,
    ) -> None:
        self.stop = AsyncMock(return_value=None)
        self.get_last_event_at = MagicMock(return_value=last_event_at)
        self.get_inactive_threshold_ms = MagicMock(
            return_value=inactive_threshold_ms,
        )


class _FakeClient:
    """Captures the wrapped handlers the pump passes to subscribe_*.

    ``pending_notify_error`` lets a test drive a transient failure
    followed by a successful retry without rebuilding the fake.
    """

    def __init__(
        self,
        notify_sub: _FakeInnerSub | None = None,
        channel_sub: _FakeInnerSub | None = None,
        is_connected: bool = True,
    ) -> None:
        self.notify_sub: _FakeInnerSub = notify_sub or _FakeInnerSub()
        self.channel_sub: _FakeInnerSub = channel_sub or _FakeInnerSub()
        self._is_connected: bool = is_connected
        self._captured_notify: (
            Callable[[dict[str, Any]], Awaitable[None]] | None
        ) = None
        self._captured_channel: (
            Callable[[dict[str, Any]], Awaitable[None]] | None
        ) = None
        self.pending_notify_error: BaseException | None = None
        # AsyncMock wrappers so tests can assert call counts cleanly.
        self.subscribe_notifications = AsyncMock(
            side_effect=self._do_subscribe_notifications,
        )
        self.subscribe_channels = AsyncMock(
            side_effect=self._do_subscribe_channels,
        )

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    async def _do_subscribe_notifications(
        self,
        handler: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> _FakeInnerSub:
        if self.pending_notify_error is not None:
            err = self.pending_notify_error
            self.pending_notify_error = None
            raise err
        self._captured_notify = handler
        return self.notify_sub

    async def _do_subscribe_channels(
        self,
        handler: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> _FakeInnerSub:
        self._captured_channel = handler
        return self.channel_sub

    def notify_handler(self) -> Callable[[dict[str, Any]], Awaitable[None]]:
        if self._captured_notify is None:
            raise AssertionError("notification handler not yet captured")
        return self._captured_notify

    def channel_handler(self) -> Callable[[dict[str, Any]], Awaitable[None]]:
        if self._captured_channel is None:
            raise AssertionError("channel handler not yet captured")
        return self._captured_channel

    def as_pump_client(self) -> WakePumpClient:
        # Duck-typed: the fake satisfies the WakePumpClient Protocol.
        return self  # type: ignore[return-value]


def _make_handlers() -> tuple[
    Callable[[dict[str, Any]], Awaitable[None]],
    Callable[[dict[str, Any]], Awaitable[None]],
    AsyncMock,
    AsyncMock,
]:
    """Return ``(on_notification, on_channel_event, *_mocks_for_assert)``."""
    on_notification = AsyncMock(return_value=None)
    on_channel_event = AsyncMock(return_value=None)
    return on_notification, on_channel_event, on_notification, on_channel_event


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    """Drop the singleton registry between tests so create_wake_pump
    always returns a fresh instance for the same user_id."""
    __reset_wake_pump_registry_for_tests()


# ── Tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_subscribes_both_consumers_once_when_called_twice() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()
    pump: WakePump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )

    # Act
    await pump.start()
    await pump.start()

    # Assert
    assert fake.subscribe_notifications.await_count == 1
    assert fake.subscribe_channels.await_count == 1
    assert pump.health().running is True


@pytest.mark.asyncio
async def test_dispatches_notifications_through_configured_handler() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, notify_mock, channel_mock = (
        _make_handlers()
    )
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )
    await pump.start()

    event_a: dict[str, Any] = {"event_id": "evt-1", "kind": "channel.message"}
    event_b: dict[str, Any] = {"event_id": "evt-2", "kind": "search.match"}

    # Act
    await fake.notify_handler()(event_a)
    await fake.notify_handler()(event_b)

    # Assert — order preserved, channel handler never invoked.
    assert notify_mock.await_count == 2
    assert notify_mock.await_args_list[0].args[0] is event_a
    assert notify_mock.await_args_list[1].args[0] is event_b
    assert channel_mock.await_count == 0


@pytest.mark.asyncio
async def test_dispatches_channel_events_through_configured_handler() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, notify_mock, channel_mock = (
        _make_handlers()
    )
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )
    await pump.start()

    event_a: dict[str, Any] = {"event_id": "evt-1", "kind": "channel.opened"}
    event_b: dict[str, Any] = {"event_id": "evt-2", "kind": "channel.message"}

    # Act
    await fake.channel_handler()(event_a)
    await fake.channel_handler()(event_b)

    # Assert
    assert channel_mock.await_count == 2
    assert channel_mock.await_args_list[0].args[0] is event_a
    assert channel_mock.await_args_list[1].args[0] is event_b
    assert notify_mock.await_count == 0


@pytest.mark.asyncio
async def test_propagates_handler_throws_for_consume_loop_to_nak() -> None:
    """A throw from the user-supplied notification handler must
    propagate out of the pump-wrapped handler so the inner consume loop
    can nak the message and let JetStream redeliver."""
    # Arrange
    fake = _FakeClient()

    async def boom(_event: dict[str, Any]) -> None:
        raise RuntimeError("handler boom")

    boom_mock = AsyncMock(side_effect=boom)
    on_channel_event = AsyncMock(return_value=None)
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        boom_mock,
        on_channel_event,
    )
    await pump.start()

    # Act + Assert
    with pytest.raises(RuntimeError, match="handler boom"):
        await fake.notify_handler()({"event_id": "evt-1"})
    assert boom_mock.await_count == 1


@pytest.mark.asyncio
async def test_stop_stops_both_inner_subs_and_flips_running_flag() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )

    # Act
    await pump.start()
    await pump.stop()

    # Assert
    assert fake.notify_sub.stop.await_count == 1
    assert fake.channel_sub.stop.await_count == 1
    assert pump.health().running is False


@pytest.mark.asyncio
async def test_stop_is_idempotent_second_call_is_noop() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )

    # Act
    await pump.start()
    await pump.stop()
    await pump.stop()

    # Assert — inner stop runs only once across two stop() calls.
    assert fake.notify_sub.stop.await_count == 1
    assert fake.channel_sub.stop.await_count == 1


def test_returns_same_singleton_for_same_user_id() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()

    # Act
    first = create_wake_pump(
        fake.as_pump_client(),
        "user-x",
        on_notification,
        on_channel_event,
    )
    second = create_wake_pump(
        fake.as_pump_client(),
        "user-x",
        on_notification,
        on_channel_event,
    )

    # Assert
    assert second is first


def test_returns_distinct_pumps_for_different_user_ids() -> None:
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()

    # Act
    pump_a = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )
    pump_b = create_wake_pump(
        fake.as_pump_client(),
        "user-b",
        on_notification,
        on_channel_event,
    )

    # Assert
    assert pump_a is not pump_b


@pytest.mark.asyncio
async def test_retries_subscribe_with_backoff_after_transient_error() -> None:
    """First subscribe_notifications raises a transient error; the
    pump's inner retry loop must catch, sleep per the (overridden)
    backoff schedule, and re-attempt — at which point the second call
    succeeds and start() resolves cleanly."""
    # Arrange
    fake = _FakeClient()
    fake.pending_notify_error = RuntimeError("transient: socket closed")
    on_notification, on_channel_event, _, _ = _make_handlers()

    # Override the backoff to zero so the test is deterministic + fast.
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
        retry_delay_seconds=lambda _attempt: 0.0,
    )

    # Act
    await pump.start()

    # Assert — exactly two attempts: one failure + one success.
    assert fake.subscribe_notifications.await_count == 2
    assert pump.health().running is True


@pytest.mark.asyncio
async def test_health_reports_last_event_timestamps_from_inner_subs() -> None:
    # Arrange
    notify_at = datetime(2026, 4, 28, 10, 0, 0, tzinfo=timezone.utc)
    channel_at = datetime(2026, 4, 28, 10, 5, 0, tzinfo=timezone.utc)
    fake = _FakeClient(
        notify_sub=_FakeInnerSub(
            last_event_at=notify_at,
            inactive_threshold_ms=30_000,
        ),
        channel_sub=_FakeInnerSub(
            last_event_at=channel_at,
            inactive_threshold_ms=60_000,
        ),
    )
    on_notification, on_channel_event, _, _ = _make_handlers()
    pump = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )
    await pump.start()

    # Act
    health = pump.health()

    # Assert
    assert health.user_id == "user-a"
    assert health.running is True
    assert health.notifications_last_event_at == notify_at
    assert health.channels_last_event_at == channel_at
    assert health.notifications_inactive_threshold_ms == 30_000
    assert health.channels_inactive_threshold_ms == 60_000


@pytest.mark.asyncio
async def test_disposed_pump_can_be_recreated_after_stop() -> None:
    """After stop(), the singleton registry must release the slot so a
    fresh create_wake_pump for the same user yields a new instance.
    Without this, klodi_setup_repair (which clears creds and re-registers)
    would re-bind to a dead pump."""
    # Arrange
    fake = _FakeClient()
    on_notification, on_channel_event, _, _ = _make_handlers()

    # Act
    first = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )
    await first.start()
    await first.stop()
    second = create_wake_pump(
        fake.as_pump_client(),
        "user-a",
        on_notification,
        on_channel_event,
    )

    # Assert
    assert second is not first
