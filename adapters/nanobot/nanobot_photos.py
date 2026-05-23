"""Photo-resolution pipeline shared by klodi_list_create and
klodi_list_update for the nanobot adapter.

Mirror of ``adapters/hermes/src/klodi_hermes/photos.py`` adapted for
nanobot's async dispatch path. Same magic-number table, same stage
tags, same all-or-nothing semantics, same canonical error envelope
shape.

Each element of ``args["photos"]`` can be either:

  * an ``http(s)://`` URL passed through verbatim at the same index, or
  * an absolute local filesystem path that the adapter validates,
    content-sniffs, uploads via the existing ``p2p.v1.assets.upload-url``
    NATS subject + R2 PUT, and substitutes with the returned
    ``asset_url``.

Order is preserved across substitutions. Mint is one NATS call per
listing call. PUTs run synchronously inside an executor (urllib is
blocking; the tests mock it via patching urlopen). The async wrapper
keeps the surface natural for nanobot's coroutine dispatcher.

The hermes helper is sync; this one is async. The duplication is
deliberate per the architect's directive — two callers don't justify
an abstraction across async/sync boundaries.
"""

from __future__ import annotations

import asyncio
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

UPLOAD_URL_SUBJECT = "p2p.v1.assets.upload-url"
MAX_PHOTOS_PER_LISTING = 10
MAX_BYTES_PER_FILE = 10 * 1024 * 1024

ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

_STATIC_SENSITIVE_PREFIXES: tuple[str, ...] = (
    "/etc/",
    "/var/run/",
    "/var/log/",
    "/proc/",
    "/sys/",
    "/root/",
)


class PhotoResolutionError(Exception):
    """Resolution / validation / upload failure with stage + path tags."""

    def __init__(self, message: str, stage: str, path: str | None = None) -> None:
        super().__init__(message)
        self.stage = stage
        self.path = path


def _sensitive_prefixes() -> tuple[str, ...]:
    dynamic: list[str] = []
    klodi_home = os.environ.get("KLODI_HOME")
    if klodi_home:
        dynamic.append(_ensure_trailing_sep(klodi_home))
    home = os.path.expanduser("~")
    if home:
        dynamic.append(os.path.join(_ensure_trailing_sep(home), ".ssh") + os.sep)
    return _STATIC_SENSITIVE_PREFIXES + tuple(dynamic)


def _ensure_trailing_sep(path: str) -> str:
    return path if path.endswith(os.sep) else path + os.sep


def _is_http_url(s: str) -> bool:
    return s.startswith(("http://", "https://"))


def _is_absolute_path(s: str) -> bool:
    if not s:
        return False
    if s.startswith("~"):
        return False
    if s.startswith("file://"):
        return False
    if s.startswith("/"):
        return True
    if len(s) >= 3 and s[1] == ":" and s[2] in ("\\", "/"):
        return True
    if s.startswith("\\\\"):
        return True
    return False


def _sniff_content_type(data: bytes) -> str | None:
    if len(data) >= 3 and data[0] == 0xFF and data[1] == 0xD8 and data[2] == 0xFF:
        return "image/jpeg"
    if (
        len(data) >= 8
        and data[0] == 0x89 and data[1] == 0x50
        and data[2] == 0x4E and data[3] == 0x47
        and data[4] == 0x0D and data[5] == 0x0A
        and data[6] == 0x1A and data[7] == 0x0A
    ):
        return "image/png"
    if (
        len(data) >= 12
        and data[0] == 0x52 and data[1] == 0x49
        and data[2] == 0x46 and data[3] == 0x46
        and data[8] == 0x57 and data[9] == 0x45
        and data[10] == 0x42 and data[11] == 0x50
    ):
        return "image/webp"
    return None


@dataclass(frozen=True)
class _LocalElement:
    index: int
    raw_path: str
    real_path: str
    data: bytes
    content_type: str


@dataclass(frozen=True)
class _UrlElement:
    index: int
    url: str


_Element = _LocalElement | _UrlElement


async def resolve_photos(
    photos: list[Any] | None,
    nats_request: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
) -> list[str] | None:
    """Resolve every local path in ``photos`` to an ``asset_url``.

    Returns the rewritten photos array, or ``None`` if ``photos`` is
    absent / falsy. Empty list passes through as ``[]``.

    ``nats_request`` is an async callable that issues a request to the
    given subject and returns the parsed reply. The caller is the
    nanobot dispatcher and supplies this via the shared
    ``KlodiClient`` singleton.

    Raises ``PhotoResolutionError`` on any validation, mint, or PUT
    failure. The caller wraps that into the structured error envelope.
    """
    if photos is None:
        return None
    if not isinstance(photos, list):
        raise PhotoResolutionError(
            f"photos must be a list, got {type(photos).__name__}",
            "type",
        )
    if not photos:
        return []

    if len(photos) > MAX_PHOTOS_PER_LISTING:
        raise PhotoResolutionError(
            f"Too many photos: {len(photos)} entries (max 10 per listing).",
            "count",
        )

    elements: list[_Element] = []
    for i, raw in enumerate(photos):
        if not isinstance(raw, str):
            raise PhotoResolutionError(
                f"photos[{i}] must be a string (URL or absolute path),"
                f" got {type(raw).__name__}.",
                "type",
            )
        if _is_http_url(raw):
            elements.append(_UrlElement(index=i, url=raw))
            continue
        elements.append(_resolve_local(raw, i))

    locals_only: list[_LocalElement] = [
        e for e in elements if isinstance(e, _LocalElement)
    ]
    if not locals_only:
        return [e.url if isinstance(e, _UrlElement) else "" for e in elements]

    mint_payload = {
        "files": [
            {
                "filename": os.path.basename(local.real_path),
                "content_type": local.content_type,
                "size": len(local.data),
            }
            for local in locals_only
        ],
    }

    try:
        mint_reply = await nats_request(UPLOAD_URL_SUBJECT, mint_payload)
    except PhotoResolutionError:
        raise
    except Exception as err:  # noqa: BLE001 — boundary; propagate KeyboardInterrupt/SystemExit/CancelledError
        raise PhotoResolutionError(
            f"Mint failed for {len(locals_only)} photo(s): {err}",
            "mint",
        ) from err

    uploads = mint_reply.get("uploads") if isinstance(mint_reply, dict) else None
    if not isinstance(uploads, list) or len(uploads) != len(locals_only):
        raise PhotoResolutionError(
            f"Mint returned {len(uploads) if isinstance(uploads, list) else 0}"
            f" upload pair(s) for {len(locals_only)} local(s).",
            "mint",
        )

    # PUTs via urllib are blocking — run them in a thread pool so the
    # event loop stays responsive. asyncio.gather preserves index order
    # in the returned list; we ignore the return values and trust
    # exceptions to propagate.
    loop = asyncio.get_running_loop()
    if locals_only:
        max_workers = min(len(locals_only), 4)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            await asyncio.gather(*[
                loop.run_in_executor(
                    pool,
                    _put_one,
                    locals_only[i],
                    uploads[i],
                )
                for i in range(len(locals_only))
            ])

    index_to_asset: dict[int, str] = {}
    for mint_idx, local in enumerate(locals_only):
        asset_url = uploads[mint_idx].get("asset_url")
        if not isinstance(asset_url, str):
            raise PhotoResolutionError(
                f"Mint reply for index {local.index} is missing asset_url.",
                "mint",
                local.raw_path,
            )
        index_to_asset[local.index] = asset_url

    out: list[str] = [""] * len(photos)
    for element in elements:
        if isinstance(element, _UrlElement):
            out[element.index] = element.url
        else:
            out[element.index] = index_to_asset[element.index]
    return out


def _put_one(local: _LocalElement, pair: dict[str, Any]) -> None:
    upload_url = pair.get("upload_url")
    if not isinstance(upload_url, str):
        raise PhotoResolutionError(
            f"Mint reply for index {local.index} is missing upload_url.",
            "mint",
            local.raw_path,
        )
    try:
        req = urllib.request.Request(
            upload_url,
            data=local.data,
            method="PUT",
            headers={"Content-Type": local.content_type},
        )
        with urllib.request.urlopen(req) as resp:
            status = getattr(resp, "status", None)
            if status is None:
                status = getattr(resp, "code", 200)
            if isinstance(status, int) and not (200 <= status < 300):
                raise PhotoResolutionError(
                    f"PUT failed for {local.raw_path}: status {status}",
                    "put",
                    local.raw_path,
                )
    except PhotoResolutionError:
        raise
    except urllib.error.HTTPError as err:
        raise PhotoResolutionError(
            f"PUT failed for {local.raw_path}: HTTP {err.code} {err.reason}",
            "put",
            local.raw_path,
        ) from err
    except urllib.error.URLError as err:
        raise PhotoResolutionError(
            f"PUT failed for {local.raw_path}: {err.reason}",
            "put",
            local.raw_path,
        ) from err


def _resolve_local(raw: str, index: int) -> _LocalElement:
    if not _is_absolute_path(raw):
        raise PhotoResolutionError(
            f"photos[{index}] must be an absolute path: {raw}",
            "absolute_path",
            raw,
        )

    try:
        resolved = os.path.realpath(raw, strict=True)
    except FileNotFoundError as err:
        raise PhotoResolutionError(
            f"photos[{index}] does not exist or is not readable: {raw} (ENOENT).",
            "missing",
            raw,
        ) from err
    except OSError as err:
        raise PhotoResolutionError(
            f"photos[{index}] is not readable: {raw} ({err}).",
            "missing",
            raw,
        ) from err

    for prefix in _sensitive_prefixes():
        # Sensitive-dir check on the REAL path, not the input path. A
        # symlink under /tmp/safe.jpg → /etc/passwd resolves to /etc/passwd
        # and gets rejected here. realpath(strict=True) above also closes
        # a symlink-race TOCTOU between sniff and PUT — the helper reads
        # bytes from `resolved`, not `raw`. See ADR-0006.
        bare = prefix.rstrip(os.sep)
        if resolved == bare or resolved.startswith(prefix):
            raise PhotoResolutionError(
                f"photos[{index}] resolves outside permitted roots: {raw}"
                f" → {resolved} (sensitive directory).",
                "sensitive_dir",
                raw,
            )

    try:
        stat = os.stat(resolved)
    except OSError as err:
        raise PhotoResolutionError(
            f"photos[{index}] is not readable: {raw} ({err}).",
            "missing",
            raw,
        ) from err

    if not os.path.isfile(resolved):
        raise PhotoResolutionError(
            f"photos[{index}] is not a regular file: {raw}.",
            "missing",
            raw,
        )

    if stat.st_size > MAX_BYTES_PER_FILE:
        raise PhotoResolutionError(
            f"photos[{index}] exceeds the 10 MB ceiling: {raw}"
            f" ({stat.st_size} bytes, 10485760 max).",
            "size",
            raw,
        )

    try:
        with open(resolved, "rb") as f:
            data = f.read()
    except OSError as err:
        raise PhotoResolutionError(
            f"photos[{index}] read failed: {raw} ({err}).",
            "missing",
            raw,
        ) from err

    sniffed = _sniff_content_type(data)
    if sniffed is None:
        raise PhotoResolutionError(
            f"photos[{index}] content-type rejected: {raw} — sniffed bytes"
            f" do not match the image/jpeg, image/png, or image/webp allowlist.",
            "content_type",
            raw,
        )

    return _LocalElement(
        index=index,
        raw_path=raw,
        real_path=resolved,
        data=data,
        content_type=sniffed,
    )


__all__ = [
    "PhotoResolutionError",
    "resolve_photos",
    "MAX_BYTES_PER_FILE",
    "MAX_PHOTOS_PER_LISTING",
    "UPLOAD_URL_SUBJECT",
]
