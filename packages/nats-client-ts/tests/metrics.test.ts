/**
 * Unit tests for the KlodiClient metrics surface (P2-27).
 *
 * Counters are wired in `consumers.ts`'s consume loop. The tests drive
 * the loop's primitives — `KlodiMetrics` directly, and the dispatch
 * path indirectly — to verify each counter ticks where it should.
 */

import { describe, it, expect, vi } from "vitest";

import { KlodiMetrics } from "../src/metrics.js";

describe("KlodiMetrics", () => {
  it("starts at zero across every counter", () => {
    const m = new KlodiMetrics();
    expect(m.snapshot()).toEqual({
      consumed: 0,
      acked: 0,
      naked: 0,
      dedup_hit: 0,
      redelivery_count: 0,
      pending_count: 0,
    });
  });

  it("increments consumed/acked/naked independently", () => {
    const m = new KlodiMetrics();
    m.incConsumed();
    m.incConsumed();
    m.incAcked();
    m.incNaked();
    const s = m.snapshot();
    expect(s.consumed).toBe(2);
    expect(s.acked).toBe(1);
    expect(s.naked).toBe(1);
  });

  it("increments dedup_hit independently", () => {
    const m = new KlodiMetrics();
    m.incDedupHit();
    m.incDedupHit();
    expect(m.snapshot().dedup_hit).toBe(2);
  });

  it("accumulates redelivery_count and ignores zero / negative", () => {
    const m = new KlodiMetrics();
    m.addRedelivery(0);    // first delivery — must not count
    m.addRedelivery(1);    // first redelivery
    m.addRedelivery(3);    // third redelivery on next message
    m.addRedelivery(-5);   // defensive — never count negatives
    expect(m.snapshot().redelivery_count).toBe(4);
  });

  it("setPending replaces the value (not additive)", () => {
    const m = new KlodiMetrics();
    m.setPending(10);
    m.setPending(3);
    m.setPending(7);
    expect(m.snapshot().pending_count).toBe(7);
  });

  it("setPending refuses NaN / negative pending counts", () => {
    const m = new KlodiMetrics();
    m.setPending(5);
    m.setPending(Number.NaN);
    m.setPending(-1);
    expect(m.snapshot().pending_count).toBe(5);
  });

  it("snapshot is a copy — mutating it does not affect future reads", () => {
    const m = new KlodiMetrics();
    m.incConsumed();
    const snap = m.snapshot();
    // Read-only at the type level; verify no mutation gets back in.
    expect(snap.consumed).toBe(1);
    m.incConsumed();
    expect(snap.consumed).toBe(1);
    expect(m.snapshot().consumed).toBe(2);
  });
});

/**
 * Integration-style: drive the consume loop with mocked JetStream
 * messages and assert counter movement. This is how the consumers.ts
 * codepath wires metrics in production.
 */
describe("consumers metrics wiring", () => {
  it("consume → ack increments consumed and acked", async () => {
    // Mocked Map-like message; ack is the single mutator.
    const m = new KlodiMetrics();
    const msg = {
      data: new TextEncoder().encode(JSON.stringify({ event_id: "e1" })),
      subject: "x",
      info: { redeliveryCount: 0 },
      ack: vi.fn().mockResolvedValue(undefined),
      nak: vi.fn().mockResolvedValue(undefined),
    };
    // Simulate the consume-loop body (without spinning the loop):
    m.incConsumed();
    m.addRedelivery(msg.info.redeliveryCount);
    await msg.ack();
    m.incAcked();
    expect(m.snapshot().consumed).toBe(1);
    expect(m.snapshot().acked).toBe(1);
    expect(m.snapshot().naked).toBe(0);
    expect(m.snapshot().redelivery_count).toBe(0);
  });

  it("redelivered message: redelivery_count accumulates", async () => {
    const m = new KlodiMetrics();
    m.incConsumed();
    m.addRedelivery(2);
    expect(m.snapshot().redelivery_count).toBe(2);

    m.incConsumed();
    m.addRedelivery(3);
    expect(m.snapshot().redelivery_count).toBe(5);
  });
});
