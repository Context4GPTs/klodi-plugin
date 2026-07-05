"""RED [unit] — a stale persisted ``wss://`` nats_url is rejected at
``KlodiClient.connect()`` BEFORE any transport dispatch (py client).

Card: collapse-nats-transport-guard-to-tls-only.

Scenario (product-owner "connect-time / stale persisted URL"): a host
whose ``config.json`` still carries a ``wss://<non-localhost>`` nats_url
(persisted before the cutover, upgraded to the tls-only client without
re-registering). ``connect()`` runs the shared guard at
``client.py`` before selecting a transport — so the stale url must raise
**synchronously**, with NO ``nats.aio.client.Client.connect`` dispatch
and NO hang. nats-py selects the raw-TCP vs WebSocket transport *inside*
``Client.connect`` (and dials there), so asserting that method is never
awaited proves neither transport fired.

Guard-before-dispatch matters: were the guard to run late, a WebSocket
connect would be attempted against an endpoint that (post server-side WS
teardown) no longer speaks ``wss://`` — reproducing the silent-hang class
the ADR-0022 loud-fail addendum fought. The ``asyncio.wait_for`` timeout
is the no-hang tripwire.

QA-owned (adversarial-testing). NEVER weaken.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import klodi_nats_client.client as client_mod
from klodi_nats_client.client import KlodiClient

_STALE_WSS = "wss://klodi-net.4gpts.com"


def _write_session(home: Path, nats_url: str) -> tuple[str, str]:
    config_path = home / "config.json"
    creds_path = home / "nats.creds"
    config_path.write_text(
        json.dumps(
            {
                "handle": "alice",
                "user_id": "u-1",
                "nkey_public": "UAAAAAAAAAAAA",
                "nats_url": nats_url,
            }
        ),
        encoding="utf-8",
    )
    creds_path.write_text(
        "-----BEGIN NATS USER JWT-----\nfake\n", encoding="utf-8"
    )
    creds_path.chmod(0o600)
    return str(creds_path), str(config_path)


@pytest.mark.asyncio
async def test_connect_rejects_stale_wss_before_transport_dispatch(
    tmp_path: Path,
) -> None:
    creds_path, config_path = _write_session(tmp_path, _STALE_WSS)
    client = KlodiClient(creds_path=creds_path, config_path=config_path)

    # Patch the single seam through which nats-py dispatches BOTH transports
    # (raw-TCP and WebSocket are selected inside ``Client.connect``). If the
    # guard fired first, this is never awaited.
    with patch.object(
        client_mod.NATSClient, "connect", new_callable=AsyncMock
    ) as nc_connect:
        # The guard must raise synchronously; the timeout is the no-hang
        # tripwire (a late guard would let nats-py retry a dead wss:// forever).
        with pytest.raises(ValueError):
            await asyncio.wait_for(client.connect(), timeout=5)

    nc_connect.assert_not_awaited()
    # And nothing half-open landed on the client.
    assert client.is_connected is False
