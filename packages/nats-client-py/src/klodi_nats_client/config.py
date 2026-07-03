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
import os
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


def is_localhost(url: str) -> bool:
    """Return True when `url`'s host is localhost / 127.0.0.1 / 0.0.0.0
    / *.localhost. Per **D § D10**: plaintext ``ws://`` is only allowed
    when the destination is unambiguously local."""
    from urllib.parse import urlparse

    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    if host in ("localhost", "127.0.0.1", "0.0.0.0"):
        return True
    return host.endswith(".localhost")


# The two encrypted transports the guard accepts on non-localhost hosts.
# `wss://` = NATS-over-WebSocket-over-TLS (the L7 edge path); `tls://` =
# raw NATS-over-TLS (the L4 TCP-proxy path). Both terminate TLS at the
# NATS server with certificate + hostname verification ON — see
# `klodi_nats_client.tls`. Their plaintext siblings `ws://` and `nats://`
# are only tolerated when the host resolves to localhost.
_ENCRYPTED_SCHEMES: tuple[str, ...] = ("wss://", "tls://")


def assert_encrypted_or_localhost(nats_url: str) -> None:
    """Refuse `nats_url` if it's plaintext on a non-localhost host.

    Per **D § D10**: the smart-default TLS posture closes the compound
    attack where a compromised registration endpoint injects a plaintext
    `nats_url` and the next connect goes to attacker-controlled
    infrastructure. Accepts the two encrypted transports (`wss://` and
    `tls://`); their plaintext siblings (`ws://` / `nats://`) are only
    allowed when the host resolves to localhost. There is no env opt-out
    — if a non-localhost host needs plaintext, the deployment is
    misconfigured (terminate TLS at the edge).
    """
    if nats_url.startswith(_ENCRYPTED_SCHEMES):
        return
    if is_localhost(nats_url):
        return
    raise ValueError(
        f"KlodiClient: nats_url must use wss:// or tls:// (got {nats_url}). "
        "Plaintext ws:// / nats:// is only allowed when the host resolves "
        "to localhost. Re-register if creds came from a compromised source.",
    )


__all__ = [
    "ConfigInvalidError",
    "ConfigNotFoundError",
    "CredsNotFoundError",
    "KlodiConfig",
    "REQUIRED_FIELDS",
    "assert_encrypted_or_localhost",
    "is_localhost",
    "load_config",
    "load_creds",
]
