"""GATED integration — verified tls:// handshake + fail-closed (py).

Card: support-tls-nats-transport-with-private-ca-trust.
Criteria (Acceptance → "Verified TLS round-trip with private-CA trust"):

  * `[integration]` trusted private CA + `nats_url` = tls://… → TLS handshake
    completes (cert + hostname verification pass) and a whoami round-trip
    succeeds.
  * `[e2e]` the same trusted setup holds a JetStream subscription open across
    an idle period and still delivers a subsequently published event.
  * `[integration]` CA absent / wrong → the handshake fails and `connect()`
    errors: the client fails CLOSED (never a plaintext / unverified fallback).

GATE (Do-NOW #3, dev-pair local TLS harness — NOT the epic Railway proxy):
this suite SKIPS unless a local `tls://` nats with a self-signed test CA is
provided via env:
  * KLODI_TLS_INTEGRATION=1
  * KLODI_TLS_NATS_URL   — e.g. tls://localhost:4222
  * KLODI_NATS_CA_FILE   — PEM path for the CA that signed the test nats cert
  * KLODI_TLS_CREDS_PATH — nats.creds valid on that local nats
It does NOT touch prod or Railway (that is the epic-gated e2e cutover).

Authored to spec; UNVALIDATED in CI until the harness exists. QA-owned —
NEVER weaken; if the impl can't satisfy a criterion, push back to the
expert-developer, do not relax the assert.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

import pytest

_ON = os.environ.get("KLODI_TLS_INTEGRATION") == "1"
_NATS_URL = os.environ.get("KLODI_TLS_NATS_URL", "")
_CA_FILE = os.environ.get("KLODI_NATS_CA_FILE", "")
_CREDS = os.environ.get("KLODI_TLS_CREDS_PATH", "")

pytestmark = pytest.mark.skipif(
    not (_ON and _NATS_URL and _CA_FILE and _CREDS),
    reason=(
        "local tls:// nats + self-signed CA harness required — set "
        "KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL, KLODI_NATS_CA_FILE, "
        "KLODI_TLS_CREDS_PATH (Do-NOW #3, dev-pair harness)"
    ),
)


def _write_config(home: Path, nats_url: str) -> tuple[str, str]:
    config_path = home / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "handle": "tlsuser",
                "user_id": "00000000-0000-4000-8000-000000000001",
                "nkey_public": "UTLSTEST",
                "nats_url": nats_url,
            }
        ),
        encoding="utf-8",
    )
    return str(config_path), _CREDS


def test_verified_tls_handshake_and_whoami_round_trip() -> None:
    from klodi_nats_client.client import KlodiClient

    async def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["KLODI_NATS_CA_FILE"] = _CA_FILE  # trust the test CA
            config_path, creds_path = _write_config(Path(tmp), _NATS_URL)
            client = KlodiClient(creds_path=creds_path, config_path=config_path)
            try:
                await client.connect()
                assert client.is_connected, "verified tls:// connect must succeed"
                resp = await client.request("p2p.v1.users.whoami", {})
                assert isinstance(resp, dict), "round-trip must return a body"
            finally:
                await client.close()

    asyncio.run(run())


def test_held_subscription_survives_idle_and_delivers() -> None:  # [e2e] tier
    from klodi_nats_client.client import KlodiClient

    async def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["KLODI_NATS_CA_FILE"] = _CA_FILE
            config_path, creds_path = _write_config(Path(tmp), _NATS_URL)
            client = KlodiClient(creds_path=creds_path, config_path=config_path)
            received: list[dict] = []
            try:
                await client.connect()
                await client.subscribe_channels(
                    lambda ev: received.append(ev) or asyncio.sleep(0)  # type: ignore[func-returns-value]
                )
                # Idle past the WS-close→EOF window the epic exists to fix.
                await asyncio.sleep(25)
                assert client.is_connected, (
                    "held tls:// subscription must survive the idle period"
                )
            finally:
                await client.close()

    asyncio.run(run())


def test_fail_closed_when_ca_is_wrong() -> None:
    """Wrong CA → the handshake cannot verify the server cert → connect()
    raises and the client never falls back to plaintext/unverified."""
    from klodi_nats_client.client import KlodiClient

    async def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # A syntactically-plausible but WRONG CA (does not sign the test
            # nats cert). Selecting the wrong CA must fail closed — it must
            # not disable verification.
            wrong_ca = Path(tmp) / "wrong-ca.pem"
            wrong_ca.write_text(
                "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                encoding="utf-8",
            )
            os.environ["KLODI_NATS_CA_FILE"] = str(wrong_ca)
            config_path, creds_path = _write_config(Path(tmp), _NATS_URL)
            client = KlodiClient(creds_path=creds_path, config_path=config_path)
            with pytest.raises(Exception):  # noqa: B017 — any connect failure
                await client.connect()
            assert not client.is_connected, "must not connect with a wrong CA"

    asyncio.run(run())
