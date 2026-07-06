"""RED [unit] — a stale persisted non-``tls://`` nats_url is rejected at
``KlodiClient.connect()`` BEFORE any transport dispatch (py client).

Two transport cases: the ``wss://``-non-localhost case (unchanged here —
verify-only) AND the NEW ``ws://localhost`` / ``wss://localhost`` cases —
RED today, since localhost is still a bypass on current ``main``.

Scenario (product-owner "connect-time / stale persisted URL"): a host whose
``config.json`` still carries a non-``tls://`` nats_url — either a
``wss://<non-localhost>`` (persisted before the tls-only cutover) or a stale
``ws://localhost`` / ``wss://localhost`` (persisted while localhost was a
plaintext bypass, before this change removed it). The host is upgraded to the
guard-collapsed client without re-registering. ``connect()`` runs the shared
guard in ``client.py`` before selecting a transport — so the stale url must
raise **synchronously**, with NO ``nats.aio.client.Client.connect`` dispatch
and NO hang. nats-py selects the raw-TCP vs WebSocket transport *inside*
``Client.connect`` (and dials there), so asserting that method is never
awaited proves neither transport fired.

Guard-before-dispatch matters: were the guard to run late, a WebSocket
connect would be attempted against an endpoint that (post server-side WS
teardown) no longer speaks ``ws://`` / ``wss://`` — reproducing the
silent-hang class the ADR-0022 loud-fail addendum fought. The
``asyncio.wait_for`` timeout is the no-hang tripwire.

QA-owned (adversarial-testing). NEVER weaken. Do NOT re-widen the guard to
accept ``ws://localhost`` so the localhost cases pass — the bypass is deleted.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import klodi_nats_client.client as client_mod
from klodi_nats_client.client import KlodiClient

# The whole stale-non-tls family the collapsed guard must reject at connect.
# ``wss://<non-localhost>`` was already rejected by the earlier tls-only collapse
# (verify-only); the localhost forms are the flip this change introduces.
_STALE_NON_TLS = [
    "wss://klodi-net.4gpts.com",
    "ws://localhost:8080",
    "wss://localhost",
]


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
@pytest.mark.parametrize("stale_url", _STALE_NON_TLS)
async def test_connect_rejects_stale_non_tls_before_transport_dispatch(
    tmp_path: Path,
    stale_url: str,
) -> None:
    creds_path, config_path = _write_session(tmp_path, stale_url)
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
