/**
 * Catalog removal contract for klodi_assets_upload_url.
 *
 * The card "fold-uploads-into-listing-tools" removes the standalone tool
 * from the canonical catalog. Every adapter consumes this single source
 * of schema truth (openclaw: direct import; hermes/nanobot: codegen
 * JSON; Rust trio: codegen Rust enum). Removing the entry here is the
 * single propagation point.
 *
 * Why a Node-native walk and not `execSync('rg ...')`:
 *   - The previous harness shelled out to ripgrep with `|| true` to
 *     coerce the exit code. In the worktree environment Node spawns
 *     `/bin/sh -c <cmd>`; the shell-resolved rg returned an empty
 *     stdout for unrelated reasons (PATH propagation, hidden .git file
 *     pointer in a worktree, glob quoting through JSON.stringify), and
 *     the catch block silently returned `[]`. Every assertion passed
 *     vacuously — adding `klodi_assets_upload_url` back to src/index.ts
 *     would have left CI green.
 *   - A Node-native walk has no PATH dependency, no shell quoting, no
 *     exit-code coercion. The harness reads files; if there are no
 *     matches the array is empty for the right reason.
 *
 * Scope of the agent-facing tool-name check (`klodi_assets_upload_url`)
 * and the Rust enum variant check (`KlodiAssetsUploadUrl`): every code
 * file under adapters/, packages/, skill/, src/, scripts/. Both names
 * are leaf identifiers — neither should appear anywhere except the
 * exceptional surfaces (docs/decisions/0006-*.md history, cards/done/
 * archive, CHANGELOG.md migration note, the active card body).
 *
 * Scope of the NATS subject literal (`p2p.v1.assets.upload-url`): the
 * mint subject is still legitimately referenced inside the new
 * adapter-internal photo helpers (TS, Python, Rust) and their tests —
 * the subject didn't go away, only the agent-facing tool did. The
 * check is therefore scoped to find subject leaks OUTSIDE those
 * known-good files. New helper files that reference the subject must
 * be added to the allow-list explicitly.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { klodiTools, TOOL_NAMES, subjectOf } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

const REMOVED_NAME = "klodi_assets_upload_url";
const REMOVED_SUBJECT = "p2p.v1.assets.upload-url";
const REMOVED_RUST_VARIANT = "KlodiAssetsUploadUrl";

/**
 * Directories never walked at all. These are build artefacts, vendor
 * trees, or VCS state — searching them is both wasteful and noisy.
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".venv",
  "__pycache__",
  "build",            // covers build/staged/ inside each adapter
  ".publish-stage",
  ".obsidian",        // contains plenty of unrelated content
  ".claude",          // hooks, agents, skills — not shipped code
]);

/**
 * File extensions we walk. Restricting to code + manifest + doc
 * extensions avoids walking binary blobs and arbitrary fixtures.
 */
const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".rs",
  ".toml", ".yaml", ".yml", ".json", ".md", ".sh",
]);

/**
 * Repo-relative paths that are intentionally allowed to mention the
 * removed identifiers. Every entry MUST have a reason next to it. New
 * legitimate references need to be added here explicitly — that's the
 * point. Drift in this list signals that work referenced the removed
 * name and got a free pass.
 */
const TOOL_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  // ADR history — the original decision is named after the removed tool.
  "docs/decisions/0006-direct-to-storage-photo-uploads.md",
  // Migration note explicitly lists the removed tool.
  "CHANGELOG.md",
  // The active card body discusses the removal in detail.
  "cards/fold-uploads-into-listing-tools.md",
  // The card-removal grep test itself names the literal.
  "packages/tool-catalog/tests/catalog-removal.test.ts",
  // Per-adapter catalog-removal assertions. Each of these is itself a
  // pinned-down-by-test grep gate for its adapter — the literal needs
  // to appear in the source code of the test to assert it is absent
  // everywhere else.
  "adapters/openclaw/src/__tests__/index.test.ts",
  "adapters/openclaw/src/__tests__/skill-content.test.ts",
  "adapters/openclaw/src/__tests__/tools/photos.test.ts",
  "adapters/hermes/tests/test_tools_photos.py",
  "adapters/nanobot/tests/test_tools_photos.py",
  "packages/klodi-rust-host/src/mcp/tools.rs",
]);

const RUST_VARIANT_ALLOWLIST: ReadonlySet<string> = new Set([
  "docs/decisions/0006-direct-to-storage-photo-uploads.md",
  "CHANGELOG.md",
  "cards/fold-uploads-into-listing-tools.md",
  "packages/tool-catalog/tests/catalog-removal.test.ts",
  // Per-adapter catalog-removal tests reference the Rust variant name
  // in their assertions (Rust side, plus the openclaw `index.test.ts`
  // header comment).
  "packages/klodi-rust-host/src/mcp/tools.rs",
]);

/**
 * The mint NATS subject is still legitimately used by the new
 * adapter-internal helpers and their tests. These are the only files
 * allowed to mention it.
 */
const SUBJECT_ALLOWLIST: ReadonlySet<string> = new Set([
  // TS helper + its tests.
  "adapters/openclaw/src/tools/photos.ts",
  "adapters/openclaw/src/__tests__/tools/photos.test.ts",
  // Python helpers + their tests.
  "adapters/hermes/src/klodi_hermes/photos.py",
  "adapters/hermes/src/klodi_hermes/tools.py",
  "adapters/hermes/tests/test_tools_photos.py",
  "adapters/nanobot/nanobot_photos.py",
  "adapters/nanobot/nanobot_tools.py",
  "adapters/nanobot/tests/test_tools_photos.py",
  // Rust helper.
  "packages/klodi-rust-host/src/mcp/photos.rs",
  // ADR + change record + card body.
  "docs/decisions/0006-direct-to-storage-photo-uploads.md",
  "CHANGELOG.md",
  "cards/fold-uploads-into-listing-tools.md",
  // This test itself.
  "packages/tool-catalog/tests/catalog-removal.test.ts",
]);

/**
 * Cards under `cards/done/` are archival; never inspect them. Same for
 * any prior card body that already documented the removal. We treat
 * the whole archive as off-limits.
 */
function isArchivePath(repoRelative: string): boolean {
  return repoRelative.startsWith("cards/done/");
}

/**
 * Walk the repo collecting paths whose extension is in
 * SCANNED_EXTENSIONS. Returns repo-relative paths so the allow-list
 * lookups are stable.
 */
function walk(absRoot: string): string[] {
  const out: string[] = [];
  walkInto(absRoot, absRoot, out);
  return out;
}

function walkInto(absRoot: string, current: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip silently
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      // Skip dotfile directories we don't whitelist above (e.g. `.cache/`).
      if (entry.name.startsWith(".") && !entry.name.startsWith(".github")) {
        continue;
      }
      walkInto(absRoot, join(current, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIdx = entry.name.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = entry.name.slice(dotIdx);
    if (!SCANNED_EXTENSIONS.has(ext)) continue;
    out.push(relative(absRoot, join(current, entry.name)));
  }
}

/**
 * Find every file in the repo that contains `needle`, minus the
 * allow-list paths and the archive. Used by the three assertions.
 *
 * Files larger than `MAX_FILE_BYTES` are skipped — protects against
 * accidentally scanning a binary blob with a matching extension. The
 * cap is generous (4 MB) so every legitimate source file fits.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function findOffenders(needle: string, allowlist: ReadonlySet<string>): string[] {
  const paths = walk(REPO_ROOT);
  const offenders: string[] = [];
  for (const repoRelative of paths) {
    if (isArchivePath(repoRelative)) continue;
    if (allowlist.has(repoRelative)) continue;
    const abs = join(REPO_ROOT, repoRelative);
    try {
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes(needle)) offenders.push(repoRelative);
    } catch {
      // unreadable — skip silently
    }
  }
  return offenders;
}

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
  // tool name, the Rust enum variant, and the mint NATS subject
  // returns no matches except in the documented exceptional surfaces
  // (the ADR, the active card, the migration note, this test).
  //
  // Why we don't shell out to `rg`: see the file header. The walk is
  // Node-native — no PATH, no shell quoting, no exit-code coercion.

  it("no file under adapters/, packages/, skill/, or root code contains the agent-facing tool name", () => {
    const offenders = findOffenders(REMOVED_NAME, TOOL_NAME_ALLOWLIST);
    expect(offenders).toEqual([]);
  });

  it("no file mentions the Rust enum variant KlodiAssetsUploadUrl", () => {
    const offenders = findOffenders(REMOVED_RUST_VARIANT, RUST_VARIANT_ALLOWLIST);
    expect(offenders).toEqual([]);
  });

  it("no file outside the documented internal-helper allowlist references the mint NATS subject", () => {
    // The subject `p2p.v1.assets.upload-url` is STILL hit by the new
    // adapter-internal helpers (TS/Python/Rust) — only the
    // agent-facing tool was removed. The allow-list pins those known
    // helper files. Any new file that references the subject must
    // either be added to the allow-list (with a justifying comment) or
    // refactored to go through the existing helpers.
    const offenders = findOffenders(REMOVED_SUBJECT, SUBJECT_ALLOWLIST);
    expect(offenders).toEqual([]);
  });
});
