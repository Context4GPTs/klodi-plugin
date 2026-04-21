/**
 * Setup state derivation — shared between klodi_setup_status and
 * klodi_pending.
 *
 * Filesystem + (optionally) NATS probes derive a single SetupPhase.
 * klodi_setup_status runs the full probe (whoami round-trip);
 * klodi_pending runs the cheap filesystem-only subset so every
 * session-start call stays sub-millisecond.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { existsSync, statSync } from "node:fs";
import {
  isConnected,
  request,
  WHOAMI_PROBE_TIMEOUT_MS,
} from "./nats-client.js";
import { readApiConfig } from "./api-config.js";
import {
  parseDurationMs,
  HEARTBEAT_EVERY_CEILING_MS,
} from "./duration.js";
import {
  getCredsPath,
  getConfigPath,
  getNegotiationStylePath,
  getSecurityPolicyPath,
  isNegotiationStyleFilled,
  loadConfig,
  type KlodiConfig,
} from "./config.js";

export type SetupPhase =
  | "unregistered"
  | "corrupt"
  | "degraded"
  | "needs_heartbeat"
  | "needs_policy"
  | "ready";

export interface SetupChecks {
  credentials_present: boolean;
  config_present: boolean;
  config_valid: boolean;
  creds_mode_600: boolean;
  nats_connected: boolean;
  /** null when probe was skipped OR NATS not connected */
  nats_whoami_ok: boolean | null;
  heartbeat_target: string | null;
  /**
   * Parsed `agents.defaults.heartbeat.every` in ms.
   * null when the config key is absent or unparseable.
   */
  heartbeat_every_ms: number | null;
  policy_seeded: boolean;
  policy_filled: boolean;
  security_policy_present: boolean;
}

export interface GatherOptions {
  /**
   * Skip the whoami NATS round-trip. Use `false` from hot paths like
   * klodi_pending where the ~100ms-3s cost is unacceptable. A skipped
   * probe sets `nats_whoami_ok: null` — derivePhase treats that as
   * "unknown, not failed", so a connected-but-revoked user reads as
   * `ready` from pending (first real tool call surfaces the failure).
   */
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

  const creds_mode_600 = credentials_present
    ? credsModeMatches(credsPath, 0o600)
    : false;

  const nats_connected = isConnected();
  const nats_whoami_ok = nats_connected && probe
    ? await probeWhoami(api)
    : null;

  const heartbeat_raw = readApiConfig(api, "agents.defaults.heartbeat.target");
  const heartbeat_target = typeof heartbeat_raw === "string"
    ? heartbeat_raw.trim()
    : null;

  const heartbeat_every_ms = parseDurationMs(
    readApiConfig(api, "agents.defaults.heartbeat.every"),
  );

  return {
    credentials_present,
    config_present,
    config_valid,
    creds_mode_600,
    nats_connected,
    nats_whoami_ok,
    heartbeat_target,
    heartbeat_every_ms,
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
  if (c.heartbeat_target !== "last") return "needs_heartbeat";
  if (
    c.heartbeat_every_ms === null
    || c.heartbeat_every_ms === 0
    || c.heartbeat_every_ms > HEARTBEAT_EVERY_CEILING_MS
  ) return "needs_heartbeat";
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

function credsModeMatches(path: string, expected: number): boolean {
  try {
    const mode = statSync(path).mode & 0o777;
    return mode === expected;
  } catch {
    return false;
  }
}

async function probeWhoami(api: PluginAPI): Promise<boolean> {
  try {
    const resp = await request(
      "p2p.v1.users.whoami",
      {},
      { timeout: WHOAMI_PROBE_TIMEOUT_MS },
    );
    if ("error" in resp) {
      api.logger.warn("whoami_probe_failed", {
        subject: "p2p.v1.users.whoami",
        error: String(resp["error"]),
        message: String(resp["message"] ?? ""),
        reason: "server_error",
      });
      return false;
    }
    return true;
  } catch (err) {
    api.logger.warn("whoami_probe_failed", {
      subject: "p2p.v1.users.whoami",
      error: String(err),
      reason: "transport_or_timeout",
    });
    return false;
  }
}
