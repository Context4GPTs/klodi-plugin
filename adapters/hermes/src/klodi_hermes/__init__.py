"""Hermes plugin entry point.

Hermes loads this module at plugin-enable time and calls
``register(ctx)``. Per 0012, the adapter holds a persistent NATS-WS
connection for the lifetime of the Hermes daemon. Tools dispatch via
``KlodiClient.request(...)``; wakes arrive on two durable JetStream
consumers that forward the full event payload to ``ctx.inject_message``.

What ``register(ctx)`` does, in order:

  1. Register every bundled skill via ``ctx.register_skill(name, path)``.
  2. Register every catalog tool that maps to a NATS request/reply.
     The catalog (``klodi-plugin/packages/tool-catalog/``) is the
     single source of schema truth — Hermes adapters consume the JSON
     Schema export bundled with ``klodi-nats-client``.
  3. Register the local tools (``klodi_setup_*``, ``klodi_register*``,
     ``klodi_watch``, ``klodi_unwatch``, ``klodi_channel_message``).
  4. **Only in the wake-pump host** (the klodi-hermes-bridge daemon's
     ``BridgeCtx``): open the persistent NATS-WS connection and subscribe
     the notifications + channels durable consumers. Steps 1-3 run in
     EVERY process that loads the plugin; step 4 is gated so a non-host
     loader (the ``hermes gateway run`` daemon, a ``hermes chat -q`` wake
     subprocess) never arms a competing pump. See :data:`WAKE_PUMP_HOST_ATTR`
     and ADR-0015 ("loaded != armed").

Lifecycle:
  Hermes is a long-running daemon, so the connection's lifetime is the
  daemon's. There's no explicit unload hook in the SDK; resources are
  released at process exit.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .bridge import WAKE_PUMP_HOST_ATTR
from .client import close_client
from .local_tools import register_local_tools
from .message import register_message_tools
from .pending_decisions import register_pending_tools
from .register import register_register_tools
from .tools import register_request_tools
from .wake_handlers import bind_ctx
from .wake_pump_control import start_wake_pump, stop_wake_pump
from .watch import register_watch_tools


log = logging.getLogger("klodi")


def register(ctx: Any) -> None:
    """Entry point called by Hermes at plugin load time.

    ``ctx`` exposes at minimum:
      * ``register_tool(name=, toolset=, schema=, handler=, ...)``
      * ``register_skill(name, skill_md_path)``
      * ``inject_message(text, role=...)`` (the wake primitive)
    """
    bind_ctx(ctx)

    # Register every bundled skill before any NATS work so the plugin's
    # skill surface stays loadable even when the connection is wedged.
    skills_registered = _register_skills(ctx, Path(__file__).resolve().parent)

    # Tools are always registered regardless of NATS connectivity. Per
    # the connection-state-aware-tools refactor: Hermes' `check_fn`
    # gate evaluates per-LLM-turn at `tools/registry.py:271`, hiding
    # tools whose check returns False from the model's schema. That
    # creates a discoverability cliff — the model can only call tools
    # it saw last turn, so a transient disconnect or a subprocess that
    # raced its own connect (e.g. `hermes chat -q` before the wake
    # pump finishes attaching) silently strips the request surface.
    # The handlers in tools.py already return structured errors when
    # the connection is bad, so we drop check_fn and let calls fail
    # informatively at dispatch time instead of vanishing from view.
    request_tools = register_request_tools(ctx)
    local_tools = register_local_tools(ctx)
    local_tools += register_register_tools(ctx)
    local_tools += register_watch_tools(ctx, None)
    # Outbound wake round-trip (host-local, not catalog tools): the
    # escalation tool and the reply-correlation read tool.
    local_tools += register_message_tools(ctx)
    local_tools += register_pending_tools(ctx)

    # Arming gate (ADR-0015 parity — "loaded != armed"). Tools/skills above
    # register in EVERY loader; the wake pump arms in EXACTLY ONE process —
    # the klodi-hermes-bridge daemon, whose BridgeCtx positively declares the
    # WAKE_PUMP_HOST_ATTR marker. A non-host loader (the `hermes gateway run`
    # daemon, a transient `hermes chat -q` wake subprocess) must NOT subscribe
    # the shared durable consumers: its ctx no-ops any wake it pulls and the
    # consumer ACKs the drop — the first-wake-after-idle split-brain this card
    # fixes. The discriminator is a positive, NON-inherited ctx attribute
    # (never an env var: inject_message merges {**os.environ} into its
    # children, so an env flag would leak and fail OPEN). See ADR-0015.
    _arm_wake_pump_or_skip(
        ctx,
        request_tools=request_tools,
        local_tools=local_tools,
        skills=skills_registered,
    )


def _is_wake_pump_host(ctx: Any) -> bool:
    """True iff ``ctx`` is the designated wake-pump host — the
    klodi-hermes-bridge daemon's ``BridgeCtx``, which positively declares the
    capability via :data:`WAKE_PUMP_HOST_ATTR`. Duck-typed on purpose: a
    non-bridge per-chat / gateway ctx simply lacks the marker, so the gate is
    fail-safe by absence and cannot be tripped by an inherited environment
    variable (the ADR-0015 fail-OPEN trap)."""
    return bool(getattr(ctx, WAKE_PUMP_HOST_ATTR, False))


def _arm_wake_pump_or_skip(
    ctx: Any, *, request_tools: int, local_tools: int, skills: int
) -> None:
    """Arm the wake pump when ``ctx`` is the wake-pump host, else load-only.

    Non-host: emit the positive ``wake_pump_skip_non_host`` marker (the
    hermes analogue of openclaw's ``wake_pump_skip_non_gateway``) and a
    tools-only registration summary — this is the EXPECTED path for the
    gateway daemon and wake subprocesses, not a degraded state.

    Host: open the connection and subscribe the durable consumers. Per
    **R § P2-29**, the ``klodi_hermes_plugin_registered`` success log fires
    ONLY when connect + wake-subscription complete cleanly; a connect failure
    logs ``klodi_hermes_plugin_connect_failed`` + ``_registered_degraded``.
    """
    if not _is_wake_pump_host(ctx):
        log.info(
            "wake_pump_skip_non_host — process is not the klodi-hermes-bridge"
            " wake-pump host; registering tools only, no wake subscription."
            " request_tools=%d local_tools=%d skills=%d",
            request_tools,
            local_tools,
            skills,
        )
        return
    # Narrow to `Exception` (not `BaseException`) so `KeyboardInterrupt` and
    # `SystemExit` propagate — those signal operator intent and critical config
    # errors that should not be swallowed during boot. Subscribe ownership
    # lives in the shared `WakePump`: it composes the two underlying subscribe
    # calls + reconnect-safe retry into one eager start — no host SDK dep.
    try:
        start_wake_pump()
    except Exception as err:  # noqa: BLE001 — never crash plugin boot on transport errors
        log.warning(
            "klodi_hermes_plugin_connect_failed error=%s — tool calls will"
            " fail until creds are present. Run klodi_register to sign up, or"
            " klodi_setup_status to diagnose existing setup.",
            err,
        )
        log.warning(
            "klodi_hermes_plugin_registered_degraded"
            " request_tools=%d local_tools=%d skills=%d wakes_wired=False",
            request_tools,
            local_tools,
            skills,
        )
        return
    log.info(
        "klodi_hermes_plugin_registered request_tools=%d local_tools=%d skills=%d",
        request_tools,
        local_tools,
        skills,
    )


def shutdown(_ctx: Any | None = None) -> None:
    """Tear down the persistent connection. Hermes does not call this
    today, but it's exposed for future SDK versions and for tests."""
    stop_wake_pump()
    close_client()


def _register_skills(ctx: Any, plugin_dir: Path) -> int:
    """Register every bundled skill under ``${plugin_dir}/skills/`` via
    Hermes's ``ctx.register_skill`` API.

    Canonical layout per the SDK docs:

        ${plugin_dir}/skills/
            klodi/SKILL.md
            <future-skill>/SKILL.md

    Each registered skill is namespaced under the plugin's name
    (``klodi:<skill>``) so collisions with built-in or user-installed
    skills are impossible. The agent loads a skill explicitly via
    ``skill_view("klodi:klodi")``.

    Returns the number of skills registered. Missing skills/ dir is
    logged as a warning and treated as zero — the plugin's tool
    surface still works without skills.
    """
    skills_dir = plugin_dir / "skills"
    if not skills_dir.is_dir():
        log.warning(
            "klodi_skills_dir_missing path=%s — no skills registered",
            skills_dir,
        )
        return 0

    registered = 0
    for child in sorted(skills_dir.iterdir()):
        if not child.is_dir():
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            log.warning(
                "klodi_skill_missing_skillmd path=%s — skipped",
                child,
            )
            continue
        try:
            ctx.register_skill(child.name, skill_md)
        except Exception as err:  # noqa: BLE001 — never crash plugin boot
            log.warning(
                "klodi_skill_register_failed name=%s path=%s error=%s",
                child.name,
                skill_md,
                err,
            )
            continue
        registered += 1
    return registered


__all__ = ["register", "shutdown"]
