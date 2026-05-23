/**
 * Tool-result envelope contract — openclaw (RED).
 *
 * Mirrors the Rust contract in `packages/klodi-rust-host/src/mcp/envelope.rs`
 * and the Python contract in `packages/nats-client-py/src/klodi_nats_client/envelope.py`.
 *
 * ADR-0011 locks the wire format at:
 *
 *   { error: "<code>", message: "<human>",
 *     details: object | null, recovery_hint: object | null }
 *
 * All four keys ALWAYS present. `details` and `recovery_hint` serialise
 * as JSON `null` when absent — never elided (`undefined` MUST NOT leak
 * to the wire; TS's `JSON.stringify` drops `undefined` keys, so the
 * envelope helper substitutes explicit `null`).
 *
 * Production items the implementer must add to
 * `adapters/openclaw/src/lib/envelope.ts`:
 *
 *   export interface RecoveryHint {
 *     readonly kind: "cli" | "tool" | "shell" | "dialog";
 *     readonly [key: string]: unknown;
 *   }
 *
 *   export interface ToolEnvelope {
 *     readonly error: string;
 *     readonly message: string;
 *     readonly details: Record<string, unknown> | null;
 *     readonly recovery_hint: RecoveryHint | null;
 *   }
 *
 *   export function makeEnvelope(parts: {
 *     error: string; message: string;
 *     details?: Record<string, unknown> | null;
 *     recovery_hint?: RecoveryHint | null;
 *   }): ToolEnvelope;
 *
 *   export function envelopeFromError(err: unknown, options?: {
 *     registerCli?: string;
 *   }): ToolEnvelope;
 *
 *   export function envelopeToToolResult(env: ToolEnvelope): ToolResult;
 *
 * This file is QA-owned during RED. NEVER weaken these asserts — add the
 * production items in envelope.ts until they hold.
 */

import { describe, it, expect } from "vitest";

// The implementer adds these symbols. Until they exist, the imports fail
// and every test in this file errors at module-load.
import {
  type RecoveryHint,
  type ToolEnvelope,
  envelopeFromError,
  envelopeToToolResult,
  makeEnvelope,
} from "../../lib/envelope.js";
import { KlodiRequestError } from "../helpers/mock-nats.js";

const ENVELOPE_KEYS = ["error", "message", "details", "recovery_hint"];

function assertEnvelopeShape(env: ToolEnvelope): void {
  const keys = Object.keys(env).sort();
  expect(keys, "envelope must carry exactly the four R1 keys").toEqual(
    ENVELOPE_KEYS.slice().sort(),
  );
}

// ── makeEnvelope: wire-shape invariants (R1) ───────────────────────────

describe("makeEnvelope (R1 wire shape)", () => {
  it("returns the four R1 keys when no details/recovery_hint are passed", () => {
    const env = makeEnvelope({
      error: "internal_error",
      message: "boom",
    });
    assertEnvelopeShape(env);
    expect(env.details).toBeNull();
    expect(env.recovery_hint).toBeNull();
  });

  it("returns `null` (not `undefined`) for missing details/recovery_hint", () => {
    const env = makeEnvelope({
      error: "internal_error",
      message: "boom",
    });
    // R1 — details/recovery_hint serialise as JSON `null`, never absent.
    // TS's JSON.stringify drops `undefined`; explicit `null` is the only
    // way to land on the wire.
    expect(env.details === null).toBe(true);
    expect(env.recovery_hint === null).toBe(true);
  });

  it("serialises null fields as JSON null — never elided", () => {
    const env = makeEnvelope({ error: "internal_error", message: "boom" });
    const wire = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(ENVELOPE_KEYS.slice().sort());
    expect(wire["details"]).toBeNull();
    expect(wire["recovery_hint"]).toBeNull();
  });

  it("preserves details object verbatim", () => {
    const env = makeEnvelope({
      error: "invalid_request",
      message: "transaction_id is required",
      details: { field: "transaction_id", problem: "missing" },
    });
    assertEnvelopeShape(env);
    expect(env.details).toEqual({
      field: "transaction_id",
      problem: "missing",
    });
    expect(env.recovery_hint).toBeNull();
  });

  it("preserves a NextAction Cli recovery_hint", () => {
    const env = makeEnvelope({
      error: "not_registered",
      message: "Run klodi-openclaw-register",
      recovery_hint: {
        kind: "cli",
        command: "klodi-openclaw-register",
        message: "Run klodi-openclaw-register from the shell.",
      },
    });
    assertEnvelopeShape(env);
    const hint = env.recovery_hint as RecoveryHint;
    expect(hint.kind).toBe("cli");
    expect(hint["command"]).toBe("klodi-openclaw-register");
  });

  it("preserves a NextAction Tool recovery_hint", () => {
    const env = makeEnvelope({
      error: "connection_not_ready",
      message: "klodi NATS connection not ready",
      recovery_hint: {
        kind: "tool",
        tool: "klodi_setup_status",
        message: "Run klodi_setup_status to diagnose.",
      },
    });
    assertEnvelopeShape(env);
    const hint = env.recovery_hint as RecoveryHint;
    expect(hint.kind).toBe("tool");
    expect(hint["tool"]).toBe("klodi_setup_status");
  });
});

// ── envelopeFromError: KlodiRequestError marketplace passthrough ──────

describe("envelopeFromError — KlodiRequestError", () => {
  it("collapses marketplace errors to the R2 catch-all `marketplace_error`", () => {
    // Round 2 P2.1 — every marketplace error now collapses to the
    // closed-vocabulary catch-all `marketplace_error`; the server's
    // original code rides in `details.marketplace_error_code`, the
    // message in `details.marketplace_message`, and extra server
    // payload in `details.marketplace_details`. Recovery_hint stays
    // null per architect open Q2 conservative default.
    const err = new KlodiRequestError({
      error: "listing_not_owned_by_caller",
      message: "Listing belongs to another user",
      details: { listing_id: "abc" },
    });
    const env = envelopeFromError(err);
    assertEnvelopeShape(env);
    expect(env.error).toBe("marketplace_error");
    expect(env.message).toBe("Listing belongs to another user");
    const details = env.details as Record<string, unknown>;
    expect(details["marketplace_error_code"]).toBe("listing_not_owned_by_caller");
    expect(details["marketplace_message"]).toBe("Listing belongs to another user");
    expect(details["marketplace_details"]).toEqual({ listing_id: "abc" });
    expect(env.recovery_hint).toBeNull();
  });

  it("omits `marketplace_details` when the marketplace returns no details", () => {
    const err = new KlodiRequestError({
      error: "validation_failed",
      message: "bad payload",
    });
    const env = envelopeFromError(err);
    assertEnvelopeShape(env);
    expect(env.error).toBe("marketplace_error");
    const details = env.details as Record<string, unknown>;
    expect(details["marketplace_error_code"]).toBe("validation_failed");
    expect("marketplace_details" in details).toBe(false);
    expect(env.recovery_hint).toBeNull();
  });
});

// ── envelopeFromError: generic transport / unknown errors ─────────────

describe("envelopeFromError — uncategorised errors", () => {
  it("maps a generic Error to `internal_error` with no recovery_hint", () => {
    const err = new Error("connection lost");
    const env = envelopeFromError(err);
    assertEnvelopeShape(env);
    expect(env.error).toBe("internal_error");
    expect(env.recovery_hint).toBeNull();
  });

  it("carries the exception class in details.exception_class", () => {
    const env = envelopeFromError(new TypeError("nope"));
    expect(env.details).not.toBeNull();
    expect(
      (env.details as Record<string, unknown>)["exception_class"],
    ).toBe("TypeError");
  });

  it("maps non-Error throw values to internal_error", () => {
    expect(envelopeFromError("boom").error).toBe("internal_error");
    expect(envelopeFromError(42).error).toBe("internal_error");
    expect(envelopeFromError({ random: "object" }).error).toBe(
      "internal_error",
    );
  });
});

// ── envelopeToToolResult: ToolResult plumbing ─────────────────────────

describe("envelopeToToolResult", () => {
  it("wraps the envelope into the ToolResult shape with isError=true", () => {
    const env = makeEnvelope({
      error: "internal_error",
      message: "boom",
    });
    const result = envelopeToToolResult(env);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("serialises the four-key envelope into content[0].text as JSON", () => {
    const env = makeEnvelope({
      error: "not_registered",
      message: "Run klodi-openclaw-register",
      recovery_hint: {
        kind: "cli",
        command: "klodi-openclaw-register",
        message: "Run klodi-openclaw-register from the shell.",
      },
    });
    const result = envelopeToToolResult(env);
    const parsed = JSON.parse(result.content[0]!.text!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual(ENVELOPE_KEYS.slice().sort());
    expect(parsed["error"]).toBe("not_registered");
    expect(parsed["details"]).toBeNull();
    const hint = parsed["recovery_hint"] as Record<string, unknown>;
    expect(hint["kind"]).toBe("cli");
    expect(hint["command"]).toBe("klodi-openclaw-register");
  });

  it("does NOT drop null fields on serialisation", () => {
    // Direct R1 invariant: JSON.stringify preserves null, drops undefined.
    // The helper must produce a value where `details` and `recovery_hint`
    // are literal null when absent — proven by the JSON output keys.
    const env = makeEnvelope({ error: "internal_error", message: "x" });
    const result = envelopeToToolResult(env);
    const wire = result.content[0]!.text!;
    expect(wire).toContain('"details": null');
    expect(wire).toContain('"recovery_hint": null');
  });
});

// ── Round-trip / cross-language parity sanity ─────────────────────────

describe("envelope round-trip / parity sanity", () => {
  it("a complete envelope round-trips through JSON unchanged", () => {
    const env = makeEnvelope({
      error: "invalid_request",
      message: "content is empty",
      details: { field: "content", problem: "empty" },
      recovery_hint: null,
    });
    const wire = JSON.stringify(env);
    const parsed = JSON.parse(wire) as ToolEnvelope;
    expect(parsed).toEqual(env);
  });

  it("the serialised key set matches the language-neutral order [details, error, message, recovery_hint]", () => {
    // Cross-language wire-format sanity: the JSON object carries the
    // same four keys the Rust / Python envelopes emit.
    const env = makeEnvelope({ error: "internal_error", message: "x" });
    const keys = Object.keys(JSON.parse(JSON.stringify(env))).sort();
    expect(keys).toEqual(["details", "error", "message", "recovery_hint"]);
  });
});
