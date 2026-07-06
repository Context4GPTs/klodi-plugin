"""RED — persist the register-response CA to ${KLODI_HOME}/nats-ca.pem (py).

Two shared helpers land in the Python nats-client:

  * ``paths.nats_ca_path(klodi_home)`` — the single source of the persisted-CA
    filename (``${KLODI_HOME}/nats-ca.pem``), shared by write and read so they
    can never disagree on location.
  * ``tls.persist_nats_ca(klodi_home, pem)`` — atomic write, mode **0644**
    (the CA cert is non-secret per ADR-0022 §Security, unlike the 0600 nkey
    creds). A non-PEM-shaped or empty value is SKIPPED (never written, never
    raises) so a garbage ``nats_ca`` can never fail registration. Last-write
    wins → re-register is the CA-rotation path.

RED today: neither helper exists.

QA-owned — NEVER weaken.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

from klodi_nats_client.paths import nats_ca_path
from klodi_nats_client.tls import persist_nats_ca

_PEM_A = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIICAlphaFixtureBodyLineOne\n"
    "MIICAlphaFixtureBodyLineTwo\n"
    "-----END CERTIFICATE-----\n"
)
_PEM_B = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIICBetaRotatedFixtureBody\n"
    "-----END CERTIFICATE-----\n"
)


@pytest.fixture
def klodi_home(tmp_path: Path) -> Path:
    home = tmp_path / "klodi"
    home.mkdir()
    return home


def test_nats_ca_path_is_nats_ca_pem_under_home(klodi_home: Path) -> None:
    """[unit] The filename source resolves to ${KLODI_HOME}/nats-ca.pem."""
    assert nats_ca_path(klodi_home) == klodi_home / "nats-ca.pem"


def test_persist_writes_pem_shaped_ca(klodi_home: Path) -> None:
    """[unit] A non-empty PEM-shaped nats_ca is written verbatim to the
    well-known path and round-trips."""
    persist_nats_ca(klodi_home, _PEM_A)

    written = nats_ca_path(klodi_home)
    assert written.is_file(), "persist_nats_ca must write ${KLODI_HOME}/nats-ca.pem"
    assert written.read_text(encoding="utf-8") == _PEM_A


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file mode")
def test_persisted_ca_is_mode_0644(klodi_home: Path) -> None:
    """[unit] The persisted CA is world-readable 0644 — a non-secret cert,
    NOT the 0600 posture of the nkey creds (ADR-0002 vs ADR-0022 §Security)."""
    persist_nats_ca(klodi_home, _PEM_A)

    mode = stat.S_IMODE(nats_ca_path(klodi_home).stat().st_mode)
    assert mode == 0o644, f"expected 0644 for the non-secret CA, got {oct(mode)}"


def test_persist_skips_non_pem_value_without_writing(klodi_home: Path) -> None:
    """[unit] A value that is not PEM-shaped (no BEGIN CERTIFICATE) is skipped:
    nothing is written and NO error is raised — a garbage nats_ca must never
    fail registration (Open questions #4, persist-side disposition)."""
    persist_nats_ca(klodi_home, "definitely not a certificate")

    assert not nats_ca_path(klodi_home).exists(), (
        "a non-PEM-shaped nats_ca must be skipped, not persisted"
    )


def test_persist_skips_empty_value_without_writing(klodi_home: Path) -> None:
    """[unit] An empty nats_ca is skipped (absent / null / "" ⇒ persist
    nothing, no error)."""
    persist_nats_ca(klodi_home, "")

    assert not nats_ca_path(klodi_home).exists()


def test_persist_overwrites_on_rotation(klodi_home: Path) -> None:
    """[unit] A fresh non-empty value overwrites the prior one (last-write
    wins) — re-register is the supported CA-rotation path."""
    persist_nats_ca(klodi_home, _PEM_A)
    persist_nats_ca(klodi_home, _PEM_B)

    assert nats_ca_path(klodi_home).read_text(encoding="utf-8") == _PEM_B
