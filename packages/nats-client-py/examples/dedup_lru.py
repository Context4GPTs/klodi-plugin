#!/usr/bin/env python3
"""Cross-language dedup-LRU example (Py half).

Per design Section 6 / P-DEDUP axis (P1-5 regression guard): the
in-process event_id LRU MUST evict by recency, not insertion order.

Test pattern (capacity-agnostic — works for any LRU backed by
recency-aware eviction):

  1. Fill the LRU to capacity (N inserts).
  2. "Touch" id_target (one of the existing entries) by calling
     ``has()`` — a true LRU refreshes recency on read.
  3. Insert (N - 1) NEW entries. Each evicts the oldest. After all
     inserts, only id_target + the (N - 1) new entries fit.
  4. Replay id_target — ``has()`` MUST return true. Handler MUST NOT
     fire.

Prints ``{"handler_fired": <bool>}`` to stdout. Expected value is
``false``. The orchestrator at
``tests/integration/nats-infra/cross-language-wire/orchestrator-dedup.py``
fails (exit 2) if any language reports ``handler_fired: true``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Production LRU lives in the package's consumers module. Importing the
# private ``_EventIdLru`` directly (rather than a public re-export)
# matches the TS example which imports from `src/consumers.js` — both
# bypass the public surface so the test exercises the same primitive
# the production consume loop uses.
_PKG_SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(_PKG_SRC))

from klodi_nats_client.consumers import (  # noqa: E402
    DEDUP_LRU_SIZE,
    _EventIdLru,
)


def main() -> int:
    capacity = DEDUP_LRU_SIZE
    target_id = f"id-{capacity // 2}"

    lru = _EventIdLru()

    # Step 1: fill to capacity.
    for i in range(capacity):
        event_id = f"id-{i}"
        if not lru.has(event_id):
            lru.remember(event_id)

    # Step 2: touch the target — has() returns True and refreshes recency.
    if not lru.has(target_id):
        print(
            "py:error dedup_lru: target evicted before touch — test setup bug",
            file=sys.stderr,
        )
        return 1

    # Step 3: insert (capacity - 1) new entries. Each evicts the oldest;
    # the touched target stays alive because it was bumped to most-recent.
    for i in range(capacity - 1):
        event_id = f"id-new-{i}"
        if not lru.has(event_id):
            lru.remember(event_id)

    # Step 4: replay the target. A true LRU still remembers it.
    handler_fired = not lru.has(target_id)

    sys.stdout.write(
        json.dumps({"handler_fired": handler_fired}, separators=(",", ":")),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
