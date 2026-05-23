/**
 * Shared helpers for formatting tool results.
 *
 * Every tool follows the same shape: pre-call guards, dispatch to a
 * subject from the catalog, format the response. `requestAndHandle`
 * wraps that in one call so individual tool files stay short.
 *
 * Error paths use the canonical four-key envelope (ADR-0011). Tools
 * call `runPreCallGuards()` from `lib/guards.js` (the single canonical
 * pre-call guard path) to short-circuit when creds are missing OR args
 * are malformed, then dispatch via `requestAndHandle` / `rawRequest`.
 * Any thrown value is converted to an envelope by `envelopeToolResult`
 * which carries the structured payload to the agent.
 *
 * The legacy `requireCredsEnvelope()` helper has been deleted (round 2
 * P1.2 + P2.4). It duplicated `guardCreds()` in `lib/guards.ts` with a
 * slightly different `message` string — a silent-drift trap. The
 * production path is now exclusively `runPreCallGuards()`.
 */

import type { ToolResult } from "openclaw/plugin-sdk";
import { getClient } from "./client.js";
import { envelopeFromError, envelopeToToolResult } from "./envelope.js";

/** Format a successful JSON response as a tool result. */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Convert any thrown value into the canonical four-key envelope
 * `ToolResult`. Per ADR-0011 the agent sees `error`, `message`,
 * `details`, `recovery_hint` — no bare strings.
 */
export function envelopeToolResult(err: unknown): ToolResult {
  return envelopeToToolResult(envelopeFromError(err));
}


export interface RequestOptions {
  timeout?: number;
}

/**
 * Send a NATS request and return a formatted ToolResult.
 * Catches both transport errors and `KlodiRequestError` (`{error,
 * message, details}` envelopes from the server) and surfaces them as a
 * canonical four-key envelope `ToolResult`. See ADR-0011.
 */
export async function requestAndHandle(
  subject: string,
  payload: Record<string, unknown>,
  options?: RequestOptions,
): Promise<ToolResult> {
  try {
    const result = await getClient().request<Record<string, unknown>>(
      subject,
      payload,
      options,
    );
    return jsonResult(result);
  } catch (err) {
    return envelopeToolResult(err);
  }
}

/**
 * Send a NATS request and return the raw parsed response.
 *
 * Tools that need to inspect the response (e.g. `listings.create`
 * writes a sell file when the response includes `listing_id`) use this;
 * they format the final `ToolResult` themselves.
 *
 * Throws on error so the caller's try/catch can decide. Use
 * {@link envelopeToolResult} from the catch arm to produce the
 * canonical envelope `ToolResult`.
 */
export async function rawRequest<T = Record<string, unknown>>(
  subject: string,
  payload: Record<string, unknown>,
  options?: RequestOptions,
): Promise<T> {
  return getClient().request<T>(subject, payload, options);
}
