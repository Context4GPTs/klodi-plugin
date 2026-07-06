"""nanobot persists a server-sent ``tls://`` nats_url and refuses non-tls.

Cards: support-tls-nats-transport-with-private-ca-trust (the tls:// persist +
non-localhost refusal, verify-only) AND
remove-dead-ws-localhost-nats-transport-bypass (the NEW ``ws://localhost``
refusal — RED today, since localhost is still a bypass on current ``main``).

nanobot does NOT carry an inline scheme check — ``_persist_credentials``
delegates to the single shared client guard (``assert_tls`` after this card's
rename) and wraps the ``ValueError`` into ``OSError``, so persist-time and
connect-time policy can never drift. This file pins that delegated contract
as part of the adapter-family audit unit (criterion D: "test all persist
sites").

Criteria (Acceptance → D "each adapter persist path rejects a non-tls:// url"):
  * tls://<svc>.proxy.rlwy.net:<port> → persisted verbatim to config.json.
  * ANY non-``tls://`` url — nats:// / ws:// non-localhost, OR ws://localhost
    (the flip) → refused (OSError), nothing written.

QA-owned. NEVER weaken. Do NOT re-add an adapter-local localhost carve-out.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

import nanobot_local_tools as lt

_TLS_PROD_URL = "tls://hayabusa.proxy.rlwy.net:32770"


def _tls_claim() -> dict:
    return {
        "status": "completed",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "nats_url": _TLS_PROD_URL,
    }


class _KlodiHomeCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._prev_env = os.environ.get("KLODI_HOME")
        os.environ["KLODI_HOME"] = str(self.home)

    def tearDown(self) -> None:
        if self._prev_env is None:
            os.environ.pop("KLODI_HOME", None)
        else:
            os.environ["KLODI_HOME"] = self._prev_env
        self._tmp.cleanup()


class TestNanobotPersistTlsUrl(_KlodiHomeCase):
    def test_persists_tls_url_unchanged(self) -> None:
        lt._persist_credentials(_tls_claim())
        config_path = self.home / "config.json"
        self.assertTrue(config_path.exists(), "config.json must be written")
        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            written["nats_url"],
            _TLS_PROD_URL,
            "tls:// nats_url must persist unchanged",
        )

    def test_rejects_plaintext_nats_non_localhost(self) -> None:
        claim = _tls_claim()
        claim["nats_url"] = "nats://hayabusa.proxy.rlwy.net:4222"
        with self.assertRaises(OSError):
            lt._persist_credentials(claim)
        self.assertFalse((self.home / "config.json").exists())
        self.assertFalse((self.home / "nats.creds").exists())

    def test_rejects_plaintext_ws_non_localhost(self) -> None:
        claim = _tls_claim()
        claim["nats_url"] = "ws://attacker.example.com:8080"
        with self.assertRaises(OSError):
            lt._persist_credentials(claim)
        self.assertFalse((self.home / "config.json").exists())

    def test_rejects_ws_localhost(self) -> None:
        # THE FLIP (remove-dead-ws-localhost-nats-transport-bypass):
        # ws://localhost was accepted while localhost was a plaintext
        # bypass. After the guard collapse the shared guard rejects it.
        claim = _tls_claim()
        claim["nats_url"] = "ws://localhost:8080"
        with self.assertRaises(OSError):
            lt._persist_credentials(claim)
        self.assertFalse((self.home / "config.json").exists())
        self.assertFalse((self.home / "nats.creds").exists())


if __name__ == "__main__":
    unittest.main()
