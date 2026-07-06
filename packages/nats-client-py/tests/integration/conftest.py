"""Integration-suite gate (P1-22 — Decision 13 D.1.py).

The Python client integration suite is symmetric with the TS suite at
``klodi-plugin/packages/nats-client-ts/tests/integration/``. It runs
against the same ``pnpm setup:dev`` NATS deployment (Decision 5
pattern). Without ``INTEGRATION=1`` and the dev keys, the suite skips
silently — same shape as the TS suite at module load.

Per-test isolation: each test mints a fresh ``user_id`` (uuid4); the
notifications consumer name (``klodi-notifications-<user_id>``) and
the filter subject (``p2p.v1.notifications.<user_id>``) namespace
automatically.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


def _repo_root(start: Path) -> Path:
    cur = start.resolve()
    for parent in [cur, *cur.parents]:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise RuntimeError("pnpm-workspace.yaml not found from " + str(start))


_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _repo_root(_HERE)
_DEV_KEYS_DIR = _REPO_ROOT / "infra" / "nats" / "dev-keys"
_SERVICE_CREDS_PATH = _DEV_KEYS_DIR / "service.creds"

INTEGRATION = os.environ.get("INTEGRATION") == "1"
# Re-homed off ws://localhost onto the surviving tls:// transport
# (remove-dead-ws-localhost-nats-transport-bypass). Requires a dev-CA
# tls://localhost NATS + the CA PEM path in KLODI_NATS_CA_FILE (the same env
# the KlodiClient resolves its CA from).
NATS_TLS_URL = os.environ.get("TEST_NATS_TLS_URL", "tls://localhost:4222")
CA_FILE = os.environ.get("KLODI_NATS_CA_FILE", "")
SERVICE_CREDS_PATH: str = str(_SERVICE_CREDS_PATH)


def pytest_collection_modifyitems(config, items):  # noqa: ARG001
    """Skip the suite when the gate is closed.

    The gate is closed when:
      - ``INTEGRATION=1`` is not set, or
      - the ``infra/nats/dev-keys/service.creds`` file does not exist.

    Conftest hooks at any depth fire for every collected item, so we
    scope the skip to items under this directory — leaves the unit
    suite untouched.
    """
    if INTEGRATION and _SERVICE_CREDS_PATH.is_file() and CA_FILE:
        return
    reason = (
        "INTEGRATION=1, infra/nats/dev-keys/service.creds, and a dev-CA"
        " tls://localhost NATS (KLODI_NATS_CA_FILE) required — run"
        " `pnpm setup:dev` first"
    )
    skip = pytest.mark.skip(reason=reason)
    integration_dir = str(_HERE)
    for item in items:
        item_path = str(item.path) if hasattr(item, "path") else str(item.fspath)
        if item_path.startswith(integration_dir):
            item.add_marker(skip)
