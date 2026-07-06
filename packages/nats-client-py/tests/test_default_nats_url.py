"""RED [unit] — ``KLODI_DEFAULT_NATS_URL`` pinned to the tls:// L4 proxy
across the source constant and BOTH tracked py codegen mirrors.

The constant is codegen'd from ``tool-catalog/src/index.ts`` into two
tracked ``schemas.json#constants`` mirrors (nats-client-py + logger-py).
This pins the cutover value ``tls://hayabusa.proxy.rlwy.net:32770``
(devops §1) at both mirrors, and guards against the two footguns:
the retired ``wss://klodi-net.4gpts.com`` edge and pgvector's
``kodama`` Postgres proxy.

QA-owned. NEVER weaken.
"""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path

from klodi_nats_client import KLODI_DEFAULT_NATS_URL

_PINNED = "tls://hayabusa.proxy.rlwy.net:32770"


def _logger_py_schemas() -> Path:
    """Locate the logger-py codegen mirror by walking up to ``packages/``.

    Both mirrors live under ``packages/<pkg>/src/.../schemas.json``; this
    test file is at ``packages/nats-client-py/tests/`` in the worktree.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = (
            parent / "logger-py" / "src" / "klodi_logger" / "schemas.json"
        )
        if candidate.exists():
            return candidate
    raise AssertionError(
        "logger-py schemas.json mirror not found walking up from "
        f"{here} — the codegen mirror must exist and be pinned"
    )


def test_constant_is_pinned_tls_endpoint() -> None:
    # The imported constant reads the nats-client-py schemas.json mirror
    # via klodi_nats_client.constants._require_str.
    assert KLODI_DEFAULT_NATS_URL == _PINNED


def test_constant_is_not_legacy_wss_or_kodama() -> None:
    assert "wss://" not in KLODI_DEFAULT_NATS_URL
    assert "klodi-net.4gpts.com" not in KLODI_DEFAULT_NATS_URL
    assert "kodama" not in KLODI_DEFAULT_NATS_URL


def test_nats_client_py_schemas_mirror_is_pinned() -> None:
    raw = (
        resources.files("klodi_nats_client")
        .joinpath("schemas.json")
        .read_text(encoding="utf-8")
    )
    constants = json.loads(raw)["constants"]
    assert constants["KLODI_DEFAULT_NATS_URL"] == _PINNED


def test_logger_py_schemas_mirror_is_pinned() -> None:
    constants = json.loads(_logger_py_schemas().read_text(encoding="utf-8"))[
        "constants"
    ]
    assert constants["KLODI_DEFAULT_NATS_URL"] == _PINNED
