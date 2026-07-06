"""Disk-backed config and credentials for the KlodiClient.

The host plugin (``klodi_register`` on the adapter) writes both files;
this package reads them. Format and lifetime mirror the canonical pair
in the TS package (``packages/nats-client-ts/src/config.ts``):

  ``${klodi_home}/config.json`` — handle, user_id, public NKey, NATS URL
  ``${klodi_home}/nats.creds``  — Ed25519 NKey credentials at mode 0600

The ``KlodiClient`` takes both paths in its constructor; the adapter
resolves them from its host's config tree.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("klodi_nats_client.config")


@dataclass(frozen=True)
class KlodiConfig:
    """Validated contents of ``config.json``."""

    handle: str
    user_id: str
    nkey_public: str
    nats_url: str


REQUIRED_FIELDS: tuple[str, ...] = (
    "handle",
    "user_id",
    "nkey_public",
    "nats_url",
)


class ConfigNotFoundError(FileNotFoundError):
    """Raised when ``config.json`` is missing — adapter should
    direct the user to ``klodi_register``."""


class ConfigInvalidError(ValueError):
    """Raised when ``config.json`` is missing required fields."""


class CredsNotFoundError(FileNotFoundError):
    """Raised when ``nats.creds`` is missing — same remedy as
    ``ConfigNotFoundError``."""


def load_config(path: str | Path) -> KlodiConfig:
    """Load and validate ``config.json``.

    Raises ``ConfigNotFoundError`` when the file is absent and
    ``ConfigInvalidError`` when required fields are missing or empty.
    Does not cache — the caller decides whether to memoize.
    """
    config_path = Path(path)
    if not config_path.exists():
        raise ConfigNotFoundError(
            f"Klodi config missing at {config_path}."
            " Run klodi_register to sign up."
        )

    raw = config_path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as err:
        raise ConfigInvalidError(
            f"Klodi config at {config_path} is not valid JSON: {err}"
        ) from err
    if not isinstance(parsed, dict):
        raise ConfigInvalidError(
            f"Klodi config at {config_path} must be a JSON object"
        )

    missing: list[str] = []
    for field in REQUIRED_FIELDS:
        value = parsed.get(field)
        if not isinstance(value, str) or not value:
            missing.append(field)
    if missing:
        raise ConfigInvalidError(
            f"Klodi config at {config_path} is missing fields:"
            f" {', '.join(missing)}. Re-register with klodi_register."
        )

    return KlodiConfig(
        handle=parsed["handle"],
        user_id=parsed["user_id"],
        nkey_public=parsed["nkey_public"],
        nats_url=parsed["nats_url"],
    )


def load_creds(path: str | Path) -> Path:
    """Validate the on-disk creds file exists and return its ``Path``.

    ``nats-py`` accepts a path as ``user_credentials`` and reads it
    lazily; we don't slurp the bytes here. We DO sanity-check the
    file mode and warn (don't fail) if it's not 0600 — the adapter's
    setup tools surface a stricter error.

    Returns the ``Path`` so the client can pass it straight to
    ``nats.connect(..., user_credentials=...)``.
    """
    creds_path = Path(path)
    if not creds_path.exists():
        raise CredsNotFoundError(
            f"Klodi credentials missing at {creds_path}."
            " Run klodi_register to sign up."
        )
    try:
        mode = creds_path.stat().st_mode & 0o777
    except OSError:
        return creds_path
    if mode & 0o077:
        log.warning(
            "klodi_creds_loose_perms path=%s mode=%o expected=600",
            creds_path,
            mode,
        )
    return creds_path


def assert_tls(nats_url: str) -> None:
    """Refuse `nats_url` unless it uses the `tls://` transport.

    ``tls://`` (raw NATS-over-TLS, the
    L4 TCP-proxy path) is the **sole** accepted transport. It terminates
    TLS at the NATS server with certificate + hostname verification ON
    (see `klodi_nats_client.tls`). Every other scheme (`wss://` / `ws://`
    / `nats://`) is rejected — there is no host-based localhost bypass and
    no plaintext transport anywhere. The dev loopback is ``tls://localhost``
    (dev CA), accepted by this same prefix check *because it is* ``tls://``,
    not via a carve-out. This closes the compound attack where a
    compromised registration endpoint injects a non-TLS `nats_url` and the
    next connect goes to attacker-controlled infrastructure. There is no
    env opt-out — a host that needs a different transport terminates TLS at
    the edge and hands the client a `tls://` URL.
    """
    if nats_url.startswith("tls://"):
        return
    raise ValueError(
        f"KlodiClient: nats_url must use tls:// (got {nats_url}). "
        "tls:// (raw NATS-over-TLS with certificate + hostname verification) "
        "is the sole accepted transport. Re-register to obtain the current "
        "tls:// endpoint.",
    )


__all__ = [
    "ConfigInvalidError",
    "ConfigNotFoundError",
    "CredsNotFoundError",
    "KlodiConfig",
    "REQUIRED_FIELDS",
    "assert_tls",
    "load_config",
    "load_creds",
]
