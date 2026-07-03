"""klodi-hermes-bridge — long-lived daemon hosting the wake pump.

Hermes's gateway loads tool plugins per-chat-subprocess, not at daemon
start. So a wake pump bound to ``register(ctx)`` only ever lives as
long as a chat invocation, and autonomous wakes outside of chat go
nowhere. This is the same shape ``tests/integration/hosts/hermes/
wake-loop.py`` already uses to make wake delivery testable.

The bridge productizes that bypass. It mirrors the pattern OpenClaw's
adapter uses against its gateway runtime (long-running process imports
the plugin, calls ``register(ctx)`` once, stays alive so the JetStream
consumers keep delivering). The production ctx's ``inject_message``
shells out to ``hermes chat -q <text> -Q --source klodi`` to run each
wake as an ISOLATED, fresh single-turn session, so the agent never
resumes or pollutes the operator's live conversation. The ``--source
klodi`` tag (:data:`KLODI_WAKE_SOURCE`) is DECLARED intent but INERT on
hermes v0.17.0: the one-shot ``-q`` create path drops it and the wake
persists ``source='cli'``, so a wake is NOT distinguished by its session
source. The outbound resolver instead refuses a wake by positive
``(platform, chat_id)`` identification (a ``cli`` row maps to no
messaging chat), and the durable proof that a wake turn completed is the
klodi-owned completion marker written on exit 0 (see
:mod:`klodi_hermes.wake_completions` and ADR-0020, Amendment 2026-07-02).
No hermes version accepts a session
flag and ``hermes chat`` cannot mint a session by name
(``--continue <name>`` errors on first contact), so the per-wake
conversation key — derived from the event (channel thread / listing /
transaction / standing search; see ``wake_handlers.derive_wake_session``)
— is no longer a CLI argument: it survives only to key the outbound
pending-decision (via the spawn env) and to correlate the wake's log
line. Each wake is single-turn, so no session grows unbounded for the
daemon's whole life. The agent reasons about the marketplace event with
the klodi toolset and acts on its own, leaving the human's other chats
untouched.

Run shape:
  * Bridge boots; if creds are absent it polls until ``klodi_register``
    has run inside an interactive ``hermes chat`` session and dropped
    ``${KLODI_HOME}/{nats.creds,config.json}``.
  * On creds present, imports ``klodi_hermes`` and calls
    ``register(BridgeCtx)``. The plugin's existing ``start_wake_pump``
    opens the persistent NATS-WS connection and attaches the two
    durable JetStream consumers.
  * The bridge sleeps on its stop event. SIGTERM / SIGINT → shutdown.

Failure modes (two classes, deliberately distinguished here — see ADR-0019):
  * Inject subprocess TIMEOUT — logged at WARNING, swallowed. The wake
    handler returns; the consumer acks; JetStream's ``max_deliver: 5``
    does NOT redeliver because nothing raised. Losing one wake is the
    right tradeoff vs. wedging the consumer on a stuck chat — and a slow
    LLM turn is transient, so redelivery would just re-hang.
  * Inject fast deterministic NONZERO exit — a misconfiguration (e.g. a
    missing/unhealthy wake session) that fails identically every wake.
    This raises :class:`WakeInjectFailed` carrying the full subprocess
    diagnostics (stdout INCLUDED — a quiet ``-Q`` CLI writes its error
    there with an empty stderr). The wake handler turns it into a loud,
    operator-visible ERROR alarm rather than silently ACKing it away.
    Classification lives here (the only site holding both the
    ``TimeoutExpired`` and the ``returncode`` signal); the alarm lives
    in ``wake_handlers._inject`` (the only site holding the wake
    correlation — ``kind``/``event_id``).
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

from . import wake_completions

log = logging.getLogger("klodi_hermes.bridge")

# Spawn-env keystone (Piece-3/4 of the outbound round-trip). The bridge —
# the only site that already computes a wake's per-entity key — also
# threads that entity identity to the in-subprocess ``klodi_message_user``
# tool via these env vars, so the outbound pending-decision is keyed by
# the SAME id the wake turn runs under, deterministically (bridge-computed,
# never LLM-supplied). The bare entity id here equals the wake-session key
# minus its ``klodi:`` namespace.
KLODI_WAKE_ENTITY_ID_ENV = "KLODI_WAKE_ENTITY_ID"
KLODI_WAKE_ENTITY_TYPE_ENV = "KLODI_WAKE_ENTITY_TYPE"
KLODI_WAKE_EVENT_ID_ENV = "KLODI_WAKE_EVENT_ID"

# Session ``--source`` tag passed on every wake turn. INERT on hermes v0.17.0:
# the one-shot ``hermes chat -q … -Q`` create path silently drops ``--source``
# (and ``HERMES_SESSION_SOURCE``) and persists the default ``source='cli'`` on
# the new ``sessions`` row — confirmed live in-container (every ``--source``/env
# variation lands ``cli``), and ``SessionDB`` exposes no source setter to
# back-fill it. The flag is RETAINED as declared intent / forward-compat: if a
# future hermes ever honours it on ``-q``, wakes become ``source='klodi'`` and
# the resolver already excludes that class too (``exclude_sources=
# [HERMES_CLI_SOURCE, KLODI_WAKE_SOURCE]`` — see ``message.resolve_operator_
# target``). Because the tag does NOT stick today, a completed wake is NOT
# distinguished by its session-row source; the durable proof-of-turn is instead
# the klodi-owned completion marker written on subprocess exit 0 (see
# :func:`klodi_hermes.wake_completions.record_wake_completion` + the exit-0
# branch of :meth:`BridgeCtx.inject_message`). Self-addressing is prevented not
# by source but by the resolver's positive ``(platform, chat_id)`` identification
# (a ``cli`` row maps to no messaging chat).
KLODI_WAKE_SOURCE = "klodi"

# How long to give ``hermes chat -q … -Q`` to process a single wake. The
# command blocks on the LLM; 120s leaves room for a normal agent turn
# while bounding pathological hangs.
DEFAULT_INJECT_TIMEOUT_SECONDS = 120

# Polling cadence while waiting for first-run ``klodi_register``. 5s
# is invisible during a demo and fast enough for a fresh container.
DEFAULT_CREDS_POLL_SECONDS = 5

# Truncate captured subprocess streams to the same bound the legacy
# WARNING used, so an alarm carrying a runaway traceback stays bounded.
_DIAG_TAIL = 500


class WakeInjectFailed(Exception):
    """A wake-inject subprocess exited fast with a nonzero code.

    A *deterministic* failure: the same misconfiguration (a missing or
    unhealthy wake session, a bad flag, a missing model) fails identically
    on every wake. Carries the full subprocess diagnostics so the wake
    handler can raise a loud, explainable, operator-visible alarm —
    ``stdout`` is included because a quiet (``-Q``) CLI routinely writes
    its error there while leaving stderr empty (the field that was dropped
    in the original bug).

    Distinct from an inject *timeout*, which is transient and stays
    swallowed-and-ACKed in :meth:`BridgeCtx.inject_message`.
    """

    __slots__ = ("returncode", "stdout", "stderr")

    def __init__(self, *, returncode: int, stdout: str, stderr: str) -> None:
        super().__init__(
            f"wake inject exited {returncode}: "
            f"stdout={stdout[-_DIAG_TAIL:]!r} stderr={stderr[-_DIAG_TAIL:]!r}"
        )
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class BridgeCtx:
    """Process-scoped ctx the bridge passes to ``klodi_hermes.register``.

    Implements only what ``register(ctx)`` reads:

      * ``register_tool(**kwargs)`` — stub. The tool surface lives on
        the per-chat-session ctx Hermes builds, not on the bridge.
        The bridge's calls keep ``register()`` happy without claiming
        a duplicate tool surface.
      * ``register_skill(name, path)`` — stub for the same reason.
      * ``inject_message(text, role, *, session)`` — production path.
        Shells out to ``hermes chat -q <text> -Q --source klodi``;
        blocks until the chat subprocess exits. ``session`` is the
        per-wake conversation key threaded down from the handler — used
        for env-keying + log correlation, NOT as a CLI flag (no hermes
        version accepts a session flag). The wake pump's
        ``max_ack_pending: 1`` already serializes deliveries, so blocking
        here is the right shape for ordered wake processing. A fast
        nonzero exit raises :class:`WakeInjectFailed`; a timeout is
        logged and swallowed.
      * ``drain_session(session)`` — best-effort reclamation of a
        session after its conversation's terminal event (probe-gated).
    """

    def __init__(
        self,
        *,
        hermes_bin: str,
        inject_timeout_seconds: int = DEFAULT_INJECT_TIMEOUT_SECONDS,
        runner: Any = None,
    ) -> None:
        self._hermes_bin = hermes_bin
        self._inject_timeout_s = inject_timeout_seconds
        # Tests inject a stub runner. Production uses subprocess.run.
        self._run = runner if runner is not None else subprocess.run
        # Cross-consumer serialization: ``handle_notification`` and
        # ``handle_channel_message`` run on separate consumer loops, so
        # both can fire concurrently. With per-conversation session keys,
        # two wakes for the SAME conversation (e.g. a ``channel.message``
        # and a ``channel.closed`` for one channel, arriving on the two
        # consumers) would otherwise race on that session's history. The
        # lock holds the second inject until the first chat exits.
        #
        # TODO(perf, confirmed-safe but deferred): the two-consumer
        # topology + ``max_ack_pending=1`` (consumers.py) bound this to at
        # most two concurrent wakes, so the lock COULD narrow to per-session
        # (same key serializes, different keys parallelize). Deferred: a
        # per-key lock map is itself an unbounded-growth vector — the very
        # bug class this card removes — and would need its own GC, all for a
        # max-two-concurrent-wake workload. The global lock is the correct
        # default (correctness over throughput); revisit only under load.
        self._inject_lock = threading.Lock()

    def register_tool(self, **_kwargs: Any) -> None:
        # The bridge does not own the tool surface. Per-chat ctx does.
        return None

    def register_skill(self, _name: str, _path: Path) -> None:
        # The bridge does not own the skill surface. Per-chat ctx does.
        return None

    def inject_message(
        self,
        text: str,
        role: str = "system",
        *,
        session: str,
        entity_type: str = "",
        entity_id: str = "",
        event_id: str = "",
    ) -> None:
        """Run one wake turn in its conversation's session. Classifies:

          * timeout → WARNING + return (transient; swallow stays)
          * nonzero exit → raise :class:`WakeInjectFailed` (deterministic)
          * exit 0 → ``wake_inject_complete`` INFO

        ``session`` is the per-wake conversation key derived by
        ``wake_handlers.derive_wake_session`` and threaded down for
        env-keying + log correlation only — it is NOT a hermes CLI flag
        (no version accepts a session flag). The turn runs in a fresh
        session — a wake never resumes the operator's session and never
        shares one global session across conversations. The argv carries
        ``--source klodi`` (:data:`KLODI_WAKE_SOURCE`) as forward-compat
        intent, but it is INERT on v0.17.0 ``-q`` (the wake persists
        ``source='cli'``); on exit 0 this method records the durable
        completion marker (see ADR-0020, Amendment 2026-07-02).

        ``entity_type`` / ``entity_id`` / ``event_id`` are the wake's
        marketplace identity (``wake_handlers.derive_wake_entity``); they
        ride on the spawn env (``KLODI_WAKE_*``) so the in-subprocess
        ``klodi_message_user`` tool keys its pending-decision by the same
        id the turn runs under. The env MUST be the merged ``{**os.environ,
        ...}`` — a bare dict carrying only the wake vars would strip
        ``PATH`` and break the spawn.
        """
        cmd = [
            self._hermes_bin,
            "chat",
            "-q",
            text,
            "-Q",
            "--source",
            KLODI_WAKE_SOURCE,
        ]
        env = {
            **os.environ,
            KLODI_WAKE_ENTITY_ID_ENV: entity_id,
            KLODI_WAKE_ENTITY_TYPE_ENV: entity_type,
            KLODI_WAKE_EVENT_ID_ENV: event_id,
        }
        with self._inject_lock:
            try:
                result = self._run(
                    cmd,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=self._inject_timeout_s,
                    env=env,
                )
            except subprocess.TimeoutExpired:
                log.warning(
                    "wake_inject_timeout role=%s session=%s timeout_s=%d",
                    role,
                    session,
                    self._inject_timeout_s,
                )
                return
            returncode = getattr(result, "returncode", 0)
            stderr = getattr(result, "stderr", "") or ""
            stdout = getattr(result, "stdout", "") or ""
            if returncode != 0:
                # Deterministic failure — surface it loudly upstream with
                # BOTH streams (stdout closes the original silent-drop bug).
                raise WakeInjectFailed(
                    returncode=returncode, stdout=stdout, stderr=stderr
                )
            # Exit 0: the agent's turn output (``stdout``) is INTENTIONALLY
            # dropped here — it is tool-narration/reasoning, not a deliverable
            # operator message. A wake report reaches the operator only by the
            # agent CALLING ``klodi_message_user`` mid-turn; the wake text's
            # terminal-disposition contract
            # (``wake_handlers._TERMINAL_DISPOSITION_CONTRACT``) is what makes
            # that reliable. Do NOT route this stdout to the operator — that is
            # the rejected salvage path (conversation pollution, breaks the
            # pending-decision round-trip). See ADR-0023.
            log.info(
                "wake_inject_complete role=%s session=%s event_id=%s exit=%d len=%d",
                role,
                session,
                event_id,
                returncode,
                len(text),
            )
            # Proof-of-turn: ONLY a completed turn (exit 0) records a marker.
            # The nonzero branch above already raised, and a timeout returned
            # early — neither reaches here — so the klodi-stage AC1 gate can
            # never see a marker for an inject that produced no turn.
            wake_completions.record_wake_completion(
                event_id=event_id, session=session, role=role
            )

    def drain_session(self, session: str) -> None:
        """Best-effort reclamation of a wake session after its
        conversation's terminal event (``channel.closed`` /
        ``listing.sold|withdrawn|expired`` /
        ``transaction.completed|cancelled``). The per-key model already
        bounds each session to one conversation; draining a finished one
        would free its on-disk history rather than let it idle.

        PROBE-GATED (merge gate): hermes session deletion BY ID is
        UNCONFIRMED in this environment (no ``hermes`` binary / wiki to run
        ``hermes chat --help`` or inspect the session store). Until the
        deletion command is confirmed we deliberately do NOT shell out a
        *guessed* command — we record the drain intent and leave the
        session to idle. This is safe-by-default: the per-key model already
        bounds each session to a single conversation (a strict improvement
        over the old shared session), so a non-reclaimed cold session is at
        worst inert. When the probe confirms the command, the real hermes
        deletion subprocess goes HERE. NEVER raises — a drain is
        best-effort and a failed drain is not a failed wake.
        """
        log.info("wake_session_drain session=%s reclaim=probe_gated", session)


class Bridge:
    """Long-lived bridge daemon. One instance per persona container."""

    def __init__(
        self,
        *,
        klodi_home: Path,
        hermes_bin: str,
        inject_timeout_seconds: int = DEFAULT_INJECT_TIMEOUT_SECONDS,
        creds_poll_seconds: int = DEFAULT_CREDS_POLL_SECONDS,
        ctx_factory: Any = None,
        klodi_loader: Any = None,
    ) -> None:
        self._klodi_home = klodi_home
        self._hermes_bin = hermes_bin
        self._inject_timeout_s = inject_timeout_seconds
        self._creds_poll_s = creds_poll_seconds
        self._stop = threading.Event()
        # Test seams. Production injects sensible defaults below.
        self._ctx_factory = (
            ctx_factory if ctx_factory is not None else self._default_ctx_factory
        )
        self._klodi_loader = (
            klodi_loader if klodi_loader is not None else self._default_klodi_loader
        )
        self._ctx: Any = None
        self._registered = False
        self._klodi_module: Any = None

    def request_stop(self) -> None:
        """Signal the run loop to exit. Idempotent, signal-safe."""
        self._stop.set()

    def run(self) -> None:
        """Main loop. Cycles between ``WAITING`` and ``REGISTERED`` until
        SIGTERM/SIGINT.

        States and transitions:

          * WAITING — block at :meth:`_wait_for_creds` until both creds
            files exist. Stop signal exits the loop.
          * REGISTERED — call ``klodi_hermes.register(ctx)``, then block
            at :meth:`_run_until_stop_or_creds_gone`. Two ways to leave:
            stop signal (exit cleanly) or creds removed (operator ran
            ``klodi_setup_repair``; drain and re-enter WAITING).

        Re-registration after creds removal is the recovery path the
        in-process per-chat ctx already has via ``klodi_register``'s
        success path. The bridge mirrors it across process boundaries
        by detecting creds removal and re-running ``register(ctx)`` once
        creds reappear.
        """
        log.info(
            "bridge_starting klodi_home=%s hermes_bin=%s",
            self._klodi_home,
            self._hermes_bin,
        )
        while not self._stop.is_set():
            if not self._wait_for_creds():
                log.info("bridge_stopped_before_register reason=creds_wait_interrupted")
                return
            if not self._register_plugin():
                # Register failed (transport, config parse, etc.). Exit so
                # docker's restart:unless-stopped re-launches us with a
                # fresh process — same recovery shape openclaw uses.
                return
            self._run_until_stop_or_creds_gone()
            self._teardown()

    def _wait_for_creds(self) -> bool:
        """Block until both creds files are present.

        Returns ``False`` if the stop event fires first.
        """
        creds = self._klodi_home / "nats.creds"
        config = self._klodi_home / "config.json"
        warned = False
        while not (creds.is_file() and config.is_file()):
            if not warned:
                log.info(
                    "bridge_waiting_for_creds creds=%s config=%s",
                    creds,
                    config,
                )
                warned = True
            if self._stop.wait(timeout=self._creds_poll_s):
                return False
        log.info("bridge_creds_present")
        return True

    def _register_plugin(self) -> bool:
        """Import the plugin and call ``register(ctx)``. Returns
        ``False`` on any failure — caller exits the run loop."""
        try:
            klodi = self._klodi_loader()
            ctx = self._ctx_factory()
            log.info("bridge_register_starting")
            klodi.register(ctx)
            self._ctx = ctx
            self._klodi_module = klodi
            self._registered = True
            log.info("bridge_register_complete")
            return True
        except BaseException as err:  # noqa: BLE001 — log and signal caller
            log.exception("bridge_register_failed error=%s", err)
            return False

    def _run_until_stop_or_creds_gone(self) -> None:
        """Block while creds remain present and the stop event is unset.

        Returns on either:
          * Stop signal (caller exits the run loop)
          * Creds disappearance (caller tears down + re-enters WAITING)

        Polls every ``self._creds_poll_s`` seconds — same cadence as
        the WAITING state so operators see consistent recovery latency
        in either direction.
        """
        creds = self._klodi_home / "nats.creds"
        config = self._klodi_home / "config.json"
        while not self._stop.is_set():
            if not (creds.is_file() and config.is_file()):
                log.warning("bridge_creds_removed — tearing down for re-register")
                return
            if self._stop.wait(timeout=self._creds_poll_s):
                return

    def _default_ctx_factory(self) -> BridgeCtx:
        return BridgeCtx(
            hermes_bin=self._hermes_bin,
            inject_timeout_seconds=self._inject_timeout_s,
        )

    def _default_klodi_loader(self) -> Any:
        import importlib

        return importlib.import_module("klodi_hermes")

    def _teardown(self) -> None:
        """Drain the pump if registered. Clears state so the next
        register cycle starts fresh. Idempotent."""
        if not self._registered or self._klodi_module is None:
            return
        try:
            self._klodi_module.shutdown(self._ctx)
            log.info("bridge_shutdown_complete")
        except BaseException as err:  # noqa: BLE001 — best-effort
            log.warning("bridge_shutdown_failed error=%s", err)
        self._registered = False
        self._klodi_module = None
        self._ctx = None


__all__ = [
    "DEFAULT_CREDS_POLL_SECONDS",
    "DEFAULT_INJECT_TIMEOUT_SECONDS",
    "KLODI_WAKE_ENTITY_ID_ENV",
    "KLODI_WAKE_ENTITY_TYPE_ENV",
    "KLODI_WAKE_EVENT_ID_ENV",
    "KLODI_WAKE_SOURCE",
    "Bridge",
    "BridgeCtx",
    "WakeInjectFailed",
]
