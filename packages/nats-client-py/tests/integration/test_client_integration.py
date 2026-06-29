"""Decision 13 — D.1.py: per-language client cycle (Python).

Real NATS via ``pnpm setup:dev``. Gated by ``INTEGRATION=1`` and the
presence of ``infra/nats/dev-keys/service.creds``. Mirrors the TS suite
at ``klodi-plugin/packages/nats-client-ts/tests/integration/client.integration.test.ts``.

Acceptance criteria (Decision 13 row D.1.{ts,py,rs}):
  - Connect with NKey + WebSocket
  - Subscribe; synthetic publisher fires N events; handler invoked N×
    in order with full payloads
  - Disconnect → reconnect → 3-event backlog drains in order
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from nats.aio.client import Client as NATSClient

from klodi_nats_client import KlodiClient

from .conftest import NATS_WS_URL, SERVICE_CREDS_PATH
from .synthetic_publisher import (
    SyntheticPublisher,
    make_synthetic_publisher,
)


@pytest.fixture
async def publisher() -> AsyncIterator[SyntheticPublisher]:
    pub = await make_synthetic_publisher(
        nats_url=NATS_WS_URL,
        creds_path=SERVICE_CREDS_PATH,
    )
    try:
        yield pub
    finally:
        await pub.close()


@pytest.fixture
async def test_user() -> AsyncIterator[dict[str, str]]:
    """Mint a per-test user_id + temporary klodi_home with creds + config.

    The test reuses the broad-permission service creds for the under-test
    KlodiClient. Per-test isolation comes from the fresh user_id (the
    durable consumer name + filter subject namespace off it).
    """
    user_id = str(uuid.uuid4())
    handle = f"pytest_{user_id[:8]}"
    home = Path(tempfile.mkdtemp(prefix=f"klodi-py-int-{handle}-"))
    creds_path = home / "nats.creds"
    config_path = home / "config.json"
    shutil.copyfile(SERVICE_CREDS_PATH, creds_path)
    creds_path.chmod(0o600)
    config_path.write_text(
        json.dumps(
            {
                "handle": handle,
                "user_id": user_id,
                "nkey_public": "test-placeholder-nkey",
                "nats_url": NATS_WS_URL,
            }
        ),
        encoding="utf-8",
    )
    try:
        yield {
            "user_id": user_id,
            "handle": handle,
            "home": str(home),
            "creds_path": str(creds_path),
            "config_path": str(config_path),
        }
    finally:
        # Best-effort consumer cleanup so a re-run doesn't trip max
        # consumers per stream.
        await _delete_consumer(f"klodi-notifications-{user_id}")
        shutil.rmtree(home, ignore_errors=True)


async def _delete_consumer(durable: str) -> None:
    """Delete the user's notifications consumer via service creds."""
    nc = NATSClient()
    try:
        await nc.connect(
            servers=NATS_WS_URL,
            user_credentials=SERVICE_CREDS_PATH,
            max_reconnect_attempts=3,
            reconnect_time_wait=1,
            connect_timeout=10,
        )
        try:
            await nc.jetstream().delete_consumer("P2P_NOTIFICATIONS", durable)
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass
    finally:
        try:
            await nc.drain()
        except Exception:  # noqa: BLE001
            pass


@pytest.mark.asyncio
async def test_connects_via_websocket_with_nkey_credentials(
    test_user: dict[str, str],
) -> None:
    client = KlodiClient(
        creds_path=test_user["creds_path"],
        config_path=test_user["config_path"],
    )
    try:
        await client.connect()
        assert client.is_connected is True
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_delivers_5_published_events_to_handler_in_order(
    test_user: dict[str, str],
    publisher: SyntheticPublisher,
) -> None:
    client = KlodiClient(
        creds_path=test_user["creds_path"],
        config_path=test_user["config_path"],
    )
    received: list[dict[str, Any]] = []
    all_received = asyncio.Event()

    async def handler(event: Any) -> None:
        received.append(event)
        if len(received) == 5:
            all_received.set()

    try:
        await client.connect()
        await client.subscribe_notifications(handler)
        # Give the consume loop a moment to attach before publishing —
        # the JetStream side buffers regardless (Interest retention),
        # but the wait reduces flakiness.
        await asyncio.sleep(0.25)

        expected_kinds = [
            "channel.opened",
            "channel.message",
            "offer.proposed",
            "offer.accepted",
            "transaction.confirmed",
        ]
        published_ids: list[str] = []
        for kind in expected_kinds:
            ack = await publisher.publish_notification(
                user_id=test_user["user_id"],
                kind=kind,
                payload={"marker": kind, "sequenceTag": len(published_ids)},
            )
            published_ids.append(ack.event_id)

        await asyncio.wait_for(all_received.wait(), timeout=10)

        assert [e["kind"] for e in received] == expected_kinds
        assert [e["event_id"] for e in received] == published_ids
        for i, kind in enumerate(expected_kinds):
            assert received[i]["marker"] == kind
            assert received[i]["sequenceTag"] == i
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_drains_3_event_backlog_after_reconnect_in_order(
    test_user: dict[str, str],
    publisher: SyntheticPublisher,
) -> None:
    # 1. Connect + subscribe to create the durable consumer.
    client = KlodiClient(
        creds_path=test_user["creds_path"],
        config_path=test_user["config_path"],
    )
    received: list[dict[str, Any]] = []
    all_received = asyncio.Event()

    async def handler(event: Any) -> None:
        received.append(event)
        if len(received) == 3:
            all_received.set()

    await client.connect()
    await client.subscribe_notifications(handler)
    await asyncio.sleep(0.25)

    # 2. Disconnect — durable consumer remains on the server.
    await client.close()

    # 3. Publish 3 events while offline. Interest retention keeps them
    #    queued because the durable consumer hasn't acked them.
    received.clear()
    backlog_kinds = ["search.match", "comment.posted", "rating.received"]
    published_ids: list[str] = []
    for kind in backlog_kinds:
        ack = await publisher.publish_notification(
            user_id=test_user["user_id"],
            kind=kind,
            payload={"backlogTag": kind},
        )
        published_ids.append(ack.event_id)

    # 4. Reconnect + subscribe again. Backlog drains in order.
    client = KlodiClient(
        creds_path=test_user["creds_path"],
        config_path=test_user["config_path"],
    )
    try:
        await client.connect()
        await client.subscribe_notifications(handler)
        await asyncio.wait_for(all_received.wait(), timeout=10)

        assert [e["kind"] for e in received] == backlog_kinds
        assert [e["event_id"] for e in received] == published_ids
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_resumes_backlog_after_in_place_flap_same_client(
    test_user: dict[str, str],
    publisher: SyntheticPublisher,
) -> None:
    """AC-6 (Piece 1a) — real-NATS in-place flap.

    Unlike ``test_drains_3_event_backlog_after_reconnect_in_order`` (which
    does a clean ``close()`` + a brand-new client + fresh ``subscribe()``),
    this drives the production daemon's actual path: a mid-stream transport
    drop with NO application ``close()`` and NO re-subscribe. The same
    long-lived client + consume loop must re-bind its pull subscription in
    place and resume delivery.

    The flap is injected via nats-py's own read-loop fault entry point
    (``Client._process_op_err``), which is exactly what fires on a real
    ``nats: unexpected EOF`` / 502 — it triggers the ``allow_reconnect``
    machinery while the client object stays alive.
    """
    import nats.errors

    client = KlodiClient(
        creds_path=test_user["creds_path"],
        config_path=test_user["config_path"],
    )
    received: list[dict[str, Any]] = []
    backlog_seen = asyncio.Event()

    async def handler(event: Any) -> None:
        received.append(event)
        if len(received) >= 4:  # 1 pre-flap + 3 post-flap backlog
            backlog_seen.set()

    try:
        await client.connect()
        await client.subscribe_notifications(handler)
        await asyncio.sleep(0.25)

        # 1. Prove the loop is live before the flap.
        pre = await publisher.publish_notification(
            user_id=test_user["user_id"], kind="offer.proposed",
            payload={"phase": "pre-flap"},
        )

        # 2. Force an in-place transport drop — no client.close().
        await client._nc._process_op_err(  # type: ignore[attr-defined]
            nats.errors.Error("simulated mid-stream EOF")
        )

        # 3. Publish a backlog while the transport is re-establishing.
        backlog_kinds = ["search.match", "comment.posted", "rating.received"]
        published_ids = [pre.event_id]
        for kind in backlog_kinds:
            ack = await publisher.publish_notification(
                user_id=test_user["user_id"], kind=kind,
                payload={"phase": "post-flap"},
            )
            published_ids.append(ack.event_id)

        # 4. The SAME client re-binds in place and drains the backlog.
        await asyncio.wait_for(backlog_seen.wait(), timeout=20)

        got_ids = [e["event_id"] for e in received]
        assert set(published_ids).issubset(set(got_ids))
        # No duplicates — the preserved dedup LRU guards redelivery.
        assert len(got_ids) == len(set(got_ids))
    finally:
        await client.close()
