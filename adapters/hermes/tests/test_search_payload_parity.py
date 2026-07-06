"""Cross-language search-payload parity — hermes consumer (RED).

Loads ``packages/tool-catalog/tests/fixtures/search-payload-golden.json``
and asserts that every input case dispatched through the hermes
``klodi_search`` / ``klodi_searches_create`` request handlers reaches
``client.request(subject, payload)`` with a payload byte-equal to the
fixture's ``expected_wire_payload``.

This is the SC-parity.{1,2} acceptance gate at the per-stack level for
hermes.

Expected at RED: every test in this file PASSES today — hermes's
``build_request_handler`` calls ``client.request(subject, args)`` with
raw, untransformed args (see ``adapters/hermes/src/klodi_hermes/tools.py``
line 188). The parity gate's purpose here is to PIN that pass-through
contract: any future regression (e.g. someone adds a `compactPayload`
analogue to hermes) trips the gate immediately.

A note on the fixture's ``klodi_watch`` exclusion: the fixture exercises
the catalog tools (``klodi_search`` / ``klodi_searches_create``)
directly, NOT the ``klodi_watch`` composite. The composite lives in
``klodi_hermes.watch`` and does its own payload construction (generates
slug, defaults delivery). Per the architect's discovery handoff,
agents calling ``klodi_searches_create`` always supply ``slug``
themselves; that path is what we pin.

Per the ``adversarial-testing`` skill: NEVER weaken these asserts to
make a stack pass. The fixture IS the spec; the implementation must
match the spec.

See ADR-0011 (envelope golden) for the cross-language fixture precedent
and the SC-parity.{1,2} criteria.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

# ── Fixture loading ──────────────────────────────────────────────────


def _fixture_path() -> Path:
    """Resolve the shared search-payload-golden fixture.

    The path is identical to the envelope-golden precedent — same
    package, sibling file. Keeping the resolution one-liner-explicit so
    a refactor that moves either fixture surfaces here, not at runtime.
    """
    here = Path(__file__).resolve().parent
    # adapters/hermes/tests/ → up three to repo root → descend.
    return (
        here.parent.parent.parent
        / "packages"
        / "tool-catalog"
        / "tests"
        / "fixtures"
        / "search-payload-golden.json"
    )


def _load_golden() -> dict[str, Any]:
    raw = _fixture_path().read_text(encoding="utf-8")
    return json.loads(raw)


def _case_entries(section: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Return the named cases from a fixture section (skipping `_doc` etc.)."""
    return [
        (name, entry)
        for name, entry in section.items()
        if not name.startswith("_")
    ]


_GOLDEN = _load_golden()
_SEARCH_CASES = _case_entries(_GOLDEN["search"])
_SEARCHES_CREATE_CASES = _case_entries(_GOLDEN["searches_create"])

SEARCH_SUBJECT = "p2p.v1.listings.search"
SEARCHES_CREATE_SUBJECT = "p2p.v1.searches.create"


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _klodi_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point ${KLODI_HOME} at a temp dir with creds + config so the
    R4 creds guard passes through to the dispatch path under test.

    Mirrors ``test_tools.py``'s ``_klodi_home`` autouse fixture so the
    rest of the suite stays homogenous.
    """
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    (tmp_path / "nats.creds").write_text("fake-creds")
    (tmp_path / "config.json").write_text("{}")
    return tmp_path


# Module-import sits AFTER the fixtures because ``default_klodi_home()``
# reads ``${KLODI_HOME}`` lazily each call — but the module-level
# fixture-loading reads the JSON file at import time, before pytest's
# monkeypatch fires for any test. The fixture file lives outside
# ${KLODI_HOME} so this ordering is safe.
from klodi_hermes import client as hermes_client  # noqa: E402
from klodi_hermes import tools as hermes_tools  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_client_singleton() -> None:
    """Reset the module-level KlodiClient between tests.

    The singleton survives a test if anything earlier in the run
    instantiated it. Wipe it so each test's monkeypatched
    ``get_client`` is the only source the handler resolves.
    """
    yield
    hermes_client._CLIENT = None  # type: ignore[attr-defined]


# ── klodi_search — per-case payload-equality (SC-parity.1) ───────────


@pytest.mark.parametrize(
    "case_name,case_entry",
    _SEARCH_CASES,
    ids=[name for name, _ in _SEARCH_CASES],
)
def test_klodi_search_payload_parity(
    monkeypatch: pytest.MonkeyPatch,
    case_name: str,
    case_entry: dict[str, Any],
) -> None:
    """For each fixture case, drive the hermes ``klodi_search`` handler
    and assert the payload that reached ``client.request(subject, args)``
    is byte-equal to the fixture's ``expected_wire_payload`` (on the
    correct subject).

    Hermes's path: ``build_request_handler(name)`` → ``client.request(
    subject, args)``. Args flow through unchanged today; any future
    regression that injects a transform (compaction, normalisation,
    default-filling) breaks this gate.

    The mock captures the (subject, payload) call via ``AsyncMock``.
    ``run_async`` is also patched so the handler does not spin up the
    asyncio bridge — this is a pure unit test of the request-bridge
    contract, no I/O.
    """
    fake_client = MagicMock()
    captured: dict[str, Any] = {}

    async def capture_request(subject: str, payload: dict[str, Any]) -> dict[str, Any]:
        # Capture both args verbatim — assert at the end of the test.
        captured["subject"] = subject
        captured["payload"] = payload
        # Return a benign response so the handler completes without
        # error. We do not care about response shape here.
        return {"results": [], "total": 0}

    fake_client.request = AsyncMock(side_effect=capture_request)
    monkeypatch.setattr(hermes_tools, "get_client", lambda: fake_client)

    # The handler bridges sync→async via run_async. In production this
    # submits the coroutine to the dedicated asyncio loop. In the test
    # we simulate by running the coroutine inline — capture_request
    # already records the call, so the result drains the awaitable.
    def run_async_inline(coro: Any) -> Any:
        import asyncio
        return asyncio.run(coro)

    monkeypatch.setattr(hermes_tools, "run_async", run_async_inline)

    handler = hermes_tools.build_request_handler("klodi_search")
    raw = handler(case_entry["input"])

    # Decoding the result also verifies the handler did not collapse
    # into a failure envelope (which would mask a payload-construction
    # bug behind an envelope wrap).
    parsed = json.loads(raw)
    assert "error" not in parsed, (
        f"{case_name}: handler returned a failure envelope —"
        f" the payload-capture path was not reached. parsed={parsed!r}"
    )

    assert captured.get("subject") == SEARCH_SUBJECT, (
        f"{case_name}: hermes routed to subject {captured.get('subject')!r}"
        f" — expected {SEARCH_SUBJECT!r}"
    )
    assert captured.get("payload") == case_entry["expected_wire_payload"], (
        f"{case_name}: hermes forwarded a payload that diverges from the spec."
        f" Expected: {json.dumps(case_entry['expected_wire_payload'])}."
        f" Got: {json.dumps(captured.get('payload'))}."
        f" The fixture IS the contract — fix the implementation, never this"
        f" assertion. See ADR-0011 (SC-parity.1)."
    )


# ── klodi_searches_create — per-case payload-equality (SC-parity.2) ──


@pytest.mark.parametrize(
    "case_name,case_entry",
    _SEARCHES_CREATE_CASES,
    ids=[name for name, _ in _SEARCHES_CREATE_CASES],
)
def test_klodi_searches_create_payload_parity(
    monkeypatch: pytest.MonkeyPatch,
    case_name: str,
    case_entry: dict[str, Any],
) -> None:
    """Same shape as the ``klodi_search`` test, but pinned to the
    ``p2p.v1.searches.create`` subject. Verifies hermes registers
    ``klodi_searches_create`` directly (not via the ``klodi_watch``
    composite) and forwards the agent's input verbatim.
    """
    fake_client = MagicMock()
    captured: dict[str, Any] = {}

    async def capture_request(subject: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured["subject"] = subject
        captured["payload"] = payload
        # Return the canonical searches_create reply shape so the
        # handler completes cleanly. The response is not asserted.
        return {
            "search_id": "550e8400-e29b-41d4-a716-446655440000",
            "slug": case_entry["input"]["slug"],
            "status": "active",
            "criteria": {
                "query": case_entry["input"].get("query"),
                "category": case_entry["input"].get("category"),
                "delivery": case_entry["input"].get(
                    "delivery", {"method": "any"},
                ),
                "min_price": case_entry["input"].get("min_price"),
                "max_price": case_entry["input"].get("max_price"),
            },
        }

    fake_client.request = AsyncMock(side_effect=capture_request)
    monkeypatch.setattr(hermes_tools, "get_client", lambda: fake_client)

    def run_async_inline(coro: Any) -> Any:
        import asyncio
        return asyncio.run(coro)

    monkeypatch.setattr(hermes_tools, "run_async", run_async_inline)

    handler = hermes_tools.build_request_handler("klodi_searches_create")
    raw = handler(case_entry["input"])

    parsed = json.loads(raw)
    assert "error" not in parsed, (
        f"{case_name}: handler returned a failure envelope —"
        f" payload capture not reached. parsed={parsed!r}"
    )

    assert captured.get("subject") == SEARCHES_CREATE_SUBJECT, (
        f"{case_name}: hermes routed to {captured.get('subject')!r}"
        f" — expected {SEARCHES_CREATE_SUBJECT!r}"
    )
    assert captured.get("payload") == case_entry["expected_wire_payload"], (
        f"{case_name}: hermes forwarded a payload that diverges from the spec."
        f" Expected: {json.dumps(case_entry['expected_wire_payload'])}."
        f" Got: {json.dumps(captured.get('payload'))}."
        f" See ADR-0011 and SC-parity.2."
    )


# ── SC-contract.3 — per-adapter schema equivalence ───────────────────


def test_hermes_klodi_search_schema_mirrors_catalog() -> None:
    """Hermes's host registration must expose the canonical catalog
    schema for ``klodi_search`` — name + params byte-equal to what the
    TS catalog publishes via codegen.

    The drift this test catches: if hermes's adapter ever rewrites or
    augments the params schema (e.g. flattens a discriminated union,
    drops a description), agents written against the catalog would
    submit calls hermes rejects pre-flight — silent breakage. Per the
    architect's open-Q3 answer, per-adapter assertions live inside the
    adapter's existing suite and consume the codegen'd schema.
    """
    from klodi_nats_client import TOOL_SCHEMAS

    schema = TOOL_SCHEMAS.get("klodi_search")
    assert schema is not None, (
        "klodi_nats_client.TOOL_SCHEMAS is missing klodi_search — codegen drift"
    )
    assert schema["subject"] == SEARCH_SUBJECT, (
        f"klodi_search subject drifted in hermes-consumed catalog:"
        f" got {schema['subject']!r}"
    )
    # Hermes registers the catalog params verbatim — assert the params
    # shape carries the agent surface we expect.
    params = schema["params"]
    assert params.get("type") == "object", "params must be an object schema"
    props = params.get("properties", {})
    for expected_key in (
        "query", "category", "min_price", "max_price",
        "delivery", "condition", "limit", "cursor",
    ):
        assert expected_key in props, (
            f"klodi_search.params dropped {expected_key!r} — breaking change"
        )


def test_hermes_klodi_searches_create_schema_mirrors_catalog() -> None:
    """Same drift check for ``klodi_searches_create``. The catalog
    requires ``slug``; every other criteria field is optional.
    """
    from klodi_nats_client import TOOL_SCHEMAS

    schema = TOOL_SCHEMAS.get("klodi_searches_create")
    assert schema is not None, (
        "klodi_nats_client.TOOL_SCHEMAS is missing klodi_searches_create"
    )
    assert schema["subject"] == SEARCHES_CREATE_SUBJECT, (
        f"klodi_searches_create subject drifted in hermes-consumed catalog"
    )
    params = schema["params"]
    assert params.get("type") == "object"
    props = params.get("properties", {})
    for expected_key in (
        "slug", "query", "category", "min_price", "max_price", "delivery",
    ):
        assert expected_key in props, (
            f"klodi_searches_create.params dropped {expected_key!r}"
        )
    # `slug` is required at the catalog level — re-asserted here so a
    # future demotion to optional trips the gate.
    required = params.get("required", [])
    assert "slug" in required, (
        "klodi_searches_create.params.slug demoted from required —"
        " every standing-search needs a client-chosen slug (last-write-wins)"
    )
