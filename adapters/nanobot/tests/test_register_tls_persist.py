"""RED — nanobot persists a server-sent ``tls://`` nats_url.

Card: support-tls-nats-transport-with-private-ca-trust.

nanobot carries the same *inline copy* of the plaintext-refusal check as
hermes (``nanobot_local_tools.py:632`` — ``startswith("wss://")`` +
``_is_localhost``), separate from the shared ``assert_wss_or_localhost``.
Discovery's "Register/persist guard family" lists this as a persist site that
would otherwise **refuse to persist the server's tls:// URL** → registration
against the new prod endpoint fails closed. The card is emphatic: "test all
persist sites" — nanobot is one, so it is covered here as part of the family.

Criteria (Acceptance → "Registration persists a server-sent tls:// endpoint"):
  * tls://<svc>.proxy.rlwy.net:<port> → persisted verbatim to config.json.
  * plaintext non-localhost (nats:// / ws://) → refused (OSError), nothing
    written.

RED today: the inline check only allows wss:// / localhost.

QA-owned. NEVER weaken.
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


if __name__ == "__main__":
    unittest.main()
