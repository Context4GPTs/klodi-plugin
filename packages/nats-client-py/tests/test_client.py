"""Unit tests for klodi-nats-client.

Boundary mocks only. Tests verify behavior exposed through the public
API: request envelope shape, dedup against ``max_deliver: 5``, subscribe
handler invocation, publish subject + body shape, config + creds
validation.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from klodi_nats_client import (
    TOOL_SCHEMAS,
    TOOL_SUBJECTS,
    ConfigInvalidError,
    ConfigNotFoundError,
    CredsNotFoundError,
    KlodiClient,
    KlodiRequestError,
    load_config,
    load_creds,
)
from klodi_nats_client.consumers import (
    _EventIdLru,
    _dispatch_message,
)
from klodi_nats_client.publish import publish_channel_message


# ── Catalog ───────────────────────────────────────────────────────────


def test_catalog_loads_every_klodi_tool() -> None:
    """Schema bundle must yield every klodi_* tool with subject + schemas."""
    assert len(TOOL_SUBJECTS) > 0
    for name, subject in TOOL_SUBJECTS.items():
        assert name.startswith("klodi_"), name
        assert subject.startswith("p2p.v1."), subject
        schema = TOOL_SCHEMAS[name]
        assert schema["subject"] == subject
        assert schema["params"]["type"] == "object"
        assert schema["result"]["type"] == "object"


def test_catalog_includes_recently_added_tools() -> None:
    """Sanity: 0012 spec adds searches.* and renames channels.send →
    direct publish. The subjects mirror the shared-contracts doc."""
    assert TOOL_SUBJECTS["klodi_list_create"] == "p2p.v1.listings.create"
    assert TOOL_SUBJECTS["klodi_whoami"] == "p2p.v1.users.whoami"
    # channels.send is gone — channel messages are direct-publish now.
    assert "klodi_channel_send" not in TOOL_SUBJECTS


# ── Config / creds ────────────────────────────────────────────────────


def test_load_config_valid(tmp_path: Path) -> None:
    cfg = {
        "handle": "alice",
        "user_id": "00000000-0000-0000-0000-000000000001",
        "nkey_public": "UABCD",
        "nats_url": "wss://nats.example/ws",
    }
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg))
    loaded = load_config(p)
    assert loaded.handle == "alice"
    assert loaded.user_id == cfg["user_id"]


def test_load_config_missing(tmp_path: Path) -> None:
    with pytest.raises(ConfigNotFoundError):
        load_config(tmp_path / "missing.json")


def test_load_config_missing_field(tmp_path: Path) -> None:
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"handle": "alice"}))
    with pytest.raises(ConfigInvalidError):
        load_config(p)


def test_load_creds_present(tmp_path: Path) -> None:
    p = tmp_path / "nats.creds"
    p.write_text("-----BEGIN NATS USER JWT-----\n...")
    p.chmod(0o600)
    assert load_creds(p) == p


def test_load_creds_missing(tmp_path: Path) -> None:
    with pytest.raises(CredsNotFoundError):
        load_creds(tmp_path / "missing.creds")


# ── Dedup LRU ─────────────────────────────────────────────────────────


def test_lru_remembers_seen_event_ids() -> None:
    lru = _EventIdLru()
    lru.remember("a")
    assert lru.has("a")
    assert not lru.has("b")


def test_lru_evicts_oldest_when_full() -> None:
    from klodi_nats_client import consumers

    lru = _EventIdLru()
    for i in range(consumers.DEDUP_LRU_SIZE + 5):
        lru.remember(f"e{i}")
    # First 5 IDs should have been evicted.
    assert not lru.has("e0")
    assert not lru.has("e4")
    assert lru.has(f"e{consumers.DEDUP_LRU_SIZE}")


# ── Dispatch ──────────────────────────────────────────────────────────


def _make_msg(payload: dict[str, Any], subject: str = "x") -> Any:
    msg = MagicMock()
    msg.data = json.dumps(payload).encode("utf-8")
    msg.subject = subject
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()
    return msg


@pytest.mark.asyncio
async def test_dispatch_acks_after_handler_success() -> None:
    handler_calls: list[Any] = []

    async def handler(payload: Any) -> None:
        handler_calls.append(payload)

    msg = _make_msg({"event_id": "e1", "kind": "channel.message"})
    lru = _EventIdLru()
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append)

    assert handler_calls == [{"event_id": "e1", "kind": "channel.message"}]
    assert msg.ack.call_count == 1
    assert msg.nak.call_count == 0
    assert errors == []
    assert lru.has("e1")


@pytest.mark.asyncio
async def test_dispatch_naks_when_handler_raises() -> None:
    async def handler(_payload: Any) -> None:
        raise RuntimeError("boom")

    msg = _make_msg({"event_id": "e2"})
    lru = _EventIdLru()
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append)

    assert msg.nak.call_count == 1
    assert msg.ack.call_count == 0
    assert any(isinstance(e, RuntimeError) for e in errors)
    # Failed events are NOT remembered — redelivery should retry.
    assert not lru.has("e2")


@pytest.mark.asyncio
async def test_dispatch_dedups_already_seen_events() -> None:
    handler_calls: list[Any] = []

    async def handler(payload: Any) -> None:
        handler_calls.append(payload)

    lru = _EventIdLru()
    lru.remember("dup")

    msg = _make_msg({"event_id": "dup"})
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append)

    assert handler_calls == []
    assert msg.ack.call_count == 1
    assert msg.nak.call_count == 0


@pytest.mark.asyncio
async def test_dispatch_acks_malformed_payload_to_avoid_loop() -> None:
    async def handler(_payload: Any) -> None:
        raise AssertionError("handler must not run on malformed payload")

    msg = MagicMock()
    msg.data = b"not json{{{"
    msg.subject = "x"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()

    lru = _EventIdLru()
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append)

    assert msg.ack.call_count == 1
    assert msg.nak.call_count == 0
    assert any(isinstance(e, RuntimeError) for e in errors)


# ── Publish ───────────────────────────────────────────────────────────


# P1-11: channel_id and sender_user_id flow into the NATS subject and
# must be strict UUID v4 — these constants pin valid values used across
# the publish tests below.
_VALID_CHANNEL_ID = "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f"
_VALID_SENDER_ID = "9c8d7e6f-1a2b-4c3d-8e9f-0a1b2c3d4e5f"


@pytest.mark.asyncio
async def test_publish_channel_message_subject_and_shape() -> None:
    js = MagicMock()

    async def fake_publish(
        subject: str, data: bytes, headers: dict[str, str] | None = None
    ) -> Any:
        captured["subject"] = subject
        captured["data"] = data
        captured["headers"] = headers
        return SimpleNamespace(seq=42)

    captured: dict[str, Any] = {}
    js.publish = fake_publish

    result = await publish_channel_message(
        js=js,
        channel_id=_VALID_CHANNEL_ID,
        sender_user_id=_VALID_SENDER_ID,
        sender_handle="alice",
        content="Hi there",
    )

    assert result.sequence == 42
    assert (
        captured["subject"]
        == f"p2p.v1.channels.{_VALID_CHANNEL_ID}.{_VALID_SENDER_ID}.msg"
    )
    assert captured["headers"] == {"Nats-Msg-Id": result.event_id}
    body = json.loads(captured["data"].decode("utf-8"))
    assert body["kind"] == "channel.message"
    assert body["channel_id"] == _VALID_CHANNEL_ID
    assert body["sender_user_id"] == _VALID_SENDER_ID
    assert body["sender_handle"] == "alice"
    assert body["content"] == "Hi there"
    assert body["event_id"] == result.event_id
    assert body["message_id"] == result.message_id
    assert body["created_at"].endswith("Z")


@pytest.mark.asyncio
async def test_publish_channel_message_rejects_empty_content() -> None:
    js = MagicMock()
    with pytest.raises(ValueError):
        await publish_channel_message(
            js=js,
            channel_id=_VALID_CHANNEL_ID,
            sender_user_id=_VALID_SENDER_ID,
            sender_handle="h",
            content="",
        )


@pytest.mark.asyncio
async def test_publish_channel_message_rejects_oversized_content() -> None:
    js = MagicMock()
    with pytest.raises(ValueError):
        await publish_channel_message(
            js=js,
            channel_id=_VALID_CHANNEL_ID,
            sender_user_id=_VALID_SENDER_ID,
            sender_handle="h",
            content="x" * 2001,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        "",
        "*",
        ">",
        "ch-1",
        "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1*",
        "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f\n",
        " 3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f",
        "3b9b1d2e-4a8c-1f1d-93f0-7c5b3a2e8c1f",  # version != 4
        "3b9b1d2e-4a8c-4f1d-c3f0-7c5b3a2e8c1f",  # variant not in {8,9,a,b}
    ],
    ids=[
        "empty",
        "asterisk",
        "gt-wildcard",
        "shortname",
        "trailing-asterisk",
        "trailing-newline",
        "leading-space",
        "version-1",
        "bad-variant",
    ],
)
async def test_publish_channel_message_rejects_malformed_channel_id(
    bad: str,
) -> None:
    js = MagicMock()
    js.publish = AsyncMock()
    with pytest.raises(ValueError, match="channel_id must be a UUID v4"):
        await publish_channel_message(
            js=js,
            channel_id=bad,
            sender_user_id=_VALID_SENDER_ID,
            sender_handle="alice",
            content="hello",
        )
    js.publish.assert_not_called()


@pytest.mark.asyncio
async def test_publish_channel_message_rejects_malformed_sender_user_id() -> None:
    js = MagicMock()
    js.publish = AsyncMock()
    with pytest.raises(ValueError, match="sender_user_id must be a UUID v4"):
        await publish_channel_message(
            js=js,
            channel_id=_VALID_CHANNEL_ID,
            sender_user_id="not-a-uuid",
            sender_handle="alice",
            content="hello",
        )
    js.publish.assert_not_called()


# ── KlodiClient request envelope ──────────────────────────────────────


def _make_client(tmp_path: Path) -> KlodiClient:
    creds_path = tmp_path / "nats.creds"
    creds_path.write_text("CREDS\n")
    creds_path.chmod(0o600)
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({
        "handle": "alice",
        "user_id": "00000000-0000-0000-0000-000000000001",
        "nkey_public": "UABCD",
        "nats_url": "ws://127.0.0.1:1/ws",
    }))
    return KlodiClient(
        creds_path=str(creds_path),
        config_path=str(config_path),
    )


@pytest.mark.asyncio
async def test_request_attaches_user_id_and_nkey_headers(
    tmp_path: Path,
) -> None:
    client = _make_client(tmp_path)

    nc = MagicMock()
    nc.is_connected = True

    async def fake_request(
        subject: str,
        data: bytes,
        timeout: float,
        headers: dict[str, str],
    ) -> Any:
        captured["subject"] = subject
        captured["data"] = data
        captured["timeout"] = timeout
        captured["headers"] = headers
        return SimpleNamespace(data=json.dumps({"ok": True}).encode())

    captured: dict[str, Any] = {}
    nc.request = fake_request
    client._nc = nc  # type: ignore[attr-defined]

    result = await client.request("p2p.v1.users.whoami", {"foo": 1})

    assert result == {"ok": True}
    assert captured["subject"] == "p2p.v1.users.whoami"
    assert captured["timeout"] == 10.0
    assert json.loads(captured["data"].decode()) == {"foo": 1}
    assert captured["headers"]["X-User-Id"] == (
        "00000000-0000-0000-0000-000000000001"
    )
    assert captured["headers"]["X-Nkey-Public"] == "UABCD"


@pytest.mark.asyncio
async def test_request_raises_klodi_request_error_on_envelope(
    tmp_path: Path,
) -> None:
    client = _make_client(tmp_path)

    nc = MagicMock()
    nc.is_connected = True

    async def fake_request(*_args: Any, **_kw: Any) -> Any:
        return SimpleNamespace(data=json.dumps({
            "error": "INVALID_REQUEST",
            "message": "bad input",
        }).encode())

    nc.request = fake_request
    client._nc = nc  # type: ignore[attr-defined]

    with pytest.raises(KlodiRequestError) as ei:
        await client.request("p2p.v1.users.whoami", {})
    assert ei.value.code == "INVALID_REQUEST"
    assert "bad input" in str(ei.value)


@pytest.mark.asyncio
async def test_request_wraps_no_responders_as_klodi_request_error(
    tmp_path: Path,
) -> None:
    from nats.errors import NoRespondersError

    client = _make_client(tmp_path)

    nc = MagicMock()
    nc.is_connected = True

    async def fake_request(*_args: Any, **_kw: Any) -> Any:
        raise NoRespondersError()

    nc.request = fake_request
    client._nc = nc  # type: ignore[attr-defined]

    with pytest.raises(KlodiRequestError) as ei:
        await client.request("p2p.v1.users.whoami", {})
    assert ei.value.code == "no_responders"


# ── Subscribe handler invocation ──────────────────────────────────────


@pytest.mark.asyncio
async def test_subscribe_invokes_handler_and_acks(
    tmp_path: Path,
) -> None:
    """Drive the subscribe path end-to-end with a fake JetStream
    context that yields one message and verifies the handler runs.

    Per **D § D5 + D7** the durable consumer is provisioned server-side
    by the marketplace at registration. The client only asserts the
    consumer exists via ``consumer_info`` — it never calls
    ``add_consumer``. This test mocks ``consumer_info`` as a successful
    no-op (the consumer is present) and verifies the handler-dispatch
    + ack path against a queued message.
    """
    client = _make_client(tmp_path)

    handler_calls: list[Any] = []

    async def handler(event: Any) -> None:
        handler_calls.append(event)

    msg = _make_msg(
        {"kind": "offer.proposed", "event_id": "e1", "amount": 100},
        subject="p2p.v1.notifications.user-1",
    )

    sub = MagicMock()
    fetch_calls = {"n": 0}

    async def fetch(batch: int, timeout: float) -> list[Any]:
        fetch_calls["n"] += 1
        if fetch_calls["n"] == 1:
            return [msg]
        # Subsequent fetches: return empty until stop is set.
        await asyncio.sleep(0.01)
        return []

    sub.fetch = fetch

    async def fake_unsubscribe() -> None:
        return None

    sub.unsubscribe = fake_unsubscribe

    js = MagicMock()
    # Consumer is server-managed (D5/D7) — present, returns benign info.
    consumer_info = AsyncMock(return_value=SimpleNamespace(name="ok"))
    js.consumer_info = consumer_info

    # Defensive: any call to add_consumer is a regression. The library
    # MUST NOT attempt to create the consumer per D5/D7.
    add_consumer = AsyncMock(
        side_effect=AssertionError(
            "subscribe_notifications must not call add_consumer "
            "— consumers are server-managed (D5/D7)"
        )
    )
    js.add_consumer = add_consumer

    pull_subscribe_bind = AsyncMock(return_value=sub)
    js.pull_subscribe_bind = pull_subscribe_bind

    client._js = js  # type: ignore[attr-defined]
    client._nc = MagicMock(is_connected=True)  # type: ignore[attr-defined]

    await client.subscribe_notifications(handler)

    # Give the loop one iteration to dispatch the queued message.
    for _ in range(50):
        if handler_calls:
            break
        await asyncio.sleep(0.02)

    assert handler_calls and handler_calls[0]["kind"] == "offer.proposed"
    assert msg.ack.call_count == 1
    # Library asserts presence, never creates.
    assert consumer_info.await_count >= 1
    info_args = consumer_info.await_args.args
    assert info_args[0] == "P2P_NOTIFICATIONS"
    assert info_args[1] == (
        "klodi-notifications-00000000-0000-0000-0000-000000000001"
    )
    assert add_consumer.await_count == 0

    await client.close()


@pytest.mark.asyncio
async def test_subscribe_notifications_raises_setup_error_when_consumer_missing(
    tmp_path: Path,
) -> None:
    """When the notifications durable is absent, the client raises
    :class:`KlodiSetupError` with code ``notifications_consumer_missing``.

    Per **D § D5 + D7** the per-user JWT does not carry
    ``CONSUMER.CREATE`` — absence means the marketplace's provisioning
    pass never ran or was reverted by an operator. Surfacing a stable
    code lets the host adapter map this to ``klodi_setup_status``.
    """
    from nats.js.errors import NotFoundError

    from klodi_nats_client.consumers import KlodiSetupError

    client = _make_client(tmp_path)

    js = MagicMock()
    js.consumer_info = AsyncMock(side_effect=NotFoundError())
    # add_consumer must never be reached — the library does not auto-create.
    js.add_consumer = AsyncMock(
        side_effect=AssertionError("library must not auto-create consumers")
    )
    js.pull_subscribe_bind = AsyncMock(
        side_effect=AssertionError("must not bind when consumer missing")
    )

    client._js = js  # type: ignore[attr-defined]
    client._nc = MagicMock(is_connected=True)  # type: ignore[attr-defined]

    async def handler(_event: Any) -> None:
        raise AssertionError("handler must not run when consumer missing")

    with pytest.raises(KlodiSetupError) as ei:
        await client.subscribe_notifications(handler)

    assert ei.value.code == "notifications_consumer_missing"
    # Stable code surfaces in the message for log/error-sink visibility.
    assert "notifications_consumer_missing" in str(ei.value)
    assert js.consumer_info.await_count == 1
    assert js.add_consumer.await_count == 0
    assert js.pull_subscribe_bind.await_count == 0

    await client.close()


@pytest.mark.asyncio
async def test_subscribe_channels_raises_setup_error_when_consumer_missing(
    tmp_path: Path,
) -> None:
    """Sibling of the notifications missing-consumer test — same
    contract on the channels stream. ``filter_subjects`` is
    server-managed; the library must never create or mutate the
    channels consumer (per **D § D5 + D7**)."""
    from nats.js.errors import NotFoundError

    from klodi_nats_client.consumers import KlodiSetupError

    client = _make_client(tmp_path)

    js = MagicMock()
    js.consumer_info = AsyncMock(side_effect=NotFoundError())
    js.add_consumer = AsyncMock(
        side_effect=AssertionError("library must not auto-create consumers")
    )
    js.pull_subscribe_bind = AsyncMock(
        side_effect=AssertionError("must not bind when consumer missing")
    )

    client._js = js  # type: ignore[attr-defined]
    client._nc = MagicMock(is_connected=True)  # type: ignore[attr-defined]

    async def handler(_event: Any) -> None:
        raise AssertionError("handler must not run when consumer missing")

    with pytest.raises(KlodiSetupError) as ei:
        await client.subscribe_channels(handler)

    assert ei.value.code == "channels_consumer_missing"
    assert "channels_consumer_missing" in str(ei.value)
    assert js.consumer_info.await_count == 1
    assert js.add_consumer.await_count == 0
    assert js.pull_subscribe_bind.await_count == 0

    await client.close()
