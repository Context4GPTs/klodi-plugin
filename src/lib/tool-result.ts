/**
 * Shared helpers for formatting tool results.
 */

import type { ToolResult } from "openclaw/plugin-sdk";
import { hasCredentials } from "./config.js";
import { request, type NatsRequestOptions } from "./nats-client.js";

/** Format a successful JSON response as a tool result. */
export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Format an error as a tool result. */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Check if a NATS response contains an error and format accordingly. */
export function handleResponse(
  response: Record<string, unknown>,
): ToolResult {
  if ("error" in response) {
    const code = response["error"] as string;
    const msg = (response["message"] as string) ?? code;
    return errorResult(`${code}: ${msg}`);
  }
  return jsonResult(response);
}

/** Return error message if not registered, null if OK. */
export function requireCreds(): string | null {
  if (!hasCredentials()) {
    return "Not registered. Use klodi_register first.";
  }
  return null;
}

/**
 * Send a NATS request and return a formatted ToolResult.
 * Catches NATS errors and returns errorResult instead of throwing.
 */
export async function requestAndHandle(
  subject: string,
  payload: Record<string, unknown>,
  options?: NatsRequestOptions,
): Promise<ToolResult> {
  try {
    const result = options
      ? await request(subject, payload, options)
      : await request(subject, payload);
    return handleResponse(result);
  } catch (err) {
    return errorResult(
      `Request failed: ${String(err)}`,
    );
  }
}
