"""TLS trust for the raw ``tls://`` NATS transport (private-CA proxy).

See ADR-0022 (``docs/decisions/0022-tls-nats-transport-private-ca-trust.md``).

The Railway L4 TCP proxy terminates TLS at the NATS server with a
**private** CA (`epic nats-ws-ingress-flap-2026-06`). This module builds
the ``ssl.SSLContext`` the client hands to ``nats.connect(..., tls=ctx)``
for a ``tls://`` URL, trusting that private CA while keeping certificate
**and** hostname verification ON.

Invariant (the card's core security control): verification is **never**
disabled. ``KLODI_NATS_CA_FILE`` selects *which* CA to trust, never
*whether* to verify. There is no ``CERT_NONE`` / ``check_hostname = False``
path anywhere — a missing / wrong CA or a SAN mismatch fails **closed**
(the handshake raises), never a plaintext or unverified fallback.

CA resolution order (highest priority first):

  1. ``KLODI_NATS_CA_FILE`` env var — a path to a PEM bundle. Selected
     for local dev / integration tests (self-signed test CA) and
     emergency CA rotation without a client release.
  2. The bundled ``KLODI_NATS_CA_PEM`` catalog constant — the shipped
     private CA, versioned with the client. Empty until the epic mints
     the real CA; empty means "fall through".
  3. Neither present → the system default trust store. A private-CA cert
     then fails closed (correct), and a public chain still verifies.

``wss://`` keeps the system-default TLS that nats-py already applies —
the private CA is a ``tls://``-only concern.
"""

from __future__ import annotations

import os
import ssl
from pathlib import Path

from klodi_nats_client.constants import KLODI_NATS_CA_PEM

_CA_FILE_ENV = "KLODI_NATS_CA_FILE"


class CaTrustError(RuntimeError):
    """Raised when a configured CA source cannot be read.

    Fail-closed signal: a ``KLODI_NATS_CA_FILE`` that points at a missing
    or unreadable PEM must abort the connect, never silently downgrade to
    an unverified transport.
    """


def _resolve_ca_pem() -> str:
    """Return the CA PEM text to trust, or ``""`` for the system store.

    Raises :class:`CaTrustError` if ``KLODI_NATS_CA_FILE`` is set but the
    file cannot be read — a configured-but-broken CA fails closed.
    """
    override = os.environ.get(_CA_FILE_ENV)
    if override:
        try:
            return Path(override).read_text(encoding="utf-8")
        except OSError as err:
            raise CaTrustError(
                f"{_CA_FILE_ENV}={override!r} could not be read: {err}. "
                "Point it at a readable PEM bundle or unset it to use the "
                "bundled / system trust store — verification is never "
                "disabled to work around this.",
            ) from err
    return KLODI_NATS_CA_PEM


def build_tls_context(nats_url: str) -> ssl.SSLContext | None:
    """Build the verifying ``SSLContext`` for a ``tls://`` URL.

    Returns ``None`` for any non-``tls://`` scheme (``wss://`` uses
    nats-py's system-default TLS; ``ws://`` localhost is plaintext). For a
    ``tls://`` URL, returns a context that trusts the resolved private CA
    (or the system store when none is configured). The context keeps
    ``check_hostname=True`` and ``verify_mode=CERT_REQUIRED`` — the
    defaults ``ssl.create_default_context`` sets; this module never
    weakens them.
    """
    if not nats_url.startswith("tls://"):
        return None

    ca_pem = _resolve_ca_pem()
    if ca_pem:
        # `cadata` trusts ONLY this CA (private-CA-only, not augmenting
        # the system roots) — the tighter posture for a proxy that
        # presents a private chain.
        ctx = ssl.create_default_context(cadata=ca_pem)
    else:
        ctx = ssl.create_default_context()

    # Belt-and-suspenders: `create_default_context` already sets these,
    # but assert them so a future edit can't silently regress the
    # invariant.
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


__all__ = ["CaTrustError", "build_tls_context"]
