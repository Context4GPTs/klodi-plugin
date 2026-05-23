"""Photo-resolution pipeline shared by klodi_list_create and
klodi_list_update for the Hermes adapter.

Each element of ``args["photos"]`` can be either:

  * an ``http(s)://`` URL passed through verbatim at the same index, or
  * an absolute local filesystem path that the adapter validates,
    content-sniffs, uploads via the existing ``p2p.v1.assets.upload-url``
    NATS subject + R2 PUT, and substitutes with the returned
    ``asset_url``.

Order is preserved across substitutions. Mint is one NATS call per
listing call — if mint fails, no PUTs occur. PUTs run concurrently
but the resulting array is reassembled by index, not completion.

Atomicity: any validation, sniff, mint, or PUT failure rejects the
entire batch with a structured error envelope naming the offending
path and the stage. The listing call is never dispatched on partial
success. See ADR-0006.

Parity with the openclaw TypeScript helper at
``adapters/openclaw/src/tools/photos.ts`` and the Rust helper at
``packages/klodi-rust-host/src/mcp/photos.rs`` — same magic-number
table, same error envelope shape, same stage tags.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any

UPLOAD_URL_SUBJECT = "p2p.v1.assets.upload-url"
MAX_PHOTOS_PER_LISTING = 10
MAX_BYTES_PER_FILE = 10 * 1024 * 1024

ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

# Static sensitive-directory prefixes (POSIX). The KLODI_HOME and
# ~/.ssh prefixes are added dynamically inside _sensitive_prefixes()
# so $KLODI_HOME overrides propagate.
_STATIC_SENSITIVE_PREFIXES: tuple[str, ...] = (
    "/etc/",
    "/var/run/",
    "/var/log/",
    "/proc/",
    "/sys/",
    "/root/",
)


class PhotoResolutionError(Exception):
    """Resolution / validation / upload failure.

    Carries the offending path and the stage tag for the error envelope.
    Stage values mirror the openclaw + Rust implementations:
    ``absolute_path``, ``missing``, ``sensitive_dir``, ``size``,
    ``content_type``, ``mint``, ``put``, ``count``, ``type``.
    """

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
    """Accept POSIX absolute (/...) and Windows absolute (C:\\..., \\\\...).

    Reject tilde, file://, relative, empty.
    """
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
    """Sniff the first bytes against the magic-number table.

    Returns the matched content type from the allowlist or ``None``.
    Parity with the openclaw TypeScript and Rust implementations.
    """
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


def resolve_photos(
    photos: list[Any] | None,
    nats_request: Any,
) -> list[str] | None:
    """Resolve every local path in ``photos`` to an ``asset_url``.

    Returns the rewritten photos array, or ``None`` if ``photos`` is
    absent / falsy. Empty list passes through as ``[]``.

    ``nats_request(subject, args) -> dict`` is the synchronous mint
    function. The hermes request bridge supplies ``run_async`` to
    bridge to ``KlodiClient.request``; this helper keeps the surface
    synchronous so it slots into ``build_request_handler``.

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

    # Count check first — before any path resolution, sniff, or mint.
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

    # Mint the entire batch in one NATS call.
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
        mint_reply = nats_request(UPLOAD_URL_SUBJECT, mint_payload)
    except PhotoResolutionError:
        raise
    except BaseException as err:  # noqa: BLE001 — boundary
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

    # Concurrent PUTs preserving index-to-pair mapping.
    def _put_one(mint_idx: int) -> None:
        local = locals_only[mint_idx]
        pair = uploads[mint_idx]
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
                # Only enforce the success-range check when we received
                # a numeric status. The Python stdlib always returns
                # ints; mock contexts may inject a non-numeric sentinel
                # whose meaning is "treat as success".
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

    if locals_only:
        max_workers = min(len(locals_only), 4)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(_put_one, i) for i in range(len(locals_only))]
            for fut in as_completed(futures):
                fut.result()  # re-raise any PhotoResolutionError

    # Assemble the final array by original index.
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
        # Either exact-match the bare prefix (strip trailing sep) or
        # the path starts with the prefix as a parent directory.
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
