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

describe("klodi_assets_upload_url removal — repo-wide grep", () => {
  // The e2e acceptance criterion: a search across the repo for the
  // tool name, the Rust enum variant, and the NATS subject returns no
  // matches except in (a) docs/decisions/0006-*.md (history-only
  // mention of the prior name) and (b) cards/done/ (archive of past
  // work). Both exceptions are intentional and documented.
  //
  // We resolve REPO_ROOT by climbing from this file (tests/) up to
  // packages/tool-catalog → packages → REPO_ROOT.
  const repoRoot = join(PACKAGE_ROOT, "..", "..");

  function grepAll(needle: string): string[] {
    const { execSync } = require("node:child_process");
    try {
      // ripgrep is required (CLAUDE.md tooling preferences). Includes
      // hidden files but skips the gitignore'd build artefacts —
      // node_modules, dist/, .venv, target, build/staged.
      const out = execSync(
        // eslint-disable-next-line no-useless-concat
        `rg -lF ${JSON.stringify(needle)} -g '!**/node_modules/**' `
          + `-g '!**/dist/**' -g '!**/build/staged/**' `
          + `-g '!**/.publish-stage/**' -g '!**/target/**' `
          + `-g '!**/.venv/**' -g '!**/__pycache__/**' `
          + `-g '!docs/decisions/0006-*.md' -g '!cards/done/**' `
          + `-g '!cards/**/fold-uploads-into-listing-tools.md' `
          + `-g '!CHANGELOG.md' || true`,
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      return out
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    } catch (err) {
      // rg exits non-zero with no matches; that's success here.
      return [];
    }
  }

  it("no file under adapters/, packages/, skill/, or root code contains the tool name", () => {
    const hits = grepAll(REMOVED_NAME);
    expect(hits).toEqual([]);
  });

  it("no file outside docs/decisions/0006-*.md mentions the NATS subject", () => {
    const hits = grepAll(REMOVED_SUBJECT);
    expect(hits).toEqual([]);
  });

  it("no file mentions the Rust enum variant KlodiAssetsUploadUrl", () => {
    const hits = grepAll("KlodiAssetsUploadUrl");
    expect(hits).toEqual([]);
  });
});
