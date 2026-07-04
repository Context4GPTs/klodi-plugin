"""Loud-fail + per-family well-formed-CA trust (py) — self-contained.

Card: gate-auto-trust-on-well-formed-ca-loud-fail.

This suite closes the blind spot the sibling `auto-trust-nats-ca-from-register`
does NOT cover. The sibling proves a bad PEM *fails closed at trust-context
build*; here the served CA is **PEM-valid and the trust context builds**, but it
cannot anchor the handshake (wrong-signer / keyUsage-missing). The failure must
be **LOUD, TERMINAL, PROMPT (bounded-time), and attributable** — never the
indefinite ``bridge_register_starting`` hang the defect produced.

Unlike the gated ``test_tls_ca_integration.py`` / ``test_nats_ca_register_e2e.py``
(which need an external ``tls://`` NATS on the klodi-stage bed), this file is
**self-contained** — it stands up an in-process ``ssl`` TLS server against the
local CA fixtures, so it RUNS in plain CI. It lives in the top-level ``tests/``
dir (NOT ``tests/integration/``, whose conftest skips the whole dir without
``INTEGRATION=1``) precisely so it always runs.

Tier: mostly ``[integration]`` (a real localhost TLS handshake crosses the
network boundary) plus one ``[unit]`` attribution test on the parse boundary.

The load-bearing PROMPTNESS proof: a wrong-CA ``connect()`` is driven under
``asyncio.wait_for``. Today ``KlodiClient.connect()`` retries the deterministic
TLS-verify failure **forever** (``max_reconnect_attempts=-1`` +
``allow_reconnect=True`` — see ``client.py``), so ``wait_for`` raises
``TimeoutError`` → RED. The GREEN fix classifies the deterministic CA/TLS-verify
failure on the initial connect as terminal and raises the structured
``CaTrustError`` promptly. Each negative test is PAIRED with a
transient-failure-still-retries guard so the classifier cannot over-reach.

QA-owned. NEVER weaken — push failures back to the expert-developer.
"""

from __future__ import annotations

import socket
import ssl
import threading
import time
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import pytest

from klodi_nats_client.client import KlodiClient
from klodi_nats_client.tls import CaTrustError, build_tls_context, persist_nats_ca

_CA_FILE_ENV = "KLODI_NATS_CA_FILE"

# A wrong-CA connect must reach a terminal error well within this bound. The
# client's reconnect_time_wait is 2s and it currently retries forever, so a
# hang trips wait_for at this bound (TimeoutError, not CaTrustError) → RED. A
# correctly-classified terminal failure surfaces on the first attempt (<1s on
# localhost), far under this bound.
_TERMINAL_BOUND_S = 8.0

# The transient (refused-port) guard: within this short window a transient
# failure must STILL be retrying (never a terminal CaTrustError). Kept short so
# the guard is quick.
_TRANSIENT_WINDOW_S = 3.0


# ── Fixture location (shared across the three language families) ─────────────


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise RuntimeError("pnpm-workspace.yaml not found above this test")


_FX = _repo_root() / "test-fixtures" / "tls-ca"


def _fx(name: str) -> Path:
    path = _FX / name
    assert path.is_file(), f"missing TLS fixture {path} (run test-fixtures/tls-ca/gen.sh)"
    return path


# ── In-process TLS server presenting a chosen server cert/chain ──────────────


# A plaintext NATS ``INFO`` line advertising ``tls_required`` — what a real
# ``tls://`` NATS endpoint (STARTTLS, the klodi transport model) sends BEFORE the
# TLS upgrade. Needed so ``KlodiClient.connect()`` (which speaks STARTTLS via
# nats-py, ``tls_handshake_first`` defaulting False) reaches the TLS upgrade and
# surfaces the real cert-verify failure — an *implicit*-TLS server would deadlock
# the STARTTLS client (it waits for INFO; the server waits for a ClientHello),
# producing a bare timeout instead of the CA-trust failure under test. See the
# In Dev handoff (dev corrected this server's TLS negotiation to STARTTLS).
_STARTTLS_INFO = (
    b'INFO {"server_id":"TEST","version":"2.10.0","proto":1,'
    b'"max_payload":1048576,"tls_required":true,"headers":true}\r\n'
)


class _LocalTlsServer:
    """A localhost TLS server that presents ``certfile`` (+ its chain) and
    ``keyfile``. Loop-accepts so the client's reconnect storm sees a real TLS
    handshake on every attempt (not a spurious connection-refused). The
    server never speaks NATS beyond the handshake prologue — it exists only to
    drive the TLS handshake.

    ``starttls`` selects the negotiation model:
      * ``False`` (default) — *implicit* TLS: upgrade on accept. For a RAW
        handshake the TEST performs itself (the Pillar-A positive probe of
        ``build_tls_context``'s context).
      * ``True`` — NATS *STARTTLS*: send the plaintext ``INFO`` (``tls_required``)
        line, THEN upgrade. Required to drive ``KlodiClient.connect()`` (a
        STARTTLS client) through the real cert-verify path in the negative tests.
    """

    def __init__(
        self, certfile: Path, keyfile: Path, *, starttls: bool = False
    ) -> None:
        self._ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._ctx.load_cert_chain(certfile=str(certfile), keyfile=str(keyfile))
        self._starttls = starttls
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self._sock.settimeout(0.25)
        self.port: int = self._sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                if self._starttls:
                    # NATS STARTTLS prologue: advertise tls_required, then upgrade.
                    conn.sendall(_STARTTLS_INFO)
                tls = self._ctx.wrap_socket(conn, server_side=True)
                tls.recv(64)
                tls.close()
            except OSError:
                try:
                    conn.close()
                except OSError:
                    pass
        try:
            self._sock.close()
        except OSError:
            pass

    def __enter__(self) -> _LocalTlsServer:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=3)


# ── Shared harness ───────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _no_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """Trust comes only from the persisted register CA — never a leaked
    ``KLODI_NATS_CA_FILE``."""
    monkeypatch.delenv(_CA_FILE_ENV, raising=False)


def _home_for(tmp_path: Path, nats_url: str, ca_pem_path: Path) -> tuple[str, str]:
    """A self-contained ``${KLODI_HOME}``: a placeholder creds file (nats-py
    reads creds only when signing the CONNECT nonce — i.e. AFTER the TLS
    handshake — so the negative paths never touch its contents), a config
    pointing at ``nats_url``, and the register CA persisted at
    ``${KLODI_HOME}/nats-ca.pem`` (the level-2 auto-trust source)."""
    import json

    creds_path = tmp_path / "nats.creds"
    creds_path.write_text("placeholder — not read before the TLS handshake\n")
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "handle": "tlsuser",
                "user_id": "00000000-0000-4000-8000-000000000001",
                "nkey_public": "UTLSTEST",
                "nats_url": nats_url,
            }
        )
    )
    persist_nats_ca(tmp_path, ca_pem_path.read_text(encoding="utf-8"))
    return str(creds_path), str(config_path)


async def _connect_disposition(
    creds_path: str, config_path: str, bound: float
) -> tuple[str, float, BaseException | None]:
    """Drive ``connect()`` under a bounded timeout. Returns
    ``(kind, elapsed, err)`` where kind ∈ {"connected", "timeout", "error"}.
    "timeout" is the hang (still retrying at ``bound``)."""
    import asyncio

    client = KlodiClient(creds_path=creds_path, config_path=config_path)
    started = time.monotonic()
    try:
        await asyncio.wait_for(client.connect(), timeout=bound)
        return ("connected", time.monotonic() - started, None)
    except asyncio.TimeoutError:
        return ("timeout", time.monotonic() - started, None)
    except BaseException as err:  # noqa: BLE001 — classify the surfaced error
        return ("error", time.monotonic() - started, err)
    finally:
        try:
            await client.close()
        except BaseException:  # noqa: BLE001 — best-effort teardown
            pass


# ── Pillar A — a well-formed keyUsage-bearing served CA is trusted (py) ──────
# [integration] GUARD: locks in that the merged auto-trust path anchors a REAL
# handshake (cert + hostname) with a keyUsage-bearing CA — proven for the
# Python family, never extrapolated from another.


def test_keyusage_ca_anchors_a_real_handshake_cert_and_hostname(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    persist_nats_ca(home, _fx("ca-good.pem").read_text(encoding="utf-8"))

    with _LocalTlsServer(_fx("leaf-good.pem"), _fx("leaf-good.key")) as server:
        ctx, _source = build_tls_context(f"tls://localhost:{server.port}", klodi_home=home)
        assert ctx is not None
        # The resolver/build path keeps verification ON.
        assert ctx.check_hostname is True
        assert ctx.verify_mode is ssl.CERT_REQUIRED

        # Cert verifies AND hostname matches the leaf SAN (DNS:localhost).
        with closing(socket.create_connection(("127.0.0.1", server.port), timeout=5)) as raw:
            with ctx.wrap_socket(raw, server_hostname="localhost") as tls:
                assert tls.getpeercert(), "verified handshake must expose the peer cert"

        # And hostname verification is genuinely enforced: the same trusted
        # context rejects a hostname the leaf does not carry.
        with closing(socket.create_connection(("127.0.0.1", server.port), timeout=5)) as raw:
            with pytest.raises(ssl.CertificateError):
                ctx.wrap_socket(raw, server_hostname="not-in-san.example")


# ── Pillar B — malformed/untrusted served CA fails LOUD, TERMINAL, PROMPT ────
# [integration] RED driver: wrong-signer CA (the universally-rejected case).


def test_wrong_signer_ca_fails_terminally_and_promptly(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    with _LocalTlsServer(
        _fx("leaf-good.pem"), _fx("leaf-good.key"), starttls=True
    ) as server:
        creds, config = _home_for(home, f"tls://localhost:{server.port}", _fx("ca-wrong.pem"))
        kind, elapsed, err = _sync_disposition(creds, config, _TERMINAL_BOUND_S)

    assert kind != "timeout", (
        f"wrong-signer connect HUNG past {_TERMINAL_BOUND_S}s (retried forever) — a "
        "deterministic CA/TLS-verify failure on the initial connect must be terminal, "
        "not swallowed by the unbounded reconnect policy"
    )
    assert kind == "error" and isinstance(err, CaTrustError), (
        "a wrong-signer served CA must surface a structured CaTrustError, not a bare "
        f"ssl/transport error or a silent non-connection (got kind={kind!r} err={err!r})"
    )
    _assert_attributable(err)
    assert elapsed < _TERMINAL_BOUND_S


# [integration] RED driver: keyUsage-missing served chain (strict-stack, py/rs).


def test_keyusage_missing_chain_fails_terminally_and_promptly(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    # Server presents leaf + a keyUsage-defective intermediate; the client
    # trusts the good root, so path-building refuses the intermediate.
    with _LocalTlsServer(
        _fx("chain-nokeyusage.pem"), _fx("leaf-viachain.key"), starttls=True
    ) as server:
        creds, config = _home_for(home, f"tls://localhost:{server.port}", _fx("ca-good.pem"))
        kind, elapsed, err = _sync_disposition(creds, config, _TERMINAL_BOUND_S)

    assert kind != "timeout", (
        f"keyUsage-missing connect HUNG past {_TERMINAL_BOUND_S}s — the motivating "
        "defect shape (PEM-valid, unusable-as-anchor) must fail terminally and promptly"
    )
    assert kind == "error" and isinstance(err, CaTrustError), (
        "a keyUsage-missing served CA must surface a structured CaTrustError "
        f"(got kind={kind!r} err={err!r})"
    )
    _assert_attributable(err)
    assert elapsed < _TERMINAL_BOUND_S


# [integration] GUARD (pair for the classifier): a TRANSIENT failure — a
# refused port — must NOT be classified as a terminal CA-trust failure; it
# keeps retrying. This is the guard against the classifier over-reaching.


def test_transient_refused_port_is_not_a_terminal_ca_failure(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    # A port with nothing listening → connection refused (transient).
    with closing(socket.socket()) as probe:
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
    # (probe closed → the port is now free/unbound → connect is refused)
    creds, config = _home_for(home, f"tls://127.0.0.1:{dead_port}", _fx("ca-good.pem"))
    kind, _elapsed, err = _sync_disposition(creds, config, _TRANSIENT_WINDOW_S)

    assert not (kind == "error" and isinstance(err, CaTrustError)), (
        "a refused-port (transient) failure must NOT be classified as a terminal "
        "CaTrustError — only the deterministic CA/TLS-verify class fails fast; "
        "transient flaps keep retrying (resilience must not regress)"
    )


# ── Pillar B — attribution [unit] (parse boundary structured wrap) ───────────


def test_malformed_persisted_ca_raises_attributable_ca_trust_error(
    tmp_path: Path,
) -> None:
    """[unit] A persisted register CA that is PEM-shaped but not a valid cert →
    ``build_tls_context`` must raise the structured ``CaTrustError`` (today it
    leaks a bare ``ssl.SSLError`` → RED), and the message must be attributable:
    name a CA-trust/TLS failure AND the served-CA source (the persisted file)
    so the operator knows the remedy."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "nats-ca.pem").write_text(
        "-----BEGIN CERTIFICATE-----\nnot-valid-base64-!!!-garbage\n"
        "-----END CERTIFICATE-----\n",
        encoding="utf-8",
    )

    with pytest.raises(CaTrustError) as excinfo:
        build_tls_context("tls://kodama.proxy.example:37360", klodi_home=home)

    _assert_attributable(excinfo.value)
    assert "nats-ca.pem" in str(excinfo.value), (
        "the error must name the persisted register CA as the source so the "
        "operator knows to re-register (or set the CA-file override)"
    )


# ── helpers ──────────────────────────────────────────────────────────────────


def _sync_disposition(creds: str, config: str, bound: float):
    """Run the async disposition probe from a sync test body."""
    import asyncio

    return asyncio.run(_connect_disposition(creds, config, bound))


def _assert_attributable(err: BaseException | None) -> None:
    """The surfaced error must identify a CA-trust / TLS-verification failure
    (not a bare timeout / generic network error). Case-insensitive so idiomatic
    phrasing is allowed; the *category* is what must be legible."""
    text = str(err).lower()
    assert any(tok in text for tok in ("ca", "certificate", "cert", "tls", "trust", "verif")), (
        "a bad-CA error must be legible as a CA-trust / TLS-verification failure, "
        f"not an opaque timeout/network error: {err!r}"
    )
