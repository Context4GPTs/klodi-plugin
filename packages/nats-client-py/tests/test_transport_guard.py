"""RED — transport guard collapsed to ``tls://`` only (py client).

Card: collapse-nats-transport-guard-to-tls-only.
Criteria (Acceptance → the tls-only guard matrix). This flips the prior
``support-tls-nats-transport`` suite from wss://-*acceptance* to
wss://-*rejection*:

  * ``tls://<non-localhost>``  → accepts (the sole prod transport)
  * ``wss://<non-localhost>``  → REJECTS  (was accepted; the collapse)
  * ``ws://<non-localhost>``   → REJECTS  (unchanged)
  * ``nats://<non-localhost>`` → REJECTS  (unchanged)
  * any scheme against localhost → accepts (localhost bypass unchanged)

The guard is the two-family security control (connect-time + persist-time).
This file pins the CONNECT-time shared guard in ``klodi_nats_client.config``.

QA-owned (adversarial-testing). NEVER weaken these asserts to match a
wider implementation.

--- COORDINATION NOTE ---------------------------------------------------
The shared guard is renamed in-dev `assert_encrypted_or_localhost` →
`assert_tls_or_localhost` (Discovery decision #2: once wss:// is rejected
off-localhost, "encrypted" is a lie — name the one accepted scheme). This
file imports the NEW name; the whole suite errors at collection until the
rename lands (expected RED — the rename IS the deliverable). No re-export
shim exists for the old name (CLAUDE.md: no backwards-compat) and none
should.
-------------------------------------------------------------------------
"""

from __future__ import annotations

import re

import pytest

from klodi_nats_client.config import assert_tls_or_localhost

# The pinned prod endpoint: Railway's L4 TCP proxy in front of NATS
# (devops §1 — NOT `kodama`, which is pgvector's Postgres proxy).
_TLS_PROD = "tls://hayabusa.proxy.rlwy.net:32770"
_WSS_PROD = "wss://klodi-net.4gpts.com"
_NATS_PLAINTEXT = "nats://hayabusa.proxy.rlwy.net:4222"
_WS_PLAINTEXT = "ws://attacker.example.com:8080"


# ── tls:// is the sole accepted non-localhost transport ──────────────────


def test_accepts_tls_non_localhost() -> None:
    """The prod transport: raw TLS through the Railway TCP proxy."""
    # Act + Assert — must not raise.
    assert_tls_or_localhost(_TLS_PROD)


def test_accepts_tls_arbitrary_non_localhost_host() -> None:
    # Not tied to the exact proxy hostname — any tls:// host is a TLS
    # transport and passes the tls-or-localhost control.
    assert_tls_or_localhost("tls://nats.example.com:4222")


# ── wss:// is now REJECTED off-localhost (the collapse) ──────────────────


def test_rejects_wss_non_localhost() -> None:
    """The load-bearing flip: ``wss://`` was accepted under the two-scheme
    allow-list; the tls-only cutover rejects it on a non-localhost host."""
    with pytest.raises(ValueError):
        assert_tls_or_localhost(_WSS_PROD)


# ── the other plaintext / encrypted-WS non-localhost schemes reject ──────


def test_rejects_plaintext_nats_non_localhost() -> None:
    """nats:// is plaintext TCP — must never stand in for tls://."""
    with pytest.raises(ValueError):
        assert_tls_or_localhost(_NATS_PLAINTEXT)


def test_rejects_bare_ws_non_localhost() -> None:
    with pytest.raises(ValueError):
        assert_tls_or_localhost(_WS_PLAINTEXT)


# ── rejection message: names tls:// as the sole required scheme ──────────


def test_rejection_message_names_tls_only_and_reregister() -> None:
    """The message is the operator's entire diagnosis surface. Post-collapse
    it must (a) name ``tls://`` as the sole required non-localhost scheme,
    (b) list ``wss://`` among the *rejected* schemes, (c) name re-register as
    the remedy — and it must NO LONGER frame ``wss://`` as acceptable
    (drop the "wss:// or tls://" two-scheme phrasing) nor frame re-register
    as a compromise-only remedy.
    """
    with pytest.raises(ValueError) as exc:
        assert_tls_or_localhost(_WSS_PROD)
    message = str(exc.value)
    # (a) names tls:// as required.
    assert "tls://" in message, f"must name tls:// as required (got: {message!r})"
    # (b) lists wss:// among the rejected schemes.
    assert "wss://" in message, (
        f"must list wss:// among the rejected schemes (got: {message!r})"
    )
    # no longer frames wss:// as an acceptable transport.
    assert "wss:// or tls://" not in message, (
        "message must not present wss:// as acceptable alongside tls:// "
        f"(got: {message!r})"
    )
    assert "must use wss://" not in message, (
        f"message must not require wss:// (got: {message!r})"
    )
    # (c) names re-register as the (benign, migration) remedy.
    assert re.search(r"re-?register", message, re.IGNORECASE), (
        f"must name re-register as the remedy (got: {message!r})"
    )
    # no longer frames re-register as compromise-only.
    assert "compromis" not in message.lower(), (
        "re-register must read as the normal migration remedy, not a "
        f"compromise-only one (got: {message!r})"
    )


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
    """The localhost bypass is orthogonal to the scheme collapse — every
    scheme (including plaintext ``ws://`` and encrypted ``wss://``) is
    allowed when the host resolves to localhost, so dev + the three
    integration harnesses (all on ``ws://localhost``) keep working."""
    assert_tls_or_localhost(url)
