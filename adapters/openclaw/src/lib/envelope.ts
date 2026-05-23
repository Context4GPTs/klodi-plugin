/**
 * Tool-result envelope contract for openclaw.
 *
 * The architect's ADR-0011 plan locks the wire format at
 *
 *   { error: "<code>", message: "<human>",
 *     details: Record<string, unknown> | null,
 *     recovery_hint: RecoveryHint | null }
 *
 * All four keys are ALWAYS present. `details` and `recovery_hint`
 * serialise as JSON `null` when absent — `undefined` MUST NOT leak to
 * the wire because `JSON.stringify` drops `undefined` keys and the
 * cross-language parity oracle (golden fixture in
 * `packages/tool-catalog/tests/fixtures/envelope-golden.json`) requires
 * the explicit `null` placeholder.
 *
 * `recovery_hint` mirrors the `NextAction` discriminated union from
 * `packages/klodi-rust-host/src/setup_status.rs` (`cli | tool | shell |
 * dialog`). Variant payload fields ride alongside `kind` as a flat
 * object so the agent sees the same shape on every adapter.
 *
 * See ADR-0011.
 */

import type { ToolResult } from "openclaw/plugin-sdk";
import { KlodiRequestError } from "./client.js";

/**
 * Structural check for the `KlodiRequestError` shape.
 *
 * Why duck-typing instead of `instanceof`: the production class lives
 * in `@klodi/nats-client`, the test mock helper at
 * `adapters/openclaw/src/__tests__/helpers/mock-nats.ts` declares its
 * own identically-shaped class so vitest's module mocking can substitute
 * the client without bringing in the WS transport. The two classes are
 * structurally identical but `instanceof`-incompatible. Reaching for
 * the shape (`name`, `.code`, `.message`) keeps the helper portable
 * across the real client and the test double. See ADR-0011.
 */
function isKlodiRequestError(value: unknown): value is KlodiRequestError {
  if (!(value instanceof Error)) return false;
  if (value.name !== "KlodiRequestError") return false;
  return typeof (value as { code?: unknown }).code === "string";
}

export interface RecoveryHint {
  readonly kind: "cli" | "tool" | "shell" | "dialog";
  readonly [key: string]: unknown;
}

export interface ToolEnvelope {
  readonly error: string;
  readonly message: string;
  readonly details: Record<string, unknown> | null;
  readonly recovery_hint: RecoveryHint | null;
}

export interface EnvelopeParts {
  error: string;
  message: string;
  details?: Record<string, unknown> | null;
  recovery_hint?: RecoveryHint | null;
}

/**
 * Build the canonical four-key envelope. Missing `details` /
 * `recovery_hint` collapse to explicit `null` so they survive
 * `JSON.stringify` round-trips (TS drops `undefined` keys; the wire
 * needs literal `null`).
 */
export function makeEnvelope(parts: EnvelopeParts): ToolEnvelope {
  return {
    error: parts.error,
    message: parts.message,
    details: parts.details ?? null,
    recovery_hint: parts.recovery_hint ?? null,
  };
}

export interface EnvelopeFromErrorOptions {
  /** Per-host register CLI name. When set, `not_registered` envelopes
   * carry the host-specific `NextAction::Cli` recovery hint (R8). */
  registerCli?: string;
}

/**
 * Map any thrown value to a `ToolEnvelope`.
 *
 * `KlodiRequestError` (marketplace passthrough) collapses to the R2
 * catch-all `marketplace_error`; the server's original code rides in
 * `details.marketplace_error_code`, the message in
 * `details.marketplace_message`, and any extra server payload in
 * `details.marketplace_details`. This preserves the R2 closed-vocabulary
 * invariant — agents pattern-match on a fixed set of `error` values.
 *
 * Everything else degrades to `internal_error`; the agent retries once
 * or surfaces. Round 2 P2.1 fix — the previous round preserved the
 * server code as `error`, violating R2.
 */
export function envelopeFromError(
  err: unknown,
  _options: EnvelopeFromErrorOptions = {},
): ToolEnvelope {
  if (isKlodiRequestError(err)) {
    const details: Record<string, unknown> = {
      marketplace_error_code: err.code,
      marketplace_message: err.message,
    };
    if (isRecord(err.details)) {
      details["marketplace_details"] = err.details;
    }
    return makeEnvelope({
      error: "marketplace_error",
      message: err.message,
      details,
      recovery_hint: null,
    });
  }
  if (err instanceof Error) {
    return makeEnvelope({
      error: "internal_error",
      message: err.message || err.name,
      details: { exception_class: err.constructor.name || err.name },
      recovery_hint: null,
    });
  }
  // Non-Error throws (strings, numbers, plain objects) — agents see the
  // class name surface as `unknown`.
  return makeEnvelope({
    error: "internal_error",
    message: String(err),
    details: { exception_class: "unknown" },
    recovery_hint: null,
  });
}

/**
 * Wrap a `ToolEnvelope` in the openclaw `ToolResult` shape. The plain-
 * text channel (`content[0].text`) carries a pretty-printed JSON
 * serialisation so non-structured-aware clients still see the
 * envelope; `isError` is set so the host treats the call as failed.
 */
export function envelopeToToolResult(env: ToolEnvelope): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
