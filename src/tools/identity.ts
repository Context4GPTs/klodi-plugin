/**
 * Identity tools: register, whoami, health, ratings.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { Handle } from "../lib/schemas.js";
import {
  isConnected,
  request,
  WHOAMI_PROBE_TIMEOUT_MS,
} from "../lib/nats-client.js";
import {
  requestAndHandle,
  jsonResult,
  errorResult,
} from "../lib/tool-result.js";
import {
  hasCredentials,
  loadConfig,
  getConfigPath,
  getCredsPath,
  getApiUrl,
} from "../lib/config.js";
import {
  startRegisterPoll,
  stopRegisterPoll,
  claimRegisterSession,
} from "./register-poller.js";
import type { ClaimResult } from "./register-poller.js";
import { ensureNatsRunning } from "../service/nats.js";

import { existsSync } from "node:fs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerIdentityTools(api: PluginAPI): void {
  registerRegister(api);
  registerWhoami(api);
  registerHealth(api);
  registerRatings(api);
}

function registerRegister(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_register",
    label: "Register on klodi",
    description:
      "Start browser-based registration on the klodi marketplace."
      + " Returns an auth URL for the user to open. The plugin then"
      + " polls the session in the background for up to 10 minutes"
      + " and wakes the agent via a system event when registration"
      + " completes, expires, or times out — no agent-side polling"
      + " loop required.",
    parameters: Type.Object({}),
    async execute() {
      if (hasCredentials()) {
        const config = loadConfig();
        return jsonResult({
          status: "already_registered",
          handle: config.handle,
        });
      }

      const sessionId = crypto.randomUUID();
      const apiUrl = getApiUrl();
      const authUrl = `${apiUrl}/authorize?session=${sessionId}`;
      const pollUrl = `${apiUrl}/api/sessions/${sessionId}`;

      startRegisterPoll(api, sessionId);

      return jsonResult({
        status: "awaiting_browser",
        message: `Open this URL to register: ${authUrl}`,
        auth_url: authUrl,
        poll_url: pollUrl,
        session_id: sessionId,
        instructions:
          "Share the auth URL with the user and wait for a"
          + " system event — the plugin is polling in the"
          + " background. klodi_register_poll is a manual fallback"
          + " only, e.g. if the agent was restarted mid-flow.",
      });
    },
  });

  // Manual-fallback poll tool. Reuses the same claim pipeline as the
  // background poller so behavior is identical across the two paths.
  api.registerTool({
    name: "klodi_register_poll",
    label: "Poll Registration Status",
    description:
      "Manual fallback: check the current state of a registration"
      + " session. klodi_register already starts a background poll"
      + " that wakes the agent on completion — only call this if"
      + " that wake hasn't arrived and you suspect the agent was"
      + " restarted before the session settled.",
    parameters: Type.Object({
      session_id: Type.String({
        description: "Session ID from klodi_register (UUID v4)",
        format: "uuid",
        minLength: 36,
        maxLength: 36,
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      }),
    }),
    async execute(_id, params) {
      const sessionId = params["session_id"] as string;
      if (!UUID_RE.test(sessionId)) {
        return errorResult(
          "session_id must be a UUID. Run klodi_register to"
          + " obtain a fresh one.",
        );
      }

      // Preempt the background poller BEFORE we fetch. If we claimed
      // after, an in-flight background fetch could still land on the
      // server's single-winner update, lose the race, receive
      // already_claimed, and wake the agent — firing a second event
      // right after the tool returns `registered`.
      stopRegisterPoll("tool_preempts");

      const result = await claimRegisterSession(api, sessionId);
      return toolResultFor(result);
    },
  });
}

function toolResultFor(result: ClaimResult) {
  switch (result.kind) {
    case "registered":
      return jsonResult({
        status: "registered",
        handle: result.handle,
        negotiation_style_seeded: result.negotiation_style_seeded,
        security_policy_seeded: result.security_policy_seeded,
        nats_connected: result.nats_connected,
        nats_reason: result.nats_reason,
      });
    case "pending":
      return jsonResult({
        status: "pending",
        message:
          "Registration not yet completed."
          + " Try again in a few seconds.",
      });
    case "expired":
      return errorResult(
        "Registration session expired. Run klodi_register again.",
      );
    case "already_claimed":
      return errorResult(
        "Registration credentials were already claimed on another"
        + " device or process. Run klodi_register again if you need"
        + " fresh credentials.",
      );
    case "http_error":
      return errorResult(
        `Registration poll failed: HTTP ${result.status}`
        + ` ${result.statusText}`,
      );
    case "transport_error":
      return errorResult(
        `Failed to poll registration: ${result.message}`,
      );
    case "invalid_response":
      return errorResult(
        `Invalid registration response: ${result.message}`,
      );
  }
}

function registerWhoami(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_whoami",
    label: "Check Identity",
    description:
      "Check your identity and ratings on klodi."
      + " Returns handle, ratings, trade counts.",
    parameters: Type.Object({}),
    async execute() {
      if (!hasCredentials()) {
        return errorResult(
          "Not registered. Use klodi_register first.",
        );
      }
      return requestAndHandle(
        "p2p.v1.users.whoami", {},
      );
    },
  });
}

function registerHealth(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_health",
    label: "Health Check",
    description:
      "Full probe: credentials, config, NATS connection, and a"
      + " live whoami round-trip. Fails fast with categorized issues.",
    parameters: Type.Object({}),
    async execute() {
      const issues: string[] = [];

      if (!existsSync(getCredsPath())) {
        issues.push("nats.creds not found");
      }
      if (!existsSync(getConfigPath())) {
        issues.push("config.json not found");
      }
      // Probe, not just read: bootstrap retries on every health call so a
      // transient wsconnect failure (see register-claim race where
      // ensureNatsRunning is one-shot) recovers without a gateway restart.
      if (issues.length === 0) {
        await ensureNatsRunning(api);
      }
      if (!isConnected()) {
        issues.push("NATS not connected");
      }

      if (issues.length > 0) {
        return jsonResult({ status: "unhealthy", issues });
      }

      const config = loadConfig();
      try {
        const resp = await request(
          "p2p.v1.users.whoami",
          {},
          { timeout: WHOAMI_PROBE_TIMEOUT_MS },
        );
        if ("error" in resp) {
          return jsonResult({
            status: "unhealthy",
            issues: [
              `whoami_failed: ${String(resp["error"])}`,
            ],
            handle: config.handle,
            nats_connected: true,
            whoami_ok: false,
          });
        }
        return jsonResult({
          status: "healthy",
          handle: config.handle,
          nats_connected: true,
          whoami_ok: true,
        });
      } catch (err) {
        return jsonResult({
          status: "unhealthy",
          issues: [`whoami_failed: ${String(err)}`],
          handle: config.handle,
          nats_connected: true,
          whoami_ok: false,
        });
      }
    },
  });
}

function registerRatings(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_ratings",
    label: "User Ratings",
    description:
      "Look up any user's public marketplace ratings.",
    parameters: Type.Object({
      handle: Handle,
    }),
    async execute(_id, params) {
      if (!hasCredentials()) {
        return errorResult(
          "Not registered. Use klodi_register first.",
        );
      }
      return requestAndHandle(
        "p2p.v1.ratings.query",
        { handle: params["handle"] },
      );
    },
  });
}
