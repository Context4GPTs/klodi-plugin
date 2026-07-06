/**
 * Schema contract for the new `klodi_match_feedback` local-publish tool
 * (SC8 flywheel emit
 * half). RED-first: this entry does NOT exist in `LOCAL_TOOLS` yet — every
 * assertion below fails until the expert-developer adds it.
 *
 * The wire shape is pinned by the SIBLING marketplace at
 * `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts` (read at
 * Discovery): `{ search_slug, listing_id, outcome: "pursued"|"dismissed",
 * action_on_match? }`, `additionalProperties: false`. The catalog entry is
 * the plugin half of that contract and MUST mirror it exactly.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts. They are
 * the spec. The single highest-value invariant here is the trust boundary —
 * the agent reports the *action* it took (`outcome`), and the ± training
 * label is derived SERVER-SIDE (`labelForOutcome`). The plugin must have NO
 * field through which a `positive`/`hard_negative` label could be smuggled,
 * which is exactly what `additionalProperties: false` + a closed `outcome`
 * union guarantees. If a future edit opens the params object or widens the
 * outcome set, this test fails for the right reason — the trust boundary
 * leaked.
 *
 * Why a structural assertion on the live `LOCAL_TOOLS` entry (not a JSON
 * snapshot): same rationale as `search-schema-snapshot.test.ts` — a fresh
 * snapshot in the RED phase only self-records the current catalog and can't
 * detect "the wrong thing was added". Pinning the required surface as
 * explicit constants makes the contract legible at read time.
 */

import { describe, expect, it } from "vitest";

import { LOCAL_TOOLS, localToolsForHostShape } from "../src/index.js";

const TOOL_NAME = "klodi_match_feedback";

// The exact closed set the marketplace's `labelForOutcome` accepts. Any
// other value must be rejected at the tool boundary, never published.
const ALLOWED_OUTCOMES = ["pursued", "dismissed"] as const;

// Fields the wire is allowed to carry. `label` is deliberately ABSENT —
// it is server-derived and must never be a plugin-side field.
const ALLOWED_PARAM_FIELDS = new Set([
  "search_slug",
  "listing_id",
  "outcome",
  "action_on_match",
]);
const REQUIRED_PARAM_FIELDS = new Set(["search_slug", "listing_id", "outcome"]);

// Fields that, if present on the params schema, prove the trust boundary
// leaked — a path through which the plugin could assert a training label or
// re-send the server-owned snapshot.
const FORBIDDEN_PARAM_FIELDS = [
  "label",
  "positive",
  "hard_negative",
  "hard-negative",
  "listing_summary",
];

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
  enum?: unknown[];
  const?: unknown;
}

/**
 * TypeBox emits JSON-Schema-shaped objects at runtime under Symbol markers
 * we don't care about. Round-trip through JSON to strip them — the same
 * trick `search-schema-snapshot.test.ts` and the codegen both use.
 */
function asSchema(schema: unknown): JsonSchema {
  const round = JSON.parse(JSON.stringify(schema)) as unknown;
  if (typeof round !== "object" || round === null) {
    throw new Error("schema did not round-trip to an object");
  }
  return round as JsonSchema;
}

/**
 * Collect the set of literal string values a TypeBox union-of-literals
 * schema accepts. TypeBox renders `Type.Union([Type.Literal('a'), ...])` as
 * `{ anyOf: [{ const: 'a' }, { const: 'b' }] }`. A single `Type.Literal`
 * renders as `{ const: 'a' }`; some emitters use `enum`. Handle all three so
 * the assertion is about the accepted SET, not the rendering.
 */
function literalUnionValues(schema: JsonSchema): Set<string> {
  const out = new Set<string>();
  if (typeof schema.const === "string") out.add(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const v of schema.enum) if (typeof v === "string") out.add(v);
  }
  if (Array.isArray(schema.anyOf)) {
    for (const member of schema.anyOf) {
      const m = asSchema(member);
      for (const v of literalUnionValues(m)) out.add(v);
    }
  }
  return out;
}

function feedbackEntry() {
  const registry = LOCAL_TOOLS as Record<string, unknown>;
  const entry = registry[TOOL_NAME];
  if (entry === undefined) {
    throw new Error(
      `LOCAL_TOOLS.${TOOL_NAME} does not exist yet — RED. The`
      + " expert-developer must add the klodi_match_feedback publish entry.",
    );
  }
  return entry as {
    name: string;
    kind: string;
    host_shapes: readonly string[];
    params: unknown;
    result: unknown;
  };
}

describe("klodi_match_feedback — catalog entry exists as a publish tool", () => {
  it("is registered in LOCAL_TOOLS", () => {
    const keys = Object.keys(LOCAL_TOOLS as Record<string, unknown>);
    expect(keys).toContain(TOOL_NAME);
  });

  it("has kind 'publish' (mirrors klodi_channel_message, not request/reply)", () => {
    expect(feedbackEntry().kind).toBe("publish");
  });

  it("declares host_shapes exactly ['in_agent'] (the verdict is formed in-agent)", () => {
    expect([...feedbackEntry().host_shapes]).toEqual(["in_agent"]);
  });

  it("its public name matches its registry key", () => {
    expect(feedbackEntry().name).toBe(TOOL_NAME);
  });
});

describe("klodi_match_feedback — params are the closed four-field wire shape", () => {
  it("params is an object with additionalProperties:false (no field can be smuggled)", () => {
    const params = asSchema(feedbackEntry().params);
    expect(params.type).toBe("object");
    // The trust-boundary guarantee. Without this, an agent could attach a
    // `label` field and assert its own training label.
    expect(params.additionalProperties).toBe(false);
  });

  it("exposes exactly {search_slug, listing_id, outcome, action_on_match?}", () => {
    const params = asSchema(feedbackEntry().params);
    const fields = new Set(Object.keys(params.properties ?? {}));
    expect(fields).toEqual(ALLOWED_PARAM_FIELDS);
  });

  it("requires search_slug, listing_id, and outcome; action_on_match is optional", () => {
    const params = asSchema(feedbackEntry().params);
    const required = new Set(params.required ?? []);
    expect(required).toEqual(REQUIRED_PARAM_FIELDS);
    // action_on_match is provenance — must NOT be required (a notify-mode
    // search may omit it and the marketplace defaults it).
    expect(required.has("action_on_match")).toBe(false);
  });

  it("has NO field through which a ± label or server snapshot could be sent", () => {
    const params = asSchema(feedbackEntry().params);
    const fields = new Set(Object.keys(params.properties ?? {}));
    for (const forbidden of FORBIDDEN_PARAM_FIELDS) {
      expect(
        fields.has(forbidden),
        `trust-boundary leak: params.${forbidden} must not exist — the label`
        + " is server-derived (labelForOutcome), and listing_summary is"
        + " re-read server-side, never sent by the plugin",
      ).toBe(false);
    }
  });
});

describe("klodi_match_feedback — outcome is a closed {pursued,dismissed} set", () => {
  it("outcome accepts ONLY 'pursued' and 'dismissed'", () => {
    const params = asSchema(feedbackEntry().params);
    const outcome = asSchema(params.properties?.["outcome"]);
    const accepted = literalUnionValues(outcome);
    expect(accepted).toEqual(new Set(ALLOWED_OUTCOMES));
  });

  it("outcome does NOT accept any ± label literal", () => {
    const params = asSchema(feedbackEntry().params);
    const outcome = asSchema(params.properties?.["outcome"]);
    const accepted = literalUnionValues(outcome);
    for (const banned of ["positive", "hard_negative", "hard-negative", "negative"]) {
      expect(
        accepted.has(banned),
        `outcome must not accept '${banned}' — outcome carries the ACTION,`
        + " the marketplace derives the label",
      ).toBe(false);
    }
  });
});

describe("klodi_match_feedback — listing_id/search_slug are body ids, NOT UUID-v4", () => {
  // The load-bearing divergence from klodi_channel_message: those ids
  // ride in the BODY, not a subject path, so the strict UUID-v4 guard must
  // NOT be reused. The catalog schema must accept a bounded string for
  // listing_id and a slug pattern for search_slug — exactly the marketplace
  // schema's constraints. A test asserting the schema does NOT pin UUID-v4
  // format is explicitly valuable.

  it("listing_id is a bounded string (1..64), not a UUID-format pin", () => {
    const params = asSchema(feedbackEntry().params);
    const listingId = asSchema(params.properties?.["listing_id"]);
    expect(listingId.type).toBe("string");
    // The marketplace pins minLength:1, maxLength:64 and DELIBERATELY does
    // not assert UUID format (it re-reads the Listing row as the real gate).
    expect((listingId as { minLength?: number }).minLength).toBe(1);
    expect((listingId as { maxLength?: number }).maxLength).toBe(64);
    // Must NOT carry a UUID-v4 pattern. If a `pattern` is present it must be
    // the absence of the canonical 8-4-4-4-12 UUID shape.
    const pattern = (listingId as { pattern?: string }).pattern;
    if (pattern !== undefined) {
      expect(
        /\[0-9a-f\]\{8\}|4\[0-9a-f\]\{3\}/i.test(pattern),
        "listing_id must not be UUID-v4-pattern-constrained — a non-UUID id"
        + " the marketplace accepts must pass the catalog schema too",
      ).toBe(false);
    }
  });

  it("search_slug uses the marketplace slug pattern, not a UUID pattern", () => {
    const params = asSchema(feedbackEntry().params);
    const slug = asSchema(params.properties?.["search_slug"]);
    expect(slug.type).toBe("string");
    const pattern = (slug as { pattern?: string }).pattern;
    // The marketplace pins ^[a-z0-9][a-z0-9._-]{0,119}$. We assert the slug
    // is pattern-constrained AND that a representative human slug matches
    // while a UUID-only constraint would not be present.
    expect(pattern, "search_slug must carry the slug pattern").toBeTypeOf("string");
    expect(new RegExp(pattern as string).test("vintage-camera_01")).toBe(true);
  });
});

describe("klodi_match_feedback — registered for the in_agent surface only", () => {
  it("appears in localToolsForHostShape('in_agent')", () => {
    expect(localToolsForHostShape("in_agent")).toContain(TOOL_NAME);
  });

  it("does NOT appear in localToolsForHostShape('daemon') — the three Rust hosts gain nothing", () => {
    expect(localToolsForHostShape("daemon")).not.toContain(TOOL_NAME);
  });

  it("daemon local-tool allowlist stays empty (vacuously additive for moltis/ironclaw/zeroclaw)", () => {
    // The whole additive-safety proof for the Rust daemon trio: they have an
    // empty in-agent tool surface, so a new in_agent tool cannot touch them.
    expect([...localToolsForHostShape("daemon")]).toEqual([]);
  });
});
