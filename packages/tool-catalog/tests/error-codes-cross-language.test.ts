/**
 * Cross-language drift detection — round 2 P2.2.
 *
 * CQG flagged that `dist/error-codes.{json,rs}` codegen never landed.
 * The TS catalog at `packages/tool-catalog/src/error-codes.ts` is the
 * authoritative vocabulary; the Python adapter (`klodi_nats_client.envelope`)
 * and the Rust shared host (`klodi-rust-host/src/mcp/envelope.rs`) emit
 * codes as literal strings inside their envelope helpers. Today the
 * three sources are hand-synced — a future PR can introduce a code in
 * one language without the others and no test catches it.
 *
 * This file parses the literal `error: "<code>"` / `error="<code>"`
 * occurrences out of the Python and Rust envelope source files and
 * asserts every emitted code is a member of the TS catalog's
 * `errorCodes` map.
 *
 * **NOT a full codegen pipeline** — that's the better fix, deferred to
 * a follow-up (see architect's plan for `dist/error-codes.{json,rs}`).
 * This is the minimum-cost drift gate that the round-2 CQG report asked
 * for: a single test catches the silent-rename case.
 *
 * Adapter-internal errors (`internal_error` etc.) and server passthrough
 * codes (the marketplace's vocabulary, which sits OUTSIDE the closed
 * R2 vocabulary by design — they ride in `details.marketplace_error_code`)
 * are exempt. The test parses ONLY the strings the adapter itself
 * emits as the agent-visible `error` field.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorCodes } from "../src/error-codes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

// Python adapter emits codes from envelope.py + guards.py (the guard
// chain produces `invalid_request`, the envelope helpers produce the
// rest).
const PYTHON_SOURCES = [
  resolve(REPO_ROOT, "packages/nats-client-py/src/klodi_nats_client/envelope.py"),
  resolve(REPO_ROOT, "packages/nats-client-py/src/klodi_nats_client/guards.py"),
];

// Rust shared host emits codes from envelope.rs + guards.rs + tools.rs
// (the dispatcher's local-tool validation helpers produce
// `invalid_request` / `internal_error` directly).
const RUST_SOURCES = [
  resolve(REPO_ROOT, "packages/klodi-rust-host/src/mcp/envelope.rs"),
  resolve(REPO_ROOT, "packages/klodi-rust-host/src/mcp/guards.rs"),
  resolve(REPO_ROOT, "packages/klodi-rust-host/src/mcp/tools.rs"),
];

/**
 * Match `error: "<code>"` (with optional whitespace, single or double
 * quote, optional trailing comma). Captures the code string in group 1.
 *
 * Examples it matches:
 *   error: "not_registered"
 *   error= "not_registered",
 *   error: 'not_registered',
 *   "error": "not_registered"
 */
const TS_RUST_PATTERN = /\berror\s*[:=]\s*"([a-z_]+)"/g;
const PY_PATTERN = /\berror\s*=\s*"([a-z_]+)"/g;

/**
 * Extract every `error: "<code>"` occurrence from the source file.
 * Returns the set of codes (deduplicated). Empty set = no codes
 * emitted (probably means the source was misparsed; let the caller
 * decide whether that's a regression).
 */
function extractEmittedCodes(filePath: string, pattern: RegExp): Set<string> {
  if (!existsSync(filePath)) {
    throw new Error(
      `cross-language drift test: source file not found at ${filePath}`,
    );
  }
  const raw = readFileSync(filePath, "utf-8");
  const codes = new Set<string>();
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    codes.add(m[1]!);
  }
  return codes;
}

/**
 * Aggregate emitted codes across multiple sources with the same
 * matcher pattern.
 */
function extractFromAll(sources: string[], pattern: RegExp): Set<string> {
  const all = new Set<string>();
  for (const src of sources) {
    for (const code of extractEmittedCodes(src, pattern)) {
      all.add(code);
    }
  }
  return all;
}

describe("cross-language error-code drift (round 2 P2.2)", () => {
  it("every `error: \"<code>\"` literal in Python adapter sources is in errorCodes", () => {
    const catalogKeys = new Set(Object.keys(errorCodes));
    const emitted = extractFromAll(PYTHON_SOURCES, PY_PATTERN);
    expect(emitted.size).toBeGreaterThan(0); // sanity — parser found something
    for (const code of emitted) {
      expect(
        catalogKeys,
        `drift: Python emits "${code}" which is not in errorCodes catalog`,
      ).toContain(code);
    }
  });

  it("every `error: \"<code>\"` literal in Rust adapter sources is in errorCodes", () => {
    const catalogKeys = new Set(Object.keys(errorCodes));
    const emitted = extractFromAll(RUST_SOURCES, TS_RUST_PATTERN);
    expect(emitted.size).toBeGreaterThan(0);
    for (const code of emitted) {
      expect(
        catalogKeys,
        `drift: Rust emits "${code}" which is not in errorCodes catalog`,
      ).toContain(code);
    }
  });

  it("Python + Rust adapters both cover the four pre-call-guard codes (R4)", () => {
    // R4 says the guard chain produces `not_registered`,
    // `klodi_home_missing` (when applicable), `connection_not_ready`,
    // and `invalid_request`. Every language adapter must emit at least
    // these. Internal_error + marketplace_error are catch-alls and
    // round out the closed vocabulary.
    const requiredAdapterCodes = [
      "not_registered",
      "connection_not_ready",
      "invalid_request",
      "internal_error",
      "marketplace_error",
    ];
    const pyEmitted = extractFromAll(PYTHON_SOURCES, PY_PATTERN);
    const rsEmitted = extractFromAll(RUST_SOURCES, TS_RUST_PATTERN);
    for (const code of requiredAdapterCodes) {
      expect(
        pyEmitted,
        `Python missing required adapter-emitted code: ${code}`,
      ).toContain(code);
      expect(
        rsEmitted,
        `Rust missing required adapter-emitted code: ${code}`,
      ).toContain(code);
    }
  });

  it("Python + Rust adapters emit the SAME set of adapter codes", () => {
    // Cross-language parity: the agent-visible error vocabulary is
    // identical on hermes / nanobot (Python) and moltis / ironclaw /
    // zeroclaw (Rust). A code that the Python adapter emits but the
    // Rust adapter does not (or vice-versa) is a parity gap the
    // founder's success signal catches at runtime — the test catches
    // it at compile time.
    const pyEmitted = extractFromAll(PYTHON_SOURCES, PY_PATTERN);
    const rsEmitted = extractFromAll(RUST_SOURCES, TS_RUST_PATTERN);
    const pyOnly = [...pyEmitted].filter((c) => !rsEmitted.has(c));
    const rsOnly = [...rsEmitted].filter((c) => !pyEmitted.has(c));
    expect(
      pyOnly,
      `Python emits codes Rust does not: ${pyOnly.join(", ")}`,
    ).toEqual([]);
    expect(
      rsOnly,
      `Rust emits codes Python does not: ${rsOnly.join(", ")}`,
    ).toEqual([]);
  });
});
