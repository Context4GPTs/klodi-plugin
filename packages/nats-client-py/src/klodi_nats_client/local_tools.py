"""Schemas for klodi local tools — P2-13.

A "local tool" is a tool the host adapter exposes to the agent that
does NOT round-trip to the marketplace (or only does so as a single
side-effect of a multi-step local flow). Examples shipped today:

* ``klodi_channel_message`` — direct JetStream publish, no
  marketplace request/reply.
* ``klodi_register`` / ``klodi_register_poll`` — HTTP polling against
  the API server, then on-disk creds + config writes.
* ``klodi_health`` / ``klodi_setup_status`` — local probes.

Their JSON-Schemas live here so every host adapter can import the
same shape instead of redeclaring it. Per **R § P2-13** the prior
duplication was Hermes ↔ nanobot — both maintained their own copy of
the channel-message schema. Phase 5 collapses both call sites onto
this module; the 2000-char cap now lives in the catalog only.

The constants module (``klodi_nats_client.constants``) holds the
underlying numeric values (``MAX_CHANNEL_MESSAGE_CHARS``) — this
module wraps them in adapter-ready JSON-Schema objects.
"""

from __future__ import annotations

from typing import Any

from klodi_nats_client.constants import MAX_CHANNEL_MESSAGE_CHARS


#: Input parameters schema for the ``klodi_channel_message`` local tool.
#:
#: Consumed by Hermes (``adapters/hermes/tools.py``) and nanobot
#: (``adapters/nanobot/nanobot_tools.py``) as the source of truth for
#: the tool's JSON-Schema. The 2000-character cap is the catalog
#: ``MAX_CHANNEL_MESSAGE_CHARS`` constant — bumping it once in the
#: catalog updates every adapter on the next codegen.
CHANNEL_MESSAGE_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "channel_id": {
            "type": "string",
            "format": "uuid",
            "description": (
                "UUID of the channel (from klodi_channel_create)."
            ),
        },
        "content": {
            "type": "string",
            "minLength": 1,
            # Per **D § D14**: cap is in Unicode code-points (not UTF-16
            # code units). Catalog `MAX_CHANNEL_MESSAGE_CHARS` is the
            # source of truth — bumping it once propagates to every
            # adapter on the next codegen.
            "maxLength": MAX_CHANNEL_MESSAGE_CHARS,
            "description": (
                f"Message body (up to {MAX_CHANNEL_MESSAGE_CHARS} characters)."
            ),
        },
    },
    "required": ["channel_id", "content"],
    "additionalProperties": False,
}


#: Input parameters schema for the ``klodi_match_feedback`` local-publish tool
#: (SC8 flywheel emit). Mirrors the catalog ``LOCAL_TOOLS.klodi_match_feedback``
#: params and the sibling marketplace ``MatchFeedback`` contract field-for-field.
#:
#: Consumed by Hermes (``adapters/hermes/.../tools.py``) and nanobot
#: (``adapters/nanobot/nanobot_tools.py``). Note: ``listing_id`` is a bounded
#: string (1..64), NOT a UUID — it rides in the body, not a subject path, and
#: the marketplace re-reads the Listing row as the real gate. ``outcome`` is a
#: closed set; ``action_on_match`` is optional provenance (capped at 40,
#: omitted when absent). No ``label`` field — the ± label is server-derived.
MATCH_FEEDBACK_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "search_slug": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9._-]{0,119}$",
            "description": "The standing-search slug the match belongs to.",
        },
        "listing_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "description": "The matched listing the verdict is about.",
        },
        "outcome": {
            "type": "string",
            "enum": ["pursued", "dismissed"],
            "description": "The agent's verdict: pursued or dismissed.",
        },
        "action_on_match": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40,
            "description": (
                "The buy file's action_on_match mode in effect (e.g. notify,"
                " negotiate) — provenance for curation-side filtering."
            ),
        },
    },
    "required": ["search_slug", "listing_id", "outcome"],
    "additionalProperties": False,
}


__all__ = ["CHANNEL_MESSAGE_PARAMS", "MATCH_FEEDBACK_PARAMS"]
