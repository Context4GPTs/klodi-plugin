/**
 * Unit tests for `computeBackoffMs` (P2-5).
 *
 * Asserts: monotonic increase up to the cap, the cap holds at high
 * attempt counts, and jitter is constrained to ±25% across many
 * samples. Random source is injected so tests are deterministic.
 */

import { describe, it, expect } from "vitest";

import {
  computeBackoffMs,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from "../src/backoff.js";

const NO_JITTER: Partial<BackoffConfig> = { random: () => 0.5 };

describe("computeBackoffMs", () => {
  it("rejects non-positive integer attempts", () => {
    expect(() => computeBackoffMs(0)).toThrow();
    expect(() => computeBackoffMs(-1)).toThrow();
    expect(() => computeBackoffMs(1.5)).toThrow();
  });

  it("starts at the base delay on attempt 1", () => {
    // random()=0.5 → jitter fraction = 0 → exact base.
    expect(computeBackoffMs(1, NO_JITTER)).toBe(DEFAULT_BACKOFF_CONFIG.baseMs);
  });

  it("doubles deterministically per attempt up to the cap", () => {
    // No jitter → exact powers of 2 from 250ms.
    const expected = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000];
    expected.forEach((ms, idx) => {
      expect(computeBackoffMs(idx + 1, NO_JITTER)).toBe(ms);
    });
  });

  it("caps at 60s once the doubling overshoots", () => {
    // 250 * 2^9 = 128_000 > 60_000 cap → returns 60_000 (no jitter).
    expect(computeBackoffMs(10, NO_JITTER)).toBe(60_000);
    expect(computeBackoffMs(20, NO_JITTER)).toBe(60_000);
  });

  it("monotonic increases (with no jitter) until the cap, then flat", () => {
    let prior = 0;
    for (let attempt = 1; attempt <= 9; attempt++) {
      const value = computeBackoffMs(attempt, NO_JITTER);
      expect(value).toBeGreaterThan(prior);
      prior = value;
    }
    // After cap the deterministic value plateaus at exactly 60_000.
    expect(computeBackoffMs(10, NO_JITTER)).toBe(60_000);
    expect(computeBackoffMs(11, NO_JITTER)).toBe(60_000);
  });

  it("samples jitter in [-25%, +25%] across 100 draws (small attempt)", () => {
    const baseMs = DEFAULT_BACKOFF_CONFIG.baseMs;
    const lower = baseMs * (1 - DEFAULT_BACKOFF_CONFIG.jitterRatio);
    const upper = baseMs * (1 + DEFAULT_BACKOFF_CONFIG.jitterRatio);
    let counter = 0;
    // Step through 100 deterministic samples spanning [0,1) so the
    // assertion is reproducible without relying on Math.random's
    // distribution.
    const random = (): number => {
      counter += 1;
      return (counter - 1) / 100;
    };
    for (let i = 0; i < 100; i++) {
      const value = computeBackoffMs(1, { random });
      expect(value).toBeGreaterThanOrEqual(lower);
      expect(value).toBeLessThanOrEqual(upper);
    }
  });

  it("samples jitter in [-25%, +25%] across 100 draws (capped attempt)", () => {
    const cap = DEFAULT_BACKOFF_CONFIG.capMs;
    const lower = cap * (1 - DEFAULT_BACKOFF_CONFIG.jitterRatio);
    const upper = cap * (1 + DEFAULT_BACKOFF_CONFIG.jitterRatio);
    let counter = 0;
    const random = (): number => {
      counter += 1;
      return (counter - 1) / 100;
    };
    for (let i = 0; i < 100; i++) {
      const value = computeBackoffMs(50, { random });
      expect(value).toBeGreaterThanOrEqual(lower);
      expect(value).toBeLessThanOrEqual(upper);
    }
  });

  it("never returns a negative delay even with extreme jitter", () => {
    // Inject a random that always produces the lower bound (-25%).
    const value = computeBackoffMs(1, { random: () => 0 });
    expect(value).toBeGreaterThanOrEqual(0);
  });
});
