"""RED — transport guard widened to accept ``tls://`` (py client).

Card: support-tls-nats-transport-with-private-ca-trust.
Criteria (Acceptance → "Transport guard — widen to tls://…"):

  * ``tls://<non-localhost>``  → accepts (the new prod transport)
  * ``wss://<non-localhost>``  → still accepts (widening must not drop wss)
  * ``nats://<non-localhost>`` → still REJECTS; error names the acceptable
                                 secure schemes (wss:// AND tls://). nats://
                                 is the plaintext-TCP sibling of tls:// and
                                 must never be silently accepted as a degraded
                                 form of it.
  * ``ws://<non-localhost>``   → still REJECTS (the D §D10 control is intact)
  * any scheme against localhost → accepts (localhost bypass unchanged)

The guard is the two-family security control (connect-time + persist-time).
This file pins the CONNECT-time shared guard in ``klodi_nats_client.config``.

QA-owned (adversarial-testing). NEVER weaken these asserts to match a
narrower implementation.

--- COORDINATION NOTE ---------------------------------------------------
The shared guard was renamed `assert_wss_or_localhost` →
`assert_encrypted_or_localhost` in-dev (it now accepts wss:// AND tls://).
The BEHAVIOUR asserted below is the spec; the symbol name is coordinated —
this file imports the new name (aliased locally). No re-export shim exists
for the old name (CLAUDE.md: no backwards-compat) and none should.
-------------------------------------------------------------------------
"""

from __future__ import annotations

import pytest

from klodi_nats_client.config import (
    assert_encrypted_or_localhost as assert_wss_or_localhost,
)

# A representative Railway L4 TCP-proxy endpoint (the card's example).
_TLS_PROD = "tls://kodama.proxy.rlwy.net:37360"
_WSS_PROD = "wss://klodi-net.4gpts.com"
_NATS_PLAINTEXT = "nats://kodama.proxy.rlwy.net:4222"
_WS_PLAINTEXT = "ws://attacker.example.com:8080"


# ── tls:// is now an accepted secure transport ───────────────────────────


def test_accepts_tls_non_localhost() -> None:
    """The new prod transport: raw TLS through the Railway TCP proxy.

    RED until the guard widens — today it only allows wss:// / localhost.
    """
    # Act + Assert — must not raise.
    assert_wss_or_localhost(_TLS_PROD)


def test_accepts_tls_arbitrary_non_localhost_host() -> None:
    # Not tied to the exact proxy hostname — any tls:// host is a TLS
    # transport and passes the encrypted-or-localhost control.
    assert_wss_or_localhost("tls://nats.example.com:4222")


# ── wss:// must NOT be dropped by the widening ───────────────────────────


def test_still_accepts_wss_non_localhost() -> None:
    assert_wss_or_localhost(_WSS_PROD)


# ── plaintext non-localhost still rejected (D §D10 intact) ───────────────


def test_rejects_plaintext_nats_non_localhost() -> None:
    """nats:// is plaintext TCP — the degraded sibling of tls://. It must
    never be accepted as a stand-in for the encrypted transport."""
    with pytest.raises(ValueError):
        assert_wss_or_localhost(_NATS_PLAINTEXT)


def test_nats_rejection_error_names_both_secure_schemes() -> None:
    """The error must name the acceptable secure schemes so an operator who
    fat-fingered nats:// for tls:// gets an actionable message. RED today:
    the message only mentions wss://."""
    with pytest.raises(ValueError) as exc:
        assert_wss_or_localhost(_NATS_PLAINTEXT)
    message = str(exc.value)
    assert "wss://" in message, "error must still cite wss://"
    assert "tls://" in message, (
        "error must cite tls:// as an acceptable secure scheme "
        f"(got: {message!r})"
    )


def test_rejects_bare_ws_non_localhost() -> None:
    with pytest.raises(ValueError):
        assert_wss_or_localhost(_WS_PLAINTEXT)


# ── localhost bypass unchanged for every scheme ──────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "ws://localhost:8080",
        "nats://127.0.0.1:4222",
        "tls://localhost:4222",
        "wss://localhost",
        "ws://0.0.0.0:8080",
        "nats://dev.localhost:4222",
    ],
)
def test_accepts_any_scheme_against_localhost(url: str) -> None:
    """The localhost bypass is orthogonal to the scheme widening — every
    scheme (including plaintext) is allowed when the host is local."""
    assert_wss_or_localhost(url)
