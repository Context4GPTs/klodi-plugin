"""Unit tests for nanobot's local-tool surface (D4 expansion).

Coverage per **D § D4** + Phase 4 contribution doc "Deferred —
D4 nanobot setup family":

* phase / issue derivation against gather_checks
* setup_repair preserves policies / buy files
* setup_reseed_policies chmods 0o755 (P3-9 mirror) + seeds templates
* setup_reseed_skill force-copies the canonical bundle
* register / register_poll happy paths + invalid input
* watch / unwatch happy paths + filesystem side effects
* health probes connection state + whoami round-trip
* dispatch_local_tool routes correctly + raises KeyError for unknown
* the new entries are visible in TOOL_DEFINITIONS

Tests use a per-test ``KLODI_HOME`` tempdir and monkey-patch the
bundled-skill resolver so they don't depend on the build-time
copy-skill step.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

import nanobot_client as client
import nanobot_local_tools as lt
import nanobot_tools as tools


# ── Helpers ───────────────────────────────────────────────────────────


def _write_creds(home: Path, mode: int = 0o600) -> Path:
    path = home / "nats.creds"
    path.write_text("-----BEGIN NATS USER JWT-----\nfake\n", encoding="utf-8")
    os.chmod(path, mode)
    return path


def _write_config(
    home: Path,
    *,
    handle: str = "alice",
    user_id: str = "u-1",
    nkey_public: str = "UAAAAAAAAAAAA",
    nats_url: str = "tls://hayabusa.proxy.rlwy.net:32770",
) -> Path:
    path = home / "config.json"
    path.write_text(
        json.dumps({
            "handle": handle,
            "user_id": user_id,
            "nkey_public": nkey_public,
            "nats_url": nats_url,
        }),
        encoding="utf-8",
    )
    return path


def _write_policies(
    home: Path,
    *,
    negotiation_filled: bool = True,
    security: bool = True,
) -> None:
    policies = home / "policies"
    policies.mkdir(parents=True, exist_ok=True)
    content = (
        "# negotiation style — user-authored\n"
        if negotiation_filled
        else "<!-- SEED: replace this block with your pricing policy -->\n"
    )
    (policies / "negotiation_style.md").write_text(content, encoding="utf-8")
    if security:
        (policies / "security.md").write_text(
            "# security hard rules\n", encoding="utf-8"
        )


def _make_fake_client() -> Any:
    fake = MagicMock()
    fake.request = AsyncMock()
    fake.publish_channel_message = AsyncMock()
    fake.is_connected = True
    return fake


class _NanobotHomeCase(unittest.TestCase):
    """Per-test KLODI_HOME tempdir + bundled-skill monkey-patch."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._prev_env = os.environ.get("KLODI_HOME")
        os.environ["KLODI_HOME"] = str(self.home)
        # Seed a fake bundled-skill source so reseed_policies /
        # reseed_skill can find templates in tests.
        self._bundle = self.home / "_fake_bundle"
        (self._bundle / "templates").mkdir(parents=True)
        (self._bundle / "policies").mkdir(parents=True)
        (self._bundle / "templates" / "negotiation_style.template.md").write_text(
            "<!-- SEED: replace this -->\n", encoding="utf-8"
        )
        (self._bundle / "policies" / "security.md").write_text(
            "# security hard rules\n", encoding="utf-8"
        )
        self._orig_bundled = lt._bundled_skill_dir
        lt._bundled_skill_dir = lambda: self._bundle  # type: ignore[assignment]

    def tearDown(self) -> None:
        lt._bundled_skill_dir = self._orig_bundled  # type: ignore[assignment]
        if self._prev_env is None:
            os.environ.pop("KLODI_HOME", None)
        else:
            os.environ["KLODI_HOME"] = self._prev_env
        self._tmp.cleanup()


# ── derive_phase / derive_issues ──────────────────────────────────────


class TestDerivePhase(_NanobotHomeCase):
    def test_empty_dir_is_unregistered(self) -> None:
        phase = lt.derive_phase(lt.gather_checks())
        self.assertEqual(phase, "unregistered")

    def test_creds_only_is_corrupt(self) -> None:
        _write_creds(self.home)
        self.assertEqual(lt.derive_phase(lt.gather_checks()), "corrupt")

    def test_config_only_is_corrupt(self) -> None:
        _write_config(self.home)
        self.assertEqual(lt.derive_phase(lt.gather_checks()), "corrupt")

    def test_registered_without_policies_is_needs_policy(self) -> None:
        _write_creds(self.home)
        _write_config(self.home)
        self.assertEqual(lt.derive_phase(lt.gather_checks()), "needs_policy")

    def test_fully_set_up_is_ready(self) -> None:
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        self.assertEqual(lt.derive_phase(lt.gather_checks()), "ready")


class TestDeriveIssues(_NanobotHomeCase):
    def test_unregistered_short_circuits_with_not_registered(self) -> None:
        issues = lt.derive_issues(lt.gather_checks())
        self.assertEqual([i["code"] for i in issues], ["not_registered"])
        self.assertEqual(issues[0]["fix"]["tool"], "klodi_register")

    def test_partial_credentials_surfaces_partial_credentials(self) -> None:
        _write_creds(self.home)
        issues = lt.derive_issues(lt.gather_checks())
        self.assertEqual([i["code"] for i in issues], ["partial_credentials"])

    def test_fully_set_up_returns_no_issues(self) -> None:
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        self.assertEqual(lt.derive_issues(lt.gather_checks()), [])


# ── handle_setup_status ───────────────────────────────────────────────


class TestSetupStatus(_NanobotHomeCase):
    def test_status_includes_phase_and_checks(self) -> None:
        result = lt.handle_setup_status({})
        self.assertIn("phase", result)
        self.assertIn("checks", result)
        self.assertIn("issues", result)
        self.assertIn("config", result)

    def test_ready_phase_when_fully_set_up(self) -> None:
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        result = lt.handle_setup_status({})
        self.assertEqual(result["phase"], "ready")
        self.assertIsNone(result["next_step"])


# ── handle_setup_repair ───────────────────────────────────────────────


class TestSetupRepair(_NanobotHomeCase):
    def test_removes_creds_and_config(self) -> None:
        creds = _write_creds(self.home)
        config = _write_config(self.home)
        result = lt.handle_setup_repair({})
        self.assertEqual(result["failures"], [])
        self.assertEqual(set(result["removed"]), {str(creds), str(config)})
        self.assertFalse(creds.exists())
        self.assertFalse(config.exists())

    def test_preserves_policies_and_buy_files(self) -> None:
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        buy_dir = self.home / "buy"
        buy_dir.mkdir()
        (buy_dir / "vintage-camera.md").write_text("policy", encoding="utf-8")
        lt.handle_setup_repair({})
        self.assertTrue(
            (self.home / "policies" / "negotiation_style.md").exists()
        )
        self.assertTrue((buy_dir / "vintage-camera.md").exists())

    def test_returns_empty_when_nothing_present(self) -> None:
        result = lt.handle_setup_repair({})
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["failures"], [])


# ── handle_setup_reseed_policies (P3-9 chmod mirror) ──────────────────


class TestSetupReseedPolicies(_NanobotHomeCase):
    def test_seeds_files_and_returns_True_for_each(self) -> None:
        result = lt.handle_setup_reseed_policies({})
        self.assertTrue(result["negotiation_style_seeded"])
        self.assertTrue(result["security_policy_seeded"])
        self.assertTrue(
            (self.home / "policies" / "negotiation_style.md").exists()
        )
        self.assertTrue(
            (self.home / "policies" / "security.md").exists()
        )

    def test_policies_dir_mode_is_0755_after_reseed(self) -> None:
        if sys.platform == "win32":
            self.skipTest("POSIX mode bits not enforced on Windows")
        prev_umask = os.umask(0o077)
        try:
            lt.handle_setup_reseed_policies({})
        finally:
            os.umask(prev_umask)
        mode = (self.home / "policies").stat().st_mode & 0o777
        self.assertEqual(mode, 0o755, f"got mode {oct(mode)}")

    def test_does_not_overwrite_existing_files(self) -> None:
        _write_policies(self.home, negotiation_filled=True, security=True)
        result = lt.handle_setup_reseed_policies({})
        self.assertFalse(result["negotiation_style_seeded"])
        self.assertFalse(result["security_policy_seeded"])
        # User content preserved.
        content = (self.home / "policies" / "negotiation_style.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("user-authored", content)


# ── handle_setup_reseed_skill ─────────────────────────────────────────


class TestSetupReseedSkill(_NanobotHomeCase):
    def test_force_copies_skill_bundle(self) -> None:
        # Add a known file in the fake bundle so we can verify it lands.
        (self._bundle / "SKILL.md").write_text("# klodi skill\n", encoding="utf-8")
        result = lt.handle_setup_reseed_skill({})
        self.assertTrue(result["skill_seeded"])
        target = self.home / "skill" / "SKILL.md"
        self.assertTrue(target.exists())

    def test_returns_error_when_source_missing(self) -> None:
        # Repoint bundle dir at a non-existent location.
        lt._bundled_skill_dir = lambda: self.home / "no_such_dir"  # type: ignore[assignment]
        result = lt.handle_setup_reseed_skill({})
        self.assertFalse(result["skill_seeded"])
        self.assertIn("error", result)

    def test_overwrites_existing_target(self) -> None:
        (self._bundle / "SKILL.md").write_text("# new\n", encoding="utf-8")
        target_dir = self.home / "skill"
        target_dir.mkdir(parents=True)
        (target_dir / "old.md").write_text("# stale\n", encoding="utf-8")
        lt.handle_setup_reseed_skill({})
        # The stale file is gone, only canonical bundle remains.
        self.assertFalse((target_dir / "old.md").exists())
        self.assertTrue((target_dir / "SKILL.md").exists())


# ── handle_register / handle_register_poll ────────────────────────────


class TestRegister(_NanobotHomeCase):
    def test_register_returns_already_registered_when_config_present(self) -> None:
        _write_config(self.home)
        result = lt.handle_register({})
        self.assertEqual(result["status"], "already_registered")
        self.assertEqual(result["handle"], "alice")

    def test_register_returns_session_id_and_auth_url(self) -> None:
        result = lt.handle_register({})
        self.assertEqual(result["status"], "awaiting_browser")
        self.assertIn("auth_url", result)
        self.assertIn("session_id", result)
        # Session is tracked so the background thread can settle it.
        with lt._LOCK:
            self.assertIn(result["session_id"], lt._IN_FLIGHT)
        # Tear down the in-flight state to avoid bleeding into other
        # tests (the daemon thread runs for up to _POLL_CEILING_S).
        with lt._LOCK:
            lt._IN_FLIGHT.pop(result["session_id"], None)

    def test_register_poll_rejects_invalid_session_id(self) -> None:
        result = lt.handle_register_poll({"session_id": "not-a-uuid"})
        self.assertEqual(result["error"], "INVALID_SESSION_ID")

    def test_register_poll_returns_settled_state_without_refetch(self) -> None:
        # Arrange — a settled state in the in-flight registry.
        sid = "00000000-0000-4000-8000-000000000000"
        state = lt._PollState(sid, thread=None)
        state.status = "registered"
        state.result = {"status": "registered", "handle": "alice"}
        with lt._LOCK:
            lt._IN_FLIGHT[sid] = state
        try:
            result = lt.handle_register_poll({"session_id": sid})
        finally:
            with lt._LOCK:
                lt._IN_FLIGHT.pop(sid, None)
        self.assertEqual(result["status"], "registered")
        self.assertEqual(result["handle"], "alice")


# ── _persist_credentials (tls-only persist guard) ─────────────────────


def _complete_claim(nats_url: str) -> dict:
    """A valid session-completed envelope with the given nats_url."""
    return {
        "status": "completed",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "nats_url": nats_url,
    }


class TestPersistCredentials(_NanobotHomeCase):
    """[integration] nanobot's register persist path routes nats_url
    through the SHARED client guard (nanobot_local_tools.py:625). The
    tls-only cutover (collapse-nats-transport-guard-to-tls-only) makes a
    wss://<non-localhost> url fail closed while tls://<host> persists."""

    def test_persist_rejects_wss_non_localhost_via_shared_guard(self) -> None:
        # A stale / compromised /register returning wss://<non-localhost>
        # is refused by the shared guard — no adapter-local scheme check.
        claim = _complete_claim("wss://klodi-net.4gpts.com")
        with self.assertRaises(OSError):
            lt._persist_credentials(claim)
        self.assertFalse((self.home / "nats.creds").exists())
        self.assertFalse((self.home / "config.json").exists())

    def test_persist_accepts_tls_non_localhost_via_shared_guard(self) -> None:
        claim = _complete_claim("tls://hayabusa.proxy.rlwy.net:32770")
        lt._persist_credentials(claim)
        written = json.loads(
            (self.home / "config.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            written["nats_url"], "tls://hayabusa.proxy.rlwy.net:32770"
        )
        self.assertTrue((self.home / "nats.creds").exists())


# ── handle_health ─────────────────────────────────────────────────────


class TestHealth(_NanobotHomeCase):
    def setUp(self) -> None:
        super().setUp()
        client._CLIENT = None  # type: ignore[attr-defined]

    def test_health_reports_disconnected_when_no_client(self) -> None:
        result = lt.handle_health({})
        self.assertFalse(result["ok"])
        self.assertFalse(result["connected"])
        self.assertIn("issue", result)

    def test_health_round_trips_whoami_when_connected(self) -> None:
        fake = _make_fake_client()
        fake.request.return_value = {"user_id": "u-1", "handle": "alice"}
        client.set_client(fake)
        result = lt.handle_health({})
        self.assertTrue(result["ok"])
        self.assertTrue(result["connected"])
        self.assertEqual(result["user_id"], "u-1")
        self.assertEqual(result["handle"], "alice")
        self.assertIsInstance(result["latency_ms"], int)


# ── handle_watch / handle_unwatch ─────────────────────────────────────


class TestWatch(_NanobotHomeCase):
    def setUp(self) -> None:
        super().setUp()
        client._CLIENT = None  # type: ignore[attr-defined]

    def test_watch_rejects_invalid_slug(self) -> None:
        client.set_client(_make_fake_client())
        result = lt.handle_watch({"slug": "Bad SLUG!"})
        self.assertEqual(result["error"], "INVALID_SLUG")

    def test_watch_rejects_missing_slug(self) -> None:
        client.set_client(_make_fake_client())
        result = lt.handle_watch({})
        self.assertEqual(result["error"], "INVALID_REQUEST")

    def test_watch_creates_search_and_writes_buy_file(self) -> None:
        fake = _make_fake_client()
        fake.request.return_value = {
            "search_id": "ssss-id",
            "slug": "vintage-camera",
        }
        client.set_client(fake)
        result = lt.handle_watch({"slug": "vintage-camera", "max_price": 5000})
        self.assertEqual(result["slug"], "vintage-camera")
        self.assertEqual(result["search_id"], "ssss-id")
        buy_file = Path(result["buy_file_path"])
        self.assertTrue(buy_file.exists())
        # Make sure searches.create was the subject hit.
        await_args = fake.request.await_args
        self.assertEqual(await_args.args[0], "p2p.v1.searches.create")
        self.assertEqual(
            await_args.args[1],
            {"slug": "vintage-camera", "max_price": 5000},
        )

    def test_unwatch_rejects_invalid_slug(self) -> None:
        client.set_client(_make_fake_client())
        result = lt.handle_unwatch({"slug": "Bad!"})
        self.assertEqual(result["error"], "INVALID_SLUG")

    def test_unwatch_removes_buy_file_and_calls_delete(self) -> None:
        fake = _make_fake_client()
        fake.request.return_value = {"slug": "x"}
        client.set_client(fake)
        # Pre-arrange — a buy file the user wants gone.
        buy_dir = self.home / "buy"
        buy_dir.mkdir()
        (buy_dir / "x.md").write_text("policy", encoding="utf-8")
        result = lt.handle_unwatch({"slug": "x"})
        self.assertTrue(result["removed"])
        self.assertTrue(result["buy_file_removed"])
        self.assertFalse((buy_dir / "x.md").exists())
        # Verify the right NATS subject got hit.
        await_args = fake.request.await_args
        self.assertEqual(await_args.args[0], "p2p.v1.searches.delete")


# ── dispatch_local_tool ───────────────────────────────────────────────


class TestDispatch(_NanobotHomeCase):
    def test_routes_known_tool_to_handler(self) -> None:
        result = lt.dispatch_local_tool("klodi_setup_status", {})
        self.assertIn("phase", result)

    def test_raises_keyerror_for_unknown(self) -> None:
        with self.assertRaises(KeyError):
            lt.dispatch_local_tool("klodi_does_not_exist", {})


# ── TOOL_DEFINITIONS surface (catalog ↔ adapter wire-up) ───────────────


class TestDefinitions(unittest.TestCase):
    def test_local_tools_are_in_definitions(self) -> None:
        names = {t["name"] for t in tools.TOOL_DEFINITIONS}
        for required in (
            "klodi_setup_status",
            "klodi_setup_repair",
            "klodi_setup_reseed_policies",
            "klodi_setup_reseed_skill",
            "klodi_register",
            "klodi_register_poll",
            "klodi_health",
            "klodi_watch",
            "klodi_unwatch",
        ):
            self.assertIn(required, names, f"missing {required}")


# ── handle() routes local tools through dispatch_local_tool ───────────


@pytest.fixture
def reset_singleton() -> None:
    client._CLIENT = None  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_handle_routes_local_tool_to_dispatch(
    reset_singleton: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Point KLODI_HOME at a fresh dir so handle_setup_status returns
    # 'unregistered' (not contaminated by host machine state).
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    raw = await tools.handle("klodi_setup_status", {})
    parsed = json.loads(raw)
    assert parsed["phase"] == "unregistered"


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_local_tool_error(
    reset_singleton: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Force the dispatcher to raise so we hit the catch-all envelope
    # path. Per ADR-0011 / R2, an uncategorised exception in a local
    # tool degrades to `internal_error` (the previous `transport_error`
    # code was outside the closed R2 vocabulary).
    def boom(name: str, args: dict) -> dict:
        raise RuntimeError("boom")

    monkeypatch.setattr(tools, "dispatch_local_tool", boom)
    raw = await tools.handle("klodi_setup_status", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert set(parsed.keys()) == {"error", "message", "details", "recovery_hint"}


if __name__ == "__main__":
    unittest.main()
