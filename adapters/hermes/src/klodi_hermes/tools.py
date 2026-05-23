"""Hermes tool handlers — every klodi_* tool maps to a NATS subject.

Per 0012, the host plugin holds a persistent NATS-WS connection. The
catalog (``klodi-plugin/packages/tool-catalog/``) is the single source
of schema truth — names, subjects, params, results — and every Python
adapter consumes the JSON Schema export bundled with
``klodi-nats-client``.

This module owns:

  * ``build_request_handler(tool_name)`` — synchronous Hermes handler
    that bridges to the async ``KlodiClient.request(subject, params)``
    via the dedicated asyncio loop in ``client.py``.
  * ``handle_channel_message(args)``   — replaces the deleted
    ``klodi_channel_send`` request/reply tool. Direct JetStream
    publish via ``KlodiClient.publish_channel_message``.
  * ``tool_emoji(name)``               — emoji shown next to each tool
    in Hermes's tool list. UX-only.
  * ``register_request_tools(ctx)``    — iterate the catalog and wire
    each tool into Hermes via ``ctx.register_tool(...)``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
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
    envelope_from_upload_failed,
    make_envelope,
)
from klodi_nats_client.guards import guard_creds
from klodi_nats_client.paths import default_klodi_home

from .client import get_client, run_async
from .photos import PhotoResolutionError, resolve_photos

log = logging.getLogger("klodi_hermes.tools")

# Per-host register CLI surfaced in `not_registered` recovery hints (R8).
# Substituted into the catalog's `klodi-<host>-register` placeholder so
# the agent surfaces the literal command the operator runs.
HERMES_REGISTER_CLI = "klodi-hermes-register"


# ── Emojis ───────────────────────────────────────────────────────────


_TOOL_EMOJIS: dict[str, str] = {
    "klodi_whoami": "ℹ️",
    "klodi_health": "❤️",
    "klodi_ratings": "🏅",
    "klodi_list_create": "🏷️",
    "klodi_list_get": "🔍",
    "klodi_list_mine": "📋",
    "klodi_list_update": "✏️",
    "klodi_list_withdraw": "🚫",
    "klodi_list_relist": "🔁",
    "klodi_list_comments": "💬",
    "klodi_comment": "💬",
    "klodi_search": "🔎",
    "klodi_offer_create": "💰",
    "klodi_offer_respond": "📩",
    "klodi_offer_mine": "🧾",
    "klodi_channel_create": "🧵",
    "klodi_channel_close": "🛑",
    "klodi_channel_message": "✉️",
    "klodi_channel_history": "📜",
    "klodi_channel_mine": "📥",
    "klodi_tx_status": "📊",
    "klodi_tx_confirm": "✅",
    "klodi_tx_cancel": "❎",
    "klodi_tx_rate": "⭐",
    "klodi_searches_create": "👁️",
    "klodi_searches_delete": "✖️",
    "klodi_searches_list": "📔",
}


def tool_emoji(name: str) -> str:
    return _TOOL_EMOJIS.get(name, "📎")


# ── Request bridge ───────────────────────────────────────────────────


_PHOTOS_AWARE_TOOLS: frozenset[str] = frozenset({
    "klodi_list_create",
    "klodi_list_update",
})


def build_request_handler(tool_name: str) -> Callable[..., str]:
    """Return a synchronous handler that issues a NATS request.

    Hermes's ``ctx.register_tool(handler=...)`` expects ``handler(args:
    dict) -> str``. We bridge to the async client by submitting the
    coroutine to the dedicated asyncio loop (see ``client.py``).
    Errors are returned as JSON envelopes so the agent sees a
    structured failure instead of a raw exception.

    For ``klodi_list_create`` and ``klodi_list_update`` the handler also
    runs the photo-resolution pipeline (see ``photos.py``) on
    ``args["photos"]`` BEFORE issuing the listings request. The mint
    call (``p2p.v1.assets.upload-url``) is dispatched through the same
    KlodiClient, and PUTs to R2 happen synchronously inside that helper.
    """
    schema = TOOL_SCHEMAS.get(tool_name)
    if schema is None:
        raise KeyError(f"Unknown tool {tool_name} not in catalog")
    subject = schema["subject"]
    is_photos_aware = tool_name in _PHOTOS_AWARE_TOOLS

    def _nats_request(subj: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Sync entry for the mint call inside resolve_photos."""
        client = get_client()
        return run_async(client.request(subj, payload))

    def handler(args: dict[str, Any], **_kwargs: Any) -> str:
        # Hermes runtime passes extra kwargs (task_id, tool_call_id,
        # etc.) — we accept-and-discard so future runtime params don't
        # break the plugin on upgrade.
        #
        # All error paths return the canonical four-key envelope
        # (ADR-0011). The agent reads `error`, follows `recovery_hint`,
        # never pattern-matches on `message`.

        # R4 — creds guard fails BEFORE any I/O. No NATS round-trip
        # (including the photo-resolution mint call below) gets issued
        # if creds are absent.
        creds_env = guard_creds(default_klodi_home(), HERMES_REGISTER_CLI)
        if creds_env is not None:
            return json.dumps(creds_env)

        # Photo resolution (ADR-0006) runs after the creds guard because
        # the mint call inside resolve_photos is NATS I/O. Per-stage
        # failures collapse to the R2 `upload_failed` code with the
        # failure site in details.stage and the offending file in
        # details.path (ADR-0011 cross-link in ADR-0006).
        if is_photos_aware:
            try:
                resolved = resolve_photos(args.get("photos"), _nats_request)
            except PhotoResolutionError as err:
                # Mint and PUT failures are network-class — operators
                # need visibility. Validation failures (absolute_path,
                # missing, content_type, size, count, type) are
                # agent-driven and would be noise at warn level. The
                # agent always sees the structured envelope below.
                if err.stage in ("mint", "put"):
                    log.warning(
                        "klodi_photos_resolution_failed"
                        " tool=%s stage=%s path=%s error=%s",
                        tool_name,
                        err.stage,
                        err.path,
                        err,
                    )
                return json.dumps(envelope_from_upload_failed(
                    stage=err.stage, message=str(err), path=err.path,
                ))
            except Exception as err:  # noqa: BLE001 — boundary; KeyboardInterrupt/SystemExit propagate
                # Adapter-internal failure inside resolution — R2 says
                # `internal_error` (P1.3: not mis-labelled as a
                # connection failure).
                log.warning(
                    "klodi_photos_resolution_failed tool=%s error=%s",
                    tool_name,
                    err,
                )
                return json.dumps(envelope_from_unknown(err))
            if resolved is not None:
                args = {**args, "photos": resolved}

        try:
            client = get_client()
            result = run_async(client.request(subject, args))
        except KlodiRequestError as err:
            return json.dumps(envelope_from_klodi_request_error(err))
        except _CONNECTION_ERROR_TYPES as err:
            # Transport / connection state — agent calls
            # klodi_setup_status to diagnose.
            log.warning(
                "klodi_tool_handler_connection_failed tool=%s subject=%s error=%s",
                tool_name,
                subject,
                err,
            )
            return json.dumps(envelope_from_not_connected())
        except Exception as err:  # noqa: BLE001 — boundary; KeyboardInterrupt/SystemExit propagate
            # Everything else (ValueError, JSONDecodeError, KeyError,
            # RuntimeError, …) is an adapter-internal failure. R2 says
            # `internal_error` — agent retries once or surfaces.
            log.warning(
                "klodi_tool_handler_failed tool=%s subject=%s error=%s",
                tool_name,
                subject,
                err,
            )
            return json.dumps(envelope_from_unknown(err))
        return json.dumps(result)

    return handler


# Exception types that signal "transport / connection is not ready".
# Catching these specifically (rather than the BaseException catch-all
# from round 1) means non-connection failures route to `internal_error`
# instead of being mis-labelled `connection_not_ready` (P1.3, R2).
_CONNECTION_ERROR_TYPES: tuple[type[BaseException], ...] = (
    ConnectionError,
    asyncio.TimeoutError,
    TimeoutError,
)


# ── klodi_channel_message — direct JetStream publish ──────────────────


def handle_channel_message(args: dict[str, Any], **_kwargs: Any) -> str:
    """Replace the deleted ``klodi_channel_send`` tool.

    Returns ``{sequence: int}`` on success — the JetStream sequence is
    proof that the message is durably stored and queued for the
    recipient's consumer.
    """
    # R4 — creds guard fails BEFORE any I/O.
    creds_env = guard_creds(default_klodi_home(), HERMES_REGISTER_CLI)
    if creds_env is not None:
        return json.dumps(creds_env)

    channel_id = args.get("channel_id")
    content = args.get("content")
    if not isinstance(channel_id, str) or not channel_id:
        return json.dumps(_invalid_request("channel_id", "missing" if channel_id is None else (
            "empty" if channel_id == "" else "wrong_type"
        )))
    if not isinstance(content, str) or not content:
        return json.dumps(_invalid_request("content", "missing" if content is None else (
            "empty" if content == "" else "wrong_type"
        )))

    try:
        client = get_client()
        result = run_async(
            client.publish_channel_message(channel_id, {"content": content})
        )
    except ValueError as err:
        # ValueError from publish_channel_message means the server-side
        # validator rejected the body shape (content max-length, etc.).
        return json.dumps(envelope_from_unknown(err))
    except _CONNECTION_ERROR_TYPES as err:
        log.warning(
            "klodi_channel_message_connection_failed channel_id=%s error=%s",
            channel_id,
            err,
        )
        return json.dumps(envelope_from_not_connected())
    except Exception as err:  # noqa: BLE001 — boundary; KeyboardInterrupt/SystemExit propagate
        # Adapter-internal failure — agent gets `internal_error`, not a
        # mis-labelled `connection_not_ready` (P1.3).
        log.warning(
            "klodi_channel_message_failed channel_id=%s error=%s",
            channel_id,
            err,
        )
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


# Per **R § P2-13**: ``CHANNEL_MESSAGE_PARAMS`` is the JSON-Schema for
# klodi_channel_message inputs and is shared between Hermes + nanobot.
# Imported from ``klodi_nats_client`` (the only adapter-agnostic source of
# truth for the schema). Bumping ``MAX_CHANNEL_MESSAGE_CHARS`` once in
# the catalog updates every adapter on the next codegen.


# ── Registration ─────────────────────────────────────────────────────


def _is_local_tool(name: str) -> bool:
    """Tools registered separately by other modules.

    These have host-specific behavior (filesystem state, browser OAuth,
    direct JetStream publish) and don't go through the request bridge.
    """
    return name in {
        # local_tools.py
        "klodi_setup_status",
        "klodi_setup_repair",
        "klodi_setup_reseed_policies",
        # register.py
        "klodi_register",
        "klodi_register_poll",
        # watch.py — uses searches.create + buy file write
        "klodi_watch",
        "klodi_unwatch",
        # this module
        "klodi_channel_message",
    }


def register_request_tools(ctx: Any) -> int:
    """Register every catalog tool that maps to a request/reply NATS
    subject. Local tools (browser OAuth, filesystem state) are
    registered by their own modules.

    Tools register unconditionally — Hermes' per-turn ``check_fn``
    gating used to hide these when the NATS client wasn't connected,
    but that created a discoverability cliff (the model can only
    call tools whose schema it received last turn). The handlers
    return the canonical four-key envelope (ADR-0011) on failure —
    `connection_not_ready` for transport-state errors, `not_registered`
    when creds are missing (guard catches it before any I/O), and
    `internal_error` for everything else — keeping the tool
    discoverable while making the failure mode actionable.

    Returns the number of tools registered.
    """
    registered = 0
    for name, schema in sorted(TOOL_SCHEMAS.items()):
        if _is_local_tool(name):
            continue
        function_schema = _function_schema(name, schema)
        ctx.register_tool(
            name=name,
            toolset="klodi",
            schema=function_schema,
            handler=build_request_handler(name),
            requires_env=[],  # NKey on disk; no env-secret coupling
            is_async=False,
            description=schema["description"],
            emoji=tool_emoji(name),
        )
        registered += 1

    # klodi_channel_message — direct JetStream publish, not a NATS
    # request, so it can't come from the request-bridge loop.
    ctx.register_tool(
        name="klodi_channel_message",
        toolset="klodi",
        schema={
            "name": "klodi_channel_message",
            "description": (
                "Send a message in an open klodi channel. The message"
                " is durably stored on the marketplace's JetStream and"
                " delivered to the other participant in real time."
                " Returns the JetStream sequence as durability proof."
            ),
            "parameters": CHANNEL_MESSAGE_PARAMS,
        },
        handler=handle_channel_message,
        requires_env=[],
        is_async=False,
        description="Send a message in a klodi channel.",
        emoji=tool_emoji("klodi_channel_message"),
    )
    registered += 1
    return registered


def _function_schema(name: str, schema: ToolSchema) -> dict[str, Any]:
    """Hermes's tools.registry expects OpenAI function-schema shape.

    See ``hermes/tools/registry.py:get_definitions`` and
    ``TERMINAL_SCHEMA`` for the reference layout. Passing bare JSON
    Schema would emit a malformed function with no description or
    parameters and the model would see an empty-params tool.
    """
    return {
        "name": name,
        "description": schema["description"],
        "parameters": schema["params"],
    }


__all__ = [
    "build_request_handler",
    "handle_channel_message",
    "register_request_tools",
    "tool_emoji",
]
