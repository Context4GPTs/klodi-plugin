"""Unit tests for ``klodi_nats_client.local_tools`` (P2-13).

Asserts the schema's shape matches what Hermes / nanobot expect — the
catalog ``MAX_CHANNEL_MESSAGE_CHARS`` is the source of truth for the
length cap.
"""

from __future__ import annotations

from klodi_nats_client.constants import MAX_CHANNEL_MESSAGE_CHARS
from klodi_nats_client.local_tools import CHANNEL_MESSAGE_PARAMS


def test_channel_message_params_has_required_fields() -> None:
    """The schema must declare ``channel_id`` + ``content`` required,
    additional properties disabled, and the catalog length cap."""
    assert CHANNEL_MESSAGE_PARAMS["type"] == "object"
    assert CHANNEL_MESSAGE_PARAMS["required"] == ["channel_id", "content"]
    assert CHANNEL_MESSAGE_PARAMS["additionalProperties"] is False


def test_channel_id_is_uuid_typed() -> None:
    cid = CHANNEL_MESSAGE_PARAMS["properties"]["channel_id"]
    assert cid["type"] == "string"
    assert cid["format"] == "uuid"


def test_content_uses_catalog_length_cap() -> None:
    content = CHANNEL_MESSAGE_PARAMS["properties"]["content"]
    assert content["type"] == "string"
    assert content["minLength"] == 1
    assert content["maxLength"] == MAX_CHANNEL_MESSAGE_CHARS


def test_top_level_schema_is_jsonable() -> None:
    """Adapters serialize this schema as part of their tool registry —
    confirm it's a plain dict (no closures or non-serialisable bits)."""
    import json
    blob = json.dumps(CHANNEL_MESSAGE_PARAMS, sort_keys=True)
    roundtrip = json.loads(blob)
    assert roundtrip == CHANNEL_MESSAGE_PARAMS
