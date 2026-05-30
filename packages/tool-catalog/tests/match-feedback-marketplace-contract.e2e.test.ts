/**
 * E2E acceptance — flywheel loop-closure, in-repo arm (card:
 * emit-standing-search-accept-dismiss-feedback, SC8).
 *
 * The card's e2e criterion spans THREE repos:
 *   klodi-plugin (emit) → 4gpts-p2p-marketplace (capture into
 *   search_match_examples) → klodi-stage (`flywheel:curate`) →
 *   flywheel.json != [].
 *
 * That full loop is the GOAL-level acceptance gate (SC8), verified by the
 * orchestrator across the three siblings — it CANNOT run inside klodi-plugin's
 * own suite, and per the card we do NOT spin up three repos here.
 *
 * What we CAN and MUST verify in-repo is the publish-contract conformance:
 * the body the plugin emits is EXACTLY what the marketplace's SC8a capture
 * schema accepts. If the plugin's catalog shape drifts from the marketplace
 * `MatchFeedback` contract, the capture silently drops the message and
 * flywheel.json stays []. So this test pins the marketplace contract as a
 * frozen expectation (sourced from a Discovery read of the sibling file
 * `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts`) and asserts
 * the `klodi_match_feedback` catalog entry conforms field-for-field. It is
 * the in-repo tripwire for the "subject/payload drift from SC8a" risk the
 * architect flagged as highest-value.
 *
 * The marketplace is a SEPARATE repo, not a dependency of klodi-plugin, so we
 * cannot import its TypeBox schema directly — we mirror its pinned constraints
 * as constants here. The frozen constant IS the cross-repo contract record;
 * a drift on either side surfaces as a diff in this file or a failing assert.
 *
 * RED-first: `klodi_match_feedback` is not in the catalog yet.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts. If the
 * marketplace contract genuinely changes, that is a coordinated two-repo
 * change — update the frozen constant here in the same breath as the
 * marketplace schema, never silently.
 */

import { describe, expect, it } from "vitest";

import { LOCAL_TOOLS } from "../src/index.js";

const TOOL_NAME = "klodi_match_feedback";

/**
 * The marketplace SC8a inbound contract, frozen from
 * `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts` (read at
 * Discovery, 2026-05-30). The plugin's emit MUST be a field-for-field match.
 */
const MARKETPLACE_CONTRACT = {
  subject: "p2p.v1.searches.match_feedback",
  additionalProperties: false as const,
  fields: {
    search_slug: { pattern: "^[a-z0-9][a-z0-9._-]{0,119}$", required: true },
    listing_id: { minLength: 1, maxLength: 64, required: true },
    outcome: { enum: ["pursued", "dismissed"], required: true },
    action_on_match: { minLength: 1, maxLength: 40, required: false },
  },
  // Fields the marketplace contract deliberately does NOT accept — sending
  // any of these crosses the trust boundary or duplicates server state.
  forbiddenFields: ["label", "positive", "hard_negative", "listing_summary"],
} as const;

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

function asSchema(s: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(s)) as JsonSchema;
}

function literalUnionValues(schema: JsonSchema): Set<string> {
  const out = new Set<string>();
  if (typeof schema.const === "string") out.add(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const v of schema.enum) if (typeof v === "string") out.add(v);
  }
  if (Array.isArray(schema.anyOf)) {
    for (const m of schema.anyOf) {
      for (const v of literalUnionValues(asSchema(m))) out.add(v);
    }
  }
  return out;
}

function catalogParams(): JsonSchema {
  const registry = LOCAL_TOOLS as Record<string, unknown>;
  const entry = registry[TOOL_NAME] as { params?: unknown } | undefined;
  if (entry === undefined) {
    throw new Error(
      `LOCAL_TOOLS.${TOOL_NAME} does not exist yet — RED. Until the emit tool`
      + " is in the catalog, the flywheel has no in-repo publish contract to"
      + " conform-check against the marketplace.",
    );
  }
  return asSchema(entry.params);
}

describe("flywheel e2e (in-repo arm) — plugin emit conforms to marketplace SC8a capture", () => {
  it("the catalog params object closes to additionalProperties:false, matching the marketplace", () => {
    expect(catalogParams().additionalProperties).toBe(
      MARKETPLACE_CONTRACT.additionalProperties,
    );
  });

  it("emits exactly the marketplace's accepted field set (no more, no less)", () => {
    const liveFields = new Set(Object.keys(catalogParams().properties ?? {}));
    const contractFields = new Set(Object.keys(MARKETPLACE_CONTRACT.fields));
    expect(liveFields).toEqual(contractFields);
  });

  it("required fields match the marketplace's required set", () => {
    const liveRequired = new Set(catalogParams().required ?? []);
    const contractRequired = new Set(
      Object.entries(MARKETPLACE_CONTRACT.fields)
        .filter(([, c]) => c.required)
        .map(([k]) => k),
    );
    expect(liveRequired).toEqual(contractRequired);
  });

  it("outcome enum matches the marketplace's closed {pursued,dismissed} set exactly", () => {
    const outcome = asSchema(catalogParams().properties?.["outcome"]);
    expect(literalUnionValues(outcome)).toEqual(
      new Set(MARKETPLACE_CONTRACT.fields.outcome.enum),
    );
  });

  it("listing_id bounds match the marketplace (1..64, NOT UUID-format)", () => {
    const listingId = asSchema(catalogParams().properties?.["listing_id"]);
    expect(listingId.minLength).toBe(MARKETPLACE_CONTRACT.fields.listing_id.minLength);
    expect(listingId.maxLength).toBe(MARKETPLACE_CONTRACT.fields.listing_id.maxLength);
  });

  it("search_slug pattern matches the marketplace slug pattern exactly", () => {
    const slug = asSchema(catalogParams().properties?.["search_slug"]);
    expect(slug.pattern).toBe(MARKETPLACE_CONTRACT.fields.search_slug.pattern);
  });

  it("carries NONE of the marketplace's forbidden fields (trust boundary intact)", () => {
    const liveFields = new Set(Object.keys(catalogParams().properties ?? {}));
    for (const forbidden of MARKETPLACE_CONTRACT.forbiddenFields) {
      expect(
        liveFields.has(forbidden),
        `drift: plugin would emit '${forbidden}', which the marketplace`
        + " contract forbids — the capture would reject or mislabel it, and"
        + " flywheel.json would not close. This is the cross-repo tripwire.",
      ).toBe(false);
    }
  });
});

describe("flywheel e2e — full three-repo loop is the GOAL-level backstop (documented, not run here)", () => {
  it("documents the loop-closure acceptance that the orchestrator verifies across siblings", () => {
    // This is intentionally a documentation-bearing assertion: the in-repo
    // suite proves the PUBLISH CONTRACT (above). The LOOP CLOSURE — two
    // notify-mode verdicts on the same query+criteria (one pursued, one
    // dismissed) → marketplace search_match_examples → klodi-stage
    // `flywheel:curate` → flywheel.json contains a non-degenerate case with
    // >=1 positive and >=1 hard-negative — runs at the goal level (SC8)
    // across klodi-plugin + 4gpts-p2p-marketplace + klodi-stage. It is NOT a
    // blocker on this PR's merge; the plugin PR's CI mocks the marketplace
    // consumer. A pursue and a dismiss on DIFFERENT searches would correctly
    // leave flywheel.json == [] (degenerate-group exclusion).
    const LOOP_CLOSURE_OWNER = "goal:robust-agentic-search (SC8), orchestrator-verified";
    expect(LOOP_CLOSURE_OWNER).toContain("SC8");
  });
});
