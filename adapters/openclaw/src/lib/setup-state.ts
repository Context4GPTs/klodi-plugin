/**
 * Setup state derivation for klodi_setup_status.
 *
 * Filesystem + (optionally) NATS probes derive a single SetupPhase.
 * Klodi does not inspect host wake-primitive config — that's the host's
 * problem to surface and fix. If wakes are not landing, the user
 * consults the host's own routing config (see adapter README).
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { existsSync, statSync } from "node:fs";
import {
  WHOAMI_PROBE_TIMEOUT_MS,
  KlodiRequestError,
} from "@klodi/nats-client";
import {
  connectClient,
  getClient,
  isClientConnected,
} from "./client.js";
import {
  getConfigPath,
  getCredsPath,
  getNegotiationStylePath,
  getSecurityPolicyPath,
} from "./paths.js";
import { loadConfig, type KlodiConfig } from "./config.js";
import { isNegotiationStyleFilled } from "./policy-seeding.js";

export type SetupPhase =
  | "unregistered"
  | "corrupt"
  | "degraded"
  | "needs_policy"
  | "ready";

export interface SetupChecks {
  credentials_present: boolean;
  config_present: boolean;
  config_valid: boolean;
  creds_mode_secure: boolean;
  nats_connected: boolean;
  /** null when probe was skipped OR NATS not connected. */
  nats_whoami_ok: boolean | null;
  policy_seeded: boolean;
  policy_filled: boolean;
  security_policy_present: boolean;
}

export interface GatherOptions {
  probe?: boolean;
}

export async function gatherChecks(
  api: PluginAPI,
  { probe = true }: GatherOptions = {},
): Promise<SetupChecks> {
  const credsPath = getCredsPath();
  const configPath = getConfigPath();
  const credentials_present = existsSync(credsPath);
  const config_present = existsSync(configPath);
  const config = safeLoadConfig();
  const config_valid = config !== null
    && typeof config.handle === "string"
    && typeof config.user_id === "string"
    && typeof config.nkey_public === "string"
    && typeof config.nats_url === "string";

  const creds_mode_secure = credentials_present
    ? credsModeSecure(credsPath)
    : false;

  if (config_valid && credentials_present) {
    try {
      await connectClient(api);
    } catch {
      // surfaced via the nats_connected flag below
    }
  }

  const nats_connected = isClientConnected();
  const nats_whoami_ok = nats_connected && probe
    ? await probeWhoami(api)
    : null;

  return {
    credentials_present,
    config_present,
    config_valid,
    creds_mode_secure,
    nats_connected,
    nats_whoami_ok,
    policy_seeded: existsSync(getNegotiationStylePath()),
    policy_filled: isNegotiationStyleFilled(),
    security_policy_present: existsSync(getSecurityPolicyPath()),
  };
}

export function derivePhase(c: SetupChecks): SetupPhase {
  if (!c.credentials_present && !c.config_present) return "unregistered";
  if (c.credentials_present !== c.config_present) return "corrupt";
  if (!c.config_valid) return "corrupt";
  if (!c.nats_connected || c.nats_whoami_ok === false) return "degraded";
  if (!c.security_policy_present) return "needs_policy";
  if (!c.policy_seeded) return "needs_policy";
  if (!c.policy_filled) return "needs_policy";
  return "ready";
}

export function safeLoadConfig(): KlodiConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * Returns true if the creds file has no group or world bits set (D2).
 * Accepts the documented 0o600 baseline AND any stricter mode (e.g.
 * 0o400, read-only owner). Mirrors the lenient rule in
 * `nats-client-ts/src/config.ts` and Python / Rust adapters.
 */
function credsModeSecure(path: string): boolean {
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function probeWhoami(api: PluginAPI): Promise<boolean> {
  try {
    await getClient().request(
      "p2p.v1.users.whoami",
      {},
      { timeout: WHOAMI_PROBE_TIMEOUT_MS },
    );
    return true;
  } catch (err: unknown) {
    if (err instanceof KlodiRequestError) {
      api.logger.warn("whoami_probe_failed", {
        subject: "p2p.v1.users.whoami",
        error: err.code,
        message: err.message,
        reason: "server_error",
      });
      return false;
    }
    api.logger.warn("whoami_probe_failed", {
      subject: "p2p.v1.users.whoami",
      error: String(err),
      reason: "transport_or_timeout",
    });
    return false;
  }
}
