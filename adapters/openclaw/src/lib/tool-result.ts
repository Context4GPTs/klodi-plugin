/**
 * Shared helpers for formatting tool results.
 *
 * Every tool follows the same shape: validate creds, dispatch to a
 * subject from the catalog, format the response. `requestAndHandle`
 * wraps that in one call so individual tool files stay short.
 */

import type { ToolResult } from "openclaw/plugin-sdk";
import { hasCredentials } from "./config.js";
import { getClient, KlodiRequestError } from "./client.js";

/** Format a successful JSON response as a tool result. */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Format an error string as a tool result. */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Return error message if not registered, null if OK. */
export function requireCreds(): string | null {
  if (!hasCredentials()) {
    return "Not registered. Use klodi_register first.";
  }
  return null;
}

export interface RequestOptions {
  timeout?: number;
}

/**
 * Send a NATS request and return a formatted ToolResult.
 * Catches both transport errors and KlodiRequestError ({error, message}
 * envelopes from the server) and surfaces them as errorResult.
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
    return errorResult(formatError(err));
  }
}

/**
 * Send a NATS request and return the raw parsed response.
 * Tools that need to inspect the response (e.g. listings.create writes
 * a sell file when the response includes listing_id) use this; they
 * format the final ToolResult themselves.
 *
 * Throws on error so the caller's try/catch can decide. Use
 * formatError() for the error string.
 */
export async function rawRequest<T = Record<string, unknown>>(
  subject: string,
  payload: Record<string, unknown>,
  options?: RequestOptions,
): Promise<T> {
  return getClient().request<T>(subject, payload, options);
}

/** Translate any error into a flat user-visible string. */
export function formatError(err: unknown): string {
  if (err instanceof KlodiRequestError) {
    const code = err.code;
    const message = err.message;
    return `${code}: ${message}`;
  }
  if (err instanceof Error) return `Request failed: ${err.message}`;
  return `Request failed: ${String(err)}`;
}
