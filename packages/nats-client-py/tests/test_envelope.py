"""Python tool-result envelope contract (RED).

The architect's ADR-0011 plan locks the wire format at::

    {"error": "<code>", "message": "<human>", "details": {...|None},
     "recovery_hint": {...|None}}

All four keys are ALWAYS present. ``details`` and ``recovery_hint``
serialise as JSON ``null`` when absent — never elided. Python's
``json.dumps`` natively emits ``None`` as ``null``, so the contract
maps to a ``dict[str, Any]`` with explicit ``None`` placeholders.

Production items the implementer must add to
``packages/nats-client-py/src/klodi_nats_client/envelope.py``::

    from typing import Any
    from collections.abc import Mapping

    ErrorCode = str  # one of the closed R2 vocabulary; the catalog
                    # holds the canonical list (codegen target).

    def make_envelope(
        *,
        error: str,
        message: str,
        details: Mapping[str, Any] | None = None,
        recovery_hint: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...  # returns the four-key dict

    def envelope_from_klodi_request_error(
        err: KlodiRequestError,
    ) -> dict[str, Any]:
        ...  # marketplace passthrough — recovery_hint=None

    def envelope_from_creds_not_found(
        register_cli: str,
    ) -> dict[str, Any]:
        ...  # not_registered + recovery_hint NextAction(Cli)

    def envelope_from_config_not_found(
        register_cli: str,
    ) -> dict[str, Any]:
        ...  # not_registered (config half)

    def envelope_from_not_connected() -> dict[str, Any]:
        ...  # connection_not_ready + recovery_hint NextAction(Tool)

    def envelope_from_setup_error(
        err: KlodiSetupError,
    ) -> dict[str, Any]:
        ...  # consumer_missing + details.consumer

    def envelope_from_unknown(err: BaseException) -> dict[str, Any]:
        ...  # internal_error

This file is QA-owned during RED. NEVER weaken these asserts to compile;
add the production items in envelope.py until the asserts hold.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from klodi_nats_client import (
    KlodiRequestError,
    KlodiSetupError,
    ConfigNotFoundError,
    CredsNotFoundError,
)

# The implementer adds this module + symbols. Until they exist the
# imports fail and every test in this file errors at collection.
from klodi_nats_client.envelope import (  # type: ignore[import-not-found]
    envelope_from_config_not_found,
    envelope_from_creds_not_found,
    envelope_from_klodi_request_error,
    envelope_from_not_connected,
    envelope_from_setup_error,
    envelope_from_unknown,
    make_envelope,
)


# ── Wire-shape invariants (R1) ────────────────────────────────────────


def _assert_envelope_keys(env: dict[str, Any]) -> None:
    """R1: exactly four canonical keys, no more, no less."""
    assert set(env.keys()) == {"error", "message", "details", "recovery_hint"}, (
        f"envelope must carry exactly the four R1 keys; got {sorted(env.keys())}"
    )


def test_make_envelope_returns_four_keys_with_none_placeholders() -> None:
    env = make_envelope(error="internal_error", message="boom")
    _assert_envelope_keys(env)
    assert env["error"] == "internal_error"
    assert env["message"] == "boom"
    assert env["details"] is None
    assert env["recovery_hint"] is None


def test_make_envelope_serialises_none_as_json_null_not_omitted() -> None:
    """R1: details/recovery_hint serialise as literal ``null`` — they are
    NEVER elided. Python's json.dumps does the right thing for ``None`` but
    we pin it explicitly so future TypedDict refactors don't accidentally
    drop the placeholder."""
    env = make_envelope(error="internal_error", message="boom")
    wire = json.loads(json.dumps(env))
    assert wire["details"] is None
    assert wire["recovery_hint"] is None
    # Round-trip preserves the four keys; details/recovery_hint stay.
    assert set(wire.keys()) == {"error", "message", "details", "recovery_hint"}


def test_make_envelope_with_details_object_preserves_fields() -> None:
    env = make_envelope(
        error="invalid_request",
        message="transaction_id is required",
        details={"field": "transaction_id", "problem": "missing"},
    )
    _assert_envelope_keys(env)
    assert env["details"] == {"field": "transaction_id", "problem": "missing"}
    assert env["recovery_hint"] is None


def test_make_envelope_with_recovery_hint_cli_preserves_kind_discriminant() -> None:
    """R3: ``recovery_hint`` mirrors the NextAction discriminated union.
    The Python shape uses ``kind`` as the discriminant (cross-language
    parity with the Rust serde tag and the TS literal)."""
    env = make_envelope(
        error="not_registered",
        message="Run klodi-hermes-register",
        recovery_hint={
            "kind": "cli",
            "command": "klodi-hermes-register",
            "message": "Run klodi-hermes-register from the shell.",
        },
    )
    _assert_envelope_keys(env)
    hint = env["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "cli"
    assert hint["command"] == "klodi-hermes-register"


def test_make_envelope_with_recovery_hint_tool_preserves_kind_discriminant() -> None:
    env = make_envelope(
        error="connection_not_ready",
        message="klodi NATS connection not ready",
        recovery_hint={
            "kind": "tool",
            "tool": "klodi_setup_status",
            "message": "Run klodi_setup_status to diagnose.",
        },
    )
    _assert_envelope_keys(env)
    hint = env["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "tool"
    assert hint["tool"] == "klodi_setup_status"


# ── envelope_from_klodi_request_error (R1 marketplace passthrough) ────


def test_envelope_from_marketplace_request_error_passes_through() -> None:
    """Marketplace passthrough: code/message preserved verbatim,
    recovery_hint stays ``None`` (architect open Q2 conservative
    default — adapter does NOT synthesise a hint for server codes)."""
    err = KlodiRequestError(
        {
            "error": "listing_not_owned_by_caller",
            "message": "Listing belongs to another user",
            "details": {"listing_id": "abc"},
        }
    )
    env = envelope_from_klodi_request_error(err)
    _assert_envelope_keys(env)
    assert env["error"] == "listing_not_owned_by_caller"
    assert env["message"] == "Listing belongs to another user"
    assert env["details"] == {"listing_id": "abc"}
    assert env["recovery_hint"] is None, (
        "marketplace passthrough must NOT synthesise a recovery_hint"
    )


def test_envelope_from_request_error_without_details_uses_none_placeholder() -> None:
    err = KlodiRequestError(
        {"error": "validation_failed", "message": "bad payload"}
    )
    env = envelope_from_klodi_request_error(err)
    _assert_envelope_keys(env)
    assert env["error"] == "validation_failed"
    assert env["details"] is None
    assert env["recovery_hint"] is None


# ── envelope_from_creds/config_not_found (not_registered, R2 + R3) ────


def test_envelope_from_creds_not_found_signals_not_registered() -> None:
    env = envelope_from_creds_not_found("klodi-hermes-register")
    _assert_envelope_keys(env)
    assert env["error"] == "not_registered"
    assert env["message"], "not_registered must carry a non-empty message"
    hint = env["recovery_hint"]
    assert hint is not None, "not_registered must carry a recovery_hint"
    assert hint["kind"] == "cli"
    assert hint["command"] == "klodi-hermes-register"


def test_envelope_from_config_not_found_also_signals_not_registered() -> None:
    """R4 — the creds_present guard treats both halves of registration
    (nats.creds + config.json) as the same failure mode."""
    env = envelope_from_config_not_found("klodi-nanobot-register")
    _assert_envelope_keys(env)
    assert env["error"] == "not_registered"
    hint = env["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "cli"
    assert hint["command"] == "klodi-nanobot-register"


def test_envelope_from_creds_not_found_uses_callers_register_cli() -> None:
    """Per-host CLI is parameterised. The shared module does not
    hard-code a specific adapter name."""
    env_hermes = envelope_from_creds_not_found("klodi-hermes-register")
    env_nanobot = envelope_from_creds_not_found("klodi-nanobot-register")
    assert env_hermes["recovery_hint"]["command"] == "klodi-hermes-register"
    assert env_nanobot["recovery_hint"]["command"] == "klodi-nanobot-register"


# ── envelope_from_not_connected (connection_not_ready) ───────────────


def test_envelope_from_not_connected_signals_connection_not_ready() -> None:
    """R2 + R3 — connection_not_ready is the canonical code (the existing
    Python ``klodi_unavailable`` is the deprecated alias per architect
    open Q1). The recovery hint targets klodi_setup_status."""
    env = envelope_from_not_connected()
    _assert_envelope_keys(env)
    assert env["error"] == "connection_not_ready"
    hint = env["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "tool"
    assert hint["tool"] == "klodi_setup_status"


# ── envelope_from_setup_error (consumer_missing) ─────────────────────


def test_envelope_from_setup_error_notifications_consumer() -> None:
    err = KlodiSetupError(
        "notifications_consumer_missing", "notifications consumer not provisioned"
    )
    env = envelope_from_setup_error(err)
    _assert_envelope_keys(env)
    assert env["error"] == "consumer_missing"
    assert env["details"] is not None
    assert env["details"]["consumer"] == "notifications"
    hint = env["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "tool"
    assert hint["tool"] == "klodi_setup_status"


def test_envelope_from_setup_error_channels_consumer() -> None:
    err = KlodiSetupError("channels_consumer_missing")
    env = envelope_from_setup_error(err)
    _assert_envelope_keys(env)
    assert env["error"] == "consumer_missing"
    assert env["details"]["consumer"] == "channels"


# ── envelope_from_unknown (internal_error) ────────────────────────────


def test_envelope_from_unknown_python_exception_signals_internal_error() -> None:
    """Any uncategorised exception degrades to ``internal_error`` with no
    recovery_hint — agent retries once or surfaces to operator."""
    err = ValueError("totally unexpected")
    env = envelope_from_unknown(err)
    _assert_envelope_keys(env)
    assert env["error"] == "internal_error"
    assert env["recovery_hint"] is None


def test_envelope_from_unknown_carries_exception_class_in_details() -> None:
    """``details`` carries what the adapter knows about the failure —
    the exception class name is the minimum that helps operators triage."""
    err = ValueError("totally unexpected")
    env = envelope_from_unknown(err)
    details = env["details"]
    assert details is not None, "internal_error details must not be None"
    assert details.get("exception_class") == "ValueError"


# ── Wire-format parity (round-trip via json.dumps) ───────────────────


def test_envelope_round_trip_through_json_preserves_shape() -> None:
    env = make_envelope(
        error="invalid_request",
        message="content is empty",
        details={"field": "content", "problem": "empty"},
        recovery_hint=None,
    )
    serialised = json.dumps(env, sort_keys=True)
    parsed = json.loads(serialised)
    assert parsed == env
    _assert_envelope_keys(parsed)


def test_envelope_serialised_keys_are_exactly_the_four_canonical_names() -> None:
    """Cross-language wire-format sanity: the JSON object carries the
    same four keys the Rust ToolEnvelope emits."""
    env = make_envelope(error="internal_error", message="x")
    serialised = json.dumps(env)
    parsed = json.loads(serialised)
    assert sorted(parsed.keys()) == ["details", "error", "message", "recovery_hint"]
