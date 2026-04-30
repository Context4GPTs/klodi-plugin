/**
 * Process-wide KlodiClient singleton.
 *
 * Replaces the previous `nats-client.ts` shim (deleted as part of
 * 0012). One client instance per plugin process — held alive by the
 * gateway lifecycle hook in `src/index.ts`. Tools call
 * `getClient().request(...)`; the gateway calls `connectClient()` /
 * `closeClient()` on session-start / session-end.
 */

import { KlodiClient, KlodiRequestError } from "@klodi/nats-client";
import { getConfigPath, getCredsPath } from "./paths.js";
import type { PluginAPILike } from "./plugin-api-types.js";

let client: KlodiClient | null = null;
let pluginApi: PluginAPILike | null = null;

/**
 * Establish (or reuse) the singleton client. Idempotent — repeated
 * calls return the existing connected instance.
 */
export async function connectClient(api: PluginAPILike): Promise<KlodiClient> {
  pluginApi = api;
  if (client === null) {
    client = new KlodiClient({
      credsPath: getCredsPath(),
      configPath: getConfigPath(),
      onError: (err: unknown, context: Record<string, unknown>) => {
        api.logger.warn("klodi_client_error", {
          error: err instanceof Error ? err.message : String(err),
          ...context,
        });
      },
    });
  }
  await client.connect();
  return client;
}

/**
 * Get the singleton without forcing connect. Tools call this after
 * `requireCreds()` has confirmed credentials exist; the underlying
 * `request()` triggers a lazy connect on first use.
 */
export function getClient(): KlodiClient {
  if (client === null) {
    if (pluginApi === null) {
      throw new Error(
        "KlodiClient not initialized. The gateway lifecycle hook must"
        + " call connectClient() at session start.",
      );
    }
    client = new KlodiClient({
      credsPath: getCredsPath(),
      configPath: getConfigPath(),
      onError: (err: unknown, context: Record<string, unknown>) => {
        pluginApi?.logger.warn("klodi_client_error", {
          error: err instanceof Error ? err.message : String(err),
          ...context,
        });
      },
    });
  }
  return client;
}

/**
 * Drain and clear the singleton. Idempotent — calling twice or after
 * the client was never connected is a no-op.
 *
 * Per **D § D13** (P2-2): only called from `gateway:shutdown` and
 * `klodi_setup_repair`. The connection persists across `command:reset`
 * and other in-session events, so this should be reached at most once
 * per gateway lifetime under normal operation.
 */
export async function closeClient(): Promise<void> {
  if (client === null) return;
  await client.close();
  client = null;
}

export function isClientConnected(): boolean {
  return client !== null && client.isConnected();
}

export { KlodiRequestError };
