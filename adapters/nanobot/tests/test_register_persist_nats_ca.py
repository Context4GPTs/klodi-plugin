"""RED — nanobot persists the register-response nats_ca (nanobot_local_tools.py).

Card: auto-trust-nats-ca-from-register.
nanobot half of the six-adapter symmetry audit. Same contract as hermes:

  * response carries a PEM nats_ca → ${KLODI_HOME}/nats-ca.pem written.
  * response omits nats_ca → nothing new persisted; creds + config still land;
    an existing persisted CA is NOT deleted on a later omission.
  * re-register with a rotated nats_ca → persisted CA replaced.

nats_ca is OPTIONAL — never added to the required-field loop. RED today:
_persist_credentials ignores nats_ca.

QA-owned — NEVER weaken.
"""

from __future__ import annotations

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

    def tearDown(self) -> None:
        if self._prev_env is None:
            os.environ.pop("KLODI_HOME", None)
        else:
            os.environ["KLODI_HOME"] = self._prev_env
        self._tmp.cleanup()

    @property
    def ca_file(self) -> Path:
        return self.home / "nats-ca.pem"


class TestNanobotPersistNatsCa(_KlodiHomeCase):
    def test_persists_nats_ca_alongside_config(self) -> None:
        lt._persist_credentials(_claim(nats_ca=_CA_ONE))

        self.assertTrue(
            self.ca_file.exists(),
            "register nats_ca must be persisted to ${KLODI_HOME}/nats-ca.pem",
        )
        self.assertEqual(self.ca_file.read_text(encoding="utf-8"), _CA_ONE)
        self.assertTrue((self.home / "config.json").exists())

    def test_omitted_nats_ca_persists_nothing_but_creds_config_land(self) -> None:
        lt._persist_credentials(_claim())

        self.assertFalse(self.ca_file.exists())
        self.assertTrue((self.home / "config.json").exists())
        self.assertTrue((self.home / "nats.creds").exists())

    def test_omission_on_reregister_does_not_delete_existing_ca(self) -> None:
        lt._persist_credentials(_claim(nats_ca=_CA_ONE))
        lt._persist_credentials(_claim())

        self.assertTrue(self.ca_file.exists())
        self.assertEqual(self.ca_file.read_text(encoding="utf-8"), _CA_ONE)

    def test_reregister_rotates_persisted_ca(self) -> None:
        lt._persist_credentials(_claim(nats_ca=_CA_ONE))
        lt._persist_credentials(_claim(nats_ca=_CA_TWO))

        self.assertEqual(self.ca_file.read_text(encoding="utf-8"), _CA_TWO)


if __name__ == "__main__":
    unittest.main()
