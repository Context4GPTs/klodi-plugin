/**
 * RED — klodi-skill rename contract: manifest<->dir agreement + build
 * materialization.
 *
 * Card: rename-skill-folder-and-frontmatter-to-klodi-skill.
 *
 * Two integration acceptance criteria, settled against the REAL build:
 *
 *  [integration] manifest<->dir agreement: openclaw.plugin.json#skills[0]
 *    is "./klodi-skill" AND that entry resolves to an on-disk directory
 *    containing SKILL.md after build. A manifest that points at a missing
 *    dir is WORSE than the original collision warning — the skill
 *    silently fails to load on the host.
 *
 *  [integration] build materialization: after `pnpm -C adapters/openclaw
 *    build` (which runs copy-skill), the bundle materializes at
 *    `adapters/openclaw/klodi-skill/SKILL.md` and NOT at
 *    `adapters/openclaw/skill/` — proving copy-skill's TARGET was renamed
 *    and the build doesn't error on a missing source path.
 *
 * This test RUNS THE BUILD (copy-skill + tsc). That's heavier than the
 * default vitest 10s budget, so it carries its own timeout. It is the
 * proof that the renamed TARGET actually produces the renamed dir — a
 * pure static grep can't prove the bytes land in the right place.
 *
 * DO NOT weaken: if the build writes ./skill/ this MUST stay red until
 * copy-skill.mjs TARGET is renamed. The implementation is the servant.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");

const MANIFEST = join(ADAPTER_ROOT, "openclaw.plugin.json");
const RENAMED_BUNDLE = join(ADAPTER_ROOT, "klodi-skill");
const OLD_BUNDLE = join(ADAPTER_ROOT, "skill");

// copy-skill + tsc — minutes, not the 10s default.
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("openclaw.plugin.json#skills agrees with the on-disk bundle", () => {
  it("declares exactly ['./klodi-skill']", () => {
    const manifest = JSON.parse(read(MANIFEST));
    expect(Array.isArray(manifest.skills)).toBe(true);
    expect(manifest.skills[0]).toBe("./klodi-skill");
  });
});

describe("pnpm -C adapters/openclaw build materializes the renamed bundle", () => {
  let buildStatus: number | null = null;
  let buildStderr = "";

  // Run the real build once before the assertions. `copy-skill` is the
  // `build` script's first step, so this exercises the renamed TARGET.
  it("runs `pnpm build` cleanly (copy-skill + tsc)", () => {
    const result = spawnSync("pnpm", ["build"], {
      cwd: ADAPTER_ROOT,
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
    });
    buildStatus = result.status;
    buildStderr = result.stderr ?? "";
    expect(buildStatus, `pnpm build failed:\n${buildStderr}`).toBe(0);
  }, BUILD_TIMEOUT_MS);

  it("materializes adapters/openclaw/klodi-skill/SKILL.md", () => {
    expect(existsSync(join(RENAMED_BUNDLE, "SKILL.md"))).toBe(true);
  });

  it("does NOT leave a bundle at the old adapters/openclaw/skill/ path", () => {
    expect(existsSync(OLD_BUNDLE)).toBe(false);
  });

  it("the manifest skills[0] resolves to a dir containing SKILL.md", () => {
    const manifest = JSON.parse(read(MANIFEST));
    const declared = manifest.skills[0] as string;
    // Resolve the manifest-relative entry the way the host would, from
    // the package root (where openclaw.plugin.json lives).
    const resolved = join(ADAPTER_ROOT, declared);
    expect(existsSync(join(resolved, "SKILL.md"))).toBe(true);
  });
});
