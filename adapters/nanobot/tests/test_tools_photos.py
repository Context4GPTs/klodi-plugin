"""Tests for the photo-resolution pipeline folded into klodi_list_create
and klodi_list_update for the nanobot adapter.

The card "fold-uploads-into-listing-tools" replaces the standalone
``klodi_assets_upload_url`` tool with adapter-internal handling. nanobot
dispatches through ``nanobot_tools.handle(name, args)``; that
dispatcher must intercept ``klodi_list_create`` and ``klodi_list_update``
before delegating to ``call_tool`` so the photo-resolution helper can
validate paths, sniff content types, mint via NATS, PUT bytes to R2,
and substitute asset_urls before the listing request hits the
marketplace.

These tests stay RED until the developer:
  1. Removes ``klodi_assets_upload_url`` from the canonical catalog
     (and re-runs codegen + vendoring), so TOOL_SCHEMAS drops it.
  2. Adds the photo-resolution helper into nanobot's dispatch path.
"""

from __future__ import annotations

import asyncio
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

import nanobot_client as client
import nanobot_tools as tools
from klodi_nats_client import TOOL_SCHEMAS


# ── Magic-number fixtures ────────────────────────────────────────────


JPEG_MAGIC = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
WEBP_MAGIC = bytes(
    [
        0x52, 0x49, 0x46, 0x46,
        0x24, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50,
    ]
)
PDF_MAGIC = bytes([0x25, 0x50, 0x44, 0x46])

LISTING_ID = "550e8400-e29b-41d4-a716-446655440000"


# ── Catalog removal contract ─────────────────────────────────────────


def test_klodi_assets_upload_url_removed_from_tool_schemas() -> None:
    assert "klodi_assets_upload_url" not in TOOL_SCHEMAS


def test_no_schema_routes_to_the_removed_subject() -> None:
    for name, schema in TOOL_SCHEMAS.items():
        assert schema["subject"] != "p2p.v1.assets.upload-url", (
            f"Tool {name} still routes to the removed subject"
        )


def test_tool_definitions_do_not_advertise_the_removed_tool() -> None:
    """nanobot's TOOL_DEFINITIONS is what the host wires into the
    OpenAI / native-function decorator. The deleted tool must not be in
    the agent-discoverable surface.
    """
    names = {entry["name"] for entry in tools.TOOL_DEFINITIONS}
    assert "klodi_assets_upload_url" not in names


def test_publish_and_local_tools_frozensets_do_not_reference_removed() -> None:
    """Confidence check: the publish + local frozensets don't accidentally
    name the removed tool (they don't today, but pin it).
    """
    assert "klodi_assets_upload_url" not in tools._PUBLISH_TOOLS
    assert "klodi_assets_upload_url" not in tools._LOCAL_TOOLS


# ── Fixtures ─────────────────────────────────────────────────────────


def _make_fake_client() -> MagicMock:
    fake = MagicMock()
    fake.request = AsyncMock(return_value={})
    fake.publish_channel_message = AsyncMock()
    return fake


@pytest.fixture(autouse=True)
def _reset_singleton() -> None:
    client._CLIENT = None  # type: ignore[attr-defined]


@pytest.fixture
def fake_client() -> MagicMock:
    fake = _make_fake_client()
    client.set_client(fake)
    return fake


@pytest.fixture
def fixtures_dir(tmp_path: Path) -> Path:
    d = tmp_path / "fixtures"
    d.mkdir()
    return d


def _write(dirpath: Path, name: str, payload: bytes) -> str:
    p = dirpath / name
    p.write_bytes(payload)
    return str(p)


async def _handle(name: str, args: dict[str, Any]) -> dict[str, Any]:
    raw = await tools.handle(name, args)
    return json.loads(raw)


# ── Path validation — unit ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_klodi_list_create_rejects_non_absolute_path(
    fake_client: MagicMock,
) -> None:
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": ["./img.jpg"],
        },
    )
    assert envelope.get("error"), f"expected error envelope, got {envelope!r}"
    msg = (envelope.get("message") or "").lower()
    assert "absolute" in msg
    assert "./img.jpg" in (envelope.get("message") or "")
    fake_client.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_klodi_list_create_rejects_missing_path(
    fake_client: MagicMock,
) -> None:
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": ["/tmp/this-file-does-not-exist-987654.jpg"],
        },
    )
    assert envelope.get("error")
    assert "/tmp/this-file-does-not-exist-987654.jpg" in (
        envelope.get("message") or ""
    )
    fake_client.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_klodi_list_create_rejects_wrong_content_type(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    pdf = _write(fixtures_dir, "doc.pdf", PDF_MAGIC)
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [pdf],
        },
    )
    assert envelope.get("error")
    assert pdf in (envelope.get("message") or "")
    fake_client.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_klodi_list_create_rejects_oversize_file(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    big = bytearray(10 * 1024 * 1024 + 1)
    big[: len(JPEG_MAGIC)] = JPEG_MAGIC
    path = _write(fixtures_dir, "huge.jpg", bytes(big))
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [path],
        },
    )
    assert envelope.get("error")
    msg = envelope.get("message") or ""
    assert path in msg
    assert ("10" in msg) or ("ten" in msg.lower())
    fake_client.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_klodi_list_create_rejects_more_than_ten_photos(
    fake_client: MagicMock,
) -> None:
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [f"https://cdn.example/{i}.jpg" for i in range(11)],
        },
    )
    assert envelope.get("error")
    msg = envelope.get("message") or ""
    assert ("10" in msg) or ("ten" in msg.lower())
    fake_client.request.assert_not_awaited()


# ── URL pass-through — regression guard ──────────────────────────────


@pytest.mark.asyncio
async def test_klodi_list_create_passes_urls_verbatim_and_does_not_mint(
    fake_client: MagicMock,
) -> None:
    fake_client.request.return_value = {
        "listing_id": LISTING_ID,
        "photos": ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
    }
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [
                "https://cdn.example/a.jpg",
                "https://cdn.example/b.jpg",
            ],
        },
    )
    assert envelope.get("listing_id") == LISTING_ID
    assert fake_client.request.await_count == 1
    subject = fake_client.request.await_args.args[0]
    assert subject == "p2p.v1.listings.create"


@pytest.mark.asyncio
async def test_klodi_list_create_is_a_no_op_when_photos_absent(
    fake_client: MagicMock,
) -> None:
    fake_client.request.return_value = {"listing_id": LISTING_ID}
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "digital"}],
        },
    )
    assert envelope.get("listing_id") == LISTING_ID
    assert fake_client.request.await_count == 1
    assert fake_client.request.await_args.args[0] == "p2p.v1.listings.create"


# ── Happy path — single local ────────────────────────────────────────


@pytest.mark.asyncio
async def test_klodi_list_create_uploads_one_local_jpeg_and_substitutes(
    fake_client: MagicMock,
    fixtures_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = _write(fixtures_dir, "img1.jpg", JPEG_MAGIC)

    async def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
        if subject == "p2p.v1.assets.upload-url":
            return {
                "uploads": [
                    {
                        "upload_url": "https://r2.example/up1?sig=abc",
                        "asset_url": "https://cdn.example/asset1.jpg",
                    },
                ],
            }
        if subject == "p2p.v1.listings.create":
            return {
                "listing_id": LISTING_ID,
                "photos": args.get("photos"),
            }
        raise AssertionError(f"Unexpected subject: {subject}")

    fake_client.request.side_effect = _mock_request

    put_calls: list[dict[str, Any]] = []

    # Patch urllib.request.urlopen — the most likely HTTP entry point.
    class _FakeResp:
        status = 200
        status_code = 200

        def read(self) -> bytes:
            return b""

        def __enter__(self) -> "_FakeResp":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    def _capture(req: Any, **kwargs: Any) -> _FakeResp:
        put_calls.append({
            "url": req.full_url if hasattr(req, "full_url") else str(req),
            "method": req.get_method() if hasattr(req, "get_method") else "PUT",
            "headers": dict(req.headers) if hasattr(req, "headers") else {},
            "data": req.data if hasattr(req, "data") else None,
        })
        return _FakeResp()

    import urllib.request as _urlreq
    monkeypatch.setattr(_urlreq, "urlopen", _capture)

    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [path],
        },
    )

    assert envelope.get("listing_id") == LISTING_ID
    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert subjects == [
        "p2p.v1.assets.upload-url",
        "p2p.v1.listings.create",
    ]
    create_args = fake_client.request.await_args_list[1].args[1]
    assert create_args["photos"] == ["https://cdn.example/asset1.jpg"]

    assert len(put_calls) == 1
    put = put_calls[0]
    assert put["url"] == "https://r2.example/up1?sig=abc"
    headers = {k.lower(): v for k, v in (put.get("headers") or {}).items()}
    assert headers.get("content-type") == "image/jpeg"


@pytest.mark.asyncio
async def test_klodi_list_create_preserves_order_across_mixed_array(
    fake_client: MagicMock,
    fixtures_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    local = _write(fixtures_dir, "middle.png", PNG_MAGIC)

    async def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
        if subject == "p2p.v1.assets.upload-url":
            return {
                "uploads": [
                    {
                        "upload_url": "https://r2.example/up-middle",
                        "asset_url": "https://cdn.example/asset-middle.png",
                    },
                ],
            }
        return {"listing_id": LISTING_ID, "photos": args.get("photos")}

    fake_client.request.side_effect = _mock_request

    import urllib.request as _urlreq

    class _Noop:
        status = 200

        def read(self) -> bytes:
            return b""

        def __enter__(self) -> "_Noop":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    monkeypatch.setattr(_urlreq, "urlopen", lambda *a, **k: _Noop())

    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [
                "https://cdn.example/keep.jpg",
                local,
                "https://cdn.example/keep2.webp",
            ],
        },
    )

    assert envelope.get("listing_id") == LISTING_ID
    create_args = fake_client.request.await_args_list[1].args[1]
    assert create_args["photos"] == [
        "https://cdn.example/keep.jpg",
        "https://cdn.example/asset-middle.png",
        "https://cdn.example/keep2.webp",
    ]


@pytest.mark.asyncio
async def test_klodi_list_update_uploads_local_and_substitutes(
    fake_client: MagicMock,
    fixtures_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = _write(fixtures_dir, "replacement.png", PNG_MAGIC)

    async def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
        if subject == "p2p.v1.assets.upload-url":
            return {
                "uploads": [
                    {
                        "upload_url": "https://r2.example/up-upd",
                        "asset_url": "https://cdn.example/replacement.png",
                    },
                ],
            }
        return {"listing_id": LISTING_ID, "photos": args.get("photos")}

    fake_client.request.side_effect = _mock_request

    import urllib.request as _urlreq

    class _Noop:
        status = 200

        def read(self) -> bytes:
            return b""

        def __enter__(self) -> "_Noop":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    monkeypatch.setattr(_urlreq, "urlopen", lambda *a, **k: _Noop())

    envelope = await _handle(
        "klodi_list_update",
        {"listing_id": LISTING_ID, "photos": [path]},
    )

    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert subjects == [
        "p2p.v1.assets.upload-url",
        "p2p.v1.listings.update",
    ]
    update_args = fake_client.request.await_args_list[1].args[1]
    assert update_args["photos"] == ["https://cdn.example/replacement.png"]


# ── Atomic failure ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_klodi_list_create_fails_atomic_on_one_bad_file_in_mixed_array(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    ok = _write(fixtures_dir, "ok.jpg", JPEG_MAGIC)
    pdf = _write(fixtures_dir, "doc.pdf", PDF_MAGIC)
    envelope = await _handle(
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [ok, pdf],
        },
    )
    assert envelope.get("error")
    assert pdf in (envelope.get("message") or "")
    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert "p2p.v1.listings.create" not in subjects
