"""Tests for klodi_hermes.local_tools — filesystem probes, phase/issue
derivation, and the non-destructive setup_repair handler.

These tools are what the agent (and the user) hit when the connection
is wedged: mis-registered, missing creds, un-customised policy. A
regression here gives the user wrong next-step guidance and strands
them in a loop. Pin the contract on both pure functions
(derive_phase / derive_issues / _seed_if_absent) and the file-effecting
handler (_handle_setup_repair).

Per 0012, the wake-registration phase is gone — the persistent NATS-WS
connection delivers wakes directly. So the phase machine collapses to:
unregistered → corrupt → needs_policy → ready.

Import style: local_tools uses relative imports, so it MUST be loaded
as a member of the hermes package, not as a top-level module.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from klodi_hermes.local_tools import (
    _handle_setup_repair,
    _handle_setup_reseed_policies,
    _seed_if_absent,
    derive_issues,
    derive_phase,
    gather_checks,
)


# ── Fixture helpers ──────────────────────────────────────────────────

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
    nats_url: str = "nats://klodi.4gpts.com:4222",
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


class _HermesHomeCase(unittest.TestCase):
    """Base class that points KLODI_HOME at a per-test tempdir and
    restores the env on teardown. Keeps every test independent."""

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


# ── derive_phase ─────────────────────────────────────────────────────

class TestDerivePhase(_HermesHomeCase):
    def test_empty_dir_is_unregistered(self):
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "unregistered")

    def test_creds_only_is_corrupt(self):
        # Arrange — partial state (creds without config) means a prior
        # register attempt crashed mid-write.
        _write_creds(self.home)
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "corrupt")

    def test_config_only_is_corrupt(self):
        # Arrange — config without creds: same class of partial state.
        _write_config(self.home)
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "corrupt")

    def test_config_missing_required_field_is_corrupt(self):
        # Arrange — both files present but config is missing handle.
        _write_creds(self.home)
        (self.home / "config.json").write_text(
            json.dumps({"user_id": "u", "nkey_public": "n", "nats_url": "nats://x"}),
            encoding="utf-8",
        )
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "corrupt")

    def test_creds_and_config_without_policies_is_needs_policy(self):
        # Arrange — registered but no policies dir yet.
        _write_creds(self.home)
        _write_config(self.home)
        phase = derive_phase(gather_checks())
        # Post-0012, the next gate after "registered" is policy seed,
        # not wake registration.
        self.assertEqual(phase, "needs_policy")

    def test_policies_unfilled_is_needs_policy(self):
        # Arrange — negotiation_style.md exists but still has SEED marker.
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=False, security=True)
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "needs_policy")

    def test_fully_set_up_is_ready(self):
        # Arrange — the happy path: every check passes.
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        phase = derive_phase(gather_checks())
        self.assertEqual(phase, "ready")


# ── derive_issues ────────────────────────────────────────────────────

class TestDeriveIssues(_HermesHomeCase):
    def test_unregistered_surfaces_not_registered_code_and_short_circuits(self):
        issues = derive_issues(gather_checks())
        codes = [i["code"] for i in issues]
        self.assertEqual(codes, ["not_registered"])
        self.assertEqual(issues[0]["severity"], "error")
        self.assertEqual(issues[0]["fix"], {
            "kind": "tool", "tool": "klodi_register",
        })

    def test_creds_only_surfaces_partial_credentials_code(self):
        _write_creds(self.home)
        issues = derive_issues(gather_checks())
        codes = [i["code"] for i in issues]
        self.assertEqual(codes, ["partial_credentials"])
        self.assertIn("config.json", issues[0]["message"])

    def test_config_only_surfaces_partial_credentials_code(self):
        _write_config(self.home)
        issues = derive_issues(gather_checks())
        codes = [i["code"] for i in issues]
        self.assertEqual(codes, ["partial_credentials"])
        self.assertIn("nats.creds", issues[0]["message"])

    def test_no_wake_unregistered_code_post_0012(self):
        # Arrange — registered, no policies. The legacy
        # `wake_unregistered` issue must NOT appear.
        _write_creds(self.home)
        _write_config(self.home)
        issues = derive_issues(gather_checks())
        codes = [i["code"] for i in issues]
        self.assertNotIn("wake_unregistered", codes)

    def test_negotiation_style_unfilled_code_when_template_markers_remain(self):
        # Arrange — registered + policies present but negotiation_style
        # still carries the SEED sentinel.
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=False, security=True)
        issues = derive_issues(gather_checks())
        codes = [i["code"] for i in issues]
        self.assertIn("negotiation_style_unfilled", codes)
        nego = next(i for i in issues if i["code"] == "negotiation_style_unfilled")
        self.assertEqual(nego["severity"], "warn")

    def test_fully_set_up_returns_no_issues(self):
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        issues = derive_issues(gather_checks())
        self.assertEqual(issues, [])


# ── _seed_if_absent ──────────────────────────────────────────────────

class TestSeedIfAbsent(unittest.TestCase):
    def test_raises_runtimeerror_when_src_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "template.md"
            dst = Path(tmp) / "out.md"
            with self.assertRaisesRegex(RuntimeError, r"Template missing"):
                _seed_if_absent(src=src, dst=dst)

    def test_copies_src_to_dst_when_dst_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "template.md"
            dst = Path(tmp) / "out.md"
            src.write_text("hello world", encoding="utf-8")
            result = _seed_if_absent(src=src, dst=dst)
            self.assertTrue(result)
            self.assertTrue(dst.exists())
            self.assertEqual(dst.read_text(encoding="utf-8"), "hello world")

    def test_is_noop_when_dst_present(self):
        # Arrange — dst has different content; must NOT be overwritten.
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "template.md"
            dst = Path(tmp) / "out.md"
            src.write_text("template", encoding="utf-8")
            dst.write_text("USER CUSTOMISATION", encoding="utf-8")
            result = _seed_if_absent(src=src, dst=dst)
            self.assertFalse(result)
            self.assertEqual(dst.read_text(encoding="utf-8"), "USER CUSTOMISATION")


# ── _handle_setup_repair ─────────────────────────────────────────────

class TestHandleSetupRepair(_HermesHomeCase):
    def test_removes_creds_and_config_and_reports_in_removed(self):
        # Arrange — creds + config present.
        creds = _write_creds(self.home)
        config = _write_config(self.home)
        result = json.loads(_handle_setup_repair({}))
        self.assertEqual(result["failures"], [])
        self.assertEqual(set(result["removed"]), {str(creds), str(config)})
        self.assertFalse(creds.exists())
        self.assertFalse(config.exists())

    def test_preserves_policies_and_buy_files(self):
        # Arrange — populate creds/config AND a policies file + a buy
        # file the user cares about.
        _write_creds(self.home)
        _write_config(self.home)
        _write_policies(self.home, negotiation_filled=True, security=True)
        buy_dir = self.home / "buy"
        buy_dir.mkdir()
        (buy_dir / "vintage-camera.md").write_text("policy", encoding="utf-8")
        _handle_setup_repair({})
        self.assertTrue((self.home / "policies" / "negotiation_style.md").exists())
        self.assertTrue((self.home / "policies" / "security.md").exists())
        self.assertTrue((buy_dir / "vintage-camera.md").exists())

    def test_skips_targets_that_are_absent(self):
        # Arrange — only creds present; config never written.
        creds = _write_creds(self.home)
        result = json.loads(_handle_setup_repair({}))
        self.assertEqual(result["removed"], [str(creds)])
        self.assertEqual(result["failures"], [])

    def test_returns_empty_removed_and_failures_when_nothing_present(self):
        result = json.loads(_handle_setup_repair({}))
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["failures"], [])


# ── _handle_setup_reseed_policies ─────────────────────────────────────


class TestHandleSetupReseedPolicies(_HermesHomeCase):
    """Per **R § P3-9**: the policies/ dir must end up at mode 0o755 so
    the agent can read seeded templates regardless of the invoking
    shell's umask. mkdir alone honors umask, which can be tighter
    (0077) on hardened systems and strand the agent on its own files."""

    def setUp(self) -> None:
        super().setUp()
        # Seed a minimal bundled-skill source so _seed_if_absent finds
        # the templates without needing the build-time copy step.
        from klodi_hermes import local_tools as lt

        bundle = self.home / "_fake_bundle"
        (bundle / "templates").mkdir(parents=True)
        (bundle / "policies").mkdir(parents=True)
        (bundle / "templates" / "negotiation_style.template.md").write_text(
            "<!-- SEED: replace this -->\n", encoding="utf-8"
        )
        (bundle / "policies" / "security.md").write_text(
            "# security hard rules\n", encoding="utf-8"
        )
        # Monkey-patch the bundle-dir resolver for the duration of the test.
        self._orig_bundled = lt._bundled_skill_dir
        lt._bundled_skill_dir = lambda: bundle  # type: ignore[assignment]

    def tearDown(self) -> None:
        from klodi_hermes import local_tools as lt

        lt._bundled_skill_dir = self._orig_bundled  # type: ignore[assignment]
        super().tearDown()

    def test_policies_dir_mode_is_0755_after_reseed(self) -> None:
        # Skip on platforms that don't honor POSIX modes — Windows runs
        # rarely-and-best-effort; the chmod is wrapped in try/except.
        if sys.platform == "win32":
            self.skipTest("POSIX mode bits not enforced on Windows")
        # Tighten the test-process umask so the directory is created at
        # something other than 0755; the explicit chmod is what should
        # land it on 0755.
        prev_umask = os.umask(0o077)
        try:
            _handle_setup_reseed_policies({})
        finally:
            os.umask(prev_umask)
        policies_dir = self.home / "policies"
        mode = policies_dir.stat().st_mode & 0o777
        self.assertEqual(
            mode,
            0o755,
            f"policies dir mode is {oct(mode)} (expected 0o755)",
        )

    def test_seeded_files_present_after_reseed(self) -> None:
        result = json.loads(_handle_setup_reseed_policies({}))
        self.assertTrue(result["negotiation_style_seeded"])
        self.assertTrue(result["security_policy_seeded"])
        self.assertTrue((self.home / "policies" / "negotiation_style.md").exists())
        self.assertTrue((self.home / "policies" / "security.md").exists())


if __name__ == "__main__":
    unittest.main()
