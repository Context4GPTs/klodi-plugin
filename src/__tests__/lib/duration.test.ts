/**
 * Tests for src/lib/duration.ts (RED — module does not exist yet).
 *
 * Purpose: validate the OpenClaw heartbeat cadence string
 * (e.g. agents.defaults.heartbeat.every). Defaults to "30m" in OpenClaw;
 * we must reject garbage early so misconfigured cadence does not silently
 * stall queued events for up to 30 minutes.
 *
 * Contract:
 *   parseDurationMs(input: unknown): number | null
 *     - Accepts strings: "<integer><unit>" where unit ∈ { s, m, h }.
 *     - Bare integer strings default to minutes (OpenClaw doc convention).
 *     - Trims leading/trailing whitespace on otherwise-valid input.
 *     - Rejects: non-string input, empty/whitespace-only, decimals,
 *       negatives, unknown units (incl. "d", "ms"), garbage.
 *     - "0" / "0m" → 0 (valid zero duration).
 */

import { describe, it, expect } from "vitest";
import { parseDurationMs } from "../../lib/duration.js";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("parseDurationMs", () => {
  describe("valid inputs", () => {
    it("parses '30m' as 1_800_000 ms", () => {
      // 30 minutes × 60 s × 1000 ms = 1_800_000
      expect(parseDurationMs("30m")).toBe(1_800_000);
    });

    it("parses '5s' as 5_000 ms", () => {
      // 5 seconds × 1000 ms
      expect(parseDurationMs("5s")).toBe(5_000);
    });

    it("parses '1h' as 3_600_000 ms", () => {
      // 1 hour × 60 m × 60 s × 1000 ms
      expect(parseDurationMs("1h")).toBe(3_600_000);
    });

    it(
      "parses bare integer '300' as minutes by default " +
        "(per OpenClaw heartbeat docs)",
      () => {
        // 300 minutes × 60 s × 1000 ms = 18_000_000
        expect(parseDurationMs("300")).toBe(18_000_000);
      },
    );

    it("parses '0' as 0 ms (zero duration is valid)", () => {
      expect(parseDurationMs("0")).toBe(0);
    });

    it("parses '0m' as 0 ms (zero duration with unit is valid)", () => {
      expect(parseDurationMs("0m")).toBe(0);
    });

    it(
      "trims leading/trailing whitespace on otherwise-valid input '  30m  '",
      () => {
        // 30 minutes × 60 s × 1000 ms = 1_800_000
        expect(parseDurationMs("  30m  ")).toBe(1_800_000);
      },
    );
  });

  describe("invalid inputs (must return null)", () => {
    it("returns null for null", () => {
      expect(parseDurationMs(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(parseDurationMs(undefined)).toBeNull();
    });

    it(
      "returns null for non-string number input (config walker returns " +
        "unknown; only strings are accepted)",
      () => {
        expect(parseDurationMs(30)).toBeNull();
      },
    );

    it("returns null for empty string", () => {
      expect(parseDurationMs("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseDurationMs("   ")).toBeNull();
    });

    it("returns null for decimal value '1.5m'", () => {
      expect(parseDurationMs("1.5m")).toBeNull();
    });

    it("returns null for negative value '-5m'", () => {
      expect(parseDurationMs("-5m")).toBeNull();
    });

    it("returns null for unknown unit '5d' (days are not supported)", () => {
      expect(parseDurationMs("5d")).toBeNull();
    });

    it(
      "returns null for unknown unit '5ms' (ambiguous with 's' suffix; " +
        "callers use ms directly)",
      () => {
        expect(parseDurationMs("5ms")).toBeNull();
      },
    );

    it("returns null for garbage 'abc'", () => {
      expect(parseDurationMs("abc")).toBeNull();
    });
  });
});
