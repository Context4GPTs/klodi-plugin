#!/usr/bin/env python3
"""Cross-language defaults equivalence example (Py half).

Per design Section 6 / P-DEFAULTS axis (P1-16 regression guard):
KLODI_DEFAULT_API_URL and KLODI_DEFAULT_NATS_URL must resolve to
byte-identical strings across TS / Py / Rust. The catalog at
``klodi-plugin/packages/tool-catalog/src/index.ts`` is the source of
truth; Py loads them from the bundled ``schemas.json`` via
``klodi_nats_client.constants``.

Imports the constants and prints the canonical payload to stdout. The
orchestrator at
``tests/integration/nats-infra/cross-language-wire/orchestrator-defaults.py``
compares the three payloads for byte equality.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _load_constants_from_schemas() -> dict[str, str]:
    """Read the bundled ``schemas.json`` directly without importing the
    full ``klodi_nats_client`` package.

    The package's runtime imports pull in ``nats``/``websockets`` deps
    that aren't required for a constant-dump and add slow-import cost
    on every orchestrator run. Reading the JSON directly keeps the
    example self-contained and fast — and surfaces a missing/stale
    codegen artifact more clearly than an attribute-lookup error would.
    """
    schemas_path = (
        Path(__file__).resolve().parent.parent
        / "src" / "klodi_nats_client" / "schemas.json"
    )
    with schemas_path.open("r", encoding="utf-8") as fh:
        loaded = json.load(fh)
    constants = loaded.get("constants", {})
    api_url = constants.get("KLODI_DEFAULT_API_URL")
    nats_url = constants.get("KLODI_DEFAULT_NATS_URL")
    if not isinstance(api_url, str) or not api_url:
        raise RuntimeError(
            "KLODI_DEFAULT_API_URL missing from schemas.json — run"
            " `pnpm --filter @klodi/tool-catalog codegen`"
        )
    if not isinstance(nats_url, str) or not nats_url:
        raise RuntimeError(
            "KLODI_DEFAULT_NATS_URL missing from schemas.json — run"
            " `pnpm --filter @klodi/tool-catalog codegen`"
        )
    return {"api_url": api_url, "nats_url": nats_url}


def main() -> int:
    try:
        payload = _load_constants_from_schemas()
    except Exception as err:  # noqa: BLE001
        print(f"py:error {err}", file=sys.stderr)
        return 1
    # Compact separators + sorted keys so the canonical-JSON comparison
    # the orchestrator runs is unambiguous.
    sys.stdout.write(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
