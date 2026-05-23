"""nanobot tool surface — every klodi_* tool wraps a NATS subject.

Per 0012, the catalog (``klodi-plugin/packages/tool-catalog/``) is the
single source of schema truth. The Python adapter consumes the JSON
Schema export bundled with ``klodi-nats-client``; a divergence breaks
imports, not production.

This module exposes:

  * ``async call_tool(name, args)``   — generic dispatcher that maps
    a klodi_* tool name to its NATS subject and round-trips through
    the shared ``KlodiClient`` singleton.
  * ``async publish_channel_message(channel_id, content)`` — direct
    JetStream publish; replaces the deleted ``klodi_channel_send``
    request/reply tool.
  * ``TOOL_DEFINITIONS``              — list of (name, description,
    schema) triples nanobot can wire via its native tool decorators.
  * ``async handle(name, args)``      — string-returning dispatcher
    that fans request/reply, channel publish, and local tools to the
    right handler.

Local tools (``klodi_setup_*``, ``klodi_register*``, ``klodi_watch*``,
``klodi_health``) live in :mod:`nanobot_local_tools` per **D § D4** —
the catalog's ``LOCAL_TOOLS`` registry declares them with
``host_shapes: ["in_agent"]`` so the CI gate (``check-adapter-tools.sh``)
fails when nanobot stops registering one.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from klodi_nats_client import (
    CHANNEL_MESSAGE_PARAMS,
    KlodiRequestError,
    TOOL_SCHEMAS,
    ToolSchema,
)
from klodi_nats_client.envelope import (
    envelope_from_klodi_request_error,
    envelope_from_not_connected,
    envelope_from_unknown,
    make_envelope,
)
from klodi_nats_client.guards import guard_creds
from klodi_nats_client.paths import default_klodi_home

from nanobot_client import get_client
from nanobot_local_tools import (
    LOCAL_TOOL_DEFINITIONS,
    LOCAL_TOOL_NAMES,
    dispatch_local_tool,
)

# Per-host register CLI surfaced in `not_registered` recovery hints (R8).
NANOBOT_REGISTER_CLI = "klodi-nanobot-register"

# Exception types that signal "transport / connection is not ready".
# Catching these specifically routes non-connection failures to
# `internal_error` instead of the round-1 mis-labelling as
# `connection_not_ready` (P1.3, R2).
_CONNECTION_ERROR_TYPES: tuple[type[BaseException], ...] = (
    ConnectionError,
    asyncio.TimeoutError,
    TimeoutError,
)


_PUBLISH_TOOLS: frozenset[str] = frozenset({
    # Direct JetStream publish, not a NATS request.
    # Per **D § D4** (P3-3): canonical name is `klodi_channel_message`;
    # the legacy `klodi_channel_send` was removed in 0012.
    "klodi_channel_message",
})

# Names that must NEVER reach `call_tool` (the request/reply path) —
# either because they're local-only (filesystem state, browser OAuth)
# or because they're the JetStream publish path.
_LOCAL_TOOLS: frozenset[str] = LOCAL_TOOL_NAMES | _PUBLISH_TOOLS


async def call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Generic tool dispatcher.

    Looks up the catalog subject for ``name`` and round-trips through
    ``KlodiClient.request``. The caller (nanobot's tool wrapper) is
    responsible for any tool-specific parameter validation; the
    catalog schema is exposed via ``TOOL_DEFINITIONS`` for nanobot's
    JSON Schema validator if it has one.

    Raises ``KeyError`` for an unknown tool name and ``KlodiRequestError``
    for any handler-level failure.
    """
    schema = TOOL_SCHEMAS.get(name)
    if schema is None:
        raise KeyError(f"Unknown klodi tool: {name}")
    if name in _LOCAL_TOOLS:
        raise ValueError(
            f"{name} is a local tool — call its dedicated function"
            " (e.g. publish_channel_message) instead of call_tool."
        )
    client = get_client()
    return await client.request(schema["subject"], args)


async def publish_channel_message(
    channel_id: str, content: str
) -> dict[str, int]:
    """Publish to ``p2p.v1.channels.<channel_id>.<sender>.msg``.

    Replaces the legacy ``klodi_channel_send`` tool. Returns the
    JetStream sequence as durability proof.
    """
    if not isinstance(channel_id, str) or not channel_id:
        raise ValueError("channel_id must be a non-empty string")
    if not isinstance(content, str) or not content:
        raise ValueError("content must be a non-empty string")
    client = get_client()
    return await client.publish_channel_message(channel_id, {"content": content})


def _tool_definition(name: str, schema: ToolSchema) -> dict[str, Any]:
    """Render a ``TOOL_DEFINITIONS`` entry.

    nanobot's tool decorator typically wants ``{name, description,
    parameters}`` — same shape as OpenAI function calling. We mirror
    Hermes's adapter for consistency across the Python adapters.
    """
    return {
        "name": name,
        "description": schema["description"],
        "parameters": schema["params"],
    }


# Per **R § P2-13**: ``CHANNEL_MESSAGE_PARAMS`` is imported from
# ``klodi_nats_client`` so Hermes + nanobot share the same JSON-Schema
# (with the catalog-pinned ``MAX_CHANNEL_MESSAGE_CHARS`` cap baked in).


def _build_definitions() -> list[dict[str, Any]]:
    """Iterate the catalog and add the local + publish tools.

    Stable order so nanobot's discovery cache stays predictable.
    """
    out: list[dict[str, Any]] = []
    for name in sorted(TOOL_SCHEMAS):
        if name in _LOCAL_TOOLS:
            continue
        out.append(_tool_definition(name, TOOL_SCHEMAS[name]))
    # Local tools (filesystem state, browser OAuth, server-side
    # standing-search composites) — declared in nanobot_local_tools and
    # routed through dispatch_local_tool() in handle().
    out.extend(LOCAL_TOOL_DEFINITIONS)
    out.append({
        "name": "klodi_channel_message",
        "description": (
            "Send a message in an open klodi channel. The message is"
            " durably stored on the marketplace's JetStream and"
            " delivered to the other participant in real time."
            " Returns the JetStream sequence as durability proof."
        ),
        "parameters": CHANNEL_MESSAGE_PARAMS,
    })
    return out


#: List of tool definitions nanobot can wire via its tool decorator.
TOOL_DEFINITIONS: list[dict[str, Any]] = _build_definitions()


async def handle(name: str, args: dict[str, Any]) -> str:
    """Convenience wrapper that returns a JSON string.

    nanobot's tool decorator expects a string body in many tool
    integrations; this saves every wrapper from re-doing the
    json.dumps / KlodiRequestError dance.

    Routing order matters:
      1. ``klodi_channel_message`` — direct JetStream publish.
      2. Any name in ``LOCAL_TOOL_NAMES`` — dispatched to
         :mod:`nanobot_local_tools` (filesystem state, browser OAuth).
      3. Anything else — generic catalog request/reply via
         :func:`call_tool`.

    R4 — every state-mutating arm runs the creds guard BEFORE any I/O.
    The two local diagnostic tools (`klodi_setup_status`, `klodi_health`)
    are exempt per R5 (they are the *target* of recovery hints and must
    always return their diagnostic payload). The guard chain is checked
    on the non-exempt local-tool path too — agents see `not_registered`
    when creds are absent, not whatever the local handler raises.
    """
    # All error paths return the canonical four-key envelope (ADR-0011).
    # The agent reads `error`, follows `recovery_hint`, never
    # pattern-matches on `message`.
    if name == "klodi_channel_message":
        # R4 — creds guard fails BEFORE any I/O.
        creds_env = guard_creds(default_klodi_home(), NANOBOT_REGISTER_CLI)
        if creds_env is not None:
            return json.dumps(creds_env)
        try:
            channel_id = args["channel_id"]
            content = args["content"]
        except KeyError as err:
            return json.dumps(_invalid_request(err.args[0], "missing"))
        try:
            result = await publish_channel_message(channel_id, content)
        except ValueError as err:
            return json.dumps(envelope_from_unknown(err))
        except _CONNECTION_ERROR_TYPES:
            return json.dumps(envelope_from_not_connected())
        except BaseException as err:  # noqa: BLE001 — boundary
            # Adapter-internal failure — R2 says `internal_error`, not
            # `connection_not_ready` (P1.3 fix).
            return json.dumps(envelope_from_unknown(err))
        return json.dumps(result)

    if name in LOCAL_TOOL_NAMES:
        # R5 — diagnostic targets of recovery hints must always return
        # their diagnostic payload, even when creds are missing.
        # nanobot_local_tools owns the per-tool diagnostic logic; it
        # surfaces structured diagnostics that drive the recovery loop.
        try:
            local_result = dispatch_local_tool(name, args)
        except KeyError as err:
            # Defensive — LOCAL_TOOL_NAMES + dispatch_local_tool are in
            # the same module, but degrade safely to internal_error so
            # the agent sees the canonical envelope.
            return json.dumps(envelope_from_unknown(err))
        except BaseException as err:  # noqa: BLE001 — boundary
            return json.dumps(envelope_from_unknown(err))
        return json.dumps(local_result)

    # R4 — creds guard fails BEFORE any I/O for the request/reply path.
    creds_env = guard_creds(default_klodi_home(), NANOBOT_REGISTER_CLI)
    if creds_env is not None:
        return json.dumps(creds_env)
    try:
        result = await call_tool(name, args)
    except KeyError as err:
        return json.dumps(envelope_from_unknown(err))
    except KlodiRequestError as err:
        return json.dumps(envelope_from_klodi_request_error(err))
    except _CONNECTION_ERROR_TYPES:
        return json.dumps(envelope_from_not_connected())
    except BaseException as err:  # noqa: BLE001 — boundary
        # Adapter-internal failure — R2 says `internal_error` (P1.3 fix).
        return json.dumps(envelope_from_unknown(err))
    return json.dumps(result)


def _invalid_request(field: str, problem: str) -> dict[str, Any]:
    """Local envelope for adapter-side schema rejections (R2 invalid_request)."""
    return make_envelope(
        error="invalid_request",
        message=f"argument `{field}` is {problem}; re-call with a corrected value",
        details={"field": field, "problem": problem},
        recovery_hint=None,
    )


__all__ = [
    "TOOL_DEFINITIONS",
    "call_tool",
    "handle",
    "publish_channel_message",
]
