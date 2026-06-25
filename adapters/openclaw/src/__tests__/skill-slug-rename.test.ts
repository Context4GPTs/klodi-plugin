/**
 * RED — klodi-skill rename contract: residual-slug grep guard.
 *
 * Card: rename-skill-folder-and-frontmatter-to-klodi-skill.
 *
 * FOUNDER SCOPE EXPANSION (2026-06-25): the canonical build-time source
 * dir `klodi-plugin/skill/` is ALSO renamed to `klodi-plugin/klodi-skill/`.
 * The original PR #27 already renamed openclaw's published DESTINATION
 * slug; this card now *adds* the canonical SOURCE rename and every
 * build-input consumer of it across all six adapters + the registry.
 *
 * The latch polarity INVERTS from the original contract:
 *   - Previously the over-reach guard asserted SOURCE + the
 *     `REPO_ROOT/skill` fixtures STAY `skill`. They must now resolve to
 *     `klodi-skill` (go RED until the `git mv` + wiring lands).
 *   - The install-time `${klodi_home}/skill` per-user target is the NEW
 *     over-reach to guard against — the founder limited the rename to
 *     BUILD TIME, so renaming user state is now the forbidden direction.
 *
 * This file is the static tripwire that guards BOTH directions:
 *   - missed rename: a build-input `skill` SOURCE slug survives in the
 *     build wiring / fixtures / registry -> the build reads a stale path.
 *   - over-reach: the install-time `${klodi_home}/skill` target got
 *     rewritten to `klodi-skill` -> user state breaks on upgrade.
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

describe("the canonical klodi-plugin/skill/ SOURCE IS renamed to klodi-skill (missed-rename guard, INVERTED)", () => {
  it("copy-skill.mjs SOURCE points at the renamed canonical ../../klodi-skill", () => {
    const src = read(join(ADAPTER_ROOT, "copy-skill.mjs"));
    // Founder scope expansion: the canonical source dir is now klodi-skill,
    // so openclaw's copy SOURCE (klodi-skill -> klodi-skill) must follow.
    expect(src).toMatch(
      /const\s+SOURCE\s*=\s*resolve\(\s*HERE\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*,\s*["']klodi-skill["']\s*\)/,
    );
    expect(src).not.toMatch(
      /const\s+SOURCE\s*=\s*resolve\(\s*HERE\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*,\s*["']skill["']\s*\)/,
    );
  });

  it("skill-content.test.ts fixtures read REPO_ROOT/klodi-skill (canonical, renamed)", () => {
    const src = read(join(ADAPTER_ROOT, "src", "__tests__", "skill-content.test.ts"));
    // The canonical-source fixtures now resolve the renamed dir; the bare
    // `skill` join must be gone.
    expect(src).toMatch(/join\(REPO_ROOT,\s*["']klodi-skill["']/);
    expect(src).not.toMatch(/join\(REPO_ROOT,\s*["']skill["']/);
  });

  it("tool-catalog skill-coverage fixtures read REPO_ROOT/klodi-skill (canonical, renamed)", () => {
    const path = join(REPO_ROOT, "packages", "tool-catalog", "tests", "skill-coverage.test.ts");
    const src = read(path);
    // resolve(REPO_ROOT, "klodi-skill", ...) — the canonical SKILL_ROOT /
    // SKILL_DOC anchors must name the renamed dir, not the bare slug.
    expect(src).toMatch(/["']klodi-skill["']/);
    expect(src).not.toMatch(/resolve\(REPO_ROOT,\s*["']skill["']/);
  });
});

describe("non-openclaw adapter build-input SOURCE is renamed to klodi-skill (cross-adapter coverage)", () => {
  it("hermes copy-skill.py SOURCE reads the renamed canonical klodi-skill", () => {
    const src = read(join(REPO_ROOT, "adapters", "hermes", "scripts", "copy-skill.py"));
    // SOURCE = HERE.parent.parent.parent / "skill" -> / "klodi-skill".
    expect(src).toMatch(/SOURCE\s*=\s*HERE\.parent\.parent\.parent\s*\/\s*["']klodi-skill["']/);
    expect(src).not.toMatch(/SOURCE\s*=\s*HERE\.parent\.parent\.parent\s*\/\s*["']skill["']/);
  });

  it("nanobot copy-skill.py SOURCE reads the renamed canonical klodi-skill", () => {
    const src = read(join(REPO_ROOT, "adapters", "nanobot", "scripts", "copy-skill.py"));
    expect(src).toMatch(/SOURCE\s*=\s*HERE\.parent\.parent\.parent\s*\/\s*["']klodi-skill["']/);
    expect(src).not.toMatch(/SOURCE\s*=\s*HERE\.parent\.parent\.parent\s*\/\s*["']skill["']/);
  });

  it("moltis vendor.py skill_src (hard-fail SystemExit gate) reads REPO_ROOT/klodi-skill", () => {
    const src = read(join(REPO_ROOT, "adapters", "moltis", "scripts", "vendor.py"));
    // skill_src = REPO_ROOT / "skill" -> / "klodi-skill". A miss fails the
    // cargo build via SystemExit(1), not silently.
    expect(src).toMatch(/skill_src\s*=\s*REPO_ROOT\s*\/\s*["']klodi-skill["']/);
    expect(src).not.toMatch(/skill_src\s*=\s*REPO_ROOT\s*\/\s*["']skill["']/);
  });

  it("ironclaw vendor.py skill_src (hard-fail SystemExit gate) reads REPO_ROOT/klodi-skill", () => {
    const src = read(join(REPO_ROOT, "adapters", "ironclaw", "scripts", "vendor.py"));
    expect(src).toMatch(/skill_src\s*=\s*REPO_ROOT\s*\/\s*["']klodi-skill["']/);
    expect(src).not.toMatch(/skill_src\s*=\s*REPO_ROOT\s*\/\s*["']skill["']/);
  });

  // zeroclaw is INTENTIONALLY NOT asserted here: its scripts/vendor.py has
  // NO skill_src / REPO_ROOT-skill read at all. The 2026-05-12
  // wake-agent-spawn redesign removed the embedded skill bundle, so
  // zeroclaw never reads the canonical dir as a build input. There is no
  // build-input surface to rename — asserting a klodi-skill ref would
  // demand a path that does not (and should not) exist. Verified:
  // `rg 'skill_src|REPO_ROOT.*skill' adapters/zeroclaw/scripts/vendor.py`
  // returns nothing (only a historical comment mentions the removed skill).

  it("registry/listings.yaml skill_path names klodi-plugin/klodi-skill", () => {
    const src = read(join(REPO_ROOT, "registry", "listings.yaml"));
    // skill_path: "klodi-plugin/skill" -> "klodi-plugin/klodi-skill".
    expect(src).toMatch(/skill_path:\s*["']klodi-plugin\/klodi-skill["']/);
    expect(src).not.toMatch(/skill_path:\s*["']klodi-plugin\/skill["']/);
  });
});

describe("the install-time ${klodi_home}/skill target STAYS skill (NEW over-reach guard)", () => {
  // Founder limited the rename to BUILD TIME. The per-user install-time
  // working copy at `${klodi_home}/skill` is user state, never a build
  // input; renaming it breaks upgrades for zero benefit. These latches
  // stay GREEN throughout and only flip red if the dev over-reaches into
  // user state.
  it("setup.ts reseed target still joins getKlodiHome() with the bare skill dir", () => {
    const src = read(join(ADAPTER_ROOT, "src", "tools", "setup.ts"));
    expect(src).toMatch(/join\(\s*getKlodiHome\(\)\s*,\s*["']skill["']\s*\)/);
    expect(src).not.toMatch(/join\(\s*getKlodiHome\(\)\s*,\s*["']klodi-skill["']\s*\)/);
  });

  it("paths.ts getKlodiHome() is untouched — no klodi-skill leaks into the user-home join", () => {
    // getBundledSkillDir() (the BUILD bundle) legitimately names
    // klodi-skill; getKlodiHome() (the USER home) must never join a
    // klodi-skill subdir. Guard the user-home seam specifically.
    const src = read(join(ADAPTER_ROOT, "src", "lib", "paths.ts"));
    expect(src).not.toMatch(/getKlodiHome\(\)\s*,\s*["']klodi-skill["']/);
  });
});
