/**
 * Cross-language param-presence gate for `klodi_list_update.category`.
 *
 * The real gap this fills: the existing `error-codes-cross-language.test.ts`
 * asserts error-CODE parity only (it greps `error: "<code>"` literals out of
 * the adapter sources). NOTHING in the suite asserts that a *param* added to
 * the TS catalog actually reaches the Python and Rust adapters. So today the
 * dev pair could add `category` to `klodi_list_update` in TypeScript, forget
 * to regen the codegen artifacts (or stage only `dist/` and miss the two
 * mirrored Python copies), and TS would expose the param while Py/Rust do
 * not — with zero test failing. This test is that missing gate.
 *
 * ── Which artifact carries the cross-language *param* contract? ──
 *
 * `schemas.json` — NOT `rust-types.rs`. This is load-bearing and was verified
 * against the codegen + consumer sources, because an early-draft
 * instruction named `rust-types.rs`:
 *
 *   - TS  → imports the TypeBox catalog directly; `schemas.json` is generated
 *           from that same source (`src/codegen/json-schema.ts`).
 *   - Py  → `klodi_nats_client` + `klodi_logger` read `schemas.json` directly
 *           (codegen `copyFileSync`s `dist/schemas.json` into each package's
 *           resource dir — `scripts/codegen.mjs:58-71`).
 *   - Rust→ `packages/klodi-rust-host/src/mcp/schemas.rs:24`
 *           `include_str!("../../schemas.json")` (the workspace symlink points
 *           at `dist/schemas.json`) and decodes each tool's
 *           `params: serde_json::Value` (`schemas.rs:32`). Rust validates
 *           params against THIS JSON, not against `rust-types.rs`.
 *
 * `rust-types.rs` deliberately emits ONLY the `ToolName` enum + subject map +
 * logging/local-tool constants — never per-tool param fields. Its own header
 * (`src/codegen/rust-types.ts:27-31`) says so: "Param and result structs are
 * NOT emitted here … Module D uses serde_json::Value for opaque pass-through."
 * Asserting `category` presence in `rust-types.rs` would be UNSATISFIABLE —
 * the expert could regen forever and it would never appear there. So the
 * cross-language param contract is `schemas.json`, asserted across every
 * artifact the three languages actually load.
 *
 * ── Which `schemas.json` copies must agree ──
 *
 *   1. `packages/tool-catalog/dist/schemas.json`            (TS dist + Rust's
 *                                                            symlinked source)
 *   2. `packages/nats-client-py/src/klodi_nats_client/schemas.json`  (mirror)
 *   3. `packages/logger-py/src/klodi_logger/schemas.json`            (mirror)
 *
 * `dist/` is gitignored/ephemeral; the two mirrors are committed. The expert
 * must `pnpm -C packages/tool-catalog codegen` and stage BOTH mirrors (easy
 * to miss — a regen that touches only `dist/` leaves the Python halves stale).
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts to match a
 * partial regen. If `category` is missing from any copy, the artifacts
 * drifted — fix the codegen/staging, not this test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_VALUES } from "../src/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const PACKAGES_ROOT = resolve(PKG_ROOT, "..");

/**
 * Every `schemas.json` artifact the three language families load. All must
 * agree on `klodi_list_update.params.category`.
 *
 * Ordering is deliberate: the two committed Python mirrors come FIRST because
 * they are git-tracked and present on any checkout, while `dist/schemas.json`
 * is gitignored/ephemeral (it exists only after `pnpm codegen`/build). On a
 * fresh checkout the mirrors make this suite fail RED on the substantive
 * "category missing" reason rather than on a "dist absent" infra error; once
 * the expert regenerates everything, `dist/schemas.json` (Rust's symlinked
 * include_str! source) is asserted too.
 */
const SCHEMA_ARTIFACTS: ReadonlyArray<{ label: string; path: string }> = [
  {
    label: "nats-client-py mirror (hermes + nanobot, git-tracked)",
    path: resolve(
      PACKAGES_ROOT,
      "nats-client-py",
      "src",
      "klodi_nats_client",
      "schemas.json",
    ),
  },
  {
    label: "logger-py mirror (git-tracked)",
    path: resolve(
      PACKAGES_ROOT,
      "logger-py",
      "src",
      "klodi_logger",
      "schemas.json",
    ),
  },
  {
    label: "dist/schemas.json (TS dist + Rust include_str! source, gitignored)",
    path: resolve(PKG_ROOT, "dist", "schemas.json"),
  },
];

/**
 * The closed `Category` union members — imported from the canonical source
 * (`schemas.ts`) so the test stays in sync when a category is added/removed.
 * Before this refactor, the 11 literals were hardcoded here (founder feedback
 * on PR #9: centralize the vocabulary).
 */
const CATEGORY_MEMBERS: ReadonlySet<string> = new Set(CATEGORY_VALUES);

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  anyOf?: Array<{ const?: string }>;
  description?: string;
}

interface CatalogArtifact {
  tools: Record<
    string,
    { params?: JsonSchemaObject; result?: JsonSchemaObject }
  >;
}

function loadArtifact(path: string): CatalogArtifact {
  if (!existsSync(path)) {
    throw new Error(
      `cross-language param test: schemas.json artifact missing at ${path}.`
      + " Run `pnpm -C packages/tool-catalog codegen` to (re)generate it"
      + " (codegen writes dist/ and mirrors into both Python package dirs).",
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as CatalogArtifact;
}

function updateParams(artifact: CatalogArtifact): JsonSchemaObject {
  const update = artifact.tools["klodi_list_update"];
  if (!update?.params) {
    throw new Error("artifact has no klodi_list_update.params block");
  }
  return update.params;
}

describe("klodi_list_update.category — cross-language param parity (acceptance #5)", () => {
  it("every schemas.json artifact the three languages load actually exists", () => {
    // dist/schemas.json is the Rust include_str! source (via symlink) AND
    // the TS dist artifact; the two mirrors are what the Python packages
    // ship. If the expert regenerates only dist/ and forgets the mirrors,
    // this still passes — the *content* assertions below are what catch a
    // partial regen. This first assertion only guarantees we are testing
    // all three real consumer artifacts, not silently skipping a missing one.
    for (const { label, path } of SCHEMA_ARTIFACTS) {
      expect(existsSync(path), `${label} not found at ${path}`).toBe(true);
    }
  });

  it("exposes klodi_list_update.params.category in every artifact", () => {
    for (const { label, path } of SCHEMA_ARTIFACTS) {
      const params = updateParams(loadArtifact(path));
      const props = params.properties ?? {};
      expect(
        Object.keys(props),
        `${label}: klodi_list_update is missing the \`category\` param`
        + ` (codegen not regenerated or this mirror not re-staged)`,
      ).toContain("category");
    }
  });

  it("types category as the closed Category union (anyOf of the 11 members) in every artifact", () => {
    for (const { label, path } of SCHEMA_ARTIFACTS) {
      const params = updateParams(loadArtifact(path));
      const category = (params.properties ?? {})["category"] as
        | JsonSchemaObject
        | undefined;
      expect(category, `${label}: category param absent`).toBeDefined();
      const members = new Set(
        (category!.anyOf ?? [])
          .map((m) => m.const)
          .filter((c): c is string => typeof c === "string"),
      );
      // Editing category must not escape the closed set — the wire schema is
      // the same union used at create time and on klodi_search.
      expect(
        members,
        `${label}: category param is not the closed Category union`,
      ).toEqual(CATEGORY_MEMBERS);
    }
  });

  it("keeps category OPTIONAL on update in every artifact (listing_id stays the only required field)", () => {
    for (const { label, path } of SCHEMA_ARTIFACTS) {
      const params = updateParams(loadArtifact(path));
      // Guard against a vacuous pass: this test is only meaningful once
      // category EXISTS. Without this, "category is not required" is trivially
      // true while the param is entirely absent (RED-phase false green).
      expect(
        Object.keys(params.properties ?? {}),
        `${label}: category param absent — cannot assert its optionality`,
      ).toContain("category");
      const required = new Set(params.required ?? []);
      // Required-at-create stays at create; on update everything but the id
      // is optional, mirroring condition/currency/tags/fulfillment.
      expect(
        required.has("category"),
        `${label}: category must be OPTIONAL on klodi_list_update,`
        + ` but it appears in the required[] array`,
      ).toBe(false);
      expect(
        [...required],
        `${label}: klodi_list_update required[] drifted from ["listing_id"]`,
      ).toEqual(["listing_id"]);
    }
  });

  it("the three artifacts carry byte-identical klodi_list_update.params, WITH category (no Py/Rust drift)", () => {
    // The whole point: TS / Python / Rust must see the SAME param surface.
    // Comparing the serialized params block across artifacts catches the
    // case where one copy was regenerated and another was left stale.
    //
    // Guard against a vacuous pass: three artifacts that all EQUALLY lack
    // category are byte-identical in their staleness. Assert category is
    // present in the shared surface so identity means "identically correct",
    // not "identically broken".
    for (const { label, path } of SCHEMA_ARTIFACTS) {
      const params = updateParams(loadArtifact(path));
      expect(
        Object.keys(params.properties ?? {}),
        `${label}: category absent — identity check would be vacuous`,
      ).toContain("category");
    }
    const serialized = SCHEMA_ARTIFACTS.map(({ path }) =>
      JSON.stringify(updateParams(loadArtifact(path))),
    );
    const [first, ...rest] = serialized;
    rest.forEach((s, i) => {
      expect(
        s,
        `${SCHEMA_ARTIFACTS[i + 1]!.label} disagrees with`
        + ` ${SCHEMA_ARTIFACTS[0]!.label} on klodi_list_update.params`
        + ` — a partial regen left an artifact stale`,
      ).toEqual(first);
    });
  });
});
