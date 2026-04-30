/**
 * Cross-language dedup-LRU example (TS half).
 *
 * Per design Section 6 / P-DEDUP axis (P1-5 regression guard): the
 * in-process event_id LRU MUST evict by recency, not insertion order.
 * P1-5 was a TS regression where the LRU silently degraded to a Set
 * with FIFO eviction — every entry was kept until GC, then dropped in
 * batches that included recently-touched entries.
 *
 * Test pattern (capacity-agnostic — works for any LRU backed by
 * recency-aware eviction):
 *   1. Fill the LRU to capacity (N inserts).
 *   2. "Touch" id_target (one of the existing entries) by calling
 *      `has()` — a true LRU refreshes recency on read.
 *   3. Insert (N - 1) NEW entries. Each evicts the oldest. After all
 *      inserts, only id_target + the (N - 1) new entries fit.
 *   4. Replay id_target — `has()` MUST return true. Handler MUST NOT
 *      fire.
 *
 * Prints `{"handler_fired": <bool>}` to stdout. Expected value is
 * `false`. The orchestrator at
 * `tests/integration/nats-infra/cross-language-wire/orchestrator-dedup.py`
 * fails (exit 2) if any language reports `handler_fired: true`.
 */

import { EventIdLru } from "../src/consumers.js";

const CAPACITY = 1000;
const TARGET_INDEX = 500;
const targetId = `id-${TARGET_INDEX}`;

const lru = new EventIdLru();

// Step 1: fill to capacity.
for (let i = 0; i < CAPACITY; i++) {
  // Production semantic: handler fires when the id is novel; afterwards
  // we record it. We model that here directly.
  if (!lru.has(`id-${i}`)) lru.remember(`id-${i}`);
}

// Step 2: touch the target. has() returns true and refreshes recency.
const touched = lru.has(targetId);
if (!touched) {
  // The target should still be in the LRU at this point — if it's not,
  // step 1 didn't insert what we expected.
  throw new Error("dedup_lru: target evicted before touch — test setup bug");
}

// Step 3: insert (CAPACITY - 1) new entries. Each evicts the oldest.
// After all inserts, the LRU contains targetId + the new entries.
for (let i = 0; i < CAPACITY - 1; i++) {
  const id = `id-new-${i}`;
  if (!lru.has(id)) lru.remember(id);
}

// Step 4: replay the target. A true LRU still remembers it; handler
// must NOT fire. A Set-backed FIFO would have evicted it.
const handlerFired = !lru.has(targetId);

process.stdout.write(JSON.stringify({ handler_fired: handlerFired }) + "\n");
