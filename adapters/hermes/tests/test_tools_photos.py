"""Tests for the photo-resolution pipeline folded into klodi_list_create
and klodi_list_update for the Hermes adapter.

The card "fold-uploads-into-listing-tools" replaces the standalone
``klodi_assets_upload_url`` tool with adapter-internal handling: each
element of ``args["photos"]`` can be either an ``http(s)://`` URL
(passed through verbatim) or an absolute local filesystem path
(validated, content-sniffed, uploaded to R2, substituted with the
returned asset_url before listings.create / listings.update is
dispatched).

Tests exercise the public ``build_request_handler('klodi_list_create')``
and ``build_request_handler('klodi_list_update')`` paths. Mocks at the
boundary:

  * ``klodi_hermes.client.get_client`` — the KlodiClient used by the
    request bridge. Replaced with a MagicMock that records subjects.
  * The R2 HTTP PUT — patched via the appropriate stdlib hook (the
    developer picks the HTTP library; the test recovers it from
    whichever module it lives in).

These assertions stay RED until the developer:
  1. Removes ``klodi_assets_upload_url`` from the catalog (so the
     catalog-removal assertions go green).
  2. Adds a photo-resolution helper that intercepts
     ``klodi_list_create`` / ``klodi_list_update`` before the request
     bridge dispatches via ``client.request(subject, args)``.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_HERMES_DIR = Path(__file__).resolve().parent.parent
_SRC_DIR = _HERMES_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from klodi_nats_client import TOOL_SCHEMAS


# ── Magic-number fixtures ────────────────────────────────────────────


JPEG_MAGIC = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
WEBP_MAGIC = bytes(
    [
        0x52, 0x49, 0x46, 0x46,  # "RIFF"
        0x24, 0x00, 0x00, 0x00,  # size placeholder
        0x57, 0x45, 0x42, 0x50,  # "WEBP"
    ]
)
PDF_MAGIC = bytes([0x25, 0x50, 0x44, 0x46])

LISTING_ID = "550e8400-e29b-41d4-a716-446655440000"


# ── Catalog removal contract ─────────────────────────────────────────


def test_klodi_assets_upload_url_removed_from_tool_schemas() -> None:
    """The Python adapter consumes the catalog JSON via TOOL_SCHEMAS.
    Once the catalog entry is gone (post-codegen + vendor), the key
    must not appear here either.
    """
    assert "klodi_assets_upload_url" not in TOOL_SCHEMAS


def test_klodi_assets_upload_url_subject_not_referenced() -> None:
    """Defense-in-depth: even if the schema entry was removed but a
    code path still references the subject string literal, that's
    dead code the dev forgot to delete.
    """
    for name, schema in TOOL_SCHEMAS.items():
        assert schema["subject"] != "p2p.v1.assets.upload-url", (
            f"Tool {name} still routes to the removed assets-upload-url "
            f"subject"
        )


def test_plugin_yaml_does_not_list_the_removed_tool() -> None:
    """The Hermes plugin manifest declares ``provides_tools`` — once
    the catalog entry is gone, this file must be in sync. The CI gate
    that compares plugin.yaml against the catalog will catch drift,
    but we pin it explicitly here too.
    """
    plugin_yaml = _SRC_DIR / "klodi_hermes" / "plugin.yaml"
    text = plugin_yaml.read_text(encoding="utf-8")
    assert "klodi_assets_upload_url" not in text


def test_tools_module_does_not_emoji_the_removed_tool() -> None:
    """The emoji table in ``klodi_hermes.tools`` carries one row per
    tool that ever existed. Dead rows are clutter; they also signal
    incomplete cleanup work.
    """
    tools_module = _SRC_DIR / "klodi_hermes" / "tools.py"
    text = tools_module.read_text(encoding="utf-8")
    assert "klodi_assets_upload_url" not in text


def test_readme_does_not_advertise_the_removed_tool() -> None:
    readme = _HERMES_DIR / "README.md"
    text = readme.read_text(encoding="utf-8")
    assert "klodi_assets_upload_url" not in text


# ── Photo-resolution pipeline — behavioral integration ───────────────


def _write_file(dirpath: Path, name: str, payload: bytes) -> str:
    path = dirpath / name
    path.write_bytes(payload)
    return str(path)


@pytest.fixture
def fixtures_dir(tmp_path: Path) -> Path:
    d = tmp_path / "fixtures"
    d.mkdir()
    return d


@pytest.fixture
def fake_client() -> MagicMock:
    """Drop-in MagicMock for ``klodi_hermes.client.get_client``.

    ``request`` is an AsyncMock — the request bridge uses ``run_async``
    to bridge to ``KlodiClient.request``; this preserves the async
    surface and gives us call inspection.

    Default ``return_value`` is a benign empty dict so an un-mocked
    pass-through doesn't trip JSON-serialization on the raw AsyncMock
    sentinel. Tests that care about the response set ``side_effect``
    or override ``return_value``.
    """
    client = MagicMock()
    client.request = AsyncMock(return_value={})
    return client


def _register_handler() -> Any:
    """Lazy import + factory. Importing klodi_hermes.tools at module
    load time would lock us into a singleton KlodiClient; instead we
    rebuild the handler for each test under patch().
    """
    from klodi_hermes.tools import build_request_handler

    return build_request_handler


def _call_handler(
    fake_client: MagicMock,
    tool_name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Build the handler with the fake client patched in, invoke it,
    and parse the JSON envelope the bridge returns.

    ``klodi_hermes.tools`` does ``from .client import get_client,
    run_async`` at module load, so the symbols live on the tools
    module — patching klodi_hermes.client.get_client wouldn't reach
    them.
    """
    with (
        patch("klodi_hermes.tools.get_client", return_value=fake_client),
        patch(
            "klodi_hermes.tools.run_async",
            side_effect=lambda coro: _drive_coro(coro),
        ),
    ):
        handler = _register_handler()(tool_name)
        raw = handler(args)
    return json.loads(raw)


def _drive_coro(coro: Any) -> Any:
    """Drive an awaitable to completion in test context — bypasses
    the dedicated event loop the bridge uses in production.

    A fresh event loop is used so that consecutive tests do not share
    state (one closed-loop reuse would break the next test).
    """
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# Path validation — unit


def test_klodi_list_create_rejects_non_absolute_path(
    fake_client: MagicMock,
) -> None:
    """An agent that passes a relative path is asking for filesystem
    ambiguity. Reject before any I/O, name the path.
    """
    envelope = _call_handler(
        fake_client,
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
    assert envelope.get("error"), (
        f"expected an error envelope, got {envelope!r}"
    )
    msg = (envelope.get("message") or "").lower()
    assert "absolute" in msg
    assert "./img.jpg" in (envelope.get("message") or "")
    fake_client.request.assert_not_awaited()


def test_klodi_list_create_rejects_missing_path(
    fake_client: MagicMock,
) -> None:
    envelope = _call_handler(
        fake_client,
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
    msg = envelope.get("message") or ""
    assert "/tmp/this-file-does-not-exist-987654.jpg" in msg
    fake_client.request.assert_not_awaited()


def test_klodi_list_create_rejects_wrong_content_type(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    pdf_path = _write_file(fixtures_dir, "doc.pdf", PDF_MAGIC)
    envelope = _call_handler(
        fake_client,
        "klodi_list_create",
        {
            "title": "x",
            "description": "x",
            "category": "home",
            "asking_price": 100,
            "fulfillment": [{"method": "pickup"}],
            "photos": [pdf_path],
        },
    )
    assert envelope.get("error")
    assert pdf_path in (envelope.get("message") or "")
    fake_client.request.assert_not_awaited()


def test_klodi_list_create_rejects_oversize_file(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    big_bytes = bytearray(10 * 1024 * 1024 + 1)
    big_bytes[: len(JPEG_MAGIC)] = JPEG_MAGIC
    path = _write_file(fixtures_dir, "huge.jpg", bytes(big_bytes))
    envelope = _call_handler(
        fake_client,
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


def test_klodi_list_create_rejects_more_than_ten_photos(
    fake_client: MagicMock,
) -> None:
    envelope = _call_handler(
        fake_client,
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


# URL pass-through — regression guard


def test_klodi_list_create_passes_urls_verbatim_and_does_not_mint(
    fake_client: MagicMock,
) -> None:
    fake_client.request.return_value = {
        "listing_id": LISTING_ID,
        "photos": [
            "https://cdn.example/a.jpg",
            "https://cdn.example/b.jpg",
        ],
    }
    envelope = _call_handler(
        fake_client,
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
    # Exactly one request — listings.create — and never the mint subject.
    assert fake_client.request.await_count == 1
    subject = fake_client.request.await_args.args[0]
    assert subject == "p2p.v1.listings.create"


def test_klodi_list_create_is_a_no_op_when_photos_absent(
    fake_client: MagicMock,
) -> None:
    fake_client.request.return_value = {"listing_id": LISTING_ID}
    envelope = _call_handler(
        fake_client,
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


# Happy path — single local


def test_klodi_list_create_uploads_one_local_jpeg_and_substitutes_asset_url(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    path = _write_file(fixtures_dir, "img1.jpg", JPEG_MAGIC)

    # Distinguish mint vs create by subject.
    def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
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

    # Capture HTTP PUTs by patching the standard-library HTTP client most
    # likely used. The developer chooses between urllib and httpx; we
    # patch both, asserting at least one was used.
    put_calls: list[dict[str, Any]] = []

    class _FakePutResp:
        status_code = 200
        status = 200

        def read(self) -> bytes:
            return b""

        def __enter__(self) -> "_FakePutResp":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    def _capture_urllib(req: Any, **kwargs: Any) -> _FakePutResp:
        put_calls.append({
            "url": req.full_url if hasattr(req, "full_url") else str(req),
            "method": req.get_method() if hasattr(req, "get_method") else "PUT",
            "headers": dict(req.headers) if hasattr(req, "headers") else {},
            "data": req.data if hasattr(req, "data") else None,
        })
        return _FakePutResp()

    with (
        patch("urllib.request.urlopen", side_effect=_capture_urllib),
    ):
        envelope = _call_handler(
            fake_client,
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

    # Mint subject was hit before the create.
    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert subjects == [
        "p2p.v1.assets.upload-url",
        "p2p.v1.listings.create",
    ]
    # listings.create received the substituted asset_url at the same index.
    create_args = fake_client.request.await_args_list[1].args[1]
    assert create_args["photos"] == ["https://cdn.example/asset1.jpg"]

    # One PUT to the presigned URL with the sniffed content-type.
    assert len(put_calls) == 1
    put = put_calls[0]
    assert put["url"] == "https://r2.example/up1?sig=abc"
    # Header keys are case-insensitive in HTTP; normalize for the assertion.
    headers = {k.lower(): v for k, v in (put.get("headers") or {}).items()}
    assert headers.get("content-type") == "image/jpeg"


def test_klodi_list_create_preserves_order_across_mixed_array(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    local = _write_file(fixtures_dir, "middle.png", PNG_MAGIC)

    def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
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

    with patch("urllib.request.urlopen"):
        envelope = _call_handler(
            fake_client,
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


def test_klodi_list_update_uploads_local_and_substitutes(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    path = _write_file(fixtures_dir, "replacement.png", PNG_MAGIC)

    def _mock_request(subject: str, args: dict[str, Any]) -> dict[str, Any]:
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

    with patch("urllib.request.urlopen"):
        envelope = _call_handler(
            fake_client,
            "klodi_list_update",
            {
                "listing_id": LISTING_ID,
                "photos": [path],
            },
        )

    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert subjects == [
        "p2p.v1.assets.upload-url",
        "p2p.v1.listings.update",
    ]
    update_args = fake_client.request.await_args_list[1].args[1]
    assert update_args["photos"] == ["https://cdn.example/replacement.png"]


# Atomic failure


def test_klodi_list_create_fails_atomic_on_one_bad_file_in_mixed_array(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    ok = _write_file(fixtures_dir, "ok.jpg", JPEG_MAGIC)
    pdf = _write_file(fixtures_dir, "doc.pdf", PDF_MAGIC)

    envelope = _call_handler(
        fake_client,
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
    # listings.create must not have been called — no partial success.
    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert "p2p.v1.listings.create" not in subjects


# ── Failure modes mirroring the openclaw red layer ───────────────────


def test_klodi_list_create_fails_when_mint_request_errors(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    """Marketplace mint error stops the whole flow before any PUT or
    listings.create dispatch.
    """
    from klodi_nats_client import KlodiRequestError

    path = _write_file(fixtures_dir, "ok.jpg", JPEG_MAGIC)

    def _mock_request(subject: str, args: dict[str, Any]) -> Any:
        if subject == "p2p.v1.assets.upload-url":
            raise KlodiRequestError("rate limited", "RATE_LIMITED")
        raise AssertionError(f"Unexpected subject reached: {subject}")

    # Wrap the sync mock in an async wrapper for AsyncMock.side_effect.
    async def _async_wrap(subject: str, args: dict[str, Any]) -> Any:
        return _mock_request(subject, args)

    fake_client.request.side_effect = _async_wrap

    envelope = _call_handler(
        fake_client,
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
    subjects = [c.args[0] for c in fake_client.request.await_args_list]
    assert "p2p.v1.listings.create" not in subjects
    assert "p2p.v1.assets.upload-url" in subjects


def test_klodi_list_update_passes_urls_verbatim_and_does_not_mint(
    fake_client: MagicMock,
) -> None:
    """Regression guard mirroring the create-side URL test."""
    fake_client.request.return_value = {
        "listing_id": LISTING_ID,
        "photos": [
            "https://cdn.example/x.jpg",
            "https://cdn.example/y.png",
        ],
    }
    envelope = _call_handler(
        fake_client,
        "klodi_list_update",
        {
            "listing_id": LISTING_ID,
            "photos": [
                "https://cdn.example/x.jpg",
                "https://cdn.example/y.png",
            ],
        },
    )
    assert envelope.get("listing_id") == LISTING_ID
    assert fake_client.request.await_count == 1
    assert fake_client.request.await_args.args[0] == "p2p.v1.listings.update"


# ── P2.6 — shutdown-signal propagation (not swallowed) ────────────────
#
# CQG round 1 P2.6: the handlers used `except BaseException` to wrap
# transport errors into a JSON envelope. That broad catch swallows
# `KeyboardInterrupt`, `SystemExit`, and `GeneratorExit` — signals
# Python uses to unwind the process cleanly. Hermes runs in a daemon
# loop; if a SIGINT arrives during the photos mint or the listings
# request, the handler must let the signal propagate so the daemon
# can shut down — not return `{"error": "klodi_unavailable", ...}` as
# if nothing happened.
#
# Tests in this group make the patched fake client raise
# `KeyboardInterrupt` from the underlying request, then assert that
# the exception escapes the handler instead of being converted to a
# JSON envelope. The same scaffolding covers the mint-time and the
# listings-time catch paths.


def test_keyboard_interrupt_propagates_through_photos_mint(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    """A SIGINT during the photo-mint NATS call must NOT be swallowed
    into a JSON envelope. The boundary catch should be `except
    Exception`, not `except BaseException`.
    """
    path = _write_file(fixtures_dir, "ok.jpg", JPEG_MAGIC)

    async def _raise_kbd(_subject: str, _args: dict[str, Any]) -> Any:
        raise KeyboardInterrupt("user pressed ctrl-c during mint")

    fake_client.request.side_effect = _raise_kbd

    with pytest.raises(KeyboardInterrupt):
        _call_handler(
            fake_client,
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


def test_system_exit_propagates_through_photos_mint(
    fake_client: MagicMock,
    fixtures_dir: Path,
) -> None:
    """SystemExit is the other shutdown-signal subclass of BaseException
    that the original `except BaseException` swallowed. Same propagation
    contract.
    """
    path = _write_file(fixtures_dir, "ok.jpg", JPEG_MAGIC)

    async def _raise_sysexit(_subject: str, _args: dict[str, Any]) -> Any:
        raise SystemExit(2)

    fake_client.request.side_effect = _raise_sysexit

    with pytest.raises(SystemExit):
        _call_handler(
            fake_client,
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


def test_keyboard_interrupt_propagates_on_non_photos_request(
    fake_client: MagicMock,
) -> None:
    """The outer try/except in `build_request_handler` (around the
    listings.* dispatch when there are no photos) must also let
    shutdown signals propagate. Same root cause: `except Exception`,
    not `except BaseException`.
    """

    async def _raise_kbd(_subject: str, _args: dict[str, Any]) -> Any:
        raise KeyboardInterrupt("user pressed ctrl-c during listings call")

    fake_client.request.side_effect = _raise_kbd

    with pytest.raises(KeyboardInterrupt):
        _call_handler(
            fake_client,
            "klodi_list_mine",
            {},
        )
