/**
 * Cross-language search-payload parity oracle — fixture-shape tests.
 *
 * `fixtures/search-payload-golden.json` is the canonical wire-format
 * oracle for `klodi_search` (subject `p2p.v1.listings.search`) and
 * `klodi_searches_create` (subject `p2p.v1.searches.create`). Every
 * adapter's per-stack test suite loads it and asserts the on-wire
 * payload it would have sent matches the fixture's
 * `expected_wire_payload` for each case.
 *
 * THIS file does NOT test adapters. It tests the fixture itself —
 * validating that every entry honours the contract so a careless edit
 * doesn't silently drift away from the spec:
 *
 *  - Every `input` is valid under the catalog's `klodi_search` /
 *    `klodi_searches_create` `params` schema (no foreign fields, no
 *    obvious type mismatches).
 *  - Every `expected_wire_payload` keys are a subset of the catalog
 *    `params.properties` keys — the wire never carries fields the
 *    catalog doesn't declare.
 *  - The single-entry-point invariant (PO `SC-entry.1`) — exactly one
 *    tool maps to `p2p.v1.listings.search` and exactly one maps to
 *    `p2p.v1.searches.create`.
 *
 * Adapters consume the fixture as a READ-ONLY oracle. Per the
 * `adversarial-testing` skill: NEVER weaken these asserts to make a
 * stack pass — the fixture IS the contract.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { klodiTools, TOOL_NAMES } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "fixtures/search-payload-golden.json");

interface GoldenCase {
  readonly _when: string;
  readonly input: Record<string, unknown>;
  readonly expected_wire_payload: Record<string, unknown>;
}

interface GoldenSection {
  readonly _doc: string;
  readonly [caseName: string]: string | GoldenCase;
}

interface Golden {
  readonly _doc: string;
  readonly search: GoldenSection;
  readonly searches_create: GoldenSection;
}

const SEARCH_SUBJECT = "p2p.v1.listings.search";
const SEARCHES_CREATE_SUBJECT = "p2p.v1.searches.create";

function loadGolden(): Golden {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as Golden;
}

function caseEntries(section: GoldenSection): Array<[string, GoldenCase]> {
  // Skip underscore-prefixed metadata (_doc, _when at section level).
  return Object.entries(section)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [k, v as GoldenCase]);
}

function catalogParamKeys(toolName: "klodi_search" | "klodi_searches_create"): Set<string> {
  const tool = klodiTools[toolName];
  // TypeBox object schemas expose properties via `.properties` at runtime
  // (Schema serialisation), but the runtime is `TSchema` — read directly.
  const props = (tool.params as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") {
    throw new Error(`catalog ${toolName}.params has no properties map`);
  }
  return new Set(Object.keys(props));
}

describe("search-payload-golden.json fixture", () => {
  it("loads as valid JSON", () => {
    const g = loadGolden();
    expect(typeof g).toBe("object");
    expect(g).not.toBeNull();
  });

  it("documents itself via a top-level `_doc` string", () => {
    const g = loadGolden();
    expect(typeof g._doc).toBe("string");
    expect(g._doc.length).toBeGreaterThan(50);
  });

  it("exposes a `search` section with at least one case", () => {
    const g = loadGolden();
    expect(typeof g.search).toBe("object");
    expect(caseEntries(g.search).length).toBeGreaterThan(0);
  });

  it("exposes a `searches_create` section with at least one case", () => {
    const g = loadGolden();
    expect(typeof g.searches_create).toBe("object");
    expect(caseEntries(g.searches_create).length).toBeGreaterThan(0);
  });

  it("includes the central openclaw `compactPayload` divergence cases", () => {
    // The discovery handoff names these explicitly as the smoking-gun
    // inputs that exercise the openclaw payload-transform divergence.
    // Removing any one of them is a regression on the spec; the test
    // names them by key so future edits get an explicit signal.
    const g = loadGolden();
    const searchKeys = caseEntries(g.search).map(([k]) => k);
    const requiredDivergenceCases = [
      "search_empty_query_string",
      "search_null_category",
      "search_empty_string_and_null_mix",
    ];
    for (const key of requiredDivergenceCases) {
      expect(
        searchKeys,
        `fixture coverage gap: missing the central openclaw divergence case "${key}"`,
      ).toContain(key);
    }
  });

  it("includes the `klodi_searches_create` criteria-recording case", () => {
    // The discovery handoff names "klodi_searches_create criteria recording"
    // as a required case — the canonical fully-populated registration.
    const g = loadGolden();
    const createKeys = caseEntries(g.searches_create).map(([k]) => k);
    expect(
      createKeys,
      "fixture coverage gap: missing the fully-populated `searches_create` criteria-recording case",
    ).toContain("searches_create_with_full_criteria");
  });
});

describe("every `search` fixture case is shape-correct", () => {
  const g = loadGolden();
  const cases = caseEntries(g.search);
  const allowedKeys = catalogParamKeys("klodi_search");

  for (const [name, entry] of cases) {
    it(`${name} — has _when / input / expected_wire_payload`, () => {
      expect(typeof entry._when).toBe("string");
      expect(entry._when.length).toBeGreaterThan(0);
      expect(typeof entry.input).toBe("object");
      expect(entry.input).not.toBeNull();
      expect(typeof entry.expected_wire_payload).toBe("object");
      expect(entry.expected_wire_payload).not.toBeNull();
    });

    it(`${name} — every input key is in the catalog params surface`, () => {
      for (const k of Object.keys(entry.input)) {
        expect(
          allowedKeys,
          `${name}.input has foreign key "${k}" not in klodi_search.params`,
        ).toContain(k);
      }
    });

    it(`${name} — every expected_wire_payload key is in the catalog params surface`, () => {
      for (const k of Object.keys(entry.expected_wire_payload)) {
        expect(
          allowedKeys,
          `${name}.expected_wire_payload has foreign key "${k}" not in klodi_search.params`,
        ).toContain(k);
      }
    });
  }
});

describe("every `searches_create` fixture case is shape-correct", () => {
  const g = loadGolden();
  const cases = caseEntries(g.searches_create);
  const allowedKeys = catalogParamKeys("klodi_searches_create");

  for (const [name, entry] of cases) {
    it(`${name} — has _when / input / expected_wire_payload`, () => {
      expect(typeof entry._when).toBe("string");
      expect(entry._when.length).toBeGreaterThan(0);
      expect(typeof entry.input).toBe("object");
      expect(entry.input).not.toBeNull();
      expect(typeof entry.expected_wire_payload).toBe("object");
      expect(entry.expected_wire_payload).not.toBeNull();
    });

    it(`${name} — every input key is in the catalog params surface`, () => {
      for (const k of Object.keys(entry.input)) {
        expect(
          allowedKeys,
          `${name}.input has foreign key "${k}" not in klodi_searches_create.params`,
        ).toContain(k);
      }
    });

    it(`${name} — every expected_wire_payload key is in the catalog params surface`, () => {
      for (const k of Object.keys(entry.expected_wire_payload)) {
        expect(
          allowedKeys,
          `${name}.expected_wire_payload has foreign key "${k}" not in klodi_searches_create.params`,
        ).toContain(k);
      }
    });

    it(`${name} — input carries the catalog-required slug field`, () => {
      // klodi_searches_create.params requires `slug` (catalog-level).
      // The catalog tool is invoked DIRECTLY in the per-stack tests
      // (not through the `klodi_watch` composite, which generates the
      // slug). Every searches_create fixture case must therefore carry
      // a `slug` in its input.
      expect(
        Object.keys(entry.input),
        `${name}.input is missing the required catalog field "slug"`,
      ).toContain("slug");
    });
  }
});

describe("single-entry-point invariant (PO SC-entry.1)", () => {
  it("exactly one catalog tool maps to p2p.v1.listings.search", () => {
    const owners = TOOL_NAMES.filter(
      (n) => klodiTools[n].subject === SEARCH_SUBJECT,
    );
    expect(
      owners,
      `more than one tool wraps ${SEARCH_SUBJECT}: ${owners.join(", ")}`,
    ).toEqual(["klodi_search"]);
  });

  it("exactly one catalog tool maps to p2p.v1.searches.create", () => {
    const owners = TOOL_NAMES.filter(
      (n) => klodiTools[n].subject === SEARCHES_CREATE_SUBJECT,
    );
    expect(
      owners,
      `more than one tool wraps ${SEARCHES_CREATE_SUBJECT}: ${owners.join(", ")}`,
    ).toEqual(["klodi_searches_create"]);
  });

  it("`klodi_search` subject is unchanged from the catalog default", () => {
    // The contract (Axis 2 — stable contract) forbids subject rename.
    expect(klodiTools.klodi_search.subject).toBe(SEARCH_SUBJECT);
  });

  it("`klodi_searches_create` subject is unchanged from the catalog default", () => {
    expect(klodiTools.klodi_searches_create.subject).toBe(SEARCHES_CREATE_SUBJECT);
  });
});
