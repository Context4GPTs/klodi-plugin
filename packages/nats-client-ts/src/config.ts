/**
 * Disk-backed config and credentials for the KlodiClient.
 *
 * The host plugin (klodi_register on the OpenClaw side) writes both
 * files; this package reads them. Format and lifetime mirror the
 * canonical pair in adapters/openclaw/src/lib/config.ts:
 *
 *   ${klodi_home}/config.json — handle, user_id, public NKey, NATS URL
 *   ${klodi_home}/nats.creds  — Ed25519 NKey credentials at mode 0600
 *
 * The KlodiClient takes both paths in its constructor; the adapter is
 * responsible for resolving them from its host's config tree.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export interface KlodiConfig {
  /** Marketplace handle, e.g. "alice". */
  handle: string;
  /** Authoritative user UUID, set by the marketplace at registration. */
  user_id: string;
  /** Public NKey, sent in the X-Nkey-Public header. */
  nkey_public: string;
  /** `tls://…` — the sole accepted transport (prod, or `tls://localhost`
   *  with the dev CA for loopback). */
  nats_url: string;
}

const REQUIRED_CONFIG_FIELDS: ReadonlyArray<keyof KlodiConfig> = [
  "handle",
  "user_id",
  "nkey_public",
  "nats_url",
];

export class ConfigNotFoundError extends Error {
  constructor(path: string) {
    super(
      `Klodi config missing at ${path}. Run klodi_register to sign up.`,
    );
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigInvalidError extends Error {
  constructor(path: string, missing: ReadonlyArray<string>) {
    super(
      `Klodi config at ${path} is missing fields: ${missing.join(", ")}.`
      + " Re-register with klodi_register.",
    );
    this.name = "ConfigInvalidError";
  }
}

export class CredsNotFoundError extends Error {
  constructor(path: string) {
    super(
      `Klodi credentials missing at ${path}. Run klodi_register to sign up.`,
    );
    this.name = "CredsNotFoundError";
  }
}

/**
 * Load and validate the config file. Throws ConfigNotFoundError when the
 * file is absent and ConfigInvalidError when required fields are missing.
 * Does not cache — the caller decides whether to memoize.
 */
export function loadConfig(path: string): KlodiConfig {
  if (!existsSync(path)) throw new ConfigNotFoundError(path);

  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigInvalidError(path, ["object"]);
  }
  const obj = raw as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      missing.push(field);
    }
  }
  if (missing.length > 0) throw new ConfigInvalidError(path, missing);

  return {
    handle: obj["handle"] as string,
    user_id: obj["user_id"] as string,
    nkey_public: obj["nkey_public"] as string,
    nats_url: obj["nats_url"] as string,
  };
}

/**
 * Read the on-disk creds file as raw bytes. Throws CredsNotFoundError if
 * absent. Does NOT throw on permissive modes — that's the host plugin's
 * call to surface; we just warn to stderr so it shows up in operator logs.
 *
 * Mode check (D2): "no group or world bits" — `(mode & 0o077) === 0`.
 * Both `0o600` (documented baseline) and `0o400` (read-only owner;
 * stricter) pass without warning. Any group or world bit set fires
 * the warning.
 */
export function loadCreds(path: string): Uint8Array {
  if (!existsSync(path)) throw new CredsNotFoundError(path);
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[klodi-nats-client] WARNING: ${path} has permissions`
      + ` ${mode.toString(8)}, expected no group/world bits (0600 or stricter)`,
    );
  }
  return readFileSync(path);
}
