"""GATED e2e — register-supplied CA, no env override, connects tls:// (py).

Criteria:
  * [e2e] private-CA NATS over tls:// + a register response supplying that CA
    as nats_ca → a host that persists it then connects using ONLY the
    register-supplied CA (no KLODI_NATS_CA_FILE, empty bundled constant)
    succeeds end-to-end ("register → connected").
  * [integration] a persisted register nats_ca that does NOT match the proxy
    chain (wrong CA / SAN mismatch) → connect fails CLOSED, never a plaintext /
    verify-off fallback.

GATE (dev-pair local TLS harness — NOT the epic Railway proxy): SKIPS unless a
local tls:// nats + self-signed test CA is provided via env — KLODI_TLS_INTEGRATION=1,
KLODI_TLS_NATS_URL, KLODI_NATS_CA_FILE (the CA that signs the test nats cert),
KLODI_TLS_CREDS_PATH. This suite reads that CA and re-homes it as the *persisted
register CA* in a fresh KLODI_HOME, then connects with KLODI_NATS_CA_FILE UNSET
so trust can only come from the persisted file.

The client derives ${KLODI_HOME} from the creds-path parent, so creds + config +
nats-ca.pem all live in one temp home. Authored to spec; UNVALIDATED in CI until
the harness exists. QA-owned — NEVER weaken.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
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
        "KLODI_TLS_CREDS_PATH"
    ),
)

# A bad persisted CA must reach a terminal error well within this bound; a hang
# (the defect) trips wait_for → TimeoutError → the assertion fails. See card
# gate-auto-trust-on-well-formed-ca-loud-fail.
_TERMINAL_BOUND_S = 12.0

# A valid but WRONG self-signed CA (does not sign the test nats cert) for the
# fail-closed / SAN-mismatch case.
_WRONG_CA_PEM = """-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUdooZy0BQuqSNCu94q6A/ScED/jQwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTa2xvZGktdGVzdC1jYS1hbHBoYTAeFw0yNjA3MDQxMjIx
MDBaFw0zNjA3MDExMjIxMDBaMB4xHDAaBgNVBAMME2tsb2RpLXRlc3QtY2EtYWxw
aGEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5J9sl5etTkVas1jjH
BmZh9l+uTFBJx7K1ZBn8lhknItWTdVUaY2GPi7nwFLdjhpDF9ZW8Q+Pm9ZxnH0ak
W6Echu3/Q9xIllRJIGpvOFns0wjbafz8RmcrVejO1JytMH22KY4zIAbcDyHY4kmy
q/sEKyYrRwzirmkY89z9ruIYymtYEnOpne6G3o0SCHP9/aA22obrqKEnSeBTt9pt
/becrfDyiSIR092+XqCBqGZ1RozNY5DXERCEKGMRlviuKWxlH1s+ut/YrCij7kSl
el5Iet4jvIdzm2drBCsIsiJvdBb4+gjZcRExIYaoEUcdLZgAv8nD6M6WEi4E+y1Q
d1HXAgMBAAGjUzBRMB0GA1UdDgQWBBSfJZNs2ahEw+OnPQBv7N52+W9hRzAfBgNV
HSMEGDAWgBSfJZNs2ahEw+OnPQBv7N52+W9hRzAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQA5E4znjCNDZBTmE4jWma5UWuGBslC15bLVmVFGIZoV
qhvwekFxJ3U+n1suhsZh8NOJj9P0lSao+cJJtOkhTbz2TUXLTIbPPHZvC9vge020
Cj55CkjQCcbT7tGFFZym1Bmy9rfJRA0x/wwsFpJHjnGYlmO9nvZ0s7QOnmqnPqaF
wIVtXE3uhugfQp3kBK0O054tJf1RHcBvQQRAG4gq1Pz93z5LuoC1b6+zLe8MeOi3
Z2AcGF8bZYroN1ej66eb5Wcqtn+qcS2kbNkws1NWBkDUeKRvxSr60AHu5VkY0uTP
4EV45itbMyAL9zboFSA5gR6/Wbjyz+A9osro8Prc3cjn
-----END CERTIFICATE-----
"""


def _home_with_creds(home: Path, nats_url: str) -> tuple[str, str]:
    """Materialise a self-contained ${KLODI_HOME}: creds copied in (so the
    client derives THIS home) + a config pointing at the tls:// url."""
    creds_path = home / "nats.creds"
    shutil.copyfile(_CREDS, creds_path)
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
    return str(creds_path), str(config_path)


def test_connects_with_only_the_persisted_register_ca() -> None:
    """[e2e] Persist the harness CA as the register CA, unset the env override,
    connect — trust must come solely from ${KLODI_HOME}/nats-ca.pem."""
    from klodi_nats_client.client import KlodiClient
    from klodi_nats_client.tls import persist_nats_ca

    async def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            persist_nats_ca(home, Path(_CA_FILE).read_text(encoding="utf-8"))
            os.environ.pop("KLODI_NATS_CA_FILE", None)  # register CA only
            creds_path, config_path = _home_with_creds(home, _NATS_URL)
            client = KlodiClient(creds_path=creds_path, config_path=config_path)
            try:
                await client.connect()
                assert client.is_connected, (
                    "must connect over tls:// using only the persisted "
                    "register CA — no manual KLODI_NATS_CA_FILE"
                )
                resp = await client.request("p2p.v1.users.whoami", {})
                assert isinstance(resp, dict)
            finally:
                await client.close()

    asyncio.run(run())


def test_wrong_persisted_ca_fails_closed() -> None:
    """[integration] A persisted register CA that does not sign the proxy chain
    → the handshake rejects and connect fails CLOSED, surfacing a **structured,
    terminal** ``CaTrustError`` within a **bounded time** (never a plaintext /
    verify-off fallback, never a silent hang).

    TIGHTENED by card gate-auto-trust-on-well-formed-ca-loud-fail from a bare
    ``raises(Exception)``: the wrong-signer persisted CA must fail *loud +
    terminal + prompt*, not merely "not connected". If ``connect()`` retries the
    deterministic verify failure forever, ``wait_for`` raises ``TimeoutError`` —
    not ``CaTrustError`` — and this fails. QA-owned — never relax."""
    from klodi_nats_client.client import KlodiClient
    from klodi_nats_client.tls import CaTrustError, persist_nats_ca

    async def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            persist_nats_ca(home, _WRONG_CA_PEM)
            os.environ.pop("KLODI_NATS_CA_FILE", None)
            creds_path, config_path = _home_with_creds(home, _NATS_URL)
            client = KlodiClient(creds_path=creds_path, config_path=config_path)
            try:
                with pytest.raises(CaTrustError):
                    await asyncio.wait_for(
                        client.connect(), timeout=_TERMINAL_BOUND_S
                    )
                assert not client.is_connected
            finally:
                await client.close()

    asyncio.run(run())
