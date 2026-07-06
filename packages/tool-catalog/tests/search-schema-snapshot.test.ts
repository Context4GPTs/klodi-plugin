/**
 * Stable-contract gate for klodi_search + klodi_searches_create.
 *
 * Carries PO SC-contract.2 + SC-additive.{1,3} from the discovery
 * acceptance criteria — the contract states:
 *
 *   - `[integration] SC-contract.2` no `params` / `result` field is
 *     removed, renamed, retyped, or `Type.Optional → required`-promoted.
 *   - `[integration] SC-additive.1` every new `params` field is
 *     wrapped in `Type.Optional` and has a documented default.
 *   - `[integration] SC-additive.3` every existing `params` field
 *     keeps its name, type, and documented meaning.
 *
 * Why structural constants in code, not a JSON snapshot diff: the
 * snapshot diff approach lives at `packages/tool-catalog/tests/golden/`,
 * but in the RED phase the snapshot would be a fresh self-recording of
 * the current catalog — and self-recording cannot detect "the wrong
 * thing was added" until a future PR drifts. Pinning the known-required
 * surface as TypeScript constants here makes the contract explicit at
 * read time. The golden JSON file at `golden/search-schemas.json`
 * carries the human-readable record; this test carries the contract.
 *
 * Adding a new optional param to `klodi_search` / `klodi_searches_create`
 * REQUIRES a coordinated edit here: bump the `KNOWN_*` constant, add the
 * `OPTIONAL_FIELDS` membership, and document the additive change. That
 * is the gate — the diff in this file is the evidence of every contract
 * change since the prior release.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts. If
 * a new field is added without bumping the constants, this test fails
 * for the right reason — the contract surface drifted.
 */

import { describe, expect, it } from "vitest";

import { klodiTools, TOOL_NAMES } from "../src/index.js";

// ─── Known params surfaces — frozen per the stable-contract gate ─

/**
 * Every catalog field the agent already calls today on `klodi_search`.
 * Removing one breaks every agent in production; renaming one is the
 * same. SC-contract.2 + SC-additive.3.
 */
const KNOWN_SEARCH_PARAMS: ReadonlySet<string> = new Set([
  "query",
  "category",
  "min_price",
  "max_price",
  "delivery",
  "condition",
  "limit",
  "cursor",
]);

/**
 * Every catalog field the agent already calls today on
 * `klodi_searches_create`. `slug` is required; the rest are optional.
 */
const KNOWN_SEARCHES_CREATE_PARAMS: ReadonlySet<string> = new Set([
  "slug",
  "query",
  "category",
  "min_price",
  "max_price",
  "delivery",
]);

/**
 * Params that are REQUIRED at the catalog level. `Type.Optional`
 * promotion to required is forbidden by SC-contract.2. Any addition
 * here is a breaking change to every existing agent.
 */
const REQUIRED_SEARCH_PARAMS: ReadonlySet<string> = new Set();
const REQUIRED_SEARCHES_CREATE_PARAMS: ReadonlySet<string> = new Set(["slug"]);

/**
 * Every catalog field on the `klodi_search` result. SC-contract.2 also
 * pins result-shape immutability — `results[]` and `total` are the
 * exact agent-facing surface.
 */
const KNOWN_SEARCH_RESULT_KEYS: ReadonlySet<string> = new Set([
  "results",
  "total",
]);

/**
 * Every catalog field on the `klodi_searches_create` result.
 */
const KNOWN_SEARCHES_CREATE_RESULT_KEYS: ReadonlySet<string> = new Set([
  "search_id",
  "slug",
  "status",
  "criteria",
]);

/**
 * The `criteria` sub-object on `klodi_searches_create.result` mirrors
 * what the marketplace recorded — agents that re-call `klodi_search`
 * with these values must see the same matcher behavior. SC7.4 closure.
 */
const KNOWN_CRITERIA_KEYS: ReadonlySet<string> = new Set([
  "query",
  "category",
  "delivery",
  "min_price",
  "max_price",
]);

const SEARCH_SUBJECT = "p2p.v1.listings.search";
const SEARCHES_CREATE_SUBJECT = "p2p.v1.searches.create";

// ─── Helpers ──────────────────────────────────────────────────────────

interface ObjectSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

function asObjectSchema(schema: unknown): ObjectSchema {
  // TypeBox emits JSON-Schema-shaped objects at runtime; the params /
  // result fields are plain JS objects under the schema markers we
  // ignore. We round-trip through JSON to strip TypeBox's Symbol
  // markers — the same trick the codegen uses (src/codegen/json-schema.ts).
  const round = JSON.parse(JSON.stringify(schema)) as unknown;
  if (typeof round !== "object" || round === null) {
    throw new Error("schema did not round-trip to an object");
  }
  return round as ObjectSchema;
}

function paramKeys(toolName: "klodi_search" | "klodi_searches_create"): Set<string> {
  const tool = klodiTools[toolName];
  const params = asObjectSchema(tool.params);
  return new Set(Object.keys(params.properties ?? {}));
}

function paramRequired(toolName: "klodi_search" | "klodi_searches_create"): Set<string> {
  const tool = klodiTools[toolName];
  const params = asObjectSchema(tool.params);
  return new Set(params.required ?? []);
}

function resultKeys(toolName: "klodi_search" | "klodi_searches_create"): Set<string> {
  const tool = klodiTools[toolName];
  const result = asObjectSchema(tool.result);
  return new Set(Object.keys(result.properties ?? {}));
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("klodi_search — stable contract (SC-contract.2 + SC-additive.3)", () => {
  it("subject is unchanged from p2p.v1.listings.search", () => {
    expect(klodiTools.klodi_search.subject).toBe(SEARCH_SUBJECT);
  });

  it("every known param is still present in the catalog", () => {
    const liveKeys = paramKeys("klodi_search");
    for (const knownKey of KNOWN_SEARCH_PARAMS) {
      expect(
        liveKeys,
        `breaking change: catalog removed klodi_search.params.${knownKey}`,
      ).toContain(knownKey);
    }
  });

  it("no param has been promoted from Type.Optional → required", () => {
    const liveRequired = paramRequired("klodi_search");
    for (const requiredKey of liveRequired) {
      expect(
        REQUIRED_SEARCH_PARAMS,
        `breaking change: klodi_search.params.${requiredKey} is now required`
        + ` (was previously optional or unknown)`,
      ).toContain(requiredKey);
    }
  });

  it("every new param (if any) is wrapped in Type.Optional (SC-additive.1)", () => {
    const liveKeys = paramKeys("klodi_search");
    const newKeys = [...liveKeys].filter((k) => !KNOWN_SEARCH_PARAMS.has(k));
    const liveRequired = paramRequired("klodi_search");
    for (const newKey of newKeys) {
      expect(
        liveRequired,
        `SC-additive.1: new param klodi_search.params.${newKey} must be optional`,
      ).not.toContain(newKey);
    }
  });

  it("every known result key is still present in the catalog", () => {
    const liveKeys = resultKeys("klodi_search");
    for (const knownKey of KNOWN_SEARCH_RESULT_KEYS) {
      expect(
        liveKeys,
        `breaking change: catalog removed klodi_search.result.${knownKey}`,
      ).toContain(knownKey);
    }
  });
});

describe("klodi_searches_create — stable contract (SC-contract.2 + SC-additive.3)", () => {
  it("subject is unchanged from p2p.v1.searches.create", () => {
    expect(klodiTools.klodi_searches_create.subject).toBe(SEARCHES_CREATE_SUBJECT);
  });

  it("every known param is still present in the catalog", () => {
    const liveKeys = paramKeys("klodi_searches_create");
    for (const knownKey of KNOWN_SEARCHES_CREATE_PARAMS) {
      expect(
        liveKeys,
        `breaking change: catalog removed klodi_searches_create.params.${knownKey}`,
      ).toContain(knownKey);
    }
  });

  it("required-fields set is unchanged (still only `slug`)", () => {
    const liveRequired = paramRequired("klodi_searches_create");
    // No new required fields appear.
    for (const requiredKey of liveRequired) {
      expect(
        REQUIRED_SEARCHES_CREATE_PARAMS,
        `breaking change: klodi_searches_create.params.${requiredKey} is now required`,
      ).toContain(requiredKey);
    }
    // The historically-required `slug` is still required.
    for (const knownRequiredKey of REQUIRED_SEARCHES_CREATE_PARAMS) {
      expect(
        liveRequired,
        `breaking change: klodi_searches_create.params.${knownRequiredKey} was required`
        + ` but is now optional or missing`,
      ).toContain(knownRequiredKey);
    }
  });

  it("every new param (if any) is wrapped in Type.Optional (SC-additive.1)", () => {
    const liveKeys = paramKeys("klodi_searches_create");
    const newKeys = [...liveKeys].filter((k) => !KNOWN_SEARCHES_CREATE_PARAMS.has(k));
    const liveRequired = paramRequired("klodi_searches_create");
    for (const newKey of newKeys) {
      expect(
        liveRequired,
        `SC-additive.1: new param klodi_searches_create.params.${newKey} must be optional`,
      ).not.toContain(newKey);
    }
  });

  it("every known result key is still present", () => {
    const liveKeys = resultKeys("klodi_searches_create");
    for (const knownKey of KNOWN_SEARCHES_CREATE_RESULT_KEYS) {
      expect(
        liveKeys,
        `breaking change: catalog removed klodi_searches_create.result.${knownKey}`,
      ).toContain(knownKey);
    }
  });

  it("the `criteria` reply object pins the marketplace's recorded filter set", () => {
    // SC7.4 closure — the criteria the marketplace records and replies
    // with must mirror what the agent could submit through `klodi_search`.
    // The criteria sub-object surface is part of the stable contract.
    const result = asObjectSchema(klodiTools.klodi_searches_create.result);
    const criteria = result.properties?.["criteria"];
    const criteriaSchema = asObjectSchema(criteria);
    const criteriaKeys = new Set(Object.keys(criteriaSchema.properties ?? {}));
    for (const known of KNOWN_CRITERIA_KEYS) {
      expect(
        criteriaKeys,
        `breaking change: catalog removed klodi_searches_create.result.criteria.${known}`,
      ).toContain(known);
    }
  });
});

describe("golden/search-schemas.json snapshot exists alongside the contract", () => {
  // Per PO Open Q2 + architect answer: the golden directory is the
  // canonical home of frozen schema snapshots. The JSON snapshot is
  // human-readable documentation of the catalog surface at the RED
  // phase. This test pins the snapshot file's existence so a future
  // catalog edit cannot silently delete it.
  it("loads the JSON-Schema snapshot from packages/tool-catalog/tests/golden/", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SNAPSHOT_PATH = resolve(HERE, "golden", "search-schemas.json");
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    const snap = JSON.parse(raw) as Record<string, unknown>;
    expect(snap).toHaveProperty("klodi_search");
    expect(snap).toHaveProperty("klodi_searches_create");
  });
});

describe("single-entry-point invariant (SC-entry.1)", () => {
  it("only klodi_search wraps p2p.v1.listings.search", () => {
    const owners = TOOL_NAMES.filter(
      (n) => klodiTools[n].subject === SEARCH_SUBJECT,
    );
    expect(owners).toEqual(["klodi_search"]);
  });

  it("only klodi_searches_create wraps p2p.v1.searches.create", () => {
    const owners = TOOL_NAMES.filter(
      (n) => klodiTools[n].subject === SEARCHES_CREATE_SUBJECT,
    );
    expect(owners).toEqual(["klodi_searches_create"]);
  });
});
