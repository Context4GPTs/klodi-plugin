/**
 * Generate dist/error-codes.json from the canonical TS catalog.
 *
 * Round 2 P2.2 — the closed R2 vocabulary lives in
 * `src/error-codes.ts` (source of truth). The Python adapter pair
 * (`klodi_nats_client`) and the Rust shared host
 * (`klodi-rust-host/src/mcp/envelope.rs`) hand-mirror the literal codes
 * inside their envelope helpers. The drift test in
 * `tests/error-codes-cross-language.test.ts` is the minimum-cost gate
 * that catches accidental rename / drop. This codegen step closes the
 * loop: emit a canonical JSON document the Python adapter can load at
 * runtime, so the codegen artifact becomes the single source of truth
 * (TS catalog → JSON → Python).
 *
 * The JSON document carries the full `errorCodes` map plus a top-level
 * `version` discriminator so consumers can detect schema bumps. The
 * Rust side embeds the codes via `static` constants in
 * `klodi-rust-host`'s envelope module — generating a Rust file is the
 * future fix; for now the drift test catches divergence.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { errorCodes, type ErrorCodeEntry } from "../error-codes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, "..", "..", "dist", "error-codes.json");
const SCHEMA_VERSION = "1";

interface ErrorCodesJson {
  version: string;
  codes: Record<string, ErrorCodeEntry>;
}

export function buildErrorCodesJson(): ErrorCodesJson {
  // Re-export under a top-level `codes` object so consumers can
  // distinguish the catalog payload from any future metadata fields
  // (deprecation notes, version-introduced markers).
  return {
    version: SCHEMA_VERSION,
    codes: { ...errorCodes },
  };
}

export function writeErrorCodesJson(): void {
  const payload = buildErrorCodesJson();
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log(`[tool-catalog] wrote ${OUT_PATH}`);
}

writeErrorCodesJson();
