/**
 * PluginAPI-free registration core — the single claim + persist-to-disk path.
 *
 * Extracted (moved, not copied) out of tools/register-poller.ts. This is the TS
 * analogue of the rust `run_register` core (packages/klodi-rust-host/src/
 * register.rs): it claims a session over HTTP, validates + persists creds /
 * config / optional CA, and returns a `CoreClaimResult`. It does NOTHING that
 * touches the plugin runtime — no PluginAPI, no NATS connect, no wake pump.
 *
 * See ADR-0015 (loaded ≠ armed): a short-lived register process (the headless
 * `klodi-openclaw-register` bin) must never arm a JetStream consumer, so the
 * claim/persist logic lives here, free of every plugin-runtime side effect. The
 * plugin's post-persist NATS/wake bring-up is re-attached by the thin
 * `claimAndBringUp` wrapper in register-poller.ts, which owns that side of the
 * boundary.
 *
 * See ADR-0022 (tls:// transport + private-CA trust): the `assertTls` fail-fast
 * (bare, no localhost bypass) and the optional-`nats_ca` contract are enforced
 * here at persist time so persist-time and connect-time policy can never drift.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { assertTls, persistNatsCa } from "@klodi/nats-client";

import {
  getApiUrl,
  getBuyDir,
  getCredsPath,
  getKlodiHome,
  getPoliciesDir,
  getSellDir,
} from "./paths.js";
import { writeConfig } from "./config.js";
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "./policy-seeding.js";

const USER_AGENT = "klodi-plugin/0.2.0";

/**
 * Minimal structured-logging seam the core needs. The plugin passes an adapter
 * over `api.logger`; the CLI passes an stderr-backed impl (its stdout is
 * reserved for the authorize URL alone). Defaults to a console-on-STDERR impl
 * so a bare `claimRegisterSession(id)` never writes diagnostics to stdout.
 */
export interface CoreLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: CoreLogger = {
  // console.error → STDERR, keeping STDOUT clean for the CLI's URL contract.
  info: (event, fields) => console.error(formatLog("info", event, fields)),
  warn: (event, fields) => console.error(formatLog("warn", event, fields)),
};

function formatLog(
  level: string,
  event: string,
  fields?: Record<string, unknown>,
): string {
  return JSON.stringify({ level, event, ...fields });
}

/**
 * Result of a single claim attempt. The `registered` variant carries ONLY the
 * disk-persist facts — the plugin-runtime fields `nats_connected` /
 * `nats_reason` are re-attached by the register-poller wrapper, never by the
 * core (ADR-0015).
 */
export type CoreClaimResult =
  | {
      kind: "registered";
      handle: string;
      negotiation_style_seeded: boolean;
      security_policy_seeded: boolean;
    }
  | { kind: "pending" }
  | { kind: "expired" }
  | { kind: "already_claimed" }
  | { kind: "http_error"; status: number; statusText: string }
  | { kind: "transport_error"; message: string }
  | { kind: "invalid_response"; message: string };

/**
 * Claim a registration session: `GET ${apiUrl}/api/sessions/<id>`, mapping the
 * envelope to a `CoreClaimResult`. A `completed` envelope is persisted to disk
 * (creds + config + optional CA) via {@link persistCompleted}.
 *
 * PluginAPI-free by design — callable with just a session id. A 15s
 * AbortController mirrors the timeout the Rust adapters and Hermes use so a
 * stalled endpoint (DNS hang, SYN drop) can't wedge a poll tick.
 */
export async function claimRegisterSession(
  sessionId: string,
  logger: CoreLogger = CONSOLE_LOGGER,
): Promise<CoreClaimResult> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}`;
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
  } catch (err) {
    return { kind: "transport_error", message: String(err) };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown }
      | null;
    if (body && body["error"] === "CREDENTIALS_ALREADY_CLAIMED") {
      return { kind: "already_claimed" };
    }
    return {
      kind: "http_error",
      status: response.status,
      statusText: response.statusText,
    };
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (data["status"] === "expired") return { kind: "expired" };
  if (data["status"] !== "completed") return { kind: "pending" };
  return persistCompleted(data, logger);
}

interface CompletedFields {
  creds: string;
  handle: string;
  userId: string;
  nkeyPublic: string;
  natsUrl: string;
}

/**
 * Narrow the completed envelope one field at a time — no `any`, no blanket
 * cast. Returns `null` when any required field is absent or the wrong type.
 * `nats_ca` is deliberately NOT here: it is optional (ADR-0022) and read
 * separately in {@link writeArtifacts}, so its absence never fails the claim.
 */
function narrowFields(data: Record<string, unknown>): CompletedFields | null {
  const creds = data["nats_creds"];
  const handle = data["handle"];
  const userId = data["user_id"];
  const nkeyPublic = data["nkey_public"];
  const natsUrl = data["nats_url"];
  if (
    typeof creds !== "string"
    || typeof handle !== "string"
    || typeof userId !== "string"
    || typeof nkeyPublic !== "string"
    || typeof natsUrl !== "string"
  ) {
    return null;
  }
  return { creds, handle, userId, nkeyPublic, natsUrl };
}

function persistCompleted(
  data: Record<string, unknown>,
  logger: CoreLogger,
): CoreClaimResult {
  const fields = narrowFields(data);
  if (fields === null) {
    return {
      kind: "invalid_response",
      message:
        "Registration response missing required fields (nats_creds,"
        + " handle, user_id, nkey_public, nats_url).",
    };
  }

  // Refuse to persist any non-`tls://` nats_url. Delegates to the single shared
  // client guard (accepts only `tls://`, rejecting `wss://` / `ws://` /
  // `nats://` on every host, with no localhost bypass) so persist-time and
  // connect-time policy can never drift. A compromised registration endpoint
  // could otherwise inject `ws://attacker.com` and trick the next connect into
  // a plaintext, attacker-controlled session.
  try {
    assertTls(fields.natsUrl);
  } catch {
    return {
      kind: "invalid_response",
      message:
        `Registration response had a plaintext nats_url (${fields.natsUrl}). `
        + "Refusing to persist. Verify your KLODI_API_URL or re-run"
        + " registration against the canonical endpoint.",
    };
  }

  writeArtifacts(fields, data, logger);

  const negotiationSeeded = seedNegotiationStyleIfAbsent();
  const securitySeeded = seedSecurityPolicyIfAbsent();

  logger.info("register_claim_persisted", {
    handle: fields.handle,
    user_id: fields.userId,
  });
  return {
    kind: "registered",
    handle: fields.handle,
    negotiation_style_seeded: negotiationSeeded,
    security_policy_seeded: securitySeeded,
  };
}

/**
 * Write the on-disk artifacts: `${klodi_home}` (0700) + sell/buy/policies dirs,
 * `nats.creds` (0600), `config.json`, and the OPTIONAL register-response CA.
 *
 * `nats_ca` is a level-2 trust source (ADR-0022): absent / empty / non-PEM
 * never fails registration — the shared helper skips a value it can't use and
 * an omission on a later re-register does not delete a persisted file.
 */
function writeArtifacts(
  fields: CompletedFields,
  data: Record<string, unknown>,
  logger: CoreLogger,
): void {
  const klodiHome = getKlodiHome();
  mkdirSync(klodiHome, { recursive: true });
  mkdirSync(getSellDir(), { recursive: true });
  mkdirSync(getBuyDir(), { recursive: true });
  mkdirSync(getPoliciesDir(), { recursive: true });

  // SECURITY.md documents `${klodi_home}` at 0700; force it past the umask
  // default. Best-effort on filesystems that don't support chmod.
  try {
    chmodSync(klodiHome, 0o700);
  } catch (err) {
    logger.warn("klodi_home_chmod_failed", {
      path: klodiHome,
      err: String(err),
    });
  }

  const credsPath = getCredsPath();
  writeFileSync(credsPath, fields.creds, { encoding: "utf-8", mode: 0o600 });
  chmodSync(credsPath, 0o600);

  writeConfig({
    handle: fields.handle,
    user_id: fields.userId,
    nkey_public: fields.nkeyPublic,
    nats_url: fields.natsUrl,
  });

  const natsCa = data["nats_ca"];
  if (typeof natsCa === "string") {
    persistNatsCa(klodiHome, natsCa);
  }
}
