"""RED — CA resolution consults the persisted register-response CA (py).

Card: auto-trust-nats-ca-from-register.

The register/session response's ``nats_ca`` is persisted to
``${KLODI_HOME}/nats-ca.pem`` and becomes a NEW level-2 trust source in the
``tls://`` CA resolver, ranked strictly:

  1. ``KLODI_NATS_CA_FILE`` env  — explicit operator override; short-circuits
     (the persisted file is not even read when this is set).
  2. ``${KLODI_HOME}/nats-ca.pem`` — persisted register-response CA. **NEW.**
  3. bundled ``KLODI_NATS_CA_PEM`` catalog constant — static fallback.
  4. system trust store — verify-ON final fallback.

These are BEHAVIOURAL tests through the public ``build_tls_context`` surface:
we introspect the resulting ``SSLContext`` with ``get_ca_certs()`` to prove
*which* CA it actually trusts, and rely on ``ssl``'s own PEM parsing to prove
fail-closed on a malformed persisted CA. The verifying posture
(``check_hostname`` + ``CERT_REQUIRED``) is asserted on every returned context.

RED today: ``build_tls_context`` takes only ``nats_url`` and never consults a
persisted ``nats-ca.pem`` — it has no ``klodi_home`` parameter. The dev threads
``klodi_home`` in and adds the level-2 step.

Governing invariant (ADR-0022): this adds a CA *source*, never a verification
toggle. QA-owned — NEVER weaken; push failures back to the expert-developer.
"""

from __future__ import annotations

import ssl
from collections.abc import Iterator
from pathlib import Path

import pytest

from klodi_nats_client.tls import CaTrustError, build_tls_context

# Two DISTINCT valid self-signed test CAs (generated with openssl, CN carries
# the identity we introspect). Alpha stands in for the operator's explicit
# ``KLODI_NATS_CA_FILE``; Beta for the server-sent register CA.
_CA_ALPHA_CN = "klodi-test-ca-alpha"
_CA_ALPHA_PEM = """-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUdooZy0BQuqSNCu94q6A/ScED/jQwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTa2xvZGktdGVzdC1jYS1hbHBoYTAeFw0yNjA3MDQxMjIx
MDBaFw0zNjA3MDExMjIxMDBaMB4xHDAaBgNVBAMME2tsb2RpLXRlc3QtY2EtYWxw
aGEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5J9sl5etTkVas1jjH
BmZh9l+uTFBJx7K1ZBn8lhknItWTdVUaY2GPi7nwFLdjhpDF9ZW8Q+Pm9ZxnH0ak
W6Echu3/Q9xIllRJIGpvOFns0wjbafz8RmcrVejO1JytMH22KY4zIAbcDyHY4kmy
q/sEKyYrRwzirmkY89z9ruIYymtYEnOpne6G3o0SCHP9/aA22obrqKEnSeBTt9pt
/becrfDyiSIR092+XqCBqGZ1RozNY5DXERCEKGMRlviuKWxlH1s+ut/YrCij7kSl
el5Iet4jvIdzm2drBCsIsiJvdBb4+gjZcRExIYaoEUcdLZgAv8nD6M6WEi4E+y1Q
d1HXAgMBAAGjUzBRMB0GA1UdDgQWBBSfJZNs2ahEw+OnPQBv7N52+W9hRzAfBgNV
HSMEGDAWgBSfJZNs2ahEw+OnPQBv7N52+W9hRzAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQA5E4znjCNDZBTmE4jWma5UWuGBslC15bLVmVFGIZoV
qhvwekFxJ3U+n1suhsZh8NOJj9P0lSao+cJJtOkhTbz2TUXLTIbPPHZvC9vge020
Cj55CkjQCcbT7tGFFZym1Bmy9rfJRA0x/wwsFpJHjnGYlmO9nvZ0s7QOnmqnPqaF
wIVtXE3uhugfQp3kBK0O054tJf1RHcBvQQRAG4gq1Pz93z5LuoC1b6+zLe8MeOi3
Z2AcGF8bZYroN1ej66eb5Wcqtn+qcS2kbNkws1NWBkDUeKRvxSr60AHu5VkY0uTP
4EV45itbMyAL9zboFSA5gR6/Wbjyz+A9osro8Prc3cjn
-----END CERTIFICATE-----
"""

_CA_BETA_CN = "klodi-test-ca-beta"
_CA_BETA_PEM = """-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUOYd0yLhlGK5jH6xxwvE3S5v0cakwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSa2xvZGktdGVzdC1jYS1iZXRhMB4XDTI2MDcwNDEyMjEw
MFoXDTM2MDcwMTEyMjEwMFowHTEbMBkGA1UEAwwSa2xvZGktdGVzdC1jYS1iZXRh
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtaUcJW6DMvTuV3j4LlBz
vRKm4B7Y4Yh/6D2mk3PpIZu0qVQXlzSr5B0Y/AXCooJxmW3p7/O21Vxf44kzDG4n
sbsgnq5UKmVnISzloymUhDF181e+tb7QHMye227SfM7liK4DdQ4lZzTx7tbDU9wI
Too/810UlL6+nlW67r4RIm3rGNCmrG6YQ8OW9Xpfub/IaDtJl+1xmXOpeASYuEEb
dw//FgdR+9BsiSDwn44ZJEDNAk6ddgX6BxK2vkoM5nsXOz+yT9BQGvSo7IIxM5DZ
fpq43DGiBnl6n1TKHkUodoWxpZ7/r2wAtO0PkCqHGYtlmcWm9Dq8uK3v0NJBgAV8
1wIDAQABo1MwUTAdBgNVHQ4EFgQU740IbcLfYe9+daxQ7v/pAE2EVxkwHwYDVR0j
BBgwFoAU740IbcLfYe9+daxQ7v/pAE2EVxkwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAC7gCQ/KxNgGRitStItsoScBqrE9oK0Dim4gA//+YrQjm
v3Mvns5LkKOh77gQ0Jjtke4WlaUgVfxLbaAAN2DxBltr2WFwLA03JZ3+q3CZZ8M/
6m1tbwlcVu+ImOlQZ9/ObWNlKD5510Z8qGmbrkw8Qo0c8hV/4X3hiBji3pRoTIaJ
uh6C6QqErvGUW6HfVZ/8oPxe5C/iVqJzYLX8jYQP+vzIT+rCRCIXvLLpKun74Oc/
DWKR7pY4DKpPbFfu3K7xwH+704ZTR7Zd3Mlcqq1sp87nBLOG9biVePFvKUzwr0U3
mb2pW8e2eH2dGBHieO2EWxmsoTfQIiKcJua4dibV+Q==
-----END CERTIFICATE-----
"""

# PEM-*shaped* (passes a cheap "-----BEGIN CERTIFICATE-----" sniff) but the
# body is not valid base64 DER — ``ssl`` rejects it at context build. Models
# Open questions #4's "PEM-shaped but deep-invalid" persisted CA that must
# fail CLOSED at connect, never loosen verification.
_MALFORMED_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "not-valid-base64-!!!-garbage\n"
    "-----END CERTIFICATE-----\n"
)

_TLS_URL = "tls://kodama.proxy.rlwy.net:37360"
_WSS_URL = "wss://klodi-net.4gpts.com"
_CA_FILE_ENV = "KLODI_NATS_CA_FILE"


def _persisted_ca_path(klodi_home: Path) -> Path:
    """The well-known persisted-CA location the resolver must consult.
    Filename fixed by the design (``${KLODI_HOME}/nats-ca.pem``); the persist
    test pins that ``nats_ca_path`` returns exactly this."""
    return klodi_home / "nats-ca.pem"


def _trusted_cns(ctx: ssl.SSLContext) -> set[str]:
    """The CommonNames of the CAs the context actually trusts. When a private
    CA is loaded via ``cadata`` the context trusts ONLY that CA, so this is an
    exact identity probe of which source won resolution."""
    cns: set[str] = set()
    for cert in ctx.get_ca_certs():
        for rdn in cert.get("subject", ()):  # type: ignore[union-attr]
            for key, value in rdn:
                if key == "commonName":
                    cns.add(value)
    return cns


@pytest.fixture
def klodi_home(tmp_path: Path) -> Path:
    home = tmp_path / "klodi"
    home.mkdir()
    return home


@pytest.fixture(autouse=True)
def clear_ca_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv(_CA_FILE_ENV, raising=False)
    yield


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


# ── Scenario 2 — explicit operator config takes precedence ──────────────────


def test_env_override_wins_over_persisted_register_ca(
    klodi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[unit] Both a persisted register nats_ca AND KLODI_NATS_CA_FILE present
    → the env override wins; the register CA is NOT substituted."""
    env_ca = _write(tmp_path / "env-ca.pem", _CA_ALPHA_PEM)
    _write(_persisted_ca_path(klodi_home), _CA_BETA_PEM)
    monkeypatch.setenv(_CA_FILE_ENV, str(env_ca))

    ctx, _source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert ctx is not None
    assert _trusted_cns(ctx) == {_CA_ALPHA_CN}, (
        "explicit KLODI_NATS_CA_FILE must win — the persisted register CA "
        "must not be silently substituted"
    )
    assert _CA_BETA_CN not in _trusted_cns(ctx)


def test_env_override_short_circuits_persisted_not_even_read(
    klodi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[unit] Env override set + a MALFORMED persisted nats_ca on disk → the
    resolver short-circuits on the env CA and never reads/parses the persisted
    file (if it did, the malformed PEM would raise). Strict precedence, no CA
    union, no divergence read. Resolves Open questions #3."""
    env_ca = _write(tmp_path / "env-ca.pem", _CA_ALPHA_PEM)
    _write(_persisted_ca_path(klodi_home), _MALFORMED_PEM)
    monkeypatch.setenv(_CA_FILE_ENV, str(env_ca))

    # Must NOT raise — proves the malformed persisted file was never touched.
    ctx, _source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert ctx is not None
    assert _trusted_cns(ctx) == {_CA_ALPHA_CN}


# ── Scenario 1 — auto-trust the persisted register CA (fresh process) ───────


def test_persisted_register_ca_is_trusted_when_no_env(klodi_home: Path) -> None:
    """[unit] Env unset + a persisted register nats_ca present → the trust
    context is built from the persisted CA (the fresh-process resolve half of
    'register → done')."""
    _write(_persisted_ca_path(klodi_home), _CA_BETA_PEM)

    ctx, _source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert ctx is not None
    assert _trusted_cns(ctx) == {_CA_BETA_CN}, (
        "with no env override the persisted register CA must be trusted"
    )
    assert ctx.check_hostname is True
    assert ctx.verify_mode is ssl.CERT_REQUIRED


# ── Scenario 3 — response omits nats_ca → no regression ─────────────────────


def test_no_persisted_and_no_env_falls_through_to_system_store(
    klodi_home: Path,
) -> None:
    """[unit] Env unset, no persisted nats_ca, bundled constant empty → falls
    through to the system trust store (a verifying default context that trusts
    NEITHER test CA). No regression from pre-change."""
    ctx, _source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert ctx is not None
    trusted = _trusted_cns(ctx)
    assert _CA_ALPHA_CN not in trusted
    assert _CA_BETA_CN not in trusted
    assert ctx.check_hostname is True
    assert ctx.verify_mode is ssl.CERT_REQUIRED


def test_manual_ca_host_unchanged_when_response_omits_nats_ca(
    klodi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[unit] Host already on a manual KLODI_NATS_CA_FILE and NO persisted
    nats_ca → resolution is behaviourally identical to pre-change (the env CA
    is trusted); hosts on manual CA see no change."""
    env_ca = _write(tmp_path / "env-ca.pem", _CA_ALPHA_PEM)
    monkeypatch.setenv(_CA_FILE_ENV, str(env_ca))

    ctx, _source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert ctx is not None
    assert _trusted_cns(ctx) == {_CA_ALPHA_CN}


# ── Boundary / error paths ──────────────────────────────────────────────────


def test_malformed_persisted_ca_fails_closed(klodi_home: Path) -> None:
    """[unit] A persisted nats_ca that is PEM-shaped but not a valid cert →
    building the tls:// trust context fails CLOSED. TIGHTENED by card
    gate-auto-trust-on-well-formed-ca-loud-fail: the parse-boundary failure must
    surface as the STRUCTURED, attributable ``CaTrustError`` (today it leaks a
    bare ``ssl.SSLError`` → RED), not merely "some exception". The message must
    name the served-CA source so the operator knows the remedy. Open questions
    #4. QA-owned — do NOT relax back to a bare-exception assertion."""
    _write(_persisted_ca_path(klodi_home), _MALFORMED_PEM)

    with pytest.raises(CaTrustError) as excinfo:
        build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert "nats-ca.pem" in str(excinfo.value), (
        "the CaTrustError must name the persisted register CA as the source"
    )


def test_wss_url_never_consults_persisted_nats_ca(klodi_home: Path) -> None:
    """[unit] nats_ca present but the url is wss:// (not tls://) → private-CA
    trust is a tls://-only concern, so nats_ca is not consulted and wss://
    behaviour is unchanged. A malformed persisted CA proves it is never read
    (else it would raise)."""
    _write(_persisted_ca_path(klodi_home), _MALFORMED_PEM)

    # wss:// short-circuits before any CA resolution → None, no raise.
    assert build_tls_context(_WSS_URL, klodi_home=klodi_home) is None
