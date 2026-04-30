/**
 * Persistent NATS-creds + identity config for the Klodi plugin.
 *
 * `nats.creds` (an NKey-signed JWT) and `config.json` (handle, user_id,
 * nkey_public, nats_url) are written under `${klodi_home}/` by the
 * registration flow and read by the connection layer on every connect.
 *
 * Path resolution lives in `paths.ts`; sell/buy file I/O in
 * `sell-buy-files.ts`; policy seeding in `policy-seeding.ts`. This
 * module is just the disk read/write contract for the auth-plane
 * artifacts.
 */

import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";

import { getConfigPath, getCredsPath, getKlodiHome } from "./paths.js";

export interface KlodiConfig {
  handle: string;
  user_id: string;
  nkey_public: string;
  nats_url: string;
  notification_channel?: string;
  notification_target?: string;
}

export function hasCredentials(): boolean {
  return existsSync(getCredsPath()) && existsSync(getConfigPath());
}

let cachedConfig: KlodiConfig | null = null;

export function loadConfig(): KlodiConfig {
  if (cachedConfig) return cachedConfig;
  const path = getConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      "Not registered. Use klodi_register to sign up.",
    );
  }
  cachedConfig = JSON.parse(
    readFileSync(path, "utf-8"),
  ) as KlodiConfig;
  return cachedConfig;
}

export function loadCreds(): Uint8Array {
  const path = getCredsPath();
  if (!existsSync(path)) {
    throw new Error(
      "Credentials not found. Use klodi_register to sign up.",
    );
  }
  // See ADR-0002. The read-time mode check catches after-write drift
  // (backup tools, user chmod -R, umask-dependent restores). The
  // klodi_setup_status tool promotes this into the `creds_perms`
  // issue code so the agent can surface it to the user.
  //
  // Mode check (D2): "no group or world bits" — `(mode & 0o077) === 0`.
  // Both 0o600 (documented baseline) and 0o400 (stricter) pass; any
  // group or world bit fires the warning.
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(
      `[klodi] WARNING: ${path} has permissions `
      + `${mode.toString(8)}, expected no group/world bits (0600 or stricter)`,
    );
  }
  return readFileSync(path);
}

export function writeConfig(config: KlodiConfig): void {
  const dir = getKlodiHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getConfigPath(),
    JSON.stringify(config, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  cachedConfig = config;
}

/**
 * Drop the in-memory config cache. Called by klodi_setup_repair to
 * ensure a subsequent loadConfig() re-reads disk instead of serving
 * the deleted user's stale handle/user_id/nats_url.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
