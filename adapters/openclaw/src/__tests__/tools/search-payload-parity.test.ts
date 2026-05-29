/**
 * Cross-language search-payload parity — openclaw consumer (RED).
 *
 * Loads `packages/tool-catalog/tests/fixtures/search-payload-golden.json`
 * and asserts that every input case dispatched through the openclaw
 * `klodi_search` / `klodi_searches_create` tool handlers reaches the
 * NATS `request()` call with a payload byte-equal to the fixture's
 * `expected_wire_payload`.
 *
 * This is the SC-parity.{1,2} acceptance gate at the per-stack level
 * for openclaw.
 *
 * Expected to FAIL today (RED): the `klodi_search` arm in
 * `adapters/openclaw/src/tools/discovery.ts:60` runs `compactPayload(params)`
 * which drops `undefined` / `null` / empty-string values. Fixture cases
 * `search_empty_query_string`, `search_null_category`, and
 * `search_empty_string_and_null_mix` carry exactly those values in their
 * `expected_wire_payload`, so the captured payload (`{}` after the
 * compact) will diverge from the expected raw catalog-shaped payload.
 *
 * Architectural resolution (Risks → cross-stack payload-transform drift):
 * strip `compactPayload` from the `klodi_search` arm. The marketplace
 * is the contract; the tool's job is to forward unchanged. The strip
 * inside `klodi_watch` (line ~117 — the composite) keeps stripping
 * adapter-internal flags (`persist`, `action_on_match`, `target_price`),
 * which are NOT catalog params and would corrupt the wire if forwarded.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts to
 * make a stack pass. The fixture is the spec; the implementation must
 * match the spec.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerDiscoveryTools } from "../../tools/discovery.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeConfig } from "../../lib/config.js";
import { writeFileSync } from "node:fs";
import { getCredsPath } from "../../lib/paths.js";
import {
  clearNatsResponses,
  getClient,
  mockNatsResponse,
} from "../helpers/mock-nats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "tool-catalog",
  "tests",
  "fixtures",
  "search-payload-golden.json",
);

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

function loadGolden(): Golden {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as Golden;
}

function caseEntries(section: GoldenSection): Array<[string, GoldenCase]> {
  return Object.entries(section)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [k, v as GoldenCase]);
}

const SEARCH_SUBJECT = "p2p.v1.listings.search";
const SEARCHES_CREATE_SUBJECT = "p2p.v1.searches.create";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

beforeEach(() => {
  temp = createTempHome();
  // Seed credentials so the pre-call guards pass — we want to reach the
  // payload-capture site, not be short-circuited by `not_registered`.
  writeFileSync(getCredsPath(), "creds-bytes");
  writeConfig({
    handle: "tester",
    user_id: "uid-1",
    nkey_public: "NKEY",
    nats_url: "nats://localhost:4222",
  });
  api = createMockPluginApi();
  registerDiscoveryTools(api);
  clearNatsResponses();
  // `mock-nats.ts` exposes a shared MockKlodiClient as a module singleton
  // (`const sharedClient = createMockClient()` at module scope). Without
  // explicitly clearing the mock-call log between tests, `client.request
  // .mock.calls[0]` would point at the FIRST request in the entire test
  // run — every test after the first would assert against a stale call.
  // Reset the spy state so each test reads ITS captured payload, not the
  // first test's.
  vi.clearAllMocks();
});

afterEach(() => temp.cleanup());

// ─── klodi_search — per-case payload-equality (SC-parity.1) ──────────

describe("klodi_search payload parity — openclaw (SC-parity.1)", () => {
  const golden = loadGolden();
  const cases = caseEntries(golden.search);
  // Sanity: the fixture loaded with at least the divergence cases.
  it("loads the golden fixture from packages/tool-catalog/tests/fixtures/", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const [name, entry] of cases) {
    it(`${name} — emits expected_wire_payload to ${SEARCH_SUBJECT}`, async () => {
      // Pin a benign success response on the subject — we care about
      // the request payload, not the response.
      mockNatsResponse(SEARCH_SUBJECT, { results: [], total: 0 });
      const client = getClient();
      const tool = getTool(api, "klodi_search");
      await tool.execute("call-1", entry.input);

      // The mock's `request` is `vi.fn(async (subject, payload) => ...)`;
      // `subject` is the first argument, `payload` is the second.
      expect(
        client.request,
        `${name}: openclaw did not call client.request at all — guard chain or upstream short-circuit?`,
      ).toHaveBeenCalled();
      const [actualSubject, actualPayload] = client.request.mock.calls[0]!;
      expect(actualSubject).toBe(SEARCH_SUBJECT);
      expect(
        actualPayload,
        `${name}: openclaw forwarded a payload that diverges from the spec.`
        + ` Expected (raw catalog-shaped): ${JSON.stringify(entry.expected_wire_payload)}.`
        + ` Got (after openclaw's compactPayload): ${JSON.stringify(actualPayload)}.`
        + ` Fix: strip compactPayload from the klodi_search arm in`
        + ` adapters/openclaw/src/tools/discovery.ts:60. See ADR-0011 and the card body.`,
      ).toEqual(entry.expected_wire_payload);
    });
  }
});

// ─── klodi_searches_create — per-case payload-equality (SC-parity.2) ─

describe("klodi_searches_create payload parity — openclaw (SC-parity.2)", () => {
  const golden = loadGolden();
  const cases = caseEntries(golden.searches_create);

  it("loads the golden fixture's searches_create section", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // openclaw today does NOT register `klodi_searches_create` directly —
  // its catalog tool only reaches the agent surface via the composite
  // `klodi_watch(persist=true)` shape. That composite generates the
  // slug, defaults delivery, and constructs the payload differently
  // from a direct invocation. Per the architect's discovery + PO
  // SC-parity.2, the parity gate REQUIRES every adapter expose
  // `klodi_searches_create` directly (hermes + nanobot already do; the
  // Rust shared host's `dispatch_passthrough` accepts the name). The
  // RED state below — `Error: Tool "klodi_searches_create" not
  // registered` — is the architectural drift this card closes. The
  // green-phase fix in openclaw is a small `registerSearchesCreate(api)`
  // adjacent to `registerSearch(api)` in
  // `adapters/openclaw/src/tools/discovery.ts`, mirroring the existing
  // `registerSearchesList` pattern. The composite `klodi_watch` stays
  // as the higher-level convenience surface; the catalog tool is the
  // direct path agents call when they want full control.
  for (const [name, entry] of cases) {
    it(`${name} — emits expected_wire_payload to ${SEARCHES_CREATE_SUBJECT}`, async () => {
      mockNatsResponse(SEARCHES_CREATE_SUBJECT, {
        search_id: "550e8400-e29b-41d4-a716-446655440000",
        slug: entry.input["slug"],
        status: "active",
        criteria: {
          query: entry.input["query"] ?? null,
          category: entry.input["category"] ?? null,
          delivery: entry.input["delivery"] ?? { method: "any" },
          min_price: entry.input["min_price"] ?? null,
          max_price: entry.input["max_price"] ?? null,
        },
      });
      const client = getClient();
      const tool = getTool(api, "klodi_searches_create");
      await tool.execute("call-1", entry.input);

      expect(
        client.request,
        `${name}: openclaw did not call client.request at all — adapter not registered?`,
      ).toHaveBeenCalled();
      const [actualSubject, actualPayload] = client.request.mock.calls[0]!;
      expect(actualSubject).toBe(SEARCHES_CREATE_SUBJECT);
      expect(
        actualPayload,
        `${name}: openclaw forwarded a payload that diverges from the spec.`
        + ` Expected: ${JSON.stringify(entry.expected_wire_payload)}.`
        + ` Got: ${JSON.stringify(actualPayload)}.`,
      ).toEqual(entry.expected_wire_payload);
    });
  }
});

// ─── SC-contract.3 — per-adapter schema equivalence ──────────────────

describe("openclaw schema equivalence with the catalog (SC-contract.3)", () => {
  it("klodi_search registered metadata mirrors klodiTools.klodi_search", async () => {
    const { klodiTools } = await import("@klodi/tool-catalog");
    const tool = getTool(api, "klodi_search");
    // Openclaw stores the registered tool definition with `parameters`
    // (the `registerTool` API field) — assert byte-equality against the
    // catalog's `params` TypeBox schema.
    const catalogParams = JSON.parse(JSON.stringify(klodiTools.klodi_search.params));
    const registeredParams = JSON.parse(JSON.stringify(tool.parameters));
    expect(
      registeredParams,
      "openclaw klodi_search.parameters drifted from the canonical catalog —"
      + " SC-contract.3 violation",
    ).toEqual(catalogParams);
  });

  it("klodi_searches_create registered metadata mirrors klodiTools.klodi_searches_create", async () => {
    const { klodiTools } = await import("@klodi/tool-catalog");
    const tool = getTool(api, "klodi_searches_create");
    const catalogParams = JSON.parse(JSON.stringify(klodiTools.klodi_searches_create.params));
    const registeredParams = JSON.parse(JSON.stringify(tool.parameters));
    expect(
      registeredParams,
      "openclaw klodi_searches_create.parameters drifted from the canonical catalog —"
      + " SC-contract.3 violation",
    ).toEqual(catalogParams);
  });
});
