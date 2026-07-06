/**
 * In-plugin polling for the klodi_register browser OAuth flow.
 *
 * Replaces the agent-driven "call klodi_register_poll every 5s for
 * 10 minutes" loop. The poller is a module-level setInterval owned by
 * the plugin process itself. On any terminal session state it stops,
 * persists credentials when applicable, and wakes the agent.
 *
 * The 10-minute ceiling matches apps/web SESSION_EXPIRY_MS.
 *
 * The PluginAPI-free claim + persist-to-disk path lives in lib/register-core.ts
 * (the TS analogue of rust `run_register`, also driven by the headless
 * `klodi-openclaw-register` bin). This module keeps ONLY the plugin runtime:
 * the setInterval loop, the wake-agent handlers, and the thin `claimAndBringUp`
 * wrapper that re-attaches the post-persist NATS/wake bring-up the core omits.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import {
  REGISTER_POLL_CEILING_SECONDS,
  REGISTER_POLL_INTERVAL_SECONDS,
} from "@klodi/tool-catalog";
import { claimRegisterSession, type CoreClaimResult } from "../lib/register-core.js";
import { closeClient, connectClient } from "../lib/client.js";
import { startWakePump, stopWakePump } from "../service/wake-pump.js";
import { wakeAgent } from "../service/wake.js";

// Per **R § P2-10** + **D § Cluster V**: the cadence lives in the
// catalog so all hosts agree. Local constants now wrap the seconds
// values into milliseconds.
const POLL_INTERVAL_MS = REGISTER_POLL_INTERVAL_SECONDS * 1_000;
const POLL_MAX_MS = REGISTER_POLL_CEILING_SECONDS * 1_000;

/**
 * The plugin-facing claim result. It is the core's result with the `registered`
 * variant re-widened to carry the plugin-runtime NATS-connection facts
 * (`nats_connected` / `nats_reason`) that {@link claimAndBringUp} attaches after
 * the post-persist bring-up. All non-`registered` variants pass through the
 * core union unchanged.
 */
export type ClaimResult =
  | {
      kind: "registered";
      handle: string;
      negotiation_style_seeded: boolean;
      security_policy_seeded: boolean;
      nats_connected: boolean;
      nats_reason?: string;
    }
  | Exclude<CoreClaimResult, { kind: "registered" }>;

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

/**
 * Plugin wrapper over the PluginAPI-free core. Claims + persists via
 * {@link claimRegisterSession}, and on a fresh `registered` result performs the
 * plugin post-persist NATS refresh — draining any stale pre-registration pump +
 * connection, then eagerly (re)connecting and arming the wake pump against the
 * freshly-written creds so inbound JetStream events flow without waiting for the
 * next tool call.
 *
 * The `stop → close → connect → start` order is PINNED (hermes locks the
 * identical order in test_register.py; openclaw parity): arming the pump before
 * draining the stale one, or connecting before closing, would leak a consumer /
 * dial on a half-torn client.
 */
export async function claimAndBringUp(
  api: PluginAPI,
  sessionId: string,
): Promise<ClaimResult> {
  const result = await claimRegisterSession(sessionId, {
    info: (event, fields) => api.logger.info(event, fields),
    warn: (event, fields) => api.logger.warn?.(event, fields),
  });
  if (result.kind !== "registered") return result;

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
    handle: result.handle,
    nats_connected: natsConnected,
  });
  return {
    kind: "registered",
    handle: result.handle,
    negotiation_style_seeded: result.negotiation_style_seeded,
    security_policy_seeded: result.security_policy_seeded,
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

  const result = await claimAndBringUp(api, sessionId);
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
