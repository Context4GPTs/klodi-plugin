"""Hermes bridge surfacing audit — a bad served CA reaches a TERMINAL
``bridge_register_failed``, never pinned at ``bridge_register_starting`` (the
defect).

This is the per-adapter surfacing witness at the exact defect site
(``bridge.py:449-461``). The motivating defect: a served keyUsage-missing CA
made the shared client's ``connect()`` retry forever, so ``klodi.register(ctx)``
never returned or raised and the bridge sat pinned at ``bridge_register_starting``
— fail-closed in theory, invisible to the operator in practice.

The FIX is rooted in the shared ``nats-client`` (a deterministic CA/TLS-verify
failure on the initial connect is reclassified as a terminal, structured error
instead of an infinite retry — proven in ``packages/nats-client-{py,ts,rs}``).
This test audits the CONSEQUENCE at the hermes lifecycle: once ``register()``
raises promptly (the shared-client contract), the bridge's existing terminal
path surfaces ``bridge_register_failed`` **bounded in time** and does NOT hang
at the ``starting`` pin. The bridge's ``except BaseException`` catch is
type-agnostic, so this drives it with a stand-in for the shared client's
terminal CA-trust error (the real ``CaTrustError`` type propagation is covered
by the shared-client suites).

QA-owned. NEVER weaken.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from klodi_hermes.bridge import Bridge

# The bad-CA connect must surface a terminal bridge state well within this
# bound; a hang (the defect) means the worker thread is still alive at the
# bound → the assertion fails.
_TERMINAL_BOUND_S = 5.0


class _SharedClientCaTrustError(RuntimeError):
    """Stand-in for ``klodi_nats_client.tls.CaTrustError`` — the structured,
    attributable terminal error the fixed shared client raises for a served CA
    that cannot anchor the handshake. The message mirrors the shared contract:
    it names a CA-trust / TLS-verification failure and the served CA source."""


class _BadCaKlodi:
    """A klodi module whose ``register`` raises the terminal CA-trust error the
    fixed shared client now produces for a bad served CA (instead of hanging)."""

    def register(self, _ctx: Any) -> None:
        raise _SharedClientCaTrustError(
            "served NATS CA ${KLODI_HOME}/nats-ca.pem could not be trusted: "
            "certificate verify failed; verification is never disabled — "
            "re-register or set KLODI_NATS_CA_FILE"
        )


def test_bad_ca_register_reaches_terminal_failed_not_pinned_at_starting(
    tmp_path: Path, caplog: Any
) -> None:
    home = tmp_path / "klodi"
    home.mkdir()
    bridge = Bridge(
        klodi_home=home,
        hermes_bin="/usr/bin/hermes",
        creds_poll_seconds=0.01,
        ctx_factory=lambda: SimpleNamespace(),
        klodi_loader=_BadCaKlodi,
    )

    result: dict[str, bool] = {}

    def run() -> None:
        result["returned"] = bridge._register_plugin()

    with caplog.at_level(logging.INFO, logger="klodi_hermes.bridge"):
        worker = threading.Thread(target=run)
        worker.start()
        worker.join(timeout=_TERMINAL_BOUND_S)

        assert not worker.is_alive(), (
            "bridge register PINNED at bridge_register_starting (hung past "
            f"{_TERMINAL_BOUND_S}s) — a bad served CA must drive the bridge to a "
            "terminal state in bounded time, not an indefinite stall"
        )

    assert result.get("returned") is False, (
        "a bad served CA at register must reach the terminal path "
        "(bridge_register_failed → run loop exits), not succeed"
    )

    messages = [r.message for r in caplog.records]
    assert any("bridge_register_starting" in m for m in messages), (
        "the bridge must have begun the register (starting) — otherwise the test "
        "is not exercising the defect path"
    )
    assert any("bridge_register_failed" in m for m in messages), (
        "the bridge must PROGRESS PAST the starting pin to the surfaced terminal "
        "bridge_register_failed — the closed blind spot"
    )
