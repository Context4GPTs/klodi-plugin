/**
 * Identity tools: register, register_poll, whoami, health, ratings.
 *
 * `klodi_register` is HTTP-only and unchanged — see ADR-0001 / 0012
 * § Bootstrap is unchanged. After registration completes, the gateway
 * lifecycle hook opens the NATS connection on first tool call.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { Handle, klodiTools } from "@klodi/tool-catalog";
import { WHOAMI_PROBE_TIMEOUT_MS } from "@klodi/nats-client";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
} from "../lib/tool-result.js";
import { runPreCallGuardsResult } from "../lib/guards.js";
import { envelopeToToolResult, makeEnvelope } from "../lib/envelope.js";

// Per-host register CLI surfaced in `not_registered` recovery hints (R8).
const OPENCLAW_REGISTER_CLI = "klodi-openclaw-register";
import {
  connectClient,
  getClient,
  isClientConnected,
} from "../lib/client.js";
import {
  getApiUrl,
  getConfigPath,
  getCredsPath,
} from "../lib/paths.js";
import { hasCredentials, loadConfig } from "../lib/config.js";
import {
  startRegisterPoll,
  stopRegisterPoll,
  claimRegisterSession,
  type ClaimResult,
} from "./register-poller.js";

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
      + " Returns an auth URL for the user to open. The plugin polls"
      + " the session in the background for up to 10 minutes and"
      + " wakes the agent via a system event when registration"
      + " completes, expires, or times out.",
    parameters: Type.Object({}),
    async execute() {
      if (hasCredentials()) {
        const config = loadConfig();
        return jsonResult({
          status: "already_registered", handle: config.handle,
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
          "Share the auth URL with the user and wait for a system"
          + " event — the plugin is polling in the background."
          + " klodi_register_poll is a manual fallback only.",
      });
    },
  });

  api.registerTool({
    name: "klodi_register_poll",
    label: "Poll Registration Status",
    description:
      "Manual fallback: check the current state of a registration"
      + " session. klodi_register already starts a background poll"
      + " — only call this if that wake hasn't arrived.",
    parameters: Type.Object({
      session_id: Type.String({
        description: "Session ID from klodi_register (UUID v4)",
        format: "uuid",
        minLength: 36, maxLength: 36,
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      }),
    }),
    async execute(_id, params) {
      const sessionId = params["session_id"] as string;
      if (!UUID_RE.test(sessionId)) {
        return envelopeToToolResult(
          makeEnvelope({
            error: "invalid_request",
            message:
              "session_id must be a UUID; re-call with a corrected value " +
              "(run klodi_register to obtain a fresh one).",
            details: { field: "session_id", problem: "wrong_type" },
            recovery_hint: null,
          }),
        );
      }
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
          "Registration not yet completed. Try again in a few seconds.",
      });
    case "expired":
      return envelopeToToolResult(
        makeEnvelope({
          error: "not_registered",
          message: "Registration session expired. Run klodi_register again.",
          details: null,
          recovery_hint: {
            kind: "tool",
            tool: "klodi_register",
            message: "Start a fresh registration session.",
          },
        }),
      );
    case "already_claimed":
      return envelopeToToolResult(
        makeEnvelope({
          error: "not_registered",
          message:
            "Registration credentials were already claimed on another " +
            "device or process. Run klodi_register again if you need " +
            "fresh credentials.",
          details: null,
          recovery_hint: {
            kind: "tool",
            tool: "klodi_register",
            message: "Mint fresh credentials.",
          },
        }),
      );
    case "http_error":
      return envelopeToToolResult(
        makeEnvelope({
          error: "internal_error",
          message: `Registration poll failed: HTTP ${result.status} ${result.statusText}`,
          details: { http_status: result.status, http_status_text: result.statusText },
          recovery_hint: null,
        }),
      );
    case "transport_error":
      return envelopeToToolResult(
        makeEnvelope({
          error: "connection_not_ready",
          message: `Failed to poll registration: ${result.message}`,
          details: null,
          recovery_hint: {
            kind: "tool",
            tool: "klodi_setup_status",
            message: "Inspect setup state — connection is not ready.",
          },
        }),
      );
    case "invalid_response":
      return envelopeToToolResult(
        makeEnvelope({
          error: "internal_error",
          message: `Invalid registration response: ${result.message}`,
          details: { reason: result.message },
          recovery_hint: null,
        }),
      );
  }
}

function registerWhoami(api: PluginAPI): void {
  const tool = klodiTools.klodi_whoami;
  api.registerTool({
    name: "klodi_whoami",
    label: "Check Identity",
    description: tool.description,
    parameters: tool.params,
    async execute() {
      const guard = runPreCallGuardsResult({}, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      try {
        const result = await rawRequest(tool.subject, {});
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

/**
 * 24h threshold from **R § P2-26**: a notifications consumer with a 7d
 * `inactive_threshold` that hasn't seen an event in 24h is suspect — the
 * server hasn't yet declared the consumer dead, but the local pull-loop
 * may be wedged. Surfaced as a warning so the operator can investigate
 * before the server-side teardown actually fires.
 */
const NOTIFICATIONS_LOOP_SUSPECT_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

interface HealthIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

function preflightIssues(): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (!existsSync(getCredsPath())) {
    issues.push({
      code: "creds_missing",
      severity: "error",
      message: "nats.creds not found",
    });
  }
  if (!existsSync(getConfigPath())) {
    issues.push({
      code: "config_missing",
      severity: "error",
      message: "config.json not found",
    });
  }
  return issues;
}

function notificationsLoopIssue(): HealthIssue | null {
  const lastEventAt = getClient().getNotificationsLastEventAt();
  const inactiveMs = getClient().getNotificationsInactiveThresholdMs();
  if (lastEventAt === null || inactiveMs === null) return null;
  const ageMs = Date.now() - lastEventAt.getTime();
  if (ageMs <= NOTIFICATIONS_LOOP_SUSPECT_THRESHOLD_MS) return null;
  return {
    code: "notifications_loop_suspect",
    severity: "warning",
    message:
      `Notifications consumer last delivered an event ${ageMs}ms ago `
      + `(threshold ${NOTIFICATIONS_LOOP_SUSPECT_THRESHOLD_MS}ms; consumer `
      + `inactive_threshold ${inactiveMs}ms). The server-side teardown `
      + "hasn't fired yet — the local pull-loop may be wedged. Restart "
      + "the host or call klodi_setup_repair to re-attach.",
  };
}

async function gatherConnectIssues(api: PluginAPI): Promise<HealthIssue[]> {
  const issues = preflightIssues();
  if (issues.length === 0) {
    try {
      await connectClient(api);
    } catch (err) {
      issues.push({
        code: "nats_connect_failed",
        severity: "error",
        message: `NATS connect failed: ${String(err)}`,
      });
    }
  }
  if (!isClientConnected()) {
    issues.push({
      code: "nats_disconnected",
      severity: "error",
      message: "NATS not connected",
    });
  }
  return issues;
}

async function probeAndReport(
  preexisting: HealthIssue[],
): Promise<ReturnType<typeof jsonResult>> {
  const config = loadConfig();
  try {
    const resp = await getClient().request<Record<string, unknown>>(
      "p2p.v1.users.whoami",
      {},
      { timeout: WHOAMI_PROBE_TIMEOUT_MS },
    );
    const loopIssue = notificationsLoopIssue();
    const issues = loopIssue === null ? preexisting : [...preexisting, loopIssue];
    return jsonResult({
      status: issues.length === 0 ? "healthy" : "degraded",
      handle: config.handle,
      nats_connected: true,
      whoami_ok: true,
      whoami_result: resp,
      issues,
    });
  } catch (err) {
    // R5 — klodi_health returns its diagnostic payload, not the error
    // envelope. Stringify the underlying error verbatim for the
    // operator-facing `issues[].message`.
    const errText = err instanceof Error ? err.message : String(err);
    const issues = [...preexisting, {
      code: "whoami_failed",
      severity: "error" as const,
      message: `whoami_failed: ${errText}`,
    }];
    return jsonResult({
      status: "unhealthy",
      issues,
      handle: config.handle,
      nats_connected: true,
      whoami_ok: false,
    });
  }
}

function registerHealth(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_health",
    label: "Health Check",
    description:
      "Full probe: credentials, config, NATS connection, a live whoami"
      + " round-trip, and notifications-consumer pull-loop liveness."
      + " Fails fast with categorized issues.",
    parameters: Type.Object({}),
    async execute() {
      const connectIssues = await gatherConnectIssues(api);
      if (connectIssues.length > 0) {
        return jsonResult({ status: "unhealthy", issues: connectIssues });
      }
      return probeAndReport(connectIssues);
    },
  });
}

function registerRatings(api: PluginAPI): void {
  const tool = klodiTools.klodi_ratings;
  api.registerTool({
    name: "klodi_ratings",
    label: "User Ratings",
    description: tool.description,
    parameters: Type.Object({ handle: Handle }),
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      try {
        const result = await rawRequest(tool.subject, {
          handle: params["handle"],
        });
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}
