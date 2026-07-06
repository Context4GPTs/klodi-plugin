"""RED — transport guard collapsed to ``tls://`` ONLY, no localhost bypass (py).

Card: remove-dead-ws-localhost-nats-transport-bypass. This flips the prior
``collapse-nats-transport-guard-to-tls-only`` suite's *localhost-accepts-any-
scheme* premise to *localhost-is-no-longer-a-bypass*. The guard's sole rule
becomes ``scheme == tls://`` — ``tls://localhost`` (dev CA) is accepted
*because it is* ``tls://``, NOT via a host carve-out.

New contract (the whole matrix, per language):

  * ``tls://<non-localhost>``  → accepts (the sole prod transport)
  * ``tls://localhost``        → accepts (dev-CA loopback — it is ``tls://``)
  * ``ws://localhost``         → REJECTS  (was accepted; the bypass is dead)
  * ``wss://localhost``        → REJECTS  (was accepted; the bypass is dead)
  * ``nats://localhost``       → REJECTS  (was accepted; the bypass is dead)
  * ``ws://<non-localhost>``   → REJECTS  (unchanged)
  * ``wss://<non-localhost>``  → REJECTS  (unchanged)
  * ``nats://<non-localhost>`` → REJECTS  (unchanged)

The guard is the two-family security control (connect-time + persist-time).
This file pins the CONNECT-time shared guard in ``klodi_nats_client.config``.

QA-owned (adversarial-testing). NEVER weaken these asserts to match a
wider implementation. In particular: do NOT re-widen the guard to accept
``ws://localhost`` so an old assertion passes — the localhost bypass is the
plaintext-transport surface this card deletes.

--- COORDINATION NOTE ---------------------------------------------------
The shared guard is renamed in-dev ``assert_tls_or_localhost`` →
``assert_tls`` (once the localhost bypass is gone, the ``_or_localhost``
suffix is an active lie). This file imports the NEW name; the whole suite
errors at collection until the rename lands (expected RED — the rename IS
part of the deliverable). No re-export shim exists for the old name
(CLAUDE.md: no backwards-compat) and none should. ``is_localhost`` is
deleted entirely — this file must never import it again.
-------------------------------------------------------------------------
"""

from __future__ import annotations

import re

import pytest

from klodi_nats_client.config import assert_tls

# The pinned prod endpoint: Railway's L4 TCP proxy in front of NATS
# (devops §1 — NOT `kodama`, which is pgvector's Postgres proxy).
_TLS_PROD = "tls://hayabusa.proxy.rlwy.net:32770"
_WSS_PROD = "wss://klodi-net.4gpts.com"
_NATS_PLAINTEXT = "nats://hayabusa.proxy.rlwy.net:4222"
_WS_PLAINTEXT = "ws://attacker.example.com:8080"


# ── tls:// is the SOLE accepted transport (localhost is not special) ──────


def test_accepts_tls_non_localhost() -> None:
    """The prod transport: raw TLS through the Railway TCP proxy."""
    assert_tls(_TLS_PROD)


def test_accepts_tls_arbitrary_non_localhost_host() -> None:
    # Any tls:// host is a TLS transport and passes the tls-only control.
    assert_tls("tls://nats.example.com:4222")


def test_accepts_tls_localhost() -> None:
    """The surviving dev loopback: ``tls://localhost`` (dev CA) is accepted
    *because it is* ``tls://`` — NOT via a localhost carve-out. This is the
    only accepted localhost form after the bypass is removed."""
    assert_tls("tls://localhost:4222")


# ── every non-tls scheme REJECTS off-localhost (unchanged) ───────────────


def test_rejects_wss_non_localhost() -> None:
    with pytest.raises(ValueError):
        assert_tls(_WSS_PROD)


def test_rejects_plaintext_nats_non_localhost() -> None:
    """nats:// is plaintext TCP — must never stand in for tls://."""
    with pytest.raises(ValueError):
        assert_tls(_NATS_PLAINTEXT)


def test_rejects_bare_ws_non_localhost() -> None:
    with pytest.raises(ValueError):
        assert_tls(_WS_PLAINTEXT)


# ── THE FLIP: every non-tls scheme against localhost now REJECTS ─────────


@pytest.mark.parametrize(
    "url",
    [
        "ws://localhost:8080",
        "wss://localhost",
        "nats://localhost:4222",
        "nats://127.0.0.1:4222",
        "ws://0.0.0.0:8080",
        "nats://dev.localhost:4222",
    ],
)
def test_rejects_non_tls_against_localhost(url: str) -> None:
    """The load-bearing flip: localhost is no longer a plaintext escape
    hatch. ``ws://``/``wss://``/``nats://`` against localhost were accepted
    under the old ``assert_tls_or_localhost`` bypass; after the collapse the
    guard rejects them — there is no host-based carve-out, only ``tls://``.
    (Inverts ``test_accepts_any_scheme_against_localhost``.)"""
    with pytest.raises(ValueError):
        assert_tls(url)


# ── rejection message: names tls:// as the sole transport, no bypass ─────


def test_rejection_message_names_tls_only_no_localhost_bypass() -> None:
    """The message is the operator's entire diagnosis surface. Post-collapse
    it must (a) name ``tls://`` as the required transport, (b) name
    re-register / the URL fix as the remedy, and (c) NO LONGER present
    localhost as an acceptable bypass (drop the "…only accepted when the
    host resolves to localhost" clause). Tested against a *non-localhost*
    offending url so echoing it can never re-introduce the word ``localhost``.
    """
    with pytest.raises(ValueError) as exc:
        assert_tls(_WS_PLAINTEXT)
    message = str(exc.value)
    # (a) names tls:// as required.
    assert "tls://" in message, f"must name tls:// as required (got: {message!r})"
    # (c) no longer frames localhost as an acceptable bypass. The old message
    # said "…only accepted when the host resolves to localhost"; that whole
    # accept-on-localhost framing must be gone.
    assert "localhost" not in message.lower(), (
        "message must not present localhost as an acceptable bypass — the "
        f"host carve-out is deleted (got: {message!r})"
    )
    # (b) names re-register / correcting the url as the remedy.
    assert re.search(r"re-?register", message, re.IGNORECASE), (
        f"must name re-register as the remedy (got: {message!r})"
    )
    # remedy reads as a normal migration, not a compromise-only escalation.
    assert "compromis" not in message.lower(), (
        "re-register must read as the normal migration remedy, not a "
        f"compromise-only one (got: {message!r})"
    )
