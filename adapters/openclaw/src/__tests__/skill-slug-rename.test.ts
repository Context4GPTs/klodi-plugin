/**
 * RED — klodi-skill rename contract: residual-slug grep guard.
 *
 * Card: rename-skill-folder-and-frontmatter-to-klodi-skill.
 *
 * The openclaw plugin's *published* skill bundle slug collides with
 * other plugins that also ship a generic `skill/` folder. The fix
 * renames openclaw's DESTINATION slug `skill` -> `klodi-skill` across
 * the build wiring + manifest, WITHOUT renaming the canonical
 * `klodi-plugin/skill/` SOURCE dir (every adapter reads that as a build
 * input — renaming it is over-reach the card explicitly forbids).
 *
 * This file is the static tripwire that guards BOTH directions:
 *   - missed rename: a destination `skill` slug survives in build wiring
 *     or the manifest -> the collision re-appears.
 *   - over-reach: `copy-skill.mjs` SOURCE or the `REPO_ROOT/skill`
 *     fixtures got rewritten to `klodi-skill` -> the canonical source
 *     dir was renamed and the whole monorepo build is broken.
 *
 * One assertion = one surface. Each failure points at exactly the file
 * that still carries (or wrongly lost) the slug.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(ADAPTER_ROOT, "..", "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("openclaw destination slug is renamed to klodi-skill (missed-rename guard)", () => {
  it("openclaw.plugin.json#skills declares ./klodi-skill, not ./skill", () => {
    const manifest = JSON.parse(read(join(ADAPTER_ROOT, "openclaw.plugin.json")));
    expect(manifest.skills).toEqual(["./klodi-skill"]);
    // Defence in depth: the raw bytes must not carry the old destination
    // slug anywhere in the skills wiring.
    expect(manifest.skills).not.toContain("./skill");
  });

  it("package.json#files ships klodi-skill, not the generic skill dir", () => {
    const pkg = JSON.parse(read(join(ADAPTER_ROOT, "package.json")));
    expect(pkg.files).toContain("klodi-skill");
    expect(pkg.files).not.toContain("skill");
  });

  it("copy-skill.mjs TARGET resolves to ./klodi-skill", () => {
    const src = read(join(ADAPTER_ROOT, "copy-skill.mjs"));
    // The TARGET (write destination) must be the renamed dir.
    expect(src).toMatch(/const\s+TARGET\s*=\s*resolve\(\s*HERE\s*,\s*["']klodi-skill["']\s*\)/);
    // No leftover `resolve(HERE, "skill")` destination anywhere.
    expect(src).not.toMatch(/resolve\(\s*HERE\s*,\s*["']skill["']\s*\)/);
  });

  it("paths.ts getBundledSkillDir() points at ../../klodi-skill", () => {
    const src = read(join(ADAPTER_ROOT, "src", "lib", "paths.ts"));
    // getBundledSkillDir resolves the published bundle; in the packed
    // package dist/lib/paths.js -> ../../klodi-skill = <pkgroot>/klodi-skill.
    expect(src).toMatch(/join\(\s*here\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*,\s*["']klodi-skill["']\s*\)/);
    expect(src).not.toMatch(/join\(\s*here\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*,\s*["']skill["']\s*\)/);
  });

  it("root .gitignore ignores the openclaw klodi-skill build artifact", () => {
    const ignore = read(join(REPO_ROOT, ".gitignore"));
    expect(ignore).toMatch(/adapters\/(openclaw|\*)\/klodi-skill\//);
  });

  it("adapters/openclaw/.gitignore ignores klodi-skill/, not skill/", () => {
    const ignore = read(join(ADAPTER_ROOT, ".gitignore"));
    expect(ignore).toMatch(/^klodi-skill\/$/m);
    expect(ignore).not.toMatch(/^skill\/$/m);
  });
});

describe("the canonical klodi-plugin/skill/ SOURCE is NOT renamed (over-reach guard)", () => {
  it("copy-skill.mjs SOURCE still points at the canonical ../../skill", () => {
    const src = read(join(ADAPTER_ROOT, "copy-skill.mjs"));
    expect(src).toMatch(
      /const\s+SOURCE\s*=\s*resolve\(\s*HERE\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*,\s*["']skill["']\s*\)/,
    );
  });

  it("skill-content.test.ts fixtures still read REPO_ROOT/skill (canonical, unchanged)", () => {
    const src = read(join(ADAPTER_ROOT, "src", "__tests__", "skill-content.test.ts"));
    // The canonical-source fixtures must keep pointing at `skill` — if a
    // dev renamed the canonical dir these would have been "fixed" to
    // klodi-skill, which is exactly the over-reach we forbid.
    expect(src).toMatch(/join\(REPO_ROOT,\s*["']skill["']/);
    expect(src).not.toMatch(/join\(REPO_ROOT,\s*["']klodi-skill["']/);
  });

  it("tool-catalog skill-coverage fixtures still read REPO_ROOT/skill (canonical, unchanged)", () => {
    const path = join(REPO_ROOT, "packages", "tool-catalog", "tests", "skill-coverage.test.ts");
    const src = read(path);
    expect(src).toMatch(/["']skill["']/);
    expect(src).not.toMatch(/["']klodi-skill["']/);
  });
});
