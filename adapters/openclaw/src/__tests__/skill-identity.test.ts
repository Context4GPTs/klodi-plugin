/**
 * RED — klodi-skill rename contract: SKILL.md declared identity.
 *
 * Card: rename-skill-folder-and-frontmatter-to-klodi-skill.
 *
 * The founder additionally elected to align the skill's *declared*
 * identity with the new slug: the canonical `skill/SKILL.md` (path
 * unchanged — only its contents) gets frontmatter `name: klodi-skill`
 * and body H1 `# klodi-skill`, so the host-visible self-title matches
 * the folder slug.
 *
 * Hard guard against over-rewrite: the `description:` frontmatter and the
 * product/marketplace "klodi" prose name the *product*, not the
 * artifact, and MUST stay verbatim. "klodi" the marketplace is not
 * `klodi-skill` the skill bundle.
 *
 * Reads the CANONICAL source SKILL.md. FOUNDER SCOPE EXPANSION
 * (2026-06-25): the canonical dir was renamed `skill/` -> `klodi-skill/`,
 * so the source now lives at REPO_ROOT/klodi-skill/SKILL.md.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const SKILL_MD = join(REPO_ROOT, "klodi-skill", "SKILL.md");

function read(): string {
  return readFileSync(SKILL_MD, "utf8");
}

/** Extract the YAML frontmatter block (between the first two `---` fences). */
function frontmatter(body: string): string {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  return match[1];
}

describe("klodi-skill/SKILL.md declares the klodi-skill identity", () => {
  it("frontmatter name: is klodi-skill (not the bare klodi slug)", () => {
    const fm = frontmatter(read());
    expect(fm).toMatch(/^name:\s*klodi-skill\s*$/m);
    expect(fm).not.toMatch(/^name:\s*klodi\s*$/m);
  });

  it("body H1 self-title is # klodi-skill", () => {
    const body = read();
    expect(body).toMatch(/^#\s+klodi-skill\s*$/m);
    expect(body).not.toMatch(/^#\s+klodi\s*$/m);
  });
});

describe("the product/marketplace name 'klodi' stays verbatim (no over-rewrite)", () => {
  it("description: still names the product klodi, unchanged", () => {
    const fm = frontmatter(read());
    // The description sells the *product*; the artifact rename must not
    // rewrite it to klodi-skill.
    expect(fm).toMatch(/^description:.*\bklodi\b/m);
    expect(fm).not.toMatch(/^description:.*klodi-skill/m);
  });

  it("the broker-on-klodi product prose is untouched", () => {
    const body = read();
    // Canonical product sentence — names the marketplace, not the skill.
    expect(body).toContain("Act as the user's broker on klodi");
    expect(body).not.toContain("broker on klodi-skill");
  });
});
