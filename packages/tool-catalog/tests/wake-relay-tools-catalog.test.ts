/**
 * Catalog-registration + schema-fidelity spec for the two wake-relay tools
 * (card: wake-relay-tools-absent-from-tool-catalog, finding F3).
 *
 * The bug: `klodi_message_user` and `klodi_pending_decisions` ship in the
 * hermes adapter and the skill, but were ABSENT from the canonical catalog
 * `LOCAL_TOOLS` — violating D4 ("tools live in the catalog or they don't
 * exist"). The fix adds exactly two `LOCAL_TOOLS` entries whose params/result
 * mirror the shipped hermes registration byte-for-byte.
 *
 * RED-first (verified against the pre-impl parent e8647f7, where neither tool
 * is in `LOCAL_TOOLS`): these assertions fail because the entries don't exist.
 *
 * These are the SPECIFICATION. Per the `adversarial-testing` skill: never
 * weaken an assertion to match the implementation. If the catalog entry
 * disagrees with the hermes schema pinned here, the CATALOG is wrong — the two
 * are a single cross-language contract and must not diverge.
 */

import { describe, expect, it } from "vitest";

import {
  LOCAL_TOOLS,
  LOCAL_TOOL_NAMES,
  localToolsForHostShape,
} from "../src/index.js";

const MESSAGE_USER = "klodi_message_user";
const PENDING = "klodi_pending_decisions";
const WAKE_RELAY_TOOLS = [MESSAGE_USER, PENDING] as const;

interface LocalEntry {
  name: string;
  description: string;
  kind: string;
  host_shapes: readonly string[];
  params: unknown;
  result: unknown;
}

function entries(): Record<string, LocalEntry> {
  return LOCAL_TOOLS as unknown as Record<string, LocalEntry>;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minLength?: number;
}

/** TypeBox schemas ARE JSON-Schema objects; round-trip to inspect them. */
function asJsonSchema(schema: unknown): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

describe("wake-relay tools — catalog registration (the fix itself)", () => {
  it.each(WAKE_RELAY_TOOLS)(
    "LOCAL_TOOLS contains %s, fully populated (name/description/params/result/kind/host_shapes)",
    (name) => {
      const entry = entries()[name];
      expect(entry, `LOCAL_TOOLS is missing ${name} — the F3 bug`).toBeDefined();
      expect(entry.name).toBe(name);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.params, `${name}.params must be populated`).toBeDefined();
      expect(entry.result, `${name}.result must be populated`).toBeDefined();
      expect(entry.kind.length).toBeGreaterThan(0);
      expect(entry.host_shapes.length).toBeGreaterThan(0);
    },
  );

  it("LOCAL_TOOL_NAMES (= Object.keys(LOCAL_TOOLS)) includes both — derived, NOT a separate edit", () => {
    // The finding's literal fix ("add the two names to LOCAL_TOOL_NAMES") is a
    // no-op red herring: the array is derived from the object. Pin that here.
    expect([...LOCAL_TOOL_NAMES]).toEqual(Object.keys(LOCAL_TOOLS));
    for (const name of WAKE_RELAY_TOOLS) {
      expect(
        [...LOCAL_TOOL_NAMES],
        `${name} absent from the derived LOCAL_TOOL_NAMES`,
      ).toContain(name);
    }
  });

  it("localToolsForHostShape('in_agent') includes both wake-relay tools", () => {
    const inAgent = new Set(localToolsForHostShape("in_agent"));
    for (const name of WAKE_RELAY_TOOLS) {
      expect(inAgent, `${name} not routed to the in_agent shape`).toContain(name);
    }
  });

  it("localToolsForHostShape('daemon') stays [] — the Rust trio gains nothing", () => {
    // host_shapes excludes "daemon", so moltis/ironclaw/zeroclaw are unaffected.
    expect([...localToolsForHostShape("daemon")]).toEqual([]);
  });

  it("neither wake-relay tool leaks into the cli_only shape", () => {
    // host_shapes is ["in_agent"] only — not cli_only. Adversarial: prove the
    // routing is exact, not "everywhere".
    const cliOnly = new Set(localToolsForHostShape("cli_only"));
    for (const name of WAKE_RELAY_TOOLS) {
      expect(cliOnly).not.toContain(name);
    }
  });
});

describe("wake-relay tools — schema fidelity (catalog must not lie about the shipped shape)", () => {
  it("klodi_message_user params = a single REQUIRED, non-empty string field `text`, closed object", () => {
    const entry = entries()[MESSAGE_USER];
    expect(entry).toBeDefined();
    const params = asJsonSchema(entry.params);

    expect(params.type).toBe("object");
    expect(Object.keys(params.properties ?? {})).toEqual(["text"]);
    expect(params.required).toEqual(["text"]);
    expect(params.additionalProperties).toBe(false);

    const text = asJsonSchema((params.properties ?? {}).text);
    expect(text.type).toBe("string");
    // minLength 1 = "non-empty" — mirrors message.py rejecting empty `text`.
    expect(text.minLength).toBe(1);
  });

  it("klodi_message_user is kind 'local' (host-local delivery, no NATS subject) on host_shapes ['in_agent']", () => {
    const entry = entries()[MESSAGE_USER];
    expect(entry.kind).toBe("local");
    expect([...entry.host_shapes]).toEqual(["in_agent"]);
  });

  it("klodi_message_user result object carries the shipped delivery-outcome fields", () => {
    // Mirrors the success return in message.py:257-265.
    const result = asJsonSchema(entries()[MESSAGE_USER].result);
    expect(result.type).toBe("object");
    expect(Object.keys(result.properties ?? {}).sort()).toEqual(
      ["chat_id", "delivered", "entity_id", "pending_status", "platform"],
    );
  });

  it("klodi_pending_decisions params = the empty object {} (closed), no fields", () => {
    const entry = entries()[PENDING];
    expect(entry).toBeDefined();
    const params = asJsonSchema(entry.params);
    expect(params.type).toBe("object");
    expect(Object.keys(params.properties ?? {})).toEqual([]);
    expect(params.additionalProperties).toBe(false);
  });

  it("klodi_pending_decisions result is a TOP-LEVEL ARRAY (NOT an object)", () => {
    // handle_pending_decisions returns json.dumps of a LIST — the first
    // array-typed result in the registry. A naive object-shaped result would
    // silently disagree with the shipped tool. This is the load-bearing
    // fidelity assertion.
    const result = asJsonSchema(entries()[PENDING].result);
    expect(result.type).toBe("array");
    expect(result.type).not.toBe("object");
    // No top-level object surface: an array root has items, not properties.
    expect(result.properties).toBeUndefined();
    expect(result.items).toBeDefined();
  });

  it("klodi_pending_decisions array items are the 8-field PendingDecision record", () => {
    // PendingDecision dataclass (pending_decisions.py:64-79) — exactly these
    // 8 fields; adding one here would break the pointer-not-snapshot invariant.
    const result = asJsonSchema(entries()[PENDING].result);
    const items = asJsonSchema(result.items);
    expect(items.type).toBe("object");
    expect(Object.keys(items.properties ?? {}).sort()).toEqual([
      "asked_at",
      "chat_id",
      "entity_id",
      "entity_type",
      "event_id",
      "platform",
      "question",
      "status",
    ]);
  });

  it("klodi_pending_decisions is kind 'local' on host_shapes ['in_agent']", () => {
    const entry = entries()[PENDING];
    expect(entry.kind).toBe("local");
    expect([...entry.host_shapes]).toEqual(["in_agent"]);
  });
});
