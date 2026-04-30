"""Bridge daemon tests.

Covers:
  * BridgeCtx — tool/skill register stubs, inject_message subprocess
    invocation, timeout & nonzero handling, cross-consumer locking.
  * Bridge — creds wait, register call shape, signal-driven shutdown,
    teardown calls plugin shutdown.
"""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from klodi_hermes.bridge import (
    DEFAULT_CREDS_POLL_SECONDS,
    DEFAULT_INJECT_TIMEOUT_SECONDS,
    Bridge,
    BridgeCtx,
)


# ── BridgeCtx ─────────────────────────────────────────────────────────


class _RecordingRunner:
    """Stub ``subprocess.run``; captures invocations + scripts results."""

    def __init__(self, *, returncode: int = 0, stderr: str = "",
                 raise_timeout: bool = False, sleep_s: float = 0.0) -> None:
        self.calls: list[dict[str, Any]] = []
        self.returncode = returncode
        self.stderr = stderr
        self.raise_timeout = raise_timeout
        self.sleep_s = sleep_s

    def __call__(self, cmd: list[str], **kwargs: Any) -> Any:
        self.calls.append({"cmd": cmd, **kwargs})
        if self.sleep_s:
            time.sleep(self.sleep_s)
        if self.raise_timeout:
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout", 0))
        return SimpleNamespace(returncode=self.returncode, stderr=self.stderr, stdout="")


def test_register_tool_and_skill_are_stubs() -> None:
    """The bridge does not own tool/skill registration — stubs must
    accept arbitrary kwargs without raising and return None."""
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=lambda *a, **k: None)
    assert ctx.register_tool(name="x", schema={}, handler=lambda: None) is None
    assert ctx.register_skill("klodi", Path("/tmp/SKILL.md")) is None


def test_inject_spawns_chat_continue_with_text_and_role_logged(caplog: Any) -> None:
    """inject_message must shell out to ``hermes chat -q <text> --continue -Q``."""
    runner = _RecordingRunner(returncode=0)
    ctx = BridgeCtx(hermes_bin="/opt/hermes/.venv/bin/hermes", runner=runner)
    with caplog.at_level("INFO", logger="klodi_hermes.bridge"):
        ctx.inject_message("hello wake", role="system")
    assert len(runner.calls) == 1
    assert runner.calls[0]["cmd"] == [
        "/opt/hermes/.venv/bin/hermes", "chat", "-q", "hello wake",
        "--continue", "-Q",
    ]
    # capture_output + text=True so we get strings back for logging.
    assert runner.calls[0]["capture_output"] is True
    assert runner.calls[0]["text"] is True
    assert any("wake_inject_complete" in r.message for r in caplog.records)


def test_inject_default_timeout_passed_to_runner() -> None:
    runner = _RecordingRunner()
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    ctx.inject_message("x")
    assert runner.calls[0]["timeout"] == DEFAULT_INJECT_TIMEOUT_SECONDS


def test_inject_custom_timeout_passed_to_runner() -> None:
    runner = _RecordingRunner()
    ctx = BridgeCtx(
        hermes_bin="/usr/bin/hermes", runner=runner,
        inject_timeout_seconds=42,
    )
    ctx.inject_message("x")
    assert runner.calls[0]["timeout"] == 42


def test_inject_timeout_swallowed_and_logged(caplog: Any) -> None:
    """Subprocess timeout must NOT raise — losing one wake is preferable
    to wedging the consumer."""
    runner = _RecordingRunner(raise_timeout=True)
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner,
                    inject_timeout_seconds=1)
    with caplog.at_level("WARNING", logger="klodi_hermes.bridge"):
        ctx.inject_message("late wake")
    assert any("wake_inject_timeout" in r.message for r in caplog.records)


def test_inject_nonzero_exit_logged_not_raised(caplog: Any) -> None:
    runner = _RecordingRunner(returncode=2, stderr="hermes: missing model")
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    with caplog.at_level("WARNING", logger="klodi_hermes.bridge"):
        ctx.inject_message("x")
    assert any("wake_inject_nonzero" in r.message for r in caplog.records)
    assert any("hermes: missing model" in r.message for r in caplog.records)


def test_inject_serializes_concurrent_calls() -> None:
    """A second inject_message must wait for the first to exit; the
    lock prevents two ``hermes chat --continue`` processes racing on
    the same session file."""
    runner = _RecordingRunner(sleep_s=0.05)
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    threads = [threading.Thread(target=ctx.inject_message, args=(f"w{i}",))
               for i in range(3)]
    start = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.monotonic() - start
    # Three serialized 50ms calls cannot complete in less than ~150ms
    # if the lock works. (Concurrent execution would finish in ~50ms.)
    assert elapsed >= 0.13
    assert len(runner.calls) == 3


# ── Bridge ────────────────────────────────────────────────────────────


class _FakeKlodi:
    """Captures register / shutdown invocations against a fake plugin."""

    def __init__(self) -> None:
        self.registered_with: Any = None
        self.shutdown_called_with: Any = None

    def register(self, ctx: Any) -> None:
        self.registered_with = ctx

    def shutdown(self, ctx: Any) -> None:
        self.shutdown_called_with = ctx


def _seed_creds(klodi_home: Path) -> None:
    klodi_home.mkdir(parents=True, exist_ok=True)
    (klodi_home / "nats.creds").write_text("creds")
    (klodi_home / "config.json").write_text("{}")


def test_run_waits_until_both_creds_appear(tmp_path: Path) -> None:
    """Bridge must NOT call register() until both creds AND config
    are present — partial state is invalid."""
    klodi_home = tmp_path / "klodi"
    klodi_home.mkdir()
    fake_klodi = _FakeKlodi()
    fake_ctx = SimpleNamespace()

    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: fake_ctx,
        klodi_loader=lambda: fake_klodi,
    )

    runner = threading.Thread(target=bridge.run)
    runner.start()

    # Stage 1 — only nats.creds: bridge must keep waiting.
    (klodi_home / "nats.creds").write_text("creds")
    time.sleep(0.05)
    assert fake_klodi.registered_with is None

    # Stage 2 — config appears: bridge proceeds.
    (klodi_home / "config.json").write_text("{}")
    deadline = time.monotonic() + 2.0
    while fake_klodi.registered_with is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert fake_klodi.registered_with is fake_ctx

    bridge.request_stop()
    runner.join(timeout=2.0)
    assert not runner.is_alive()


def test_run_calls_register_then_blocks_until_signal(tmp_path: Path) -> None:
    """After register(), bridge must block on the stop event so the
    pump's asyncio thread keeps running. SIGTERM unblocks; teardown
    calls plugin shutdown."""
    klodi_home = tmp_path / "klodi"
    _seed_creds(klodi_home)
    fake_klodi = _FakeKlodi()
    fake_ctx = SimpleNamespace()
    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: fake_ctx,
        klodi_loader=lambda: fake_klodi,
    )

    runner = threading.Thread(target=bridge.run)
    runner.start()

    deadline = time.monotonic() + 1.0
    while fake_klodi.registered_with is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert fake_klodi.registered_with is fake_ctx
    # Bridge is blocked on stop event — runner thread is still alive.
    assert runner.is_alive()

    bridge.request_stop()
    runner.join(timeout=2.0)
    assert not runner.is_alive()
    assert fake_klodi.shutdown_called_with is fake_ctx


def test_request_stop_during_creds_wait_exits_cleanly(tmp_path: Path) -> None:
    """Sending a stop signal while still waiting for creds must exit
    without ever calling register()."""
    klodi_home = tmp_path / "klodi"
    klodi_home.mkdir()
    fake_klodi = _FakeKlodi()
    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: SimpleNamespace(),
        klodi_loader=lambda: fake_klodi,
    )

    runner = threading.Thread(target=bridge.run)
    runner.start()
    time.sleep(0.05)
    bridge.request_stop()
    runner.join(timeout=1.0)
    assert not runner.is_alive()
    assert fake_klodi.registered_with is None
    assert fake_klodi.shutdown_called_with is None


def test_register_failure_logged_and_run_exits(tmp_path: Path, caplog: Any) -> None:
    """If the plugin's register() raises, the bridge logs and exits —
    it does not call shutdown (nothing to drain)."""
    klodi_home = tmp_path / "klodi"
    _seed_creds(klodi_home)

    class _BoomKlodi:
        def register(self, _ctx: Any) -> None:
            raise RuntimeError("boom")

        def shutdown(self, _ctx: Any) -> None:
            raise AssertionError("shutdown must not run if register failed")

    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: SimpleNamespace(),
        klodi_loader=_BoomKlodi,
    )

    with caplog.at_level("ERROR", logger="klodi_hermes.bridge"):
        bridge.run()
    assert any("bridge_register_failed" in r.message for r in caplog.records)


def test_default_creds_poll_seconds_is_sensible() -> None:
    """Guard against a future change accidentally setting this to a
    pathological value (0 or hours)."""
    assert 1 <= DEFAULT_CREDS_POLL_SECONDS <= 30


# ── Recovery loop ─────────────────────────────────────────────────────


class _CountingKlodi:
    """Like ``_FakeKlodi`` but counts calls so the recovery test can
    assert exact register/shutdown sequencing across multiple cycles."""

    def __init__(self) -> None:
        self.register_count = 0
        self.shutdown_count = 0
        self.last_registered_ctx: Any = None
        self.last_shutdown_ctx: Any = None

    def register(self, ctx: Any) -> None:
        self.register_count += 1
        self.last_registered_ctx = ctx

    def shutdown(self, ctx: Any) -> None:
        self.shutdown_count += 1
        self.last_shutdown_ctx = ctx


def test_creds_removed_after_register_triggers_re_register(tmp_path: Path) -> None:
    """``klodi_setup_repair`` removes creds while the bridge is registered.
    The bridge must detect the removal, drain the plugin via shutdown(),
    re-enter the WAITING state, and re-register once creds reappear.

    This is the load-bearing test for the recovery loop. If someone
    reverts the run() refactor to a single-shot register-then-block
    shape, this test must fail.
    """
    # Arrange — seed creds, build a counting fake, start the bridge.
    klodi_home = tmp_path / "klodi"
    _seed_creds(klodi_home)
    fake_klodi = _CountingKlodi()
    fake_ctx = SimpleNamespace()
    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: fake_ctx,
        klodi_loader=lambda: fake_klodi,
    )

    runner = threading.Thread(target=bridge.run)
    runner.start()

    try:
        # Act 1 — wait for the first register call.
        deadline = time.monotonic() + 1.0
        while fake_klodi.register_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert fake_klodi.register_count == 1
        assert fake_klodi.shutdown_count == 0
        assert runner.is_alive()

        # Act 2 — operator runs ``klodi_setup_repair``, removing creds.
        # Bridge must observe the removal within ~poll cadence and drain.
        (klodi_home / "nats.creds").unlink()
        deadline = time.monotonic() + 1.0
        while fake_klodi.shutdown_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert fake_klodi.shutdown_count == 1
        # Register count must NOT have advanced yet — bridge is back in
        # WAITING, blocked on the missing nats.creds.
        assert fake_klodi.register_count == 1
        assert runner.is_alive()

        # Act 3 — operator re-runs ``klodi_register`` (creds reappear).
        _seed_creds(klodi_home)
        deadline = time.monotonic() + 1.0
        while fake_klodi.register_count < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert fake_klodi.register_count == 2
        # Second register cycle is active; the second shutdown has not
        # happened yet because nothing has signaled stop or removed creds.
        assert fake_klodi.shutdown_count == 1
        assert runner.is_alive()

        # Act 4 — clean stop drains the second register.
        bridge.request_stop()
        runner.join(timeout=2.0)
    finally:
        # Defensive cleanup — never leak the runner thread on assertion
        # failure. request_stop is idempotent + signal-safe.
        bridge.request_stop()
        runner.join(timeout=2.0)

    # Assert — exactly two full register/shutdown cycles, runner exited.
    assert not runner.is_alive()
    assert fake_klodi.register_count == 2
    assert fake_klodi.shutdown_count == 2


def test_teardown_swallows_plugin_shutdown_error(
    tmp_path: Path, caplog: Any
) -> None:
    """If the plugin's ``shutdown(ctx)`` raises mid-drain (e.g., NATS
    drain hits a reset connection), ``_teardown`` must log
    ``bridge_shutdown_failed`` at WARNING and let ``run()`` exit cleanly
    rather than letting the exception propagate out of the daemon.

    Closing the P3 from quality review: an unexpected shutdown failure
    must not crash the bridge process — docker would just restart it,
    losing the chance to re-enter WAITING for a fresh creds cycle.
    """
    # Arrange — creds present, plugin whose shutdown raises.
    klodi_home = tmp_path / "klodi"
    _seed_creds(klodi_home)

    class _ShutdownBoomKlodi:
        def __init__(self) -> None:
            self.register_count = 0
            self.shutdown_count = 0

        def register(self, _ctx: Any) -> None:
            self.register_count += 1

        def shutdown(self, _ctx: Any) -> None:
            self.shutdown_count += 1
            raise ConnectionResetError("mid-drain")

    fake_klodi = _ShutdownBoomKlodi()
    bridge = Bridge(
        klodi_home=klodi_home, hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: SimpleNamespace(),
        klodi_loader=lambda: fake_klodi,
    )

    # Act — start bridge, wait for register, then request stop.
    with caplog.at_level("WARNING", logger="klodi_hermes.bridge"):
        runner = threading.Thread(target=bridge.run)
        runner.start()
        try:
            deadline = time.monotonic() + 1.0
            while fake_klodi.register_count < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            assert fake_klodi.register_count == 1

            bridge.request_stop()
            runner.join(timeout=2.0)
        finally:
            bridge.request_stop()
            runner.join(timeout=2.0)

    # Assert — thread exited, shutdown was attempted exactly once,
    # WARNING was emitted, no exception leaked out of run().
    assert not runner.is_alive()
    assert fake_klodi.shutdown_count == 1
    warning_records = [
        r for r in caplog.records
        if r.levelname == "WARNING" and "bridge_shutdown_failed" in r.message
    ]
    assert len(warning_records) >= 1, (
        f"expected bridge_shutdown_failed WARNING, got: "
        f"{[(r.levelname, r.message) for r in caplog.records]}"
    )
