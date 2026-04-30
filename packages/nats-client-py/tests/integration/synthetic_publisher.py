"""Synthetic publisher helper — P1-22, mirror of the TS helper at
``klodi-plugin/packages/nats-client-ts/tests/integration/synthetic-publisher.ts``.

Connects to NATS over WebSocket using the service-account creds (broad
publish allow), publishes a fully-formed ``NotificationEvent`` on a
per-test subject, returns the JetStream ack. The KlodiClient under test
connects via WebSocket on the user-scoped creds — keeping the publisher
on a separate connection mirrors the production topology (marketplace
publishes via service identity → P2P_*).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from nats.aio.client import Client as NATSClient


@dataclass
class _PublishedAck:
    event_id: str
    sequence: int


class SyntheticPublisher:
    """Service-creds publisher used by the integration suite.

    A separate ``NATSClient`` instance from the system-under-test client
    so the connection identities don't mix.
    """

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        self._js = nc.jetstream()

    async def publish_notification(
        self,
        *,
        user_id: str,
        kind: str,
        payload: dict[str, Any],
    ) -> _PublishedAck:
        event_id = str(uuid.uuid4())
        body = {"event_id": event_id, "kind": kind, **payload}
        ack = await self._js.publish(
            f"p2p.v1.notifications.{user_id}",
            json.dumps(body).encode("utf-8"),
            headers={"Nats-Msg-Id": event_id},
        )
        return _PublishedAck(event_id=event_id, sequence=ack.seq)

    async def close(self) -> None:
        await self._nc.drain()


async def make_synthetic_publisher(
    *,
    nats_url: str,
    creds_path: str,
) -> SyntheticPublisher:
    """Open a service-creds connection and return the publisher wrapper.

    The wsconnect equivalent in nats-py is ``connect`` with a ``ws://``
    or ``wss://`` URL — the library auto-selects WebSocket transport.
    """
    nc = NATSClient()
    await nc.connect(
        servers=nats_url,
        user_credentials=creds_path,
        max_reconnect_attempts=3,
        reconnect_time_wait=1,
        connect_timeout=10,
        allow_reconnect=True,
    )
    return SyntheticPublisher(nc)
