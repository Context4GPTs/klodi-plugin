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
  4. Open the persistent NATS-WS connection and attach the
     notifications + channels wake handlers.

Lifecycle:
  Hermes is a long-running daemon, so the connection's lifetime is the
  daemon's. There's no explicit unload hook in the SDK; resources are
  released at process exit.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .client import close_client
from .local_tools import register_local_tools
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

    # Open the connection and wire wake handlers. This must happen
    # AFTER tool registration so the agent sees the toolset even if
    # the connection fails (the user can call klodi_setup_status to
    # diagnose).
    #
    # Per **R § P2-29**: the success log used to fire unconditionally
    # AFTER the try/except around connect+wakes — meaning a connect
    # failure would log both `klodi_hermes_plugin_connect_failed`
    # (WARN) and `klodi_hermes_plugin_registered` (INFO), giving
    # operators a misleading "everything is fine" signal. Now the
    # success log fires only when both connect and wake-subscription
    # complete cleanly.
    wakes_wired = False
    # Narrow to `Exception` (not `BaseException`) so `KeyboardInterrupt`
    # and `SystemExit` propagate — those signal operator intent and
    # critical config errors that should not be swallowed during boot.
    #
    # Per `docs/plans/2026-04-28-host-agnostic-wake-pump.md`: subscribe
    # ownership lives in the shared `WakePump`. The pump composes the
    # two underlying subscribe calls + reconnect-safe retry into one
    # eager start — no host SDK lifecycle dependency.
    try:
        start_wake_pump()
        wakes_wired = True
    except Exception as err:  # noqa: BLE001 — never crash plugin boot on transport errors
        log.warning(
            "klodi_hermes_plugin_connect_failed error=%s — tool calls"
            " will fail until creds are present. Run klodi_register to"
            " sign up, or klodi_setup_status to diagnose existing setup.",
            err,
        )

    if wakes_wired:
        log.info(
            "klodi_hermes_plugin_registered request_tools=%d local_tools=%d skills=%d",
            request_tools,
            local_tools,
            skills_registered,
        )
    else:
        log.warning(
            "klodi_hermes_plugin_registered_degraded"
            " request_tools=%d local_tools=%d skills=%d wakes_wired=False",
            request_tools,
            local_tools,
            skills_registered,
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
