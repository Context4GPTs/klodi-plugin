"""Cross-language contract test (Python half) — Decision 7.

Reads every fixture from the golden corpus at
``klodi-plugin/packages/tool-catalog/tests/golden/`` and parses it with the
stdlib JSON loader — the same path the Python consumer takes inside
``klodi_nats_client.consumers._dispatch_message`` before handing the dict
to user code. Asserts every required field per the canonical event types
in ``klodi_nats_client.events`` (TypedDict mirrors of TS ``events.ts``).

If schemas drift in TS without a fixture update, this test fails — and
its TS / Rust counterparts fail in lockstep.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

GOLDEN_DIR = (
    Path(__file__).resolve().parents[3]
    / "tool-catalog"
    / "tests"
    / "golden"
)


def _load(name: str) -> dict[str, Any]:
    with (GOLDEN_DIR / name).open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _assert_event_id(evt: dict[str, Any]) -> None:
    assert isinstance(evt["event_id"], str)
    assert evt["event_id"] != ""


def test_corpus_directory_resolves() -> None:
    """Smoke check: the relative path we use to locate fixtures resolves."""
    assert GOLDEN_DIR.is_dir(), f"golden corpus missing at {GOLDEN_DIR}"
    fixtures = list(GOLDEN_DIR.glob("*.json"))
    assert len(fixtures) > 0


# ─── ListingStateEvent variants ────────────────────────────────────────


def test_listing_created() -> None:
    evt = _load("listing.created.json")
    assert evt["kind"] == "listing.created"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["title"], str)


def test_listing_relisted() -> None:
    evt = _load("listing.relisted.json")
    assert evt["kind"] == "listing.relisted"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["title"], str)


def test_listing_withdrawn() -> None:
    evt = _load("listing.withdrawn.json")
    assert evt["kind"] == "listing.withdrawn"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)


def test_listing_sold() -> None:
    evt = _load("listing.sold.json")
    assert evt["kind"] == "listing.sold"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)


def test_listing_expired() -> None:
    evt = _load("listing.expired.json")
    assert evt["kind"] == "listing.expired"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)


# ─── ListingStatusChangedEvent ─────────────────────────────────────────


def test_listing_status_changed() -> None:
    evt = _load("listing.status_changed.json")
    assert evt["kind"] == "listing.status_changed"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["old_status"], str)
    assert isinstance(evt["new_status"], str)
    assert evt["old_status"] != evt["new_status"]


# ─── OfferProposedEvent ────────────────────────────────────────────────


def test_offer_proposed() -> None:
    evt = _load("offer.proposed.json")
    assert evt["kind"] == "offer.proposed"
    _assert_event_id(evt)
    assert isinstance(evt["offer_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["buyer_handle"], str)
    # Booleans are int subclasses in Python — guard explicitly.
    assert isinstance(evt["amount"], int) and not isinstance(evt["amount"], bool)
    # terms is `Record<string, unknown> | None` — present here.
    assert evt["terms"] is not None
    assert isinstance(evt["terms"], dict)


# ─── OfferRespondedEvent variants ──────────────────────────────────────


def test_offer_accepted_carries_amount_and_transaction_id() -> None:
    evt = _load("offer.accepted.json")
    assert evt["kind"] == "offer.accepted"
    _assert_event_id(evt)
    assert isinstance(evt["offer_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["seller_handle"], str)
    assert isinstance(evt["amount"], int) and not isinstance(evt["amount"], bool)
    assert isinstance(evt["transaction_id"], str)


def test_offer_rejected_omits_amount_and_transaction_id() -> None:
    evt = _load("offer.rejected.json")
    assert evt["kind"] == "offer.rejected"
    _assert_event_id(evt)
    assert isinstance(evt["offer_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["seller_handle"], str)
    # Per OfferRespondedEvent these are accept-only.
    assert "amount" not in evt
    assert "transaction_id" not in evt


# ─── TransactionStateEvent variants ────────────────────────────────────


def test_transaction_completed() -> None:
    evt = _load("transaction.completed.json")
    assert evt["kind"] == "transaction.completed"
    _assert_event_id(evt)
    assert isinstance(evt["transaction_id"], str)
    assert isinstance(evt["listing_id"], str)


def test_transaction_cancelled_carries_reason() -> None:
    evt = _load("transaction.cancelled.json")
    assert evt["kind"] == "transaction.cancelled"
    _assert_event_id(evt)
    assert isinstance(evt["transaction_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["cancelled_by_handle"], str)
    assert isinstance(evt["reason"], str)


# ─── CommentPostedEvent ────────────────────────────────────────────────


def test_comment_created() -> None:
    evt = _load("comment.created.json")
    assert evt["kind"] == "comment.created"
    _assert_event_id(evt)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["comment_id"], str)
    assert isinstance(evt["handle"], str)
    assert isinstance(evt["body"], str)
    assert isinstance(evt["mentions"], list)
    for m in evt["mentions"]:
        assert isinstance(m, str)
    assert isinstance(evt["created_at"], str)
    assert evt["created_at"].endswith("Z")


# ─── SearchMatchEvent ──────────────────────────────────────────────────


def test_search_match() -> None:
    evt = _load("search.match.json")
    assert evt["kind"] == "search.match"
    _assert_event_id(evt)
    assert isinstance(evt["search_slug"], str)
    assert isinstance(evt["listing_id"], str)
    summary = evt["listing_summary"]
    assert isinstance(summary, dict)
    assert isinstance(summary["title"], str)
    assert isinstance(summary["asking_price"], int) and not isinstance(
        summary["asking_price"], bool
    )
    assert isinstance(summary["currency"], str)
    assert isinstance(summary["delivery_method"], str)
    # location_area is `str | None`.
    if summary["location_area"] is not None:
        assert isinstance(summary["location_area"], str)
    assert isinstance(summary["seller_handle"], str)
    assert isinstance(summary["photos"], list)
    for p in summary["photos"]:
        assert isinstance(p, str)


# ─── ChannelLifecycleEvent variants ────────────────────────────────────


def test_channel_opened() -> None:
    evt = _load("channel.opened.json")
    assert evt["kind"] == "channel.opened"
    _assert_event_id(evt)
    assert isinstance(evt["channel_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["buyer_handle"], str)


def test_channel_closed() -> None:
    evt = _load("channel.closed.json")
    assert evt["kind"] == "channel.closed"
    _assert_event_id(evt)
    assert isinstance(evt["channel_id"], str)
    assert isinstance(evt["listing_id"], str)
    assert isinstance(evt["closed_by"], str)


# ─── ChannelMessageEvent (channel-stream) ─────────────────────────────


def test_channel_message() -> None:
    evt = _load("channel.message.json")
    assert evt["kind"] == "channel.message"
    _assert_event_id(evt)
    assert isinstance(evt["channel_id"], str)
    assert isinstance(evt["message_id"], str)
    assert isinstance(evt["sequence"], int) and not isinstance(evt["sequence"], bool)
    assert isinstance(evt["sender_user_id"], str)
    assert isinstance(evt["sender_handle"], str)
    assert isinstance(evt["content"], str)
    assert 0 < len(evt["content"]) <= 2000
    assert isinstance(evt["created_at"], str)
    assert evt["created_at"].endswith("Z")


# Marker for pytest discovery completeness — referenced by the drift gate.
if False:  # pragma: no cover
    pytest.main()
# qa-developer: golden-corpus-decision-7
