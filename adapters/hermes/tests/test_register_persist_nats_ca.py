"""RED — hermes persists the register-response nats_ca (register.py).

Criteria (Scenario 1 persist + Scenario 3 no-regression + rotation, hermes half
of the six-adapter symmetry audit):

  * response carries a PEM nats_ca → ${KLODI_HOME}/nats-ca.pem is written
    alongside config.json (survives restart; non-secret cert).
  * response omits nats_ca → nothing new persisted; creds + config still land
    (older @klodi/web ⇒ no regression). An existing persisted CA is NOT
    deleted on a later omission ("no update" ≠ "revoke").
  * re-register with a rotated nats_ca → the persisted CA is replaced.

nats_ca is OPTIONAL — it must NEVER be added to the required-field loop, so an
absent value never fails registration. RED today: register.py:_persist_credentials
ignores nats_ca entirely.

Harness mirrors test_register_tls_persist.py (the persist tail boots the wake
pump; both entry points patched to no-ops so persist runs in isolation).

QA-owned — NEVER weaken.
"""

from __future__ import annotations

import importlib
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

_TLS_URL = "tls://hayabusa.proxy.rlwy.net:32770"
_CA_ONE = (
    "-----BEGIN CERTIFICATE-----\nMIICregisterCaOneFixtureBody\n"
    "-----END CERTIFICATE-----\n"
)
_CA_TWO = (
    "-----BEGIN CERTIFICATE-----\nMIICrotatedCaTwoFixtureBody\n"
    "-----END CERTIFICATE-----\n"
)


def _claim(*, nats_ca: str | None = None) -> dict:
    claim = {
        "status": "completed",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "nats_url": _TLS_URL,
    }
    if nats_ca is not None:
        claim["nats_ca"] = nats_ca
    return claim


class _KlodiHomeCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._prev_env = os.environ.get("KLODI_HOME")
        os.environ["KLODI_HOME"] = str(self.home)
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

    @property
    def ca_file(self) -> Path:
        return self.home / "nats-ca.pem"


class TestHermesPersistNatsCa(_KlodiHomeCase):
    def test_persists_nats_ca_alongside_config(self) -> None:
        _persist_credentials(_claim(nats_ca=_CA_ONE))

        self.assertTrue(
            self.ca_file.exists(),
            "register nats_ca must be persisted to ${KLODI_HOME}/nats-ca.pem",
        )
        self.assertEqual(self.ca_file.read_text(encoding="utf-8"), _CA_ONE)
        self.assertTrue((self.home / "config.json").exists())

    def test_omitted_nats_ca_persists_nothing_but_creds_config_land(self) -> None:
        _persist_credentials(_claim())  # older @klodi/web — no nats_ca

        self.assertFalse(
            self.ca_file.exists(),
            "no nats_ca in the response ⇒ nothing new persisted",
        )
        # No regression: creds + config still written.
        self.assertTrue((self.home / "config.json").exists())
        self.assertTrue((self.home / "nats.creds").exists())

    def test_omission_on_reregister_does_not_delete_existing_ca(self) -> None:
        _persist_credentials(_claim(nats_ca=_CA_ONE))
        _persist_credentials(_claim())  # later re-register omits the field

        self.assertTrue(
            self.ca_file.exists(),
            "'no update' must not revoke a previously persisted CA",
        )
        self.assertEqual(self.ca_file.read_text(encoding="utf-8"), _CA_ONE)

    def test_reregister_rotates_persisted_ca(self) -> None:
        _persist_credentials(_claim(nats_ca=_CA_ONE))
        _persist_credentials(_claim(nats_ca=_CA_TWO))

        self.assertEqual(
            self.ca_file.read_text(encoding="utf-8"),
            _CA_TWO,
            "a fresh nats_ca on re-register must replace the persisted CA",
        )


if __name__ == "__main__":
    unittest.main()
