/**
 * Pre-call guard contract — openclaw (RED).
 *
 * Three guards run in fixed order before any NATS request:
 *
 *   1. `guardCreds` — `${KLODI_HOME}/{nats.creds, config.json}` both
 *      exist. Failure → `not_registered` + `NextAction(Cli)`.
 *   2. `guardConnection` — the singleton KlodiClient is connected.
 *      Failure → `connection_not_ready` + `NextAction(Tool, klodi_setup_status)`.
 *   3. `guardArgs` — schema check on adapter-side required fields.
 *      Failure → `invalid_request` + `details: {field, problem}`,
 *      no recovery_hint.
 *
 * Guards fail FAST — no NATS request, no filesystem write, no
 * marketplace round-trip. First failure short-circuits; later guards do
 * NOT execute (R4).
 *
 * Production items the implementer must add to
 * `adapters/openclaw/src/lib/guards.ts`:
 *
 *   export type ArgKind = "uuid" | "string" | "integer" | "bool"
 *                       | "non_empty_string";
 *
 *   export function guardCreds(opts?: { registerCli?: string }):
 *     ToolEnvelope | null;
 *
 *   export function guardArgs(
 *     args: Record<string, unknown>,
 *     required: ReadonlyArray<{ field: string; kind: ArgKind }>,
 *   ): ToolEnvelope | null;
 *
 *   export function runPreCallGuards(
 *     args: Record<string, unknown>,
 *     required: ReadonlyArray<{ field: string; kind: ArgKind }>,
 *     opts?: { registerCli?: string },
 *   ): ToolEnvelope | null;
 *
 * The async `guardConnection` lives next to the dispatcher because it
 * depends on the singleton client lifecycle; tests for it live in the
 * tools tests (mocked client).
 *
 * This file is QA-owned during RED. NEVER weaken these asserts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";

import {
  type ArgKind,
  guardArgs,
  guardCreds,
  runPreCallGuards,
} from "../../lib/guards.js";
import type { RecoveryHint, ToolEnvelope } from "../../lib/envelope.js";
import { getConfigPath, getCredsPath } from "../../lib/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const ENVELOPE_KEYS = ["details", "error", "message", "recovery_hint"];

function assertEnvelopeShape(env: ToolEnvelope): void {
  expect(Object.keys(env).sort()).toEqual(ENVELOPE_KEYS);
}

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
});

// ── guardCreds ────────────────────────────────────────────────────────

describe("guardCreds", () => {
  it("returns null when both credential files exist", () => {
    writeFileSync(getCredsPath(), "fake-creds");
    writeFileSync(getConfigPath(), "{}");
    expect(guardCreds()).toBeNull();
  });

  it("rejects with not_registered when nats.creds is missing", () => {
    writeFileSync(getConfigPath(), "{}");
    const env = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(env, "guard fails when nats.creds is absent").not.toBeNull();
    const e = env!;
    assertEnvelopeShape(e);
    expect(e.error).toBe("not_registered");
    const hint = e.recovery_hint as RecoveryHint;
    expect(hint.kind).toBe("cli");
    // R8 — recovery_hint references the caller's per-host CLI verbatim.
    expect(hint["command"]).toBe("klodi-openclaw-register");
  });

  it("rejects with not_registered when config.json is missing", () => {
    writeFileSync(getCredsPath(), "fake-creds");
    const env = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(env).not.toBeNull();
    expect(env!.error).toBe("not_registered");
  });

  it("rejects with not_registered when both files are missing", () => {
    // R4 — first guard fires; later guards do not run.
    const env = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(env).not.toBeNull();
    expect(env!.error).toBe("not_registered");
  });

  it("returns the four-key envelope shape on rejection", () => {
    const env = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(env).not.toBeNull();
    assertEnvelopeShape(env!);
  });

  it("uses a sensible default register CLI when none supplied", () => {
    // The dev pair picks the default — almost certainly the openclaw
    // host name — but the contract is "always emits the cli kind".
    const env = guardCreds();
    expect(env).not.toBeNull();
    const hint = env!.recovery_hint as RecoveryHint;
    expect(hint.kind).toBe("cli");
    // Must not be empty/undefined — the agent surfaces the literal command.
    expect(typeof hint["command"]).toBe("string");
    expect((hint["command"] as string).length).toBeGreaterThan(0);
  });
});

// ── guardArgs ─────────────────────────────────────────────────────────

describe("guardArgs", () => {
  it("returns null when every required field is well-formed", () => {
    const env = guardArgs(
      { transaction_id: "550e8400-e29b-41d4-a716-446655440000" },
      [{ field: "transaction_id", kind: "uuid" }],
    );
    expect(env).toBeNull();
  });

  it("rejects missing required fields with problem=missing", () => {
    const env = guardArgs({}, [
      { field: "transaction_id", kind: "uuid" },
    ]);
    expect(env).not.toBeNull();
    assertEnvelopeShape(env!);
    expect(env!.error).toBe("invalid_request");
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("transaction_id");
    expect(details["problem"]).toBe("missing");
    expect(env!.recovery_hint).toBeNull();
  });

  it("rejects wrong-type fields with problem=wrong_type", () => {
    const env = guardArgs({ transaction_id: 42 }, [
      { field: "transaction_id", kind: "uuid" },
    ]);
    expect(env).not.toBeNull();
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("transaction_id");
    expect(details["problem"]).toBe("wrong_type");
  });

  it("rejects empty strings on non_empty_string with problem=empty", () => {
    const env = guardArgs({ content: "" }, [
      { field: "content", kind: "non_empty_string" },
    ]);
    expect(env).not.toBeNull();
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("content");
    expect(details["problem"]).toBe("empty");
  });

  it("rejects malformed UUIDs with problem=wrong_type", () => {
    const env = guardArgs({ transaction_id: "not-a-uuid" }, [
      { field: "transaction_id", kind: "uuid" },
    ]);
    expect(env).not.toBeNull();
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("transaction_id");
    expect(details["problem"]).toBe("wrong_type");
  });

  it("short-circuits at the first failure (R4 ordering)", () => {
    // channel_id is missing AND content is empty — guard reports
    // channel_id because it's first in the required list.
    const env = guardArgs({ content: "" }, [
      { field: "channel_id", kind: "uuid" },
      { field: "content", kind: "non_empty_string" },
    ]);
    expect(env).not.toBeNull();
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("channel_id");
    expect(details["problem"]).toBe("missing");
  });

  it("passes integers when expected", () => {
    const env = guardArgs({ limit: 10 }, [{ field: "limit", kind: "integer" }]);
    expect(env).toBeNull();
  });

  it("rejects floats passed where integers are required", () => {
    // The agent might pass 3.14 hoping it gets truncated. The guard says
    // no.
    const env = guardArgs({ limit: 3.14 }, [
      { field: "limit", kind: "integer" },
    ]);
    expect(env).not.toBeNull();
    const details = env!.details as Record<string, unknown>;
    expect(details["field"]).toBe("limit");
    expect(details["problem"]).toBe("wrong_type");
  });

  const argKinds: ArgKind[] = [
    "uuid",
    "string",
    "integer",
    "bool",
    "non_empty_string",
  ];

  for (const kind of argKinds) {
    it(`recognises ArgKind: ${kind}`, () => {
      // Just exercise each variant in the type — the implementer can't
      // change the enum without breaking this test.
      const result = guardArgs({}, [{ field: "x", kind }]);
      expect(result).not.toBeNull();
      expect(result!.error).toBe("invalid_request");
    });
  }
});

// ── runPreCallGuards (ordering / composition) ─────────────────────────

describe("runPreCallGuards", () => {
  it("reports creds failure BEFORE args failure (R4 creds-first)", () => {
    // No creds files written; args also empty — creds guard fires first.
    const env = runPreCallGuards(
      {},
      [{ field: "transaction_id", kind: "uuid" }],
      { registerCli: "klodi-openclaw-register" },
    );
    expect(env).not.toBeNull();
    expect(env!.error).toBe(
      "not_registered",
      // Implementation hint — see test name; never weaken this assert.
    );
  });

  it("reaches the args guard when creds pass", () => {
    writeFileSync(getCredsPath(), "fake-creds");
    writeFileSync(getConfigPath(), "{}");
    const env = runPreCallGuards(
      {},
      [{ field: "transaction_id", kind: "uuid" }],
      { registerCli: "klodi-openclaw-register" },
    );
    expect(env).not.toBeNull();
    expect(env!.error).toBe("invalid_request");
  });

  it("returns null when every guard passes", () => {
    writeFileSync(getCredsPath(), "fake-creds");
    writeFileSync(getConfigPath(), "{}");
    const env = runPreCallGuards(
      { transaction_id: "550e8400-e29b-41d4-a716-446655440000" },
      [{ field: "transaction_id", kind: "uuid" }],
      { registerCli: "klodi-openclaw-register" },
    );
    expect(env).toBeNull();
  });

  it("never mutates KLODI_HOME (side-effect freedom, R4)", () => {
    // Snapshot the directory listing before and after a failing call.
    // Guards must not create sell/buy/policies files in the process of
    // rejecting.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const before = readdirSync(home.path).sort();
    runPreCallGuards(
      {},
      [{ field: "transaction_id", kind: "uuid" }],
      { registerCli: "klodi-openclaw-register" },
    );
    const after = readdirSync(home.path).sort();
    expect(after).toEqual(before);
  });

  it("returns a four-key envelope on every rejection", () => {
    const env = runPreCallGuards(
      {},
      [{ field: "transaction_id", kind: "uuid" }],
      { registerCli: "klodi-openclaw-register" },
    );
    expect(env).not.toBeNull();
    assertEnvelopeShape(env!);
  });
});
