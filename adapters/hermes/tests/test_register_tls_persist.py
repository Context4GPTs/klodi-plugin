"""RED — hermes persists a server-sent ``tls://`` nats_url (register.py).

Card: support-tls-nats-transport-with-private-ca-trust.
Criteria (Acceptance → "Registration persists a server-sent tls:// endpoint"):

  * Given the marketplace returns ``nats_url: tls://<svc>.proxy.rlwy.net:<port>``,
    ``_persist_credentials`` writes that EXACT url to config.json — no rewrite,
    no rejection.
  * Given the server returns a plaintext non-localhost nats_url
    (``nats://…`` or ``ws://…``), persist REFUSES (OSError) — the
    compromised-endpoint defense (D §D10) stays intact for the new scheme set.

hermes carries an *inline copy* of the plaintext-refusal check
(``register.py:350`` — ``startswith("wss://")``), separate from the shared
``assert_wss_or_localhost``. This file pins that inline copy. RED today: the
inline check only allows wss:// / localhost, so a tls:// url is refused.

Harness mirrors ``test_register.py::TestPersistCredentials`` — the persist
tail boots the wake pump, so both pump entry points are patched to no-ops so
the persist contract runs in isolation.

QA-owned (adversarial-testing). NEVER weaken.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERMES_DIR = Path(__file__).resolve().parent.parent
_SRC_DIR = _HERMES_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

_register_mod = importlib.import_module("klodi_hermes.register")
_persist_credentials = _register_mod._persist_credentials

_TLS_PROD_URL = "tls://hayabusa.proxy.rlwy.net:32770"


def _tls_claim() -> dict:
    """A completed-session envelope carrying the new tls:// prod transport."""
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
        # Persist tail boots the wake pump against the (fake) nats_url;
        # neutralise both entry points so we exercise persist in isolation.
        self._pump_patches = patch.multiple(
            "klodi_hermes.wake_pump_control",
            start_wake_pump=lambda: None,
            stop_wake_pump=lambda: None,
        )
        self._pump_patches.start()
        self.addCleanup(self._pump_patches.stop)
        self._close_patch = patch(
            "klodi_hermes.client.close_client", side_effect=lambda: None
        )
        self._close_patch.start()
        self.addCleanup(self._close_patch.stop)

    def tearDown(self) -> None:
        if self._prev_env is None:
            os.environ.pop("KLODI_HOME", None)
        else:
            os.environ["KLODI_HOME"] = self._prev_env
        self._tmp.cleanup()


class TestPersistTlsUrl(_KlodiHomeCase):
    def test_persists_tls_url_unchanged(self) -> None:
        # Act
        _persist_credentials(_tls_claim())

        # Assert — the server's tls:// url landed in config.json verbatim.
        config_path = self.home / "config.json"
        self.assertTrue(config_path.exists(), "config.json must be written")
        written = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(
            written["nats_url"],
            _TLS_PROD_URL,
            "tls:// nats_url must persist unchanged (not rewritten/dropped)",
        )

    def test_rejects_plaintext_nats_non_localhost(self) -> None:
        claim = _tls_claim()
        claim["nats_url"] = "nats://hayabusa.proxy.rlwy.net:4222"
        with self.assertRaises(OSError):
            _persist_credentials(claim)
        # Nothing persisted.
        self.assertFalse((self.home / "config.json").exists())
        self.assertFalse((self.home / "nats.creds").exists())

    def test_rejects_plaintext_ws_non_localhost(self) -> None:
        claim = _tls_claim()
        claim["nats_url"] = "ws://attacker.example.com:8080"
        with self.assertRaises(OSError):
            _persist_credentials(claim)
        self.assertFalse((self.home / "config.json").exists())


if __name__ == "__main__":
    unittest.main()
