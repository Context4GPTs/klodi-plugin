/**
 * Cross-language defaults equivalence example (TS half).
 *
 * Per design Section 6 / P-DEFAULTS axis (P1-16 regression guard):
 * KLODI_DEFAULT_API_URL and KLODI_DEFAULT_NATS_URL must resolve to
 * byte-identical strings across TS / Py / Rust. The catalog at
 * `klodi-plugin/packages/tool-catalog/src/index.ts` is the source of
 * truth; Py and Rust consume codegen output (`schemas.json` /
 * `dist/rust-types.rs`).
 *
 * Imports the constants from the catalog and prints the canonical
 * payload to stdout. The orchestrator at
 * `tests/integration/nats-infra/cross-language-wire/orchestrator-defaults.py`
 * compares the three payloads for byte equality.
 */

import {
  KLODI_DEFAULT_API_URL,
  KLODI_DEFAULT_NATS_URL,
} from "@klodi/tool-catalog";

// Stable key order so the canonical-JSON sorted-keys comparison the
// orchestrator runs is unambiguous: alphabetical here matches sorted
// in Py / Rust without any per-language quirks.
const payload = {
  api_url: KLODI_DEFAULT_API_URL,
  nats_url: KLODI_DEFAULT_NATS_URL,
};
process.stdout.write(JSON.stringify(payload) + "\n");
