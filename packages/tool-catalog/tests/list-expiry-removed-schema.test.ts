/**
 * Schema-shape contract for the REMOVAL of listing expiry from the wire.
 *
 * The marketplace is dropping listing
 *   expiry, so the plugin's listing tools must stop carrying it on the wire:
 *     - the request param `expires_hours` on `klodi_list_create` + `_update`
 *     - the reply field   `expires_at`    on `ListingResult` (shared by all
 *       six listing replies: create/update/get/mine/withdraw/relist)
 *
 *   Acceptance criteria covered here (the `[unit]` half — asserted straight
 *   off the `klodiTools` catalog object, the single TypeBox source of truth):
 *     - any listing-bearing tool schema has no `expires_hours` param and no
 *       `expires_at` reply field, including absent from each result's
 *       `required` array (not just `properties`).
 *     - SCOPE GUARD (the assertion that makes an over-broad deletion fail):
 *       the CHANNEL TTLs survive — `ChannelResult.expires_at`
 *       (`klodi_channel_create`) and the `klodi_channel_mine` reply
 *       `expires_at` are STILL present and unchanged.
 *     - the `klodi_list_update` description no longer references
 *       `expires_hours` / expiry (and `klodi_list_create`'s carries none).
 *
 * ── Why assert off the catalog object, not a doc grep ──
 *
 * The `klodiTools` catalog (`src/index.ts`) is the source every artifact is
 * generated from. Round-tripping each TypeBox schema through
 * JSON.parse(JSON.stringify(...)) yields the same JSON Schema shape the
 * codegen emits, so this test pins the contract at its origin. The companion
 * `list-expiry-removed-cross-language.test.ts` pins the *generated* mirrors
 * (`schemas.json`) that Python and Rust load — together they prove the source
 * dropped the field AND the regen propagated it.
 *
 * ── The load-bearing RED facts (verified against the live catalog) ──
 *
 *   - `klodi_list_create.params.properties.expires_hours` exists today
 *     (src/index.ts:240); `klodi_list_update.params.properties.expires_hours`
 *     exists today (src/index.ts:275-277). Both must go.
 *   - `ListingResult.expires_at` (src/index.ts:68) is BOTH a property AND in
 *     the result's `required[]` for every listing reply; `klodi_list_mine`
 *     nests it under `result.properties.listings.items` (an array). Removing
 *     the TypeBox field drops it from properties AND required, at every depth.
 *   - `expires_at` appears 4× in src/index.ts; only ONE is listing
 *     (`ListingResult`, line 68). `ChannelResult.expires_at` (line 111) and
 *     the inline `klodi_channel_mine` reply `expires_at` (line 481) are
 *     CHANNEL TTLs and MUST remain. A blind find-replace on `expires_at` would
 *     strip them and silently break channel-TTL readers — the positive
 *     channel assertions below are what catch that.
 *
 * Per the `adversarial-testing` skill: tests are the spec. NEVER weaken these
 * asserts to match the implementation. If a listing `expires_*` is still
 * present the catalog wasn't edited; if a channel `expires_at` vanished the
 * deletion was over-broad — fix `src/index.ts`, not this test.
 */

import { describe, expect, it } from "vitest";

import { klodiTools } from "../src/index.js";

/**
 * Every listing-bearing tool. All share `result: ListingResult`, so the
 * reply-field assertions apply uniformly; `klodi_list_mine` wraps it as an
 * array (`result.listings: ListingResult[]`), exercised by the recursive walk.
 */
const LISTING_TOOLS = [
  "klodi_list_create",
  "klodi_list_update",
  "klodi_list_get",
  "klodi_list_mine",
  "klodi_list_withdraw",
  "klodi_list_relist",
] as const;

/** Tools whose params today expose the `expires_hours` request field. */
const EXPIRES_HOURS_PARAM_TOOLS = ["klodi_list_create", "klodi_list_update"] as const;

const LISTING_EXPIRY_KEYS = ["expires_hours", "expires_at"] as const;

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

/**
 * Round-trip a TypeBox schema to its plain JSON-Schema shape — the exact
 * representation codegen serialises. Mirrors `asSchema` in the sibling
 * `list-update-category-schema.test.ts`.
 */
function asSchema(schema: unknown): JsonSchema {
  const round = JSON.parse(JSON.stringify(schema)) as unknown;
  if (typeof round !== "object" || round === null) {
    throw new Error("schema did not round-trip to a JSON-Schema object");
  }
  return round as JsonSchema;
}

/**
 * Collect every JSON-path at which `key` appears as a declared property OR in
 * a `required[]` array, recursing through `properties`, array `items`, and the
 * `anyOf`/`allOf`/`oneOf` combinators (so a field nested in an array-of-objects
 * reply — e.g. `klodi_list_mine.result.listings[].expires_at` — is found, not
 * just top-level properties). Returns human-readable paths for assertion
 * messages. The recursion is what makes "absent" mean absent at EVERY depth,
 * defeating a partial removal that leaves the nested-array copy behind.
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

describe("listing expiry removed — catalog schema shape (unit)", () => {
  it.each(EXPIRES_HOURS_PARAM_TOOLS)(
    "%s.params has no `expires_hours` request field (anywhere, incl. required[])",
    (tool) => {
      const params = asSchema(klodiTools[tool].params);
      const hits = findKey(params, "expires_hours", "params");
      expect(
        hits,
        `${tool}.params still exposes \`expires_hours\` at: ${hits.join(", ")}`
        + ` — the listing-expiry request param must be removed from the catalog.`,
      ).toEqual([]);
    },
  );

  it.each(LISTING_TOOLS)(
    "%s.result has no `expires_at` reply field (anywhere, incl. nested arrays + required[])",
    (tool) => {
      const result = asSchema(klodiTools[tool].result);
      const hits = findKey(result, "expires_at", "result");
      expect(
        hits,
        `${tool}.result still carries \`expires_at\` at: ${hits.join(", ")}`
        + ` — ListingResult.expires_at must be removed; the reply omits the key`
        + ` entirely (absent, not null).`,
      ).toEqual([]);
    },
  );

  it("no listing tool carries either expiry key in params or result (sweep)", () => {
    const offenders: string[] = [];
    for (const tool of LISTING_TOOLS) {
      const entry = klodiTools[tool];
      const params = asSchema(entry.params);
      const result = asSchema(entry.result);
      for (const key of LISTING_EXPIRY_KEYS) {
        for (const hit of findKey(params, key, `${tool}.params`)) offenders.push(hit);
        for (const hit of findKey(result, key, `${tool}.result`)) offenders.push(hit);
      }
    }
    expect(
      offenders,
      `listing tools still reference expiry at: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("SCOPE GUARD — channel TTLs survive (unit)", () => {
  // These are the assertions that make an over-broad `expires_at` deletion
  // fail RED-after-GREEN. `expires_at` on channels is a TTL unrelated to
  // listing expiry and MUST remain. If the expert removes it too, these turn
  // red and the deletion is rejected.

  it("klodi_channel_create.result (ChannelResult) STILL declares `expires_at`", () => {
    const result = asSchema(klodiTools.klodi_channel_create.result);
    expect(
      Object.keys(result.properties ?? {}),
      "ChannelResult.expires_at (channel TTL) was removed — it is NOT listing"
      + " expiry and must survive this change (src/index.ts:111).",
    ).toContain("expires_at");
    expect(
      result.required ?? [],
      "ChannelResult.expires_at must remain required — channel TTL is always"
      + " present on the reply.",
    ).toContain("expires_at");
  });

  it("klodi_channel_mine.result.channels[] STILL declares `expires_at`", () => {
    const result = asSchema(klodiTools.klodi_channel_mine.result);
    const hits = findKey(result, "expires_at", "result");
    // The channel-mine reply nests expires_at under channels[].items — assert
    // it is present at that depth (the property hit), proving the channel TTL
    // survived (src/index.ts:481).
    expect(
      hits,
      "klodi_channel_mine reply lost its channel-TTL `expires_at` — this is a"
      + " channel field, out of scope for listing-expiry removal, and must stay.",
    ).toContain("result.properties.channels.items.properties.expires_at");
  });
});

describe("listing expiry removed — description scrub (unit)", () => {
  it("klodi_list_update description no longer mentions expires_hours / expiry", () => {
    const desc = klodiTools.klodi_list_update.description.toLowerCase();
    expect(
      desc,
      "the klodi_list_update description still names `expires_hours` — the"
      + " agent-facing description is wire surface; stale expiry text is a"
      + " contract lie and must be scrubbed.",
    ).not.toContain("expires_hours");
    expect(
      desc,
      "the klodi_list_update description still references expiry/TTL prose —"
      + " remove the sentence describing the now-deleted expires_hours param.",
    ).not.toMatch(/\bexpir/);
  });

  it("klodi_list_create description references no expiry param", () => {
    const desc = klodiTools.klodi_list_create.description.toLowerCase();
    expect(
      desc,
      "the klodi_list_create description must not name `expires_hours`.",
    ).not.toContain("expires_hours");
    expect(
      desc,
      "the klodi_list_create description must carry no expiry/TTL prose after"
      + " the param is removed.",
    ).not.toMatch(/\bexpir/);
  });
});
