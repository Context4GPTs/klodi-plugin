/**
 * In-plugin polling for the klodi_register browser OAuth flow.
 *
 * Replaces the agent-driven "call klodi_register_poll every 5s for
 * 10 minutes" loop. The poller is a module-level setInterval owned by
 * the plugin process itself. On any terminal session state it stops,
 * persists credentials when applicable, and wakes the agent.
 *
 * The 10-minute ceiling matches apps/web SESSION_EXPIRY_MS.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { assertTlsOrLocalhost, persistNatsCa } from "@klodi/nats-client";
import {
  REGISTER_POLL_CEILING_SECONDS,
  REGISTER_POLL_INTERVAL_SECONDS,
} from "@klodi/tool-catalog";
import {
  getApiUrl,
  getBuyDir,
  getCredsPath,
  getKlodiHome,
  getPoliciesDir,
  getSellDir,
} from "../lib/paths.js";
import { writeConfig } from "../lib/config.js";
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../lib/policy-seeding.js";
import { closeClient, connectClient } from "../lib/client.js";
import { startWakePump, stopWakePump } from "../service/wake-pump.js";
import { wakeAgent } from "../service/wake.js";

// Per **R § P2-10** + **D § Cluster V**: the cadence lives in the
// catalog so all hosts agree. Local constants now wrap the seconds
// values into milliseconds.
const POLL_INTERVAL_MS = REGISTER_POLL_INTERVAL_SECONDS * 1_000;
const POLL_MAX_MS = REGISTER_POLL_CEILING_SECONDS * 1_000;
const USER_AGENT = "klodi-plugin/0.2.0";

export type ClaimResult =
  | {
      kind: "registered";
      handle: string;
      negotiation_style_seeded: boolean;
      security_policy_seeded: boolean;
      nats_connected: boolean;
      nats_reason?: string;
    }
  | { kind: "pending" }
  | { kind: "expired" }
  | { kind: "already_claimed" }
  | { kind: "http_error"; status: number; statusText: string }
  | { kind: "transport_error"; message: string }
  | { kind: "invalid_response"; message: string };

interface ActivePoll {
  api: PluginAPI;
  sessionId: string;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
}

let active: ActivePoll | null = null;

export function startRegisterPoll(
  api: PluginAPI,
  sessionId: string,
): void {
  stopRegisterPoll("replaced");
  const timer = setInterval(() => {
    void pollOnce(api, sessionId);
  }, POLL_INTERVAL_MS);
  active = { api, sessionId, timer, startedAt: Date.now() };
  api.logger.info("register_poll_started", {
    session_id: sessionId,
    interval_ms: POLL_INTERVAL_MS,
    max_ms: POLL_MAX_MS,
  });
}

export function stopRegisterPoll(reason: string): void {
  if (active === null) return;
  const { timer, sessionId, api } = active;
  active = null;
  clearInterval(timer);
  api.logger.debug("register_poll_stopped", { session_id: sessionId, reason });
}

export async function claimRegisterSession(
  api: PluginAPI,
  sessionId: string,
): Promise<ClaimResult> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}`;
  let response: Response;
  // Per **R § P2-19**: TS poller had no timeout, so a stalled API
  // (DNS hang, SYN drop) blocked the poll-tick indefinitely. Mirror
  // the 15s timeout used by Hermes and the Rust adapters.
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
    const body = await response.json().catch(() => null) as
      | { error?: unknown } | null;
    if (body && body["error"] === "CREDENTIALS_ALREADY_CLAIMED") {
      return { kind: "already_claimed" };
    }
    return {
      kind: "http_error",
      status: response.status, statusText: response.statusText,
    };
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (data["status"] === "expired") return { kind: "expired" };
  if (data["status"] !== "completed") return { kind: "pending" };
  return persistCompleted(api, data);
}

async function persistCompleted(
  api: PluginAPI,
  data: Record<string, unknown>,
): Promise<ClaimResult> {
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
    return {
      kind: "invalid_response",
      message:
        "Registration response missing required fields (nats_creds,"
        + " handle, user_id, nkey_public, nats_url).",
    };
  }

  // Per **D § D10** (P2-17 closure): refuse to persist a non-`tls://`
  // `nats_url` on a non-localhost host. Delegates to the single shared
  // client guard (accepts only `tls://` off localhost, rejecting
  // `wss://` / `ws://` / `nats://`) so persist-time and connect-time
  // policy can never drift. A compromised registration endpoint could
  // otherwise inject `ws://attacker.com` and trick the next connect into
  // a plaintext, attacker-controlled session.
  try {
    assertTlsOrLocalhost(natsUrl);
  } catch {
    return {
      kind: "invalid_response",
      message:
        `Registration response had a plaintext nats_url (${natsUrl}). `
        + "Refusing to persist. Verify your KLODI_API_URL or re-run"
        + " registration against the canonical endpoint.",
    };
  }

  const klodiHome = getKlodiHome();
  mkdirSync(klodiHome, { recursive: true });
  mkdirSync(getSellDir(), { recursive: true });
  mkdirSync(getBuyDir(), { recursive: true });
  mkdirSync(getPoliciesDir(), { recursive: true });

  // P1-10 — `${klodi_home}` was inheriting the umask default (typically
  // 0755). SECURITY.md documents the dir at 0700; force it. Best-effort
  // on filesystems that don't support chmod (rare on macOS/Linux dev
  // hosts; common on a sub-tree of a Docker volume).
  try {
    chmodSync(klodiHome, 0o700);
  } catch (err) {
    api.logger.warn?.("klodi_home_chmod_failed", {
      path: klodiHome,
      err: String(err),
    });
  }

  const credsPath = getCredsPath();
  writeFileSync(credsPath, creds, { encoding: "utf-8", mode: 0o600 });
  chmodSync(credsPath, 0o600);

  writeConfig({
    handle, user_id: userId, nkey_public: nkeyPublic, nats_url: natsUrl,
  });

  // Auto-trust the register-response CA (card
  // auto-trust-nats-ca-from-register): `nats_ca` is OPTIONAL — it is NOT in
  // the required-field check above, so an absent value never fails
  // registration. The shared helper skips a non-string / empty /
  // non-PEM-shaped value and never throws; an omission on a later
  // re-register does not delete the persisted file ("no update" ≠
  // "revoke"). A fresh value overwrites → re-register is the CA-rotation
  // path.
  const natsCa = data["nats_ca"];
  if (typeof natsCa === "string") {
    persistNatsCa(klodiHome, natsCa);
  }

  const negotiationSeeded = seedNegotiationStyleIfAbsent();
  const securitySeeded = seedSecurityPolicyIfAbsent();

  // Drain any stale pre-registration pump + connection (idempotent),
  // then eagerly start the wake pump against the freshly-written creds
  // so inbound JetStream events flow without waiting for the next tool
  // call and any transport failure surfaces here rather than at first
  // whoami.
  await stopWakePump(api);
  await closeClient();
  let natsConnected = false;
  let natsReason: string | undefined;
  try {
    await connectClient(api);
    await startWakePump(api);
    natsConnected = true;
  } catch (err) {
    natsReason = String(err);
  }

  api.logger.info("register_claim_succeeded", {
    handle, user_id: userId, nats_connected: natsConnected,
  });
  return {
    kind: "registered",
    handle,
    negotiation_style_seeded: negotiationSeeded,
    security_policy_seeded: securitySeeded,
    nats_connected: natsConnected,
    nats_reason: natsReason,
  };
}

/**
 * Per **R § P3-11**: split into a thin `pollOnce` orchestrator and two
 * branch handlers. Terminal kinds (`registered`, `expired`,
 * `already_claimed`, `invalid_response`) stop the poll and wake the
 * agent. Non-terminal kinds (`pending`, `http_error`, `transport_error`)
 * log the transient and let the next interval tick re-poll. The split
 * keeps each function under the project's cyclomatic and length limits
 * (8 / 100) while preserving the per-tick `active`-session guard.
 */
async function pollOnce(
  api: PluginAPI,
  sessionId: string,
): Promise<void> {
  if (active === null || active.sessionId !== sessionId) return;

  if (Date.now() - active.startedAt >= POLL_MAX_MS) {
    stopRegisterPoll("timeout");
    await wakeAgent(
      api,
      "[klodi] No registration completion detected in 10 minutes."
      + " Call klodi_register for a fresh link if you still want to sign up.",
      "klodi-register-timeout",
      { kind: "klodi-register-timeout", event_id: null },
    );
    return;
  }

  const result = await claimRegisterSession(api, sessionId);
  // Re-check the active session AFTER the await — a concurrent
  // klodi_register or klodi_setup_repair may have rotated or stopped
  // the poll while the HTTP round-trip was in flight.
  if (active === null || active.sessionId !== sessionId) return;

  if (isTerminalResult(result)) {
    await handleTerminalResult(api, sessionId, result);
    return;
  }
  handleNonTerminalResult(api, sessionId, result);
}

type TerminalResult = Extract<
  ClaimResult,
  { kind: "registered" | "expired" | "already_claimed" | "invalid_response" }
>;

type NonTerminalResult = Extract<
  ClaimResult,
  { kind: "pending" | "http_error" | "transport_error" }
>;

function isTerminalResult(result: ClaimResult): result is TerminalResult {
  return (
    result.kind === "registered"
    || result.kind === "expired"
    || result.kind === "already_claimed"
    || result.kind === "invalid_response"
  );
}

async function handleTerminalResult(
  api: PluginAPI,
  sessionId: string,
  result: TerminalResult,
): Promise<void> {
  switch (result.kind) {
    case "registered":
      stopRegisterPoll("registered");
      await wakeAgent(
        api,
        `[klodi] Registration complete — welcome, @${result.handle}.`
        + " Call klodi_setup_status to continue setup.",
        "klodi-register-complete",
        { kind: "klodi-register-complete", event_id: null },
      );
      return;
    case "expired":
      stopRegisterPoll("expired");
      await wakeAgent(
        api,
        "[klodi] Registration link expired before you completed it."
        + " Call klodi_register to get a fresh link.",
        "klodi-register-expired",
        { kind: "klodi-register-expired", event_id: null },
      );
      return;
    case "already_claimed":
      stopRegisterPoll("already_claimed");
      await wakeAgent(
        api,
        "[klodi] The registration session was already claimed on"
        + " another device or process. Call klodi_register to get a"
        + " fresh session.",
        "klodi-register-already-claimed",
        { kind: "klodi-register-already-claimed", event_id: null },
      );
      return;
    case "invalid_response":
      api.logger.error("register_poll_invalid_response", {
        session_id: sessionId, message: result.message,
      });
      stopRegisterPoll("invalid_response");
      await wakeAgent(
        api,
        "[klodi] The registration server returned a malformed"
        + " response — report this to klodi support, then call"
        + " klodi_register for a fresh session.",
        "klodi-register-invalid-response",
        { kind: "klodi-register-invalid-response", event_id: null },
      );
      return;
  }
}

function handleNonTerminalResult(
  api: PluginAPI,
  sessionId: string,
  result: NonTerminalResult,
): void {
  switch (result.kind) {
    case "pending":
      return;
    case "http_error":
      api.logger.warn("register_poll_http_error", {
        session_id: sessionId,
        status: result.status, status_text: result.statusText,
      });
      return;
    case "transport_error":
      api.logger.warn("register_poll_transport_error", {
        session_id: sessionId, message: result.message,
      });
      return;
  }
}
