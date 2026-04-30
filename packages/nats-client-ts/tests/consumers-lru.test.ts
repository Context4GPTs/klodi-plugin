/**
 * Unit tests for the Map-backed `EventIdLru` (P1-5).
 *
 * The LRU's job is simple but load-bearing: under sustained redelivery
 * pressure the dedup window must NOT evict an event_id while it's
 * still actively being seen — otherwise the same wake fires the
 * handler twice. The Python `OrderedDict.move_to_end` and the Rust
 * `lru::LruCache` both refresh recency on every hit; the TS version
 * must match.
 */

import { describe, it, expect } from "vitest";

import { EventIdLru } from "../src/consumers.js";

const CAPACITY = 1_000;

function pad(n: number): string {
  return n.toString().padStart(6, "0");
}

describe("EventIdLru", () => {
  it("remembers recently inserted ids", () => {
    const lru = new EventIdLru();
    lru.remember("evt-a");
    lru.remember("evt-b");

    expect(lru.has("evt-a")).toBe(true);
    expect(lru.has("evt-b")).toBe(true);
    expect(lru.has("evt-c")).toBe(false);
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    const lru = new EventIdLru();
    for (let i = 0; i < CAPACITY; i++) lru.remember(`id-${pad(i)}`);
    lru.remember("overflow");

    expect(lru.has("id-000000")).toBe(false);
    expect(lru.has("id-000001")).toBe(true);
    expect(lru.has("overflow")).toBe(true);
  });

  it("refreshes recency on has() so a redelivered id is not evicted", () => {
    const lru = new EventIdLru();
    for (let i = 0; i < CAPACITY; i++) lru.remember(`id-${pad(i)}`);

    // Refresh `id-000000` — it must move to the back of the order so
    // that the next eviction targets `id-000001` instead.
    expect(lru.has("id-000000")).toBe(true);
    lru.remember("overflow");

    expect(lru.has("id-000000")).toBe(true);
    expect(lru.has("id-000001")).toBe(false);
    expect(lru.has("overflow")).toBe(true);
  });

  it("treats remember() on a duplicate id as a recency refresh", () => {
    const lru = new EventIdLru();
    for (let i = 0; i < CAPACITY; i++) lru.remember(`id-${pad(i)}`);

    // Re-`remember` the oldest entry — same observable effect as
    // `has()` followed by `remember()` on a fresh id; the entry must
    // not occupy two slots and must move to the back of the order.
    lru.remember("id-000000");
    lru.remember("overflow");

    expect(lru.has("id-000000")).toBe(true);
    expect(lru.has("id-000001")).toBe(false);
    expect(lru.has("overflow")).toBe(true);
  });

  it("survives 1001-element redelivery without evicting the in-flight id", () => {
    // Mirrors Py/Rust acceptance: stream 1001 unique events through
    // the dedup window while one event is "in flight" (continuously
    // refreshed via has()) and verify it survives.
    const lru = new EventIdLru();
    const inFlight = "in-flight";
    lru.remember(inFlight);

    for (let i = 0; i < CAPACITY + 1; i++) {
      // Touch the in-flight id once per iteration to mimic the
      // redelivery loop.
      lru.has(inFlight);
      lru.remember(`stream-${pad(i)}`);
    }

    expect(lru.has(inFlight)).toBe(true);
  });
});
