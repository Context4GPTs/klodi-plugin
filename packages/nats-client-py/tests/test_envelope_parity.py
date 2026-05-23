"""Cross-language envelope parity — Python consumer (RED).

Loads ``packages/tool-catalog/tests/fixtures/envelope-golden.json`` and
asserts the Python adapter's envelope helpers produce the same shape
the fixture pins (after substituting per-host placeholders).

Coverage scope: every failure mode in the golden fixture that the
Python shared module reaches (creds-not-found, config-not-found,
not-connected, setup-error notifications/channels, marketplace
passthrough, internal_error). The fixture is the SINGLE oracle; this
test verifies the Python implementation conforms.

R8 — every assertion that pins `error` is exact-string match; every
assertion that pins `recovery_hint` is exact-structure match modulo
placeholder substitution (the host's register CLI name).

This file is QA-owned during RED. NEVER weaken these asserts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from klodi_nats_client import (
    KlodiRequestError,
    KlodiSetupError,
)
from klodi_nats_client.envelope import (  # type: ignore[import-not-found]
    envelope_from_creds_not_found,
    envelope_from_klodi_request_error,
    envelope_from_not_connected,
    envelope_from_setup_error,
    envelope_from_unknown,
)


_HERE = Path(__file__).resolve().parent
_FIXTURE = (
    _HERE.parents[2]  # repo root
    / "packages"
    / "tool-catalog"
    / "tests"
    / "fixtures"
    / "envelope-golden.json"
)


def _load_golden() -> dict[str, Any]:
    with _FIXTURE.open("r") as f:
        return json.load(f)


def _envelope_for(key: str) -> dict[str, Any]:
    g = _load_golden()
    entry = g[key]
    assert isinstance(entry, dict), f"fixture entry {key} is not an object"
    return entry["envelope"]


def _assert_envelope_keys_match(actual: dict[str, Any]) -> None:
    """R1 — exactly four keys."""
    assert set(actual.keys()) == {
        "error",
        "message",
        "details",
        "recovery_hint",
    }


def _assert_recovery_hint_matches(
    actual: dict[str, Any] | None,
    expected: dict[str, Any] | None,
    substitutions: dict[str, str] | None = None,
) -> None:
    """R3 — recovery_hint structure-equal after placeholder substitution.

    ``substitutions`` maps placeholder strings (e.g. ``<host>``) to the
    concrete value the test passed to the adapter (e.g. ``hermes``).
    """
    if expected is None:
        assert actual is None, (
            f"recovery_hint must be None when fixture says null; got {actual}"
        )
        return
    assert actual is not None, (
        "recovery_hint must NOT be None when fixture supplies a NextAction"
    )
    assert actual.get("kind") == expected.get("kind"), (
        f"recovery_hint.kind mismatch: actual={actual.get('kind')!r} "
        f"expected={expected.get('kind')!r}"
    )
    subs = substitutions or {}
    for k, exp_v in expected.items():
        if k == "kind":
            continue
        if exp_v is None:
            continue  # free-form field — fixture skips
        actual_v = actual.get(k)
        # Substitute placeholders in the expected value.
        if isinstance(exp_v, str):
            for placeholder, real in subs.items():
                exp_v = exp_v.replace(placeholder, real)
        assert actual_v == exp_v, (
            f"recovery_hint.{k} mismatch after substitution: "
            f"actual={actual_v!r} expected={exp_v!r}"
        )


# ── not_registered (creds + config) ───────────────────────────────────


def test_parity_not_registered_creds_path() -> None:
    expected = _envelope_for("not_registered")
    actual = envelope_from_creds_not_found("klodi-hermes-register")
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    _assert_recovery_hint_matches(
        actual["recovery_hint"],
        expected["recovery_hint"],
        substitutions={"<host>": "hermes"},
    )


def test_parity_not_registered_config_path_uses_same_envelope_shape() -> None:
    """Per R4: creds-not-found and config-not-found map to the same
    ``not_registered`` envelope. Two halves of registration."""
    expected = _envelope_for("not_registered")
    actual = envelope_from_creds_not_found("klodi-nanobot-register")
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    _assert_recovery_hint_matches(
        actual["recovery_hint"],
        expected["recovery_hint"],
        substitutions={"<host>": "nanobot"},
    )


# ── connection_not_ready ──────────────────────────────────────────────


def test_parity_connection_not_ready() -> None:
    expected = _envelope_for("connection_not_ready")
    actual = envelope_from_not_connected()
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    _assert_recovery_hint_matches(
        actual["recovery_hint"], expected["recovery_hint"]
    )


# ── consumer_missing (notifications + channels) ──────────────────────


def test_parity_consumer_missing_notifications() -> None:
    expected = _envelope_for("consumer_missing_notifications")
    err = KlodiSetupError("notifications_consumer_missing", "missing")
    actual = envelope_from_setup_error(err)
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    assert actual["details"] == expected["details"], (
        "details.consumer must be 'notifications'"
    )
    _assert_recovery_hint_matches(
        actual["recovery_hint"], expected["recovery_hint"]
    )


def test_parity_consumer_missing_channels() -> None:
    expected = _envelope_for("consumer_missing_channels")
    err = KlodiSetupError("channels_consumer_missing")
    actual = envelope_from_setup_error(err)
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    assert actual["details"] == expected["details"]


# ── marketplace passthrough ──────────────────────────────────────────


def test_parity_marketplace_error_collapses_to_marketplace_error() -> None:
    # Round 2 P2.1 — marketplace codes collapse to the R2 catch-all;
    # original code rides in details.marketplace_error_code.
    err = KlodiRequestError(
        {
            "error": "listing_not_owned_by_caller",
            "message": "Listing belongs to another user",
            "details": {"listing_id": "550e8400-e29b-41d4-a716-446655440000"},
        }
    )
    actual = envelope_from_klodi_request_error(err)
    _assert_envelope_keys_match(actual)
    expected = _envelope_for("marketplace_error_unknown_code")
    assert actual["error"] == expected["error"]
    assert actual["error"] == "marketplace_error"
    assert actual["details"]["marketplace_error_code"] == "listing_not_owned_by_caller"
    assert actual["recovery_hint"] is None


# ── internal_error ───────────────────────────────────────────────────


def test_parity_internal_error_no_recovery_hint() -> None:
    expected = _envelope_for("internal_error_generic")
    actual = envelope_from_unknown(ValueError("boom"))
    _assert_envelope_keys_match(actual)
    assert actual["error"] == expected["error"]
    assert actual["recovery_hint"] is None
    # details.exception_class is the only field the fixture pins for
    # internal_error.
    assert actual["details"] is not None
    assert "exception_class" in actual["details"]
