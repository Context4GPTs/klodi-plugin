"""RED — the WS transport crutch is retained + documented as inert on tls://.

Card: support-tls-nats-transport-with-private-ca-trust.
Criterion (Acceptance → "The WS transport crutch does not gate the tls:// path"):

  Given the tls:// (raw TCP + TLS) transport, the py client completes the
  round-trip WITHOUT relying on ``_ws_transport_patch.py``. The patch is
  either removed OR explicitly documented as belt-and-suspenders for the
  surviving ``ws://localhost`` dev path.

Discovery resolved this as KEEP + DOCUMENT (alternative #3 ruled out): the
patch is inert on a ``tls://`` TCP transport but STILL load-bearing on every
``ws://`` connection (its CLOSE-frame→EOF fix fires on localhost nats
drains/pings). So the contract is:

  1. The module + its ``apply_patch`` are retained (import must still work).
     → covered here + by the untouched ``test_ws_transport_patch.py``.
  2. The module docstring documents that it is inert on ``tls://`` and
     retained for the surviving ``ws://`` dev transport. → this file.

RED today: the current docstring predates the tls:// transition and says
nothing about tls:// inertness / ws:// retention.

The behavioural half — a real tls:// round-trip that does not depend on the
WS patch — lives in the gated local-CA integration suite
(``tests/integration/test_tls_ca_integration.py``).

QA-owned. NEVER weaken.
"""

from __future__ import annotations

import klodi_nats_client._ws_transport_patch as ws_patch


def test_patch_module_is_retained_and_importable() -> None:
    """KEEP decision — the module and its entry point survive the tls://
    transition (it is dev-path load-bearing, not universally inert)."""
    assert hasattr(ws_patch, "apply_patch"), (
        "apply_patch must remain the public entry point — the patch is kept"
    )


def test_docstring_documents_tls_inertness() -> None:
    doc = (ws_patch.__doc__ or "").lower()
    assert "tls://" in doc, (
        "module docstring must state the patch is inert on the tls:// "
        "transport (belt-and-suspenders) — see card criterion"
    )


def test_docstring_documents_ws_dev_path_retention() -> None:
    doc = (ws_patch.__doc__ or "").lower()
    assert "ws://" in doc, (
        "module docstring must state the patch is retained for the "
        "surviving ws:// dev transport"
    )
