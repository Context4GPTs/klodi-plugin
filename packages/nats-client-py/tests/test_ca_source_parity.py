"""CA-source precedence has ONE encoding — the resolver (py).

The precedence walk (env → persisted → bundled) and the operator-facing
source label are produced in exactly one place — ``build_tls_context`` (via
``_resolve_ca_pem``) — and the connect-failure attribution *consumes* that
label instead of re-deriving the order. The parallel ``describe_ca_source``
helper is deleted; there is no second encoding to drift.

This pin asserts, per precedence level (env / persisted / bundled):

  (a) the resolver reports the exact expected source label, and
  (b) the loud-fail ``CaTrustError`` the client assembles names *exactly*
      that same label — proving attribution consumes the resolver's
      selection.

Plus two structural guards: the attribution site performs no independent
env/filesystem walk (it echoes whatever the resolver reported, even a
value that matches no real level), and the label set the resolver can
report is exhaustive over the precedence levels.

QA-owned. NEVER weaken — push failures back to the expert-developer.
"""

from __future__ import annotations

import asyncio
import ssl
from collections.abc import Iterator
from pathlib import Path

import pytest

from klodi_nats_client.client import KlodiClient
from klodi_nats_client.tls import CaTrustError, build_tls_context

_CA_FILE_ENV = "KLODI_NATS_CA_FILE"
_TLS_URL = "tls://hayabusa.proxy.rlwy.net:32770"

# A single valid self-signed test CA — the parity pin cares about the
# *source label*, not the trusted identity (that is covered by
# test_nats_ca_resolve.py). Reused for both the env-file and the persisted
# file so any level resolves to a real, parseable context.
_CA_PEM = """-----BEGIN CERTIFICATE-----
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


@pytest.fixture
def klodi_home(tmp_path: Path) -> Path:
    home = tmp_path / "klodi"
    home.mkdir()
    return home


@pytest.fixture(autouse=True)
def clear_ca_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv(_CA_FILE_ENV, raising=False)
    yield


def _persisted(klodi_home: Path) -> Path:
    return klodi_home / "nats-ca.pem"


def _attributed_source(source: str | None) -> str:
    """The ``<source>`` the client renders into the loud-fail message for a
    stored ``_ca_source`` — driving the exact attribution site the operator
    reads, with no live connect. Fails the test if it is not the terminal
    ``CaTrustError`` (a transient reclassification would break the contract).
    """
    client = KlodiClient(creds_path="unused", config_path="unused")
    client._ca_source = source
    client._connecting_initial = True
    verify_err = ssl.SSLCertVerificationError("certificate verify failed")
    with pytest.raises(CaTrustError) as excinfo:
        asyncio.run(client._async_error_cb(verify_err))
    return str(excinfo.value)


def test_env_source_reported_and_attributed(
    klodi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[unit] env level: resolver-reported source == attributed source."""
    env_ca = tmp_path / "env-ca.pem"
    env_ca.write_text(_CA_PEM, encoding="utf-8")
    monkeypatch.setenv(_CA_FILE_ENV, str(env_ca))

    _ctx, source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert source == f"{_CA_FILE_ENV}={env_ca}"
    assert f"served NATS CA ({source})" in _attributed_source(source)


def test_persisted_source_reported_and_attributed(klodi_home: Path) -> None:
    """[unit] persisted level: resolver-reported source == attributed source."""
    _persisted(klodi_home).write_text(_CA_PEM, encoding="utf-8")

    _ctx, source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert source == f"persisted register CA at {_persisted(klodi_home)}"
    assert f"served NATS CA ({source})" in _attributed_source(source)


def test_bundled_source_reported_and_attributed(klodi_home: Path) -> None:
    """[unit] bundled level (empty bundle → system store): the resolver still
    reports the bundled label and the loud-fail names exactly it."""
    _ctx, source = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    assert source == "bundled KLODI_NATS_CA_PEM"
    assert f"served NATS CA ({source})" in _attributed_source(source)


def test_attribution_echoes_resolver_and_never_rewalks() -> None:
    """[unit] The attribution site derives its label *solely* from the stored
    resolver selection — a sentinel that matches no real precedence level is
    rendered verbatim, proving no independent env/filesystem re-walk."""
    sentinel = "SENTINEL-CA-SOURCE-not-a-real-level"
    assert f"served NATS CA ({sentinel})" in _attributed_source(sentinel)


def test_resolver_source_is_exhaustive_over_levels(
    klodi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """[unit] Every precedence level the resolver can select yields a
    non-empty label — the mapping is exhaustive, so adding/removing a level is
    a single resolver-side edit with attribution staying correct."""
    # bundled / system store
    _bundled_ctx, bundled = build_tls_context(_TLS_URL, klodi_home=klodi_home)
    # persisted
    _persisted(klodi_home).write_text(_CA_PEM, encoding="utf-8")
    _persisted_ctx, persisted = build_tls_context(_TLS_URL, klodi_home=klodi_home)
    # env override
    env_ca = tmp_path / "env-ca.pem"
    env_ca.write_text(_CA_PEM, encoding="utf-8")
    monkeypatch.setenv(_CA_FILE_ENV, str(env_ca))
    _env_ctx, env = build_tls_context(_TLS_URL, klodi_home=klodi_home)

    labels = {env, persisted, bundled}
    assert len(labels) == 3, "each level must yield a distinct, populated label"
    assert all(label for label in labels)
