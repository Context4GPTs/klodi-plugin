/**
 * In-plugin polling for the klodi_register browser OAuth flow.
 *
 * Replaces the agent-driven "call klodi_register_poll every 5s for
 * 10 minutes" loop that OpenClaw could not sustain — the agent's
 * shell-backed async process is torn down after ~7 min of silent
 * output, so completions landing later were silently lost.
 *
 * The poller is a module-level setInterval owned by the plugin
 * process itself. On any terminal session state it stops, persists
 * credentials when applicable, and wakes the agent via
 * enqueueSystemEvent + requestHeartbeatNow — mirroring the pattern
 * in src/service/notifications.ts:167-170.
 *
 * The 10-minute ceiling matches apps/web SESSION_EXPIRY_MS so the
 * poller and the web session have the exact same lifetime.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import {
  getApiUrl,
  getKlodiHome,
  getCredsPath,
  getSellDir,
  getBuyDir,
  getPoliciesDir,
  writeConfig,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../lib/config.js";
import { ensureNatsRunning, resetNatsState } from "../service/nats.js";
import { wakeAgent } from "../service/wake.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 10 * 60 * 1_000;
// User-Agent bump: keep the plugin version in sync with package.json
// on every release. Lets the web service distinguish plugin traffic
// from browser traffic during incident triage.
const USER_AGENT = "klodi-plugin/0.1.6";

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

/**
 * Start (or replace) the background poll for a registration session.
 * The first HTTP claim fires 5s after this call — not synchronously —
 * to give the user time to open the auth URL before the plugin
 * probes an un-started session.
 */
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

/** Halt the active poll. Idempotent: safe to call with no active poll. */
export function stopRegisterPoll(reason: string): void {
  if (active === null) return;
  const { timer, sessionId, api } = active;
  active = null;
  clearInterval(timer);
  api.logger.debug("register_poll_stopped", {
    session_id: sessionId,
    reason,
  });
}

/**
 * One-shot attempt to claim a registration session. Shared with the
 * klodi_register_poll tool so tool and background poller execute
 * identical persistence logic.
 */
export async function claimRegisterSession(
  api: PluginAPI,
  sessionId: string,
): Promise<ClaimResult> {
  const url = `${getApiUrl()}/api/sessions/${sessionId}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
    });
  } catch (err) {
    return { kind: "transport_error", message: String(err) };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: unknown } | null;
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
        "Registration response missing required fields"
        + " (nats_creds, handle, user_id, nkey_public, nats_url).",
    };
  }

  mkdirSync(getKlodiHome(), { recursive: true });
  mkdirSync(getSellDir(), { recursive: true });
  mkdirSync(getBuyDir(), { recursive: true });
  mkdirSync(getPoliciesDir(), { recursive: true });

  // See ADR-0002. The explicit chmodSync after writeFileSync closes the
  // umask-interaction hole where writeFileSync's create-flow can land a
  // wider mode than requested. Both calls intentional.
  const credsPath = getCredsPath();
  writeFileSync(credsPath, creds, { encoding: "utf-8", mode: 0o600 });
  chmodSync(credsPath, 0o600);

  writeConfig({
    handle,
    user_id: userId,
    nkey_public: nkeyPublic,
    nats_url: natsUrl,
  });

  const negotiationSeeded = seedNegotiationStyleIfAbsent();
  const securitySeeded = seedSecurityPolicyIfAbsent();

  // Order matters: drain any stale connection BEFORE ensureNatsRunning,
  // otherwise the (consuming && isConnected()) short-circuit in
  // service/nats.ts:95 keeps the plugin bound to prior-user creds.
  await resetNatsState();
  const nats = await ensureNatsRunning(api);

  const result: ClaimResult = {
    kind: "registered",
    handle,
    negotiation_style_seeded: negotiationSeeded,
    security_policy_seeded: securitySeeded,
    nats_connected: nats.status === "running",
    nats_reason: nats.reason,
  };
  api.logger.info("register_claim_succeeded", {
    handle,
    user_id: userId,
    nats_connected: result.nats_connected,
  });
  return result;
}

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
      + " Call klodi_register for a fresh link if you still want to"
      + " sign up.",
      "klodi-register-timeout",
    );
    return;
  }

  const result = await claimRegisterSession(api, sessionId);

  // The session may have been replaced or stopped while the claim
  // was in flight — do not act on results for a stale session.
  if (active === null || active.sessionId !== sessionId) return;

  switch (result.kind) {
    case "registered":
      stopRegisterPoll("registered");
      await wakeAgent(
        api,
        `[klodi] Registration complete — welcome, @${result.handle}.`
        + " Call klodi_setup_status to continue setup.",
        "klodi-register-complete",
      );
      return;
    case "expired":
      stopRegisterPoll("expired");
      await wakeAgent(
        api,
        "[klodi] Registration link expired before you completed it."
        + " Call klodi_register to get a fresh link.",
        "klodi-register-expired",
      );
      return;
    case "already_claimed":
      stopRegisterPoll("already_claimed");
      await wakeAgent(
        api,
        "[klodi] The registration session was already claimed on"
        + " another device or process. Call klodi_register to get"
        + " a fresh session.",
        "klodi-register-already-claimed",
      );
      return;
    case "pending":
      return;
    case "http_error":
      api.logger.warn("register_poll_http_error", {
        session_id: sessionId,
        status: result.status,
        status_text: result.statusText,
      });
      return;
    case "transport_error":
      api.logger.warn("register_poll_transport_error", {
        session_id: sessionId,
        message: result.message,
      });
      return;
    case "invalid_response":
      // Server returned `completed` with malformed payload — this is a
      // server-side bug, not a transient failure. Further polls won't
      // recover; bail out explicitly so the user gets a clear signal.
      api.logger.error("register_poll_invalid_response", {
        session_id: sessionId,
        message: result.message,
      });
      stopRegisterPoll("invalid_response");
      await wakeAgent(
        api,
        "[klodi] The registration server returned a malformed"
        + " response — report this to klodi support, then"
        + " call klodi_register for a fresh session.",
        "klodi-register-invalid-response",
      );
      return;
  }
}

