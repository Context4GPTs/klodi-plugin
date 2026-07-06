"""Round-2 RED tests for the Hermes request bridge.

CQG round-1 P2.3: `build_request_handler` had ZERO unit tests. The
helper-layer envelope tests in `klodi_nats_client.tests.test_envelope`
verify the envelope shape; they do not exercise the production dispatch
path. Without coverage here, the P1.3 split (`ConnectionError` →
``connection_not_ready``, everything else → ``internal_error``) and the
P1.2 wire-up (``guard_creds`` runs BEFORE ``get_client()``) can silently
regress on any future edit.

This file pins the dispatch-path contract:

  * Happy path returns ``json.dumps(result)``.
  * `KlodiRequestError` → passthrough envelope (server code preserved).
  * `ConnectionError` / `asyncio.TimeoutError` → ``connection_not_ready``
    with the `klodi_setup_status` recovery hint.
  * `ValueError` / `RuntimeError` / `KeyError` / arbitrary `Exception`
    → ``internal_error`` with `details.exception_class` (NOT
    ``connection_not_ready`` — that was the P1.3 round-1 bug).
  * Missing creds → ``not_registered`` envelope BEFORE ``get_client()``
    is called (R4 + R8).
  * `handle_channel_message` mirrors the same contract.

Tests are QA-owned during RED. NEVER weaken these asserts; if the
production catch-all routes a non-connection exception back to
``connection_not_ready``, fix the catch-all, never this file.

See ADR-0011.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _klodi_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point ``${KLODI_HOME}`` at a temp dir with creds + config so the
    creds guard passes through to the dispatch path under test. Tests
    that exercise the guard rejection use the ``_klodi_home_unset``
    fixture instead.
    """
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    (tmp_path / "nats.creds").write_text("fake-creds")
    (tmp_path / "config.json").write_text("{}")
    return tmp_path


@pytest.fixture
def _klodi_home_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> Path:
    """Point ``${KLODI_HOME}`` at an EMPTY temp dir (no creds, no config)
    so the creds guard fires on every dispatch.

    We allocate a NEW path via `tmp_path_factory` rather than reusing the
    shared `tmp_path`, because the autouse `_klodi_home` fixture already
    seeded the shared tmp_path with `nats.creds` + `config.json`. Using a
    fresh empty dir gives the guard a clean rejection surface.
    """
    fresh = tmp_path_factory.mktemp("empty-klodi-home")
    monkeypatch.setenv("KLODI_HOME", str(fresh))
    return fresh


# Import inside the test module — env-driven default_klodi_home() reads
# the patched KLODI_HOME on every call.
from klodi_hermes import tools as hermes_tools  # noqa: E402
from klodi_hermes import client as hermes_client  # noqa: E402
from klodi_nats_client import KlodiRequestError  # noqa: E402


def _envelope_keys(parsed: dict[str, Any]) -> set[str]:
    return set(parsed.keys())


# ── build_request_handler — happy path ───────────────────────────────


def test_build_request_handler_happy_path_returns_json_dumps_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: client.request() returns a dict; handler returns
    json.dumps of it (no envelope wrapping, no `error` key)."""
    fake_client = MagicMock()
    # The handler bridges sync→async via run_async; we monkeypatch both
    # so the test doesn't spawn the asyncio loop thread.
    monkeypatch.setattr(hermes_tools, "get_client", lambda: fake_client)
    monkeypatch.setattr(
        hermes_tools,
        "run_async",
        lambda _coro: {"handle": "tester", "user_id": "u-1"},
    )

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed == {"handle": "tester", "user_id": "u-1"}
    assert "error" not in parsed, "happy path must NOT wrap in failure envelope"


# ── build_request_handler — KlodiRequestError passthrough ────────────


def test_build_request_handler_klodi_request_error_returns_marketplace_error_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When client.request raises KlodiRequestError (marketplace
    rejection), handler returns the canonical four-key envelope with
    the R2 catch-all `marketplace_error` code. The server's original
    code rides in details.marketplace_error_code; the message in
    details.marketplace_message; extra payload in
    details.marketplace_details. Round 2 P2.1 fix — preserving server
    codes verbatim violated R2 closed vocabulary.
    """

    def raise_klodi(_coro: Any) -> Any:
        raise KlodiRequestError({
            "error": "listing_not_owned_by_caller",
            "message": "Listing belongs to another user",
            "details": {"listing_id": "abc-123"},
        })

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_klodi)

    handler = hermes_tools.build_request_handler("klodi_list_update")
    raw = handler({"listing_id": "abc-123"})

    parsed = json.loads(raw)
    assert _envelope_keys(parsed) == {"error", "message", "details", "recovery_hint"}
    assert parsed["error"] == "marketplace_error"
    assert parsed["details"]["marketplace_error_code"] == "listing_not_owned_by_caller"
    assert parsed["details"]["marketplace_message"] == "Listing belongs to another user"
    assert parsed["details"]["marketplace_details"] == {"listing_id": "abc-123"}
    # Marketplace passthrough — recovery_hint stays null (architect open Q2).
    assert parsed["recovery_hint"] is None


# ── build_request_handler — P1.3 split (the round-1 mis-labelling bug) ─


def test_build_request_handler_value_error_returns_internal_error_not_connection_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P1.3 — A `ValueError` (e.g. server returned malformed JSON, an
    internal data-validation issue, or any non-connection exception)
    MUST surface as `internal_error`, NOT `connection_not_ready`.

    The round-1 bug: `except BaseException` collapsed everything into
    `envelope_from_not_connected()`, pointing agents at
    `klodi_setup_status` for an entirely unrelated failure.
    """

    def raise_value_error(_coro: Any) -> Any:
        raise ValueError("malformed server response")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_value_error)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error", (
        "non-connection exceptions MUST route to `internal_error`, NOT "
        "`connection_not_ready` (P1.3 round-1 regression)"
    )
    # exception_class lets operators triage; agent does not pattern-match.
    assert parsed["details"]["exception_class"] == "ValueError"
    assert parsed["recovery_hint"] is None


def test_build_request_handler_runtime_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P1.3 — `RuntimeError` (e.g. asyncio loop issue, bridge bug) is
    NOT a connection state error. The agent must NOT be told to call
    `klodi_setup_status` — that would mask the real failure."""

    def raise_runtime(_coro: Any) -> Any:
        raise RuntimeError("bridge thread crashed")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_runtime)

    handler = hermes_tools.build_request_handler("klodi_tx_confirm")
    raw = handler({"transaction_id": "abc"})

    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert parsed["details"]["exception_class"] == "RuntimeError"


def test_build_request_handler_key_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P1.3 — `KeyError` (e.g. a future code path raises one) MUST route
    to `internal_error`, not a misleading `connection_not_ready`."""

    def raise_key(_coro: Any) -> Any:
        raise KeyError("missing-key")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_key)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert parsed["details"]["exception_class"] == "KeyError"


def test_build_request_handler_json_decode_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`json.JSONDecodeError` (from a malformed server response payload)
    is a data-validation issue, NOT a transport state issue. Route to
    `internal_error`."""

    def raise_json(_coro: Any) -> Any:
        # JSONDecodeError requires (msg, doc, pos).
        raise json.JSONDecodeError("malformed", "garbage", 0)

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_json)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert parsed["details"]["exception_class"] == "JSONDecodeError"


# ── build_request_handler — transport errors stay connection_not_ready ─


def test_build_request_handler_connection_error_returns_connection_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Genuine transport errors (`ConnectionError`) keep mapping to
    `connection_not_ready` with the `klodi_setup_status` recovery hint.
    R6 — read-only tools share the envelope contract."""

    def raise_conn(_coro: Any) -> Any:
        raise ConnectionError("NATS-WS dropped")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_conn)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"
    hint = parsed["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "tool"
    assert hint["tool"] == "klodi_setup_status"


def test_build_request_handler_asyncio_timeout_returns_connection_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`asyncio.TimeoutError` is a transport-state issue — the upstream
    didn't respond in time. Maps to `connection_not_ready`."""

    def raise_timeout(_coro: Any) -> Any:
        raise asyncio.TimeoutError()

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_timeout)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"


# ── build_request_handler — creds guard fires BEFORE I/O (R4) ────────


def test_build_request_handler_without_creds_returns_not_registered_before_client(
    monkeypatch: pytest.MonkeyPatch,
    _klodi_home_unset: Path,
) -> None:
    """R4 — when creds are missing, the handler MUST short-circuit BEFORE
    calling `get_client()`. The agent sees `not_registered` with the
    per-host CLI in the recovery hint (R8).

    Side-effect freedom: if guards run before I/O, no get_client call
    happens. We verify by replacing get_client with a sentinel that
    panics on call.
    """
    called: list[Any] = []

    def get_client_should_not_be_called() -> Any:
        called.append("get_client_was_called")
        raise AssertionError(
            "guard_creds MUST short-circuit BEFORE get_client() is called (R4)"
        )

    monkeypatch.setattr(hermes_tools, "get_client", get_client_should_not_be_called)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert parsed["error"] == "not_registered"
    assert called == [], "get_client must NOT be invoked when creds are absent"
    hint = parsed["recovery_hint"]
    assert hint is not None
    assert hint["kind"] == "cli"
    # R8 — per-host CLI is substituted into the recovery hint.
    assert hint["command"] == "klodi-hermes-register"


# ── handle_channel_message — mirrors the same contract ───────────────


def test_handle_channel_message_without_creds_returns_not_registered(
    monkeypatch: pytest.MonkeyPatch,
    _klodi_home_unset: Path,
) -> None:
    """R4 — the channel-message direct-publish path also fails behind
    the creds guard before any I/O."""

    def get_client_panic() -> Any:
        raise AssertionError("guard must fire before get_client()")

    monkeypatch.setattr(hermes_tools, "get_client", get_client_panic)

    raw = hermes_tools.handle_channel_message({
        "channel_id": "550e8400-e29b-41d4-a716-446655440000",
        "content": "hi",
    })

    parsed = json.loads(raw)
    assert parsed["error"] == "not_registered"
    assert parsed["recovery_hint"]["kind"] == "cli"
    assert parsed["recovery_hint"]["command"] == "klodi-hermes-register"


def test_handle_channel_message_missing_channel_id_returns_invalid_request() -> None:
    """Arg-shape rejection produces `invalid_request` with structured
    details, identical to the Rust + nanobot paths (R1 parity)."""
    raw = hermes_tools.handle_channel_message({"content": "hi"})
    parsed = json.loads(raw)
    assert parsed["error"] == "invalid_request"
    assert parsed["details"]["field"] == "channel_id"
    assert parsed["details"]["problem"] == "missing"
    assert parsed["recovery_hint"] is None


def test_handle_channel_message_empty_content_returns_invalid_request() -> None:
    """Empty content is a distinct failure from missing — R2 specifies
    `problem: "empty"`. The agent reads `details.problem` to decide."""
    raw = hermes_tools.handle_channel_message({
        "channel_id": "550e8400-e29b-41d4-a716-446655440000",
        "content": "",
    })
    parsed = json.loads(raw)
    assert parsed["error"] == "invalid_request"
    assert parsed["details"]["field"] == "content"
    assert parsed["details"]["problem"] == "empty"


def test_handle_channel_message_runtime_error_returns_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P1.3 mirror — a non-connection exception in the channel-publish
    path also routes to `internal_error`, NOT `connection_not_ready`."""

    def raise_runtime(_coro: Any) -> Any:
        raise RuntimeError("unexpected publish failure")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_runtime)

    raw = hermes_tools.handle_channel_message({
        "channel_id": "550e8400-e29b-41d4-a716-446655440000",
        "content": "hi",
    })

    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert parsed["details"]["exception_class"] == "RuntimeError"


def test_handle_channel_message_connection_error_returns_connection_not_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Transport errors keep mapping to `connection_not_ready`."""

    def raise_conn(_coro: Any) -> Any:
        raise ConnectionError("WS dropped")

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_conn)

    raw = hermes_tools.handle_channel_message({
        "channel_id": "550e8400-e29b-41d4-a716-446655440000",
        "content": "hi",
    })

    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"


# ── build_request_handler — every error path returns the four-key envelope (R1) ─


@pytest.mark.parametrize(
    "exception",
    [
        ValueError("value"),
        RuntimeError("runtime"),
        KeyError("key"),
        TypeError("type"),
    ],
)
def test_build_request_handler_every_internal_error_carries_four_envelope_keys(
    monkeypatch: pytest.MonkeyPatch,
    exception: BaseException,
) -> None:
    """R1 — every envelope carries exactly four keys, even when
    `details` / `recovery_hint` collapse to null."""

    def raise_it(_coro: Any) -> Any:
        raise exception

    monkeypatch.setattr(hermes_tools, "get_client", lambda: MagicMock())
    monkeypatch.setattr(hermes_tools, "run_async", raise_it)

    handler = hermes_tools.build_request_handler("klodi_whoami")
    raw = handler({})

    parsed = json.loads(raw)
    assert _envelope_keys(parsed) == {"error", "message", "details", "recovery_hint"}


def test_build_request_handler_rejects_unknown_tool() -> None:
    """Build-time check — `build_request_handler` raises `KeyError` if
    the tool name is not in the catalog. (Defensive; the runtime caller
    looks up in TOOL_SCHEMAS.)"""
    with pytest.raises(KeyError):
        hermes_tools.build_request_handler("klodi_does_not_exist")


# ── client.py singleton cleanup between tests ────────────────────────


@pytest.fixture(autouse=True)
def _reset_singleton() -> None:
    """Wipe the module-level KlodiClient between tests so each test's
    monkeypatched `get_client` is the only one in scope."""
    yield
    hermes_client._CLIENT = None  # type: ignore[attr-defined]
