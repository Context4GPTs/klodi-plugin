"""TLS trust for the raw ``tls://`` NATS transport (private-CA proxy).

See ADR-0022 (``docs/decisions/0022-tls-nats-transport-private-ca-trust.md``).

The Railway L4 TCP proxy terminates TLS at the NATS server with a
**private** CA. This module builds
the ``ssl.SSLContext`` the client hands to ``nats.connect(..., tls=ctx)``
for a ``tls://`` URL, trusting that private CA while keeping certificate
**and** hostname verification ON.

Invariant (the core security control): verification is **never**
disabled. ``KLODI_NATS_CA_FILE`` selects *which* CA to trust, never
*whether* to verify. There is no ``CERT_NONE`` / ``check_hostname = False``
path anywhere — a missing / wrong CA or a SAN mismatch fails **closed**
(the handshake raises), never a plaintext or unverified fallback.

CA resolution order (highest priority first):

  1. ``KLODI_NATS_CA_FILE`` env var — a path to a PEM bundle. Selected
     for local dev / integration tests (self-signed test CA) and
     emergency CA rotation without a client release. When set it
     **short-circuits** — the persisted register CA is not even read.
  2. ``${KLODI_HOME}/nats-ca.pem`` — the register-response CA persisted
     at registration (see :func:`persist_nats_ca`). Server-authoritative,
     endpoint-matched to the served ``nats_url``, and rotatable without a
     client release (ADR-0022).
     Present-but-unreadable/invalid fails closed; absent falls through.
  3. The bundled ``KLODI_NATS_CA_PEM`` catalog constant — the shipped
     private CA, versioned with the client. Empty until the real CA is
     minted; empty means "fall through".
  4. None present → the system default trust store. A private-CA cert
     then fails closed (correct), and a public chain still verifies.

``wss://`` keeps the system-default TLS that nats-py already applies —
the private CA is a ``tls://``-only concern, so the persisted CA is
never consulted for a ``wss://`` URL.
"""

from __future__ import annotations

import logging
import os
import ssl
from pathlib import Path

from klodi_nats_client.constants import KLODI_NATS_CA_PEM
from klodi_nats_client.paths import nats_ca_path
from klodi_nats_client.secret_write import klodi_secret_write

log = logging.getLogger("klodi_nats_client.tls")

_CA_FILE_ENV = "KLODI_NATS_CA_FILE"

# Cheap PEM-shape sniff at the persist boundary — a full X.509 parse would
# make the four adapter persist sites expensive and asymmetric; a
# PEM-shaped-but-deep-invalid cert instead fails closed at connect (the
# verifying context rejects it). See ADR-0022 / Open questions #4.
_PEM_MARKER = "-----BEGIN CERTIFICATE-----"

# Non-secret cert (ADR-0022 §Security) — world-readable, unlike the 0600
# nkey creds of ADR-0002.
_CA_FILE_MODE = 0o644


class CaTrustError(RuntimeError):
    """Raised when the resolved CA cannot be trusted for the ``tls://``
    handshake.

    Fail-closed signal covering both boundaries: a configured CA source
    that cannot be *read* (missing / unreadable ``KLODI_NATS_CA_FILE`` or
    persisted file), and one that reads but cannot be *used as a trust
    anchor* — PEM-unparseable at context build (see
    :func:`build_tls_context`), or rejected at the handshake (wrong-signer
    / keyUsage-missing, reclassified terminal at the initial connect; see
    ``client.py``). A bad served CA aborts the connect with this structured,
    attributable error — never a silent downgrade to an unverified
    transport, and never an indefinite retry that pins the caller at a
    "connecting" state.
    """


def _resolve_ca_pem(klodi_home: Path | str | None) -> tuple[str, str]:
    """Return ``(ca_pem, source)`` — the CA PEM text to trust (``""`` for the
    system store) and a legible label naming its source.

    Applies the resolution order documented on the module: env override
    (short-circuits) → persisted ``${KLODI_HOME}/nats-ca.pem`` → bundled
    constant → system store. Raises :class:`CaTrustError` if a configured
    CA source (env override, or a present persisted file) cannot be read —
    a configured-but-broken CA fails closed, never a silent downgrade.
    """
    override = os.environ.get(_CA_FILE_ENV)
    if override:
        try:
            return (
                Path(override).read_text(encoding="utf-8"),
                f"{_CA_FILE_ENV}={override}",
            )
        except OSError as err:
            raise CaTrustError(
                f"{_CA_FILE_ENV}={override!r} could not be read: {err}. "
                "Point it at a readable PEM bundle or unset it to use the "
                "persisted / bundled / system trust store — verification is "
                "never disabled to work around this.",
            ) from err

    # Level 2 — the register-response CA persisted at registration. Only
    # reached when the env override is unset (strict precedence, no CA
    # union, no divergence read). A present-but-unreadable file fails
    # closed; an absent file falls through to the bundled constant.
    if klodi_home is not None:
        persisted = nats_ca_path(klodi_home)
        if persisted.exists():
            try:
                return (
                    persisted.read_text(encoding="utf-8"),
                    f"persisted register CA at {persisted}",
                )
            except OSError as err:
                raise CaTrustError(
                    f"persisted register CA at {persisted} could not be "
                    f"read: {err}. Re-register to repersist it, or set "
                    f"{_CA_FILE_ENV} to an explicit PEM — verification is "
                    "never disabled to work around this.",
                ) from err

    return KLODI_NATS_CA_PEM, "bundled KLODI_NATS_CA_PEM"


def persist_nats_ca(klodi_home: Path | str, pem: str) -> Path | None:
    """Persist the register-response CA to ``${KLODI_HOME}/nats-ca.pem``.

    Atomic write (temp + fsync + rename, via :func:`klodi_secret_write`) at
    mode 0644 — a non-secret CA certificate (ADR-0022 §Security), unlike
    the 0600 nkey creds. **Skips** — writing nothing, raising nothing —
    when ``pem`` is empty or not PEM-shaped (no ``-----BEGIN CERTIFICATE
    -----``), so an absent / garbage ``nats_ca`` can never fail
    registration. Last-write-wins: a fresh value overwrites the prior one,
    making re-register the supported CA-rotation path (an *omission* does
    not delete — "no update" ≠ "revoke", handled at the call sites).

    Returns the written path, or ``None`` when the value was skipped.
    """
    if not pem or _PEM_MARKER not in pem:
        log.info(
            "nats_ca_persist_skipped reason=%s",
            "empty" if not pem else "not_pem_shaped",
        )
        return None
    return klodi_secret_write(nats_ca_path(klodi_home), pem, _CA_FILE_MODE)


def build_tls_context(
    nats_url: str, *, klodi_home: Path | str | None = None
) -> tuple[ssl.SSLContext, str] | None:
    """Build the verifying ``SSLContext`` for a ``tls://`` URL.

    Returns ``None`` for any non-``tls://`` scheme (``wss://`` uses
    nats-py's system-default TLS; ``ws://`` localhost is plaintext). For a
    ``tls://`` URL, returns ``(ctx, source)`` — a context that trusts the
    resolved private CA (env override → persisted register CA under
    ``klodi_home`` → bundled constant → system store) **and** the legible
    label naming *which* source :func:`_resolve_ca_pem` selected. The
    ``source`` is the single source of truth for the connect-failure
    attribution: the client stores it and interpolates it into the surfaced
    :class:`CaTrustError`, so the precedence is never re-derived elsewhere.
    The context keeps ``check_hostname=True`` and
    ``verify_mode=CERT_REQUIRED`` — the defaults ``ssl.create_default_context``
    sets; this module never weakens them.

    ``klodi_home`` locates the persisted ``nats-ca.pem`` (level 2); the
    caller derives it from the creds-path parent so no upward
    ``KLODI_HOME`` re-resolution happens in this lower-layer package.
    """
    if not nats_url.startswith("tls://"):
        return None

    ca_pem, source = _resolve_ca_pem(klodi_home)
    if ca_pem:
        # `cadata` trusts ONLY this CA (private-CA-only, not augmenting
        # the system roots) — the tighter posture for a proxy that
        # presents a private chain. A PEM-shaped-but-unparseable CA raises
        # here; wrap the bare ``ssl.SSLError`` into the structured,
        # source-attributed ``CaTrustError`` (the parse boundary) so the
        # operator sees a legible fail-closed error, not a leaked stack.
        try:
            ctx = ssl.create_default_context(cadata=ca_pem)
        except ssl.SSLError as err:
            raise CaTrustError(
                f"served NATS CA ({source}) could not be parsed as a trust "
                f"anchor: {err}. Re-register to repersist it, or set "
                f"{_CA_FILE_ENV} to a valid PEM — verification is never "
                "disabled to work around this.",
            ) from err
    else:
        ctx = ssl.create_default_context()

    # Belt-and-suspenders: `create_default_context` already sets these,
    # but assert them so a future edit can't silently regress the
    # invariant.
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx, source


__all__ = [
    "CaTrustError",
    "build_tls_context",
    "persist_nats_ca",
]
