"""Publish-boundary tests for ``publish_match_feedback`` (Python half).

The flywheel-emit helper added by card
emit-standing-search-accept-dismiss-feedback (SC8). This is the
hermes + nanobot shared layer — both adapters reach the wire through this
single ``klodi_nats_client.publish`` helper, so it is where Python's wire
bytes are defined and where TS/Py byte parity is proven.

RED-first: ``publish_match_feedback`` is not defined in
``klodi_nats_client.publish`` yet, so the import below fails to resolve
until the expert-developer adds it. (Python RED for a not-yet-existent
symbol surfaces at import / collection — the idiomatic signal, mirroring
how ``test_client.py`` imports ``publish_channel_message``.)

We MOCK THE NATS BOUNDARY, NOT LOGIC: a ``MagicMock`` JetStream context with
a ``fake_publish`` capturing subject / data / headers, exactly like the
existing ``test_publish_channel_message_subject_and_shape``. The assertions
are about the bytes on the wire.

Wire contract (sibling marketplace
``4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts``):
    subject  p2p.v1.searches.match_feedback
    body     {search_slug, listing_id, outcome, action_on_match?}
    additionalProperties: false  — NO label, NO listing_summary.

Per the ``adversarial-testing`` skill: NEVER weaken these asserts to match a
helper that sends extra fields, the wrong subject, or omits the dedup
header. The helper serves the contract.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

# RED: this symbol does not exist yet. The expert-developer adds
# ``publish_match_feedback`` to packages/nats-client-py/src/klodi_nats_client/publish.py
# (byte-for-byte wire parity with the TS ``publishMatchFeedback``).
from klodi_nats_client.publish import publish_match_feedback

SUBJECT = "p2p.v1.searches.match_feedback"

# A real human buy-file slug (^[a-z0-9][a-z0-9._-]{0,119}$). NOT a UUID.
SEARCH_SLUG = "vintage-camera_01"
# A listing id that is deliberately NOT a UUID v4 — the marketplace accepts a
# bounded string here and re-reads the Listing row as the real gate. The
# helper MUST accept this; copying the channel-message UUID-v4 guard would
# wrongly reject it.
NON_UUID_LISTING_ID = "listing-7f3a"


def _capturing_js() -> tuple[MagicMock, dict[str, Any]]:
    """A JetStream mock whose ``publish`` records subject/data/headers."""
    captured: dict[str, Any] = {}
    js = MagicMock()

    async def fake_publish(
        subject: str, data: bytes, headers: dict[str, str] | None = None
    ) -> Any:
        captured["subject"] = subject
        captured["data"] = data
        captured["headers"] = headers
        captured["call_count"] = captured.get("call_count", 0) + 1
        return SimpleNamespace(seq=captured["call_count"])

    js.publish = fake_publish
    return js, captured


def _body(captured: dict[str, Any]) -> dict[str, Any]:
    return json.loads(captured["data"].decode("utf-8"))


@pytest.mark.asyncio
async def test_pursue_emits_outcome_pursued_on_the_subject() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
        action_on_match="notify",
    )
    assert captured["subject"] == SUBJECT
    body = _body(captured)
    assert body["outcome"] == "pursued"


@pytest.mark.asyncio
async def test_body_is_exactly_the_four_fields_no_label_no_summary() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
        action_on_match="notify",
    )
    body = _body(captured)
    assert body == {
        "search_slug": SEARCH_SLUG,
        "listing_id": NON_UUID_LISTING_ID,
        "outcome": "pursued",
        "action_on_match": "notify",
    }
    # Closed-set trust-boundary assertions.
    assert set(body.keys()) == {
        "search_slug",
        "listing_id",
        "outcome",
        "action_on_match",
    }
    assert "label" not in body
    assert "listing_summary" not in body


@pytest.mark.asyncio
async def test_dismiss_emits_outcome_dismissed_label_never_sent() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="dismissed",
        action_on_match="notify",
    )
    body = _body(captured)
    assert body["outcome"] == "dismissed"
    assert body["search_slug"] == SEARCH_SLUG
    assert body["listing_id"] == NON_UUID_LISTING_ID
    # The ± label is server-derived (to hard_negative) — never on the wire.
    assert "label" not in body
    assert body["outcome"] != "hard_negative"


@pytest.mark.asyncio
async def test_provenance_negotiate_reported_honestly() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
        action_on_match="negotiate",
    )
    body = _body(captured)
    # Reporting `negotiate` honestly (curation will drop it) is correct;
    # rewriting it to `notify` to "save" the signal poisons the corpus.
    assert body["action_on_match"] == "negotiate"


@pytest.mark.asyncio
async def test_action_on_match_omitted_when_not_provided() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
    )
    body = _body(captured)
    # Optional provenance: when absent the field must not be emitted as null;
    # the marketplace defaults it server-side.
    assert "action_on_match" not in body


@pytest.mark.asyncio
async def test_dedup_header_is_a_fresh_event_id_per_publish() -> None:
    js, captured = _capturing_js()
    # publish_channel_message returns a result carrying event_id; the
    # match-feedback helper mirrors that. We re-mint the capturing js between
    # calls so each publish's header is observable.
    js1, cap1 = _capturing_js()
    first = await publish_match_feedback(
        js=js1,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
        action_on_match="notify",
    )
    js2, cap2 = _capturing_js()
    second = await publish_match_feedback(
        js=js2,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="dismissed",
        action_on_match="notify",
    )
    # The Nats-Msg-Id header is the minted event_id (matches the
    # channel-message helper's dedup contract).
    assert cap1["headers"] == {"Nats-Msg-Id": first.event_id}
    assert cap2["headers"] == {"Nats-Msg-Id": second.event_id}
    # A redelivered wake / flipped verdict is a genuinely new event.
    assert first.event_id != second.event_id


@pytest.mark.asyncio
async def test_accepts_non_uuid_listing_id() -> None:
    # The explicit card assertion: a non-UUID listing_id must NOT be rejected.
    # It rides in the body, not a subject path; the marketplace accepts a
    # bounded string. Copying the channel-message UUID guard would break this.
    js, captured = _capturing_js()
    result = await publish_match_feedback(
        js=js,
        search_slug=SEARCH_SLUG,
        listing_id=NON_UUID_LISTING_ID,
        outcome="pursued",
        action_on_match="notify",
    )
    assert result is not None
    assert _body(captured)["listing_id"] == NON_UUID_LISTING_ID


@pytest.mark.asyncio
async def test_accepts_slug_with_dots_dashes_underscores() -> None:
    js, captured = _capturing_js()
    await publish_match_feedback(
        js=js,
        search_slug="a.b-c_d0",
        listing_id=NON_UUID_LISTING_ID,
        outcome="dismissed",
        action_on_match="notify",
    )
    assert _body(captured)["search_slug"] == "a.b-c_d0"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_outcome",
    ["positive", "hard_negative", "negative", "", "PURSUED"],
)
async def test_rejects_out_of_set_outcome_before_wire(bad_outcome: str) -> None:
    js = MagicMock()
    js.publish = MagicMock()
    with pytest.raises(ValueError):
        await publish_match_feedback(
            js=js,
            search_slug=SEARCH_SLUG,
            listing_id=NON_UUID_LISTING_ID,
            outcome=bad_outcome,  # type: ignore[arg-type]
            action_on_match="notify",
        )
    js.publish.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_slug",
    ["", "Has Space", "UPPER", "-leading-dash", "x" * 200],
    ids=["empty", "space", "upper", "leading-dash", "too-long"],
)
async def test_rejects_bad_search_slug_before_wire(bad_slug: str) -> None:
    js = MagicMock()
    js.publish = MagicMock()
    with pytest.raises(ValueError):
        await publish_match_feedback(
            js=js,
            search_slug=bad_slug,
            listing_id=NON_UUID_LISTING_ID,
            outcome="pursued",
            action_on_match="notify",
        )
    js.publish.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_listing", ["", "x" * 65])
async def test_rejects_empty_or_overlong_listing_id_before_wire(
    bad_listing: str,
) -> None:
    js = MagicMock()
    js.publish = MagicMock()
    with pytest.raises(ValueError):
        await publish_match_feedback(
            js=js,
            search_slug=SEARCH_SLUG,
            listing_id=bad_listing,
            outcome="pursued",
            action_on_match="notify",
        )
    js.publish.assert_not_called()
