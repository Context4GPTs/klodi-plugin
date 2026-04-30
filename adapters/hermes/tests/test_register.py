"""Tests for klodi_hermes.register — the Auth0 session handoff that
persists NATS credentials on claim success.

We cover the three deterministic leaf functions that hold the security-
sensitive contract:

* ``_is_uuid``            — the gate that keeps un-validated
                             session_ids from reaching the session
                             fetch (and incidentally the remote API).
* ``_persist_credentials`` — writes creds + config under KLODI_HOME,
                             raises OSError on any missing field so a
                             half-claimed session can't leak a partial
                             state onto disk.
* ``handle_register_poll`` — the manual-fallback entry point; must
                             reject a bad session_id without fetching.

Out of scope: the background poll loop, urllib network calls, and the
Hermes ctx wake injection. Those are integration concerns and belong
in a separate test tier — this file is the unit contract.

Import style mirrors test_envelope.py / test_local_tools.py: register
uses relative imports, so must be loaded as a hermes package member.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

# Import the module itself by its dotted path so patch() has a stable
# attribute target. The top-level `klodi_hermes` package exposes a
# `register` function in its __init__, which shadows the `register`
# submodule when looking up klodi_hermes.register as an attribute.
# Pulling the module via importlib avoids that collision.
import importlib

_register_mod = importlib.import_module("klodi_hermes.register")
_is_uuid = _register_mod._is_uuid
_persist_credentials = _register_mod._persist_credentials
handle_register_poll = _register_mod.handle_register_poll


_VALID_SESSION = "550e8400-e29b-41d4-a716-446655440000"


def _complete_claim() -> dict:
    """A valid session-completed envelope as returned by the Klodi API."""
    return {
        "status": "completed",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "nats_url": "wss://klodi-net.4gpts.com",
    }


class _KlodiHomeCase(unittest.TestCase):
    """Per-test KLODI_HOME pointed at a throwaway directory."""

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


# ── _is_uuid ─────────────────────────────────────────────────────────

class TestIsUuid(unittest.TestCase):
    def test_accepts_canonical_v4_uuid(self):
        # Arrange + Act + Assert — the format the client-side uses.
        self.assertTrue(_is_uuid(_VALID_SESSION))

    def test_accepts_uppercase_uuid(self):
        # Arrange — uuid.UUID is case-insensitive; both forms the API
        # might echo back should be accepted.
        self.assertTrue(_is_uuid(_VALID_SESSION.upper()))

    def test_rejects_empty_string(self):
        # Act + Assert
        self.assertFalse(_is_uuid(""))

    def test_rejects_non_uuid_garbage(self):
        # Act + Assert — a classic injection probe.
        self.assertFalse(_is_uuid("not-a-uuid"))

    def test_rejects_truncated_uuid(self):
        # Arrange — drop the final hex char; uuid.UUID raises ValueError.
        truncated = _VALID_SESSION[:-1]
        # Act + Assert
        self.assertFalse(_is_uuid(truncated))

    def test_rejects_uuid_with_trailing_garbage(self):
        # Arrange + Act + Assert
        self.assertFalse(_is_uuid(_VALID_SESSION + "xxx"))

    def test_rejects_numeric_string(self):
        # Act + Assert — a plausible "session id" shape that is NOT a UUID.
        self.assertFalse(_is_uuid("12345678"))


# ── _persist_credentials ─────────────────────────────────────────────

class TestPersistCredentials(_KlodiHomeCase):
    """``_persist_credentials`` ends by booting the shared WakePump so a
    fresh registration is observable over NATS without an extra call.
    The pump's ``start_wake_pump`` opens a real NATS-WS connection via
    ``connect_client()`` — fine in production, fatal in unit tests because
    the fake ``nats_url`` (``wss://nats.fake.local``) hangs the connect.

    Patch both pump entry points on ``klodi_hermes.wake_pump_control``
    (the module ``_persist_credentials`` imports them from at call time)
    so the persist contract is exercised in isolation. We patch at class
    scope rather than per-test — the early-fail OSError tests don't reach
    the pump call today, but a future happy-path-shaped test would, and
    making one test hang the whole run is too sharp an edge to leave."""

    def setUp(self) -> None:
        super().setUp()
        # Module-level patch: the local import inside _persist_credentials
        # (``from .wake_pump_control import start_wake_pump, stop_wake_pump``)
        # binds the attributes on klodi_hermes.wake_pump_control at call
        # time, so patching the module attributes catches the lookup.
        self._pump_patches = patch.multiple(
            "klodi_hermes.wake_pump_control",
            start_wake_pump=lambda: None,
            stop_wake_pump=lambda: None,
        )
        self._pump_patches.start()
        self.addCleanup(self._pump_patches.stop)

    def test_happy_path_writes_creds_and_config(self):
        # Arrange
        claim = _complete_claim()

        # Act
        _persist_credentials(claim)

        # Assert — nats.creds holds the raw creds content.
        creds_path = self.home / "nats.creds"
        self.assertTrue(creds_path.exists())
        self.assertEqual(
            creds_path.read_text(encoding="utf-8"),
            claim["nats_creds"],
        )

        # Assert — config.json is valid JSON with the four required
        # string fields AND does not leak nats_creds into the config
        # file (creds are separate on disk).
        config_path = self.home / "config.json"
        self.assertTrue(config_path.exists())
        written_config = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(written_config["handle"], claim["handle"])
        self.assertEqual(written_config["user_id"], claim["user_id"])
        self.assertEqual(written_config["nkey_public"], claim["nkey_public"])
        self.assertEqual(written_config["nats_url"], claim["nats_url"])
        self.assertNotIn("nats_creds", written_config)

    def test_creds_file_is_mode_600(self):
        # Arrange + Act
        _persist_credentials(_complete_claim())

        # Assert — creds containing a private-key-derived JWT must not
        # be group/world readable. If chmod silently fails the contract
        # in _creds_mode_secure (local_tools) flags it; here we pin the
        # happy-path behaviour.
        mode = (self.home / "nats.creds").stat().st_mode & 0o777
        # Accept 0o600 or stricter (e.g. 0o400 on a user who hardened).
        self.assertEqual(mode & 0o077, 0, f"creds mode {oct(mode)} is group/world readable")

    def test_raises_oserror_when_handle_missing(self):
        # Arrange — remove handle.
        claim = _complete_claim()
        del claim["handle"]

        # Act + Assert — each missing required field aborts before any
        # write lands on disk.
        with self.assertRaisesRegex(OSError, r"handle"):
            _persist_credentials(claim)
        self.assertFalse((self.home / "nats.creds").exists())
        self.assertFalse((self.home / "config.json").exists())

    def test_raises_oserror_when_user_id_missing(self):
        # Arrange
        claim = _complete_claim()
        del claim["user_id"]

        # Act + Assert
        with self.assertRaisesRegex(OSError, r"user_id"):
            _persist_credentials(claim)

    def test_raises_oserror_when_nkey_public_missing(self):
        # Arrange
        claim = _complete_claim()
        del claim["nkey_public"]

        # Act + Assert
        with self.assertRaisesRegex(OSError, r"nkey_public"):
            _persist_credentials(claim)

    def test_raises_oserror_when_nats_creds_missing(self):
        # Arrange
        claim = _complete_claim()
        del claim["nats_creds"]

        # Act + Assert
        with self.assertRaisesRegex(OSError, r"nats_creds"):
            _persist_credentials(claim)

    def test_raises_oserror_when_nats_url_missing(self):
        # Arrange
        claim = _complete_claim()
        del claim["nats_url"]

        # Act + Assert
        with self.assertRaisesRegex(OSError, r"nats_url"):
            _persist_credentials(claim)

    def test_raises_oserror_when_field_is_empty_string(self):
        # Arrange — an empty string is not a valid credential payload.
        claim = _complete_claim()
        claim["handle"] = ""

        # Act + Assert — both missing AND empty trigger OSError so there
        # is exactly one failure mode the caller must handle.
        with self.assertRaisesRegex(OSError, r"handle"):
            _persist_credentials(claim)

    def test_raises_oserror_when_field_is_non_string(self):
        # Arrange — numeric user_id would be a type violation; accepting
        # it would mean `{"user_id": 0}` could sneak through.
        claim = _complete_claim()
        claim["user_id"] = 42

        # Act + Assert
        with self.assertRaisesRegex(OSError, r"user_id"):
            _persist_credentials(claim)

    def test_persist_calls_close_client_between_stop_and_start_pump(self):
        # Arrange — the bug this pins: the chat-session process keeps a
        # stale module-level `_CLIENT` (klodi_hermes.client._CLIENT) after
        # a setup_repair → register cycle. ``stop_wake_pump`` / ``start_wake_pump``
        # alone don't tear down that singleton (``connect_client`` reuses
        # the existing instance), so klodi_whoami stays UNAUTHORIZED even
        # though creds files on disk have rotated. The fix inserts
        # ``close_client()`` between the stop/start pair so the next
        # ``start_wake_pump`` reconstructs a fresh KlodiClient bound to
        # the new creds. Order matters: ``close_client`` BEFORE
        # ``stop_wake_pump`` would tear down the asyncio loop the pump's
        # stop coroutine still needs; AFTER ``start_wake_pump`` would
        # immediately kill the freshly-started pump's connection. The
        # only correct slot is the middle.
        calls: list[str] = []

        # Override the class-level no-op patches with recorders. The
        # local import inside ``_persist_credentials`` resolves
        # ``stop_wake_pump`` / ``start_wake_pump`` from
        # ``klodi_hermes.wake_pump_control`` at call time, and
        # ``close_client`` from ``klodi_hermes.client`` (the fix uses a
        # symmetric local import for cycle reasons), so we patch the
        # module attributes both lookups hit.
        with patch.multiple(
            "klodi_hermes.wake_pump_control",
            stop_wake_pump=lambda: calls.append("stop_wake"),
            start_wake_pump=lambda: calls.append("start_wake"),
        ), patch(
            "klodi_hermes.client.close_client",
            side_effect=lambda: calls.append("close_client"),
        ):
            # Act — happy-path persist exercises the stop/close/start trio.
            _persist_credentials(_complete_claim())

        # Assert — exact order. A regression that drops close_client
        # entirely produces ["stop_wake", "start_wake"]; a regression
        # that flips the order produces e.g.
        # ["close_client", "stop_wake", "start_wake"]. Both fail this
        # equality check.
        self.assertEqual(
            calls,
            ["stop_wake", "close_client", "start_wake"],
            "stop/close/start order is the contract — see comment above",
        )


# ── handle_register_poll ─────────────────────────────────────────────

class TestHandleRegisterPoll(_KlodiHomeCase):
    def test_rejects_missing_session_id_without_fetching(self):
        # Arrange — no session_id supplied at all. Patch _fetch_session
        # so if the early-return broke we'd see the fetch fire.
        with patch.object(_register_mod, "_fetch_session") as fetch:
            # Act
            raw = handle_register_poll({})

            # Assert — INVALID_SESSION_ID error + _fetch_session never
            # touched. A regression that dropped the guard would make
            # the API fetch with session_id=None.
            result = json.loads(raw)
            self.assertEqual(result["error"], "INVALID_SESSION_ID")
            fetch.assert_not_called()

    def test_rejects_non_string_session_id_without_fetching(self):
        # Arrange
        with patch.object(_register_mod, "_fetch_session") as fetch:
            # Act
            raw = handle_register_poll({"session_id": 42})

            # Assert
            result = json.loads(raw)
            self.assertEqual(result["error"], "INVALID_SESSION_ID")
            fetch.assert_not_called()

    def test_rejects_malformed_uuid_without_fetching(self):
        # Arrange — a string but not a UUID. This is the adversarial
        # case: an attacker-controlled string must NOT reach _fetch_session
        # because it would be interpolated into a URL path.
        with patch.object(_register_mod, "_fetch_session") as fetch:
            # Act
            raw = handle_register_poll({"session_id": "not-a-uuid"})

            # Assert
            result = json.loads(raw)
            self.assertEqual(result["error"], "INVALID_SESSION_ID")
            self.assertIn("UUID", result["message"])
            fetch.assert_not_called()

    def test_rejects_empty_string_session_id_without_fetching(self):
        # Arrange
        with patch.object(_register_mod, "_fetch_session") as fetch:
            # Act
            raw = handle_register_poll({"session_id": ""})

            # Assert — empty string is a string but not a UUID; must
            # also be rejected.
            result = json.loads(raw)
            self.assertEqual(result["error"], "INVALID_SESSION_ID")
            fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
