/**
 * Catalog-removal guard — the standalone klodi_assets_upload_url tool
 * is gone from every agent-facing surface bundled in the openclaw
 * adapter: the skill the agent reads, the OpenClaw plugin manifest, the
 * adapter README, and the adapter SECURITY policy. The history-only
 * mention in `docs/decisions/0006-direct-to-storage-photo-uploads.md`
 * is excluded — that lives outside the adapter.
 *
 * Driven by the acceptance criterion: "Given a fresh install of any
 * adapter ... klodi_assets_upload_url is not in the list. The canonical
 * catalog entry, the per-adapter registration call, the plugin manifest
 * ... no longer mention it."
 *
 * One file = one assertion. Each failure points at exactly the surface
 * that still leaks the removed tool name.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(ADAPTER_ROOT, "..", "..");

const REMOVED_TOOL = "klodi_assets_upload_url";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("klodi_assets_upload_url is gone from the openclaw-bundled skill", () => {
  it("is not mentioned in klodi-skill/references/tool_inventory.md", () => {
    const path = join(REPO_ROOT, "klodi-skill", "references", "tool_inventory.md");
    expect(read(path)).not.toContain(REMOVED_TOOL);
  });

  it("is not mentioned in klodi-skill/references/photo_upload_flow.md (or its successor)", () => {
    // The architect's plan allows renaming this file to photos.md. We
    // accept either location, but reject the old tool name in BOTH.
    const candidates = [
      join(REPO_ROOT, "klodi-skill", "references", "photo_upload_flow.md"),
      join(REPO_ROOT, "klodi-skill", "references", "photos.md"),
    ];
    const bodies: string[] = [];
    for (const candidate of candidates) {
      try {
        bodies.push(read(candidate));
      } catch {
        // File doesn't exist — that's fine if its sibling does.
      }
    }
    // At least one of the two must exist (we still need a photos
    // reference — the agent has to know the schema accepts paths).
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(REMOVED_TOOL);
    }
  });

  it("is not mentioned in klodi-skill/SKILL.md", () => {
    const path = join(REPO_ROOT, "klodi-skill", "SKILL.md");
    expect(read(path)).not.toContain(REMOVED_TOOL);
  });
});

describe("klodi_assets_upload_url is gone from openclaw adapter surfaces", () => {
  it("is not declared in openclaw.plugin.json contracts.tools", () => {
    const path = join(ADAPTER_ROOT, "openclaw.plugin.json");
    expect(read(path)).not.toContain(REMOVED_TOOL);
  });

  it("is not mentioned in adapters/openclaw/README.md", () => {
    const path = join(ADAPTER_ROOT, "README.md");
    expect(read(path)).not.toContain(REMOVED_TOOL);
  });

  it("is not mentioned in adapters/openclaw/SECURITY.md", () => {
    const path = join(ADAPTER_ROOT, "SECURITY.md");
    expect(read(path)).not.toContain(REMOVED_TOOL);
  });
});

describe("the canonical phrase covers what photos accepts", () => {
  // Per the product-marketer's lock: every agent-facing surface that
  // documents the photos parameter uses the phrase
  // "image URLs or absolute local file paths". One canonical phrase
  // across surfaces prevents the drift bug this card is closing.
  const CANONICAL = /image URLs? or absolute local file paths?/i;

  it("appears in klodi-skill/references/tool_inventory.md", () => {
    const path = join(REPO_ROOT, "klodi-skill", "references", "tool_inventory.md");
    expect(read(path)).toMatch(CANONICAL);
  });

  it("appears in the photos.md or photo_upload_flow.md skill reference", () => {
    const candidates = [
      join(REPO_ROOT, "klodi-skill", "references", "photo_upload_flow.md"),
      join(REPO_ROOT, "klodi-skill", "references", "photos.md"),
    ];
    const bodies: string[] = [];
    for (const candidate of candidates) {
      try {
        bodies.push(read(candidate));
      } catch {
        /* skip */
      }
    }
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((body) => CANONICAL.test(body))).toBe(true);
  });
});
