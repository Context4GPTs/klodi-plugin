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

import json
from typing import Any

from klodi_nats_client import (
    CHANNEL_MESSAGE_PARAMS,
    KlodiRequestError,
    TOOL_SCHEMAS,
    ToolSchema,
)

from nanobot_client import get_client
from nanobot_local_tools import (
    LOCAL_TOOL_DEFINITIONS,
    LOCAL_TOOL_NAMES,
    dispatch_local_tool,
)
from nanobot_photos import PhotoResolutionError, resolve_photos


_PUBLISH_TOOLS: frozenset[str] = frozenset({
    # Direct JetStream publish, not a NATS request.
    # Per **D § D4** (P3-3): canonical name is `klodi_channel_message`;
    # the legacy `klodi_channel_send` was removed in 0012.
    "klodi_channel_message",
})

# Tools whose `photos` parameter is run through the adapter-internal
# photo-resolution pipeline before the listing request is dispatched.
# See `nanobot_photos.resolve_photos` and ADR-0006.
_PHOTOS_AWARE_TOOLS: frozenset[str] = frozenset({
    "klodi_list_create",
    "klodi_list_update",
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
    """
    if name == "klodi_channel_message":
        try:
            channel_id = args["channel_id"]
            content = args["content"]
        except KeyError as err:
            return json.dumps({
                "error": "INVALID_REQUEST",
                "message": f"missing required field: {err.args[0]}",
            })
        try:
            result = await publish_channel_message(channel_id, content)
        except ValueError as err:
            return json.dumps({"error": "INVALID_REQUEST", "message": str(err)})
        except BaseException as err:  # noqa: BLE001 — boundary
            return json.dumps({
                "error": "transport_error",
                "message": str(err),
            })
        return json.dumps(result)

    if name in LOCAL_TOOL_NAMES:
        try:
            local_result = dispatch_local_tool(name, args)
        except KeyError as err:
            # Defensive — LOCAL_TOOL_NAMES + dispatch_local_tool are in
            # the same module, but keep the envelope shape consistent.
            return json.dumps({"error": "UNKNOWN_TOOL", "message": str(err)})
        except BaseException as err:  # noqa: BLE001 — boundary
            return json.dumps({
                "error": "transport_error",
                "message": str(err),
            })
        return json.dumps(local_result)

    if name in _PHOTOS_AWARE_TOOLS:
        try:
            resolved = await resolve_photos(
                args.get("photos"),
                _client_request,
            )
        except PhotoResolutionError as err:
            return json.dumps({
                "error": err.stage,
                "message": str(err),
                "path": err.path,
            })
        except BaseException as err:  # noqa: BLE001 — boundary
            return json.dumps({
                "error": "transport_error",
                "message": str(err),
            })
        if resolved is not None:
            args = {**args, "photos": resolved}

    try:
        result = await call_tool(name, args)
    except KeyError as err:
        return json.dumps({
            "error": "UNKNOWN_TOOL",
            "message": str(err),
        })
    except KlodiRequestError as err:
        return json.dumps({
            "error": err.code or "request_failed",
            "message": str(err),
        })
    except BaseException as err:  # noqa: BLE001 — boundary
        return json.dumps({
            "error": "transport_error",
            "message": str(err),
        })
    return json.dumps(result)


async def _client_request(
    subject: str, payload: dict[str, Any],
) -> dict[str, Any]:
    """Bridge ``resolve_photos`` to the shared KlodiClient singleton."""
    return await get_client().request(subject, payload)


__all__ = [
    "TOOL_DEFINITIONS",
    "call_tool",
    "handle",
    "publish_channel_message",
]
