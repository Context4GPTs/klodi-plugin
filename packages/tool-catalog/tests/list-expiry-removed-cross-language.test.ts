/**
 * Cross-language gate for the REMOVAL of listing expiry from the generated
 * `schemas.json` — the artifact Python and Rust actually load.
 *
 * Card: remove-listing-expiry-n-from-the-wire-contract (epic
 *   remove-listing-expiry-2026-06). This is the inverse of
 *   `list-update-category-cross-language.test.ts`: that test asserts a param
 *   is PRESENT across the mirrored schemas; this one asserts the listing
 *   expiry fields are ABSENT across them.
 *
 *   Acceptance criterion covered (the `[integration]` half):
 *     - the two mirrored `schemas.json` (nats-client-py, logger-py) that Python
 *       and Rust both load contain zero `expires_hours` / `expires_at` in any
 *       `klodi_list_*` block — in both `properties` and `required[]`, at every
 *       depth (incl. the array-nested `klodi_list_mine.listings[]`).
 *     - SCOPE GUARD: the channel TTLs (`klodi_channel_create`,
 *       `klodi_channel_mine`) STILL carry `expires_at` in the same artifacts —
 *       only listing expiry was removed.
 *
 * ── Which artifact carries the cross-language contract, and why dist is last ──
 *
 * `schemas.json` — NOT `rust-types.rs` (which emits only the ToolName enum +
 * subject map + constants, never per-tool param/result fields; asserting a
 * field's presence/absence there is unsatisfiable — see the sibling
 * category cross-language test header for the full proof).
 *
 *   - Py  → `klodi_nats_client` + `klodi_logger` read `schemas.json` directly
 *           (codegen `copyFileSync`s `dist/schemas.json` into each package's
 *           resource dir — `scripts/codegen.mjs`).
 *   - Rust→ `packages/klodi-rust-host/src/mcp/schemas.rs:24`
 *           `include_str!("../../schemas.json")` (symlink → dist), decoding
 *           each tool's `params: serde_json::Value`. Rust validates against
 *           THIS JSON.
 *
 * The two committed Python mirrors come FIRST in the artifact list and are
 * REQUIRED to exist; `dist/schemas.json` is gitignored/ephemeral (absent on a
 * fresh checkout until `pnpm codegen` runs) and is therefore asserted only
 * WHEN PRESENT. Rationale: the absence-of-expiry assertions must fail RED on
 * the substantive "field still present in the tracked mirror" reason — never
 * on a "dist missing" infra error. Once the expert runs codegen, dist is
 * present and gets the same absence checks (it is Rust's include_str! source).
 *
 * ── The documented footgun this gates ──
 *
 * `check:codegen-fresh` compares `dist/` ONLY. An expert who edits the TS
 * catalog and stages only `dist/` leaves the two tracked Python mirrors
 * carrying the old `expires_*` — and the freshness check will not catch it.
 * This cross-language test IS that missing gate: it reads the tracked mirrors
 * and fails if either still carries listing expiry after the change.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts to match a
 * partial regen. If listing `expires_*` is present in any mirror the artifacts
 * drifted — fix the codegen/staging, not this test. If a channel `expires_at`
 * vanished the source deletion was over-broad — fix `src/index.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const PACKAGES_ROOT = resolve(PKG_ROOT, "..");

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
}

interface ToolDef {
  params?: JsonSchema;
  result?: JsonSchema;
}

interface CatalogArtifact {
  tools: Record<string, ToolDef>;
}

/**
 * The `schemas.json` artifacts the three language families load. The two
 * git-tracked Python mirrors are listed FIRST and marked required — present on
 * every checkout, so the suite fails RED on the real reason. `dist/schemas.json`
 * (Rust's include_str! source via symlink) is gitignored/ephemeral and is
 * therefore `optional: true` — asserted only when codegen has produced it.
 */
const SCHEMA_ARTIFACTS: ReadonlyArray<{
  label: string;
  path: string;
  optional: boolean;
}> = [
  {
    label: "nats-client-py mirror (hermes + nanobot, git-tracked)",
    path: resolve(
      PACKAGES_ROOT,
      "nats-client-py",
      "src",
      "klodi_nats_client",
      "schemas.json",
    ),
    optional: false,
  },
  {
    label: "logger-py mirror (git-tracked)",
    path: resolve(PACKAGES_ROOT, "logger-py", "src", "klodi_logger", "schemas.json"),
    optional: false,
  },
  {
    label: "dist/schemas.json (TS dist + Rust include_str! source, gitignored)",
    path: resolve(PKG_ROOT, "dist", "schemas.json"),
    optional: true,
  },
];

const LISTING_TOOLS = [
  "klodi_list_create",
  "klodi_list_update",
  "klodi_list_get",
  "klodi_list_mine",
  "klodi_list_withdraw",
  "klodi_list_relist",
] as const;

const LISTING_EXPIRY_KEYS = ["expires_hours", "expires_at"] as const;

function loadArtifact(path: string): CatalogArtifact {
  if (!existsSync(path)) {
    throw new Error(
      `listing-expiry cross-language test: schemas.json artifact missing at ${path}.`
      + " Run `pnpm -C packages/tool-catalog codegen` to (re)generate it"
      + " (codegen writes dist/ and mirrors into both Python package dirs).",
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as CatalogArtifact;
}

/** Artifacts that exist right now (required ones always; dist only if present). */
function presentArtifacts(): ReadonlyArray<{ label: string; path: string }> {
  return SCHEMA_ARTIFACTS.filter((a) => !a.optional || existsSync(a.path));
}

function toolBlock(artifact: CatalogArtifact, tool: string): ToolDef {
  const def = artifact.tools?.[tool];
  if (!def) throw new Error(`artifact has no '${tool}' tool block`);
  return def;
}

/**
 * Every JSON-path at which `key` appears as a property OR in a `required[]`,
 * recursing through `properties`, array `items`, and anyOf/allOf/oneOf — so a
 * field nested under an array reply (`klodi_list_mine.listings[]`,
 * `klodi_channel_mine.channels[]`) is found, not just the top level.
 */
function findKey(schema: JsonSchema | undefined, key: string, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  const hits: string[] = [];
  const props = schema.properties ?? {};
  if (Object.prototype.hasOwnProperty.call(props, key)) {
    hits.push(`${path}.properties.${key}`);
  }
  for (const req of schema.required ?? []) {
    if (req === key) hits.push(`${path}.required[]:${key}`);
  }
  for (const [name, child] of Object.entries(props)) {
    hits.push(...findKey(child, key, `${path}.properties.${name}`));
  }
  if (schema.items) hits.push(...findKey(schema.items, key, `${path}.items`));
  for (const combinator of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = schema[combinator];
    if (!branches) continue;
    branches.forEach((branch, i) =>
      hits.push(...findKey(branch, key, `${path}.${combinator}[${i}]`)),
    );
  }
  return hits;
}

describe("listing expiry removed — cross-language schemas.json parity (integration)", () => {
  it("every required schemas.json mirror exists (the cross-language contract is testable)", () => {
    for (const { label, path, optional } of SCHEMA_ARTIFACTS) {
      if (optional) continue;
      expect(
        existsSync(path),
        `${label} not found at ${path} — the git-tracked Python mirror must`
        + ` exist; this is the artifact Python and Rust load.`,
      ).toBe(true);
    }
  });

  it("no klodi_list_* block in any artifact carries expires_hours / expires_at (properties or required, any depth)", () => {
    const offenders: string[] = [];
    for (const { label, path } of presentArtifacts()) {
      const artifact = loadArtifact(path);
      for (const tool of LISTING_TOOLS) {
        const def = toolBlock(artifact, tool);
        for (const key of LISTING_EXPIRY_KEYS) {
          for (const hit of findKey(def.params, key, `${tool}.params`)) {
            offenders.push(`${label}: ${hit}`);
          }
          for (const hit of findKey(def.result, key, `${tool}.result`)) {
            offenders.push(`${label}: ${hit}`);
          }
        }
      }
    }
    expect(
      offenders,
      `listing expiry still present in generated schema(s) at:\n  ${offenders.join("\n  ")}\n`
      + `Regenerate from the updated catalog (\`pnpm -C packages/tool-catalog codegen\`)`
      + ` and stage BOTH Python mirrors — staging only dist/ leaves them stale`
      + ` (check:codegen-fresh compares dist/ only and will not catch this).`,
    ).toEqual([]);
  });

  it.each(LISTING_TOOLS)(
    "%s reply omits expires_at in every artifact (absent key, not null)",
    (tool) => {
      const offenders: string[] = [];
      for (const { label, path } of presentArtifacts()) {
        const def = toolBlock(loadArtifact(path), tool);
        for (const hit of findKey(def.result, "expires_at", `${tool}.result`)) {
          offenders.push(`${label}: ${hit}`);
        }
      }
      expect(
        offenders,
        `${tool} still carries expires_at in generated schema(s) at: ${offenders.join(", ")}`,
      ).toEqual([]);
    },
  );
});

describe("SCOPE GUARD — channel TTLs survive in the generated artifacts (integration)", () => {
  // The mirror of the source-level scope guard: an over-broad deletion that
  // strips channel `expires_at` from the catalog would propagate into these
  // generated artifacts too. Assert the channel TTL is STILL present in every
  // artifact so a regen of an over-broad source change fails here.

  it("klodi_channel_create.result still carries expires_at in every artifact", () => {
    for (const { label, path } of presentArtifacts()) {
      const def = toolBlock(loadArtifact(path), "klodi_channel_create");
      const hits = findKey(def.result, "expires_at", "result");
      expect(
        hits,
        `${label}: klodi_channel_create reply lost its channel-TTL expires_at`
        + ` — this is a channel field, out of scope, and must remain.`,
      ).toContain("result.properties.expires_at");
    }
  });

  it("klodi_channel_mine.result.channels[] still carries expires_at in every artifact", () => {
    for (const { label, path } of presentArtifacts()) {
      const def = toolBlock(loadArtifact(path), "klodi_channel_mine");
      const hits = findKey(def.result, "expires_at", "result");
      expect(
        hits,
        `${label}: klodi_channel_mine reply lost its nested channel-TTL`
        + ` expires_at — channel field, out of scope, must remain.`,
      ).toContain("result.properties.channels.items.properties.expires_at");
    }
  });
});
