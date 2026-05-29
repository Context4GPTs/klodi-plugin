"""Cross-language search-payload parity — nanobot consumer (RED).

Loads ``packages/tool-catalog/tests/fixtures/search-payload-golden.json``
and asserts that every input case dispatched through nanobot's
``klodi_search`` / ``klodi_searches_create`` paths reaches
``client.request(subject, payload)`` with a payload byte-equal to the
fixture's ``expected_wire_payload``.

This is the SC-parity.{1,2} acceptance gate at the per-stack level for
nanobot.

Why this gate exists even though nanobot's dispatch path
(``adapters/nanobot/nanobot_tools.py:118``) passes ``args`` raw to
``client.request(schema['subject'], args)``: the architectural risk
the architect flagged in discovery is *cross-stack drift*. Today
nanobot is conformant; the gate is the lock that prevents a future
adapter-side transform (compaction, normalisation, default-filling)
from silently introducing the openclaw-style divergence here.

A note on the ``klodi_watch`` composite: nanobot's ``handle_watch``
(in ``nanobot_local_tools.py``) does construct the searches.create
payload differently from a direct ``klodi_searches_create`` invocation
— it generates the slug, defaults delivery. Per the architect's
discovery handoff, this fixture exercises the catalog tool DIRECTLY,
NOT the composite — agents calling ``klodi_searches_create`` always
supply ``slug`` themselves.

Per the ``adversarial-testing`` skill: NEVER weaken these asserts to
make a stack pass. The fixture IS the spec; the implementation must
match the spec.

See ADR-0011 (envelope golden) for the cross-language fixture
precedent and the card body for SC-parity.{1,2}.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

import nanobot_client as nanobot_client_mod
import nanobot_tools as nanobot_tools

# ── Fixture loading ──────────────────────────────────────────────────


def _fixture_path() -> Path:
    """Resolve the shared search-payload-golden fixture.

    nanobot lives at ``adapters/nanobot/`` (no nested ``src``), so we
    go up two from ``adapters/nanobot/tests/`` to reach the repo root.
    """
    here = Path(__file__).resolve().parent
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
    """Seed ${KLODI_HOME} so the R4 creds guard inside
    ``nanobot_tools.handle`` passes through to ``call_tool`` (where
    the request hits ``client.request``).
    """
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    (tmp_path / "nats.creds").write_text("fake-creds")
    (tmp_path / "config.json").write_text("{}")
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_client_singleton() -> None:
    """Wipe ``nanobot_client._CLIENT`` between tests so each test's
    monkeypatched client is the only resolver in scope.
    """
    yield
    nanobot_client_mod._CLIENT = None  # type: ignore[attr-defined]


def _make_capture_client() -> tuple[Any, dict[str, Any]]:
    """Return a (fake_client, captured) pair.

    ``fake_client.request`` is an ``AsyncMock`` whose side-effect
    records the subject + payload into ``captured`` for end-of-test
    assertions, then returns a benign response so the dispatcher
    completes cleanly.
    """
    captured: dict[str, Any] = {}
    fake_client = MagicMock()

    async def capture(subject: str, payload: dict[str, Any]) -> dict[str, Any]:
        captured["subject"] = subject
        captured["payload"] = payload
        # Minimal valid response shape for both subjects. The handler
        # serialises whatever we return — we never assert on it.
        if subject == SEARCH_SUBJECT:
            return {"results": [], "total": 0}
        if subject == SEARCHES_CREATE_SUBJECT:
            return {
                "search_id": "550e8400-e29b-41d4-a716-446655440000",
                "slug": payload.get("slug"),
                "status": "active",
                "criteria": {
                    "query": payload.get("query"),
                    "category": payload.get("category"),
                    "delivery": payload.get("delivery", {"method": "any"}),
                    "min_price": payload.get("min_price"),
                    "max_price": payload.get("max_price"),
                },
            }
        return {}

    fake_client.request = AsyncMock(side_effect=capture)
    return fake_client, captured


# ── klodi_search — per-case payload-equality (SC-parity.1) ───────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case_name,case_entry",
    _SEARCH_CASES,
    ids=[name for name, _ in _SEARCH_CASES],
)
async def test_klodi_search_payload_parity(
    case_name: str,
    case_entry: dict[str, Any],
) -> None:
    """Drive ``nanobot_tools.handle('klodi_search', input)`` and assert
    the captured ``client.request`` call carries the spec payload.

    nanobot's ``handle`` runs R4 creds guard → ``call_tool(name, args)``
    → ``client.request(catalog_subject, args)``. The args travel
    verbatim from ``handle``'s caller to ``client.request``.
    """
    fake_client, captured = _make_capture_client()
    nanobot_client_mod.set_client(fake_client)

    raw = await nanobot_tools.handle("klodi_search", case_entry["input"])

    # Decode — surface envelope-mode failures so we don't silently treat
    # a guard-rejection envelope as a "no call" signal.
    parsed = json.loads(raw)
    assert "error" not in parsed, (
        f"{case_name}: nanobot returned a failure envelope —"
        f" payload-capture path was not reached. parsed={parsed!r}"
    )

    assert captured.get("subject") == SEARCH_SUBJECT, (
        f"{case_name}: nanobot routed to {captured.get('subject')!r}"
        f" — expected {SEARCH_SUBJECT!r}"
    )
    assert captured.get("payload") == case_entry["expected_wire_payload"], (
        f"{case_name}: nanobot forwarded a payload that diverges from the spec."
        f" Expected: {json.dumps(case_entry['expected_wire_payload'])}."
        f" Got: {json.dumps(captured.get('payload'))}."
        f" The fixture IS the contract — fix the implementation, never this"
        f" assertion. See ADR-0011 and the card body's SC-parity.1."
    )


# ── klodi_searches_create — per-case payload-equality (SC-parity.2) ──


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case_name,case_entry",
    _SEARCHES_CREATE_CASES,
    ids=[name for name, _ in _SEARCHES_CREATE_CASES],
)
async def test_klodi_searches_create_payload_parity(
    case_name: str,
    case_entry: dict[str, Any],
) -> None:
    """Same shape as the search test, but pinned to
    ``p2p.v1.searches.create``. Verifies nanobot routes the catalog
    tool through ``call_tool`` (not the ``klodi_watch`` composite) and
    forwards the agent's input verbatim.
    """
    fake_client, captured = _make_capture_client()
    nanobot_client_mod.set_client(fake_client)

    raw = await nanobot_tools.handle("klodi_searches_create", case_entry["input"])

    parsed = json.loads(raw)
    assert "error" not in parsed, (
        f"{case_name}: nanobot returned a failure envelope —"
        f" payload-capture path was not reached. parsed={parsed!r}"
    )

    assert captured.get("subject") == SEARCHES_CREATE_SUBJECT, (
        f"{case_name}: nanobot routed to {captured.get('subject')!r}"
        f" — expected {SEARCHES_CREATE_SUBJECT!r}"
    )
    assert captured.get("payload") == case_entry["expected_wire_payload"], (
        f"{case_name}: nanobot forwarded a payload that diverges from the spec."
        f" Expected: {json.dumps(case_entry['expected_wire_payload'])}."
        f" Got: {json.dumps(captured.get('payload'))}."
        f" See ADR-0011 and SC-parity.2."
    )


# ── SC-contract.3 — per-adapter schema equivalence ───────────────────


def test_nanobot_klodi_search_in_definitions() -> None:
    """nanobot's ``TOOL_DEFINITIONS`` MUST include ``klodi_search`` with
    the canonical catalog parameter shape — agents look up the tool by
    name in the OpenAI-function-shaped definitions.
    """
    by_name = {t["name"]: t for t in nanobot_tools.TOOL_DEFINITIONS}
    assert "klodi_search" in by_name, (
        "nanobot dropped klodi_search from TOOL_DEFINITIONS — agents would"
        " never discover the search path. SC-contract.3 violation."
    )
    entry = by_name["klodi_search"]
    assert entry["parameters"]["type"] == "object"
    props = entry["parameters"].get("properties", {})
    for k in (
        "query", "category", "min_price", "max_price",
        "delivery", "condition", "limit", "cursor",
    ):
        assert k in props, (
            f"nanobot klodi_search.params dropped {k!r} — breaking change"
        )


def test_nanobot_klodi_searches_create_in_definitions() -> None:
    """nanobot must expose ``klodi_searches_create`` directly — not just
    via the ``klodi_watch`` composite — so the single-entry-point
    invariant (SC-entry.1) holds across the agent surface.
    """
    by_name = {t["name"]: t for t in nanobot_tools.TOOL_DEFINITIONS}
    assert "klodi_searches_create" in by_name, (
        "nanobot dropped klodi_searches_create from TOOL_DEFINITIONS —"
        " agents calling the standing-search registration directly would"
        " see no such tool. SC-contract.3 violation."
    )
    entry = by_name["klodi_searches_create"]
    assert entry["parameters"]["type"] == "object"
    props = entry["parameters"].get("properties", {})
    for k in (
        "slug", "query", "category", "min_price", "max_price", "delivery",
    ):
        assert k in props, (
            f"nanobot klodi_searches_create.params dropped {k!r}"
        )
    required = entry["parameters"].get("required", [])
    assert "slug" in required, (
        "klodi_searches_create.params.slug demoted from required —"
        " every standing-search needs a client-chosen slug (last-write-wins)"
    )
