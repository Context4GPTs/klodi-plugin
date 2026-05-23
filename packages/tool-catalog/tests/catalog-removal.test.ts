/**
 * Catalog removal contract for klodi_assets_upload_url.
 *
 * The card "fold-uploads-into-listing-tools" removes the standalone tool
 * from the canonical catalog. Every adapter consumes this single source
 * of schema truth (openclaw: direct import; hermes/nanobot: codegen
 * JSON; Rust trio: codegen Rust enum). Removing the entry here is the
 * single propagation point.
 *
 * These assertions stay RED until the developer deletes the entry from
 * `src/index.ts` and (separately) runs `pnpm codegen` to regenerate the
 * downstream artefacts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { klodiTools, TOOL_NAMES, subjectOf } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

const REMOVED_NAME = "klodi_assets_upload_url";
const REMOVED_SUBJECT = "p2p.v1.assets.upload-url";

describe("klodi_assets_upload_url removal — source", () => {
  it("is not a key on klodiTools", () => {
    // Cast to a loose record so we can test for the absent key without
    // tripping the typed lookup signature.
    const keys = Object.keys(klodiTools as Record<string, unknown>);
    expect(keys).not.toContain(REMOVED_NAME);
  });

  it("does not appear in TOOL_NAMES", () => {
    expect(TOOL_NAMES as readonly string[]).not.toContain(REMOVED_NAME);
  });

  it("subjectOf(<old name>) is not a valid call at the type level — runtime guard", () => {
    // `subjectOf` is typed `(name: ToolName) => string`. Once
    // KlodiAssetsUploadUrl is gone from ToolName, this call ceases to
    // compile. We exercise the runtime via TOOL_NAMES iteration to keep
    // the test runtime-meaningful.
    for (const name of TOOL_NAMES) {
      expect(subjectOf(name)).not.toBe(REMOVED_SUBJECT);
    }
  });
});

describe("klodi_assets_upload_url removal — source text", () => {
  // Grep-style guards. Pins both the tool name and the subject string
  // so a partial cleanup (deleting the entry but leaving the literal
  // subject somewhere in src/) is caught.
  const sourcePath = join(PACKAGE_ROOT, "src", "index.ts");
  const source = readFileSync(sourcePath, "utf8");

  it("src/index.ts does not contain the tool name", () => {
    expect(source).not.toContain(REMOVED_NAME);
  });

  it("src/index.ts does not contain the NATS subject literal", () => {
    expect(source).not.toContain(REMOVED_SUBJECT);
  });
});
