/**
 * Setup-phase tools: klodi_setup_status, klodi_setup_repair,
 * klodi_setup_reseed_policies.
 *
 * klodi_setup_status is the single source of truth consumed by
 * SETUP.md. Returns a resolved phase (unregistered, corrupt,
 * needs_heartbeat, needs_policy, degraded, ready) plus a structured
 * issues list with fix actions the agent can dispatch on.
 *
 * klodi_setup_repair clears partial-write credential state AND
 * resets NATS module state (drains connection, flushes cache) so
 * the next klodi_register binds to fresh credentials. Never
 * touches sell/buy directories or policy files.
 *
 * klodi_setup_reseed_policies restores the bundled policy files
 * when they go missing from the user's policies dir — non-destructive
 * alternative to klodi_setup_repair for that narrow case.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { existsSync, unlinkSync } from "node:fs";
import {
  applyPluginConfigOverrides,
  getKlodiHome,
  getKlodiHomeSource,
  getApiUrl,
  getApiUrlSource,
  getCredsPath,
  getConfigPath,
  clearConfigCache,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
  type KlodiPluginConfig,
} from "../lib/config.js";
import {
  gatherChecks,
  derivePhase,
  safeLoadConfig,
  type SetupChecks,
  type SetupPhase,
} from "../lib/setup-state.js";
import { HEARTBEAT_EVERY_CEILING_MS } from "../lib/duration.js";
import { resetNatsState } from "../service/nats.js";
import { stopRegisterPoll } from "./register-poller.js";
import { jsonResult, errorResult } from "../lib/tool-result.js";

interface SetupIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
  fix: {
    kind: "tool" | "shell" | "dialog";
    tool?: string;
    tool_args?: Record<string, unknown>;
    /**
     * Shell command string surfaced to the user. NEVER exec this
     * field from an agent — it's user-facing copy, not a hook. Paths
     * are interpolated from getKlodiHome() (trusted input) but the
     * contract is still "show this to the human."
     */
    shell?: string;
    dialog?: string;
  };
}

export function registerSetupTools(api: PluginAPI): void {
  // Idempotent re-apply: index.ts also calls this at plugin load, but
  // applying here lets test paths that exercise registerSetupTools in
  // isolation still observe the pluginConfig override taking effect.
  applyPluginConfigOverrides(api.pluginConfig as KlodiPluginConfig | undefined);
  registerSetupStatus(api);
  registerSetupRepair(api);
  registerSetupReseedPolicies(api);
}

function registerSetupStatus(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_setup_status",
    label: "Setup Status",
    description:
      "Return the current setup phase and the exact next step."
      + " SETUP.md dispatches on the `phase` field and applies"
      + " the `fix` action of each issue.",
    parameters: Type.Object({}),
    async execute() {
      const checks = await gatherChecks(api);
      const issues = deriveIssues(checks);
      const phase = derivePhase(checks);
      const config = safeLoadConfig();

      api.logger.info("setup_status_probed", {
        phase,
        issue_codes: issues.map((i) => i.code),
      });

      return jsonResult({
        phase,
        config: {
          klodi_home: getKlodiHome(),
          klodi_home_source: getKlodiHomeSource(),
          api_url: getApiUrl(),
          api_url_source: getApiUrlSource(),
          nats_url: config?.nats_url ?? null,
        },
        checks,
        issues,
        next_step: deriveNextStep(phase, issues),
      });
    },
  });
}

function registerSetupRepair(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_setup_repair",
    label: "Setup Repair",
    description:
      "Stop the NATS consumer, drain the connection, clear the"
      + " config cache, and remove nats.creds + config.json so"
      + " klodi_register can run cleanly. Never touches sell/, buy/,"
      + " or policies/.",
    parameters: Type.Object({}),
    async execute() {
      const priorUserId = safeLoadConfig()?.user_id ?? null;

      // Cancel any in-flight registration poll first — it would
      // otherwise keep fetching against the now-obsolete session and
      // could claim fresh creds the user is no longer committed to.
      stopRegisterPoll("setup_repair");

      // Order matters: reset runtime state before touching disk,
      // otherwise a concurrent consumeLoop iteration could read
      // the just-unlinked creds via getConnection() retry.
      await resetNatsState();
      clearConfigCache();

      const removed: string[] = [];
      const failures: Array<{ path: string; error: string }> = [];
      for (const path of [getCredsPath(), getConfigPath()]) {
        if (!existsSync(path)) continue;
        try {
          unlinkSync(path);
          removed.push(path);
        } catch (err) {
          failures.push({ path, error: String(err) });
        }
      }

      if (failures.length > 0) {
        api.logger.error("setup_repair_failed", {
          prior_user_id: priorUserId,
          removed,
          failures,
        });
        // Hard failure — the agent must NOT proceed to klodi_register
        // believing repair succeeded. klodi_register would hit
        // already_registered if either file survived the partial repair.
        const paths = failures.map((f) => f.path).join(", ");
        return errorResult(
          `Repair incomplete. Failed to remove: ${paths}.`
          + " Check filesystem permissions on the klodi home dir"
          + ` (${getKlodiHome()}), then retry klodi_setup_repair.`,
        );
      }

      api.logger.warn("setup_repaired", {
        prior_user_id: priorUserId,
        removed,
      });

      return jsonResult({ removed, failures });
    },
  });
}

function registerSetupReseedPolicies(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_setup_reseed_policies",
    label: "Re-seed Policy Files",
    description:
      "Non-destructive: restores negotiation_style.md and"
      + " security.md from bundled templates if absent. Never"
      + " overwrites existing policy files. Use when"
      + " klodi_setup_status reports missing policy files —"
      + " NOT a substitute for klodi_setup_repair.",
    parameters: Type.Object({}),
    async execute() {
      const negotiation_style_seeded = seedNegotiationStyleIfAbsent();
      const security_policy_seeded = seedSecurityPolicyIfAbsent();
      api.logger.info("policies_reseeded", {
        negotiation_style_seeded,
        security_policy_seeded,
      });
      return jsonResult({
        negotiation_style_seeded,
        security_policy_seeded,
      });
    },
  });
}

// ── Issue derivation (split by concern per CLAUDE.md hard limits) ────────

function deriveIssues(c: SetupChecks): SetupIssue[] {
  const reg = registrationIssues(c);
  if (reg.length > 0) return reg;

  return [
    ...credPermIssues(c),
    ...natsIssues(c),
    ...heartbeatIssues(c),
    ...policyIssues(c),
  ];
}

function registrationIssues(c: SetupChecks): SetupIssue[] {
  if (!c.credentials_present && !c.config_present) {
    return [{
      code: "not_registered",
      severity: "error",
      message: "No credentials found. Run klodi_register to sign up.",
      fix: { kind: "tool", tool: "klodi_register" },
    }];
  }
  if (c.credentials_present !== c.config_present) {
    const missing = c.credentials_present ? "config.json" : "nats.creds";
    const present = c.credentials_present ? "nats.creds" : "config.json";
    return [{
      code: "partial_credentials",
      severity: "error",
      message:
        `Partial state: ${present} present, ${missing} missing.`
        + " Clear before re-registering.",
      fix: { kind: "tool", tool: "klodi_setup_repair" },
    }];
  }
  if (!c.config_valid) {
    return [{
      code: "invalid_config",
      severity: "error",
      message:
        "config.json is missing required fields."
        + " Clear and re-register.",
      fix: { kind: "tool", tool: "klodi_setup_repair" },
    }];
  }
  return [];
}

function credPermIssues(c: SetupChecks): SetupIssue[] {
  if (c.creds_mode_600) return [];
  return [{
    code: "creds_perms",
    severity: "warn",
    message:
      "nats.creds is not mode 600. Private credentials should"
      + " not be world-readable.",
    fix: { kind: "shell", shell: `chmod 600 ${getCredsPath()}` },
  }];
}

function natsIssues(c: SetupChecks): SetupIssue[] {
  if (!c.nats_connected) {
    return [{
      code: "nats_disconnected",
      severity: "error",
      message:
        "NATS not connected. The service will retry on the next"
        + " credential-touching tool call.",
      fix: { kind: "tool", tool: "klodi_health" },
    }];
  }
  if (c.nats_whoami_ok === false) {
    return [{
      code: "whoami_failed",
      severity: "error",
      message:
        "NATS connected but whoami round-trip failed."
        + " Credentials may be revoked or the server is down.",
      fix: { kind: "tool", tool: "klodi_health" },
    }];
  }
  return [];
}

function heartbeatIssues(c: SetupChecks): SetupIssue[] {
  const issues: SetupIssue[] = [];

  if (c.heartbeat_target !== "last") {
    issues.push({
      code: "heartbeat_not_last",
      severity: "error",
      message:
        "agents.defaults.heartbeat.target must be \"last\" for"
        + " notifications to wake the agent. OpenClaw SDK is"
        + " read-only; user must run the shell command.",
      fix: {
        kind: "shell",
        shell:
          'openclaw config set agents.defaults.heartbeat.target "last"',
      },
    });
  }

  if (
    c.heartbeat_every_ms === null
    || c.heartbeat_every_ms === 0
    || c.heartbeat_every_ms > HEARTBEAT_EVERY_CEILING_MS
  ) {
    issues.push({
      code: "heartbeat_interval_too_long",
      severity: "error",
      message:
        "agents.defaults.heartbeat.every is the fallback cadence when"
        + " requestHeartbeatNow silently no-ops (OpenClaw SDK #29215/"
        + "#34338/#14191). Must be > 0 and ≤ 2 minutes; the SDK"
        + " default of \"30m\" stalls queued wakes for up to half an"
        + " hour. User must run the shell command.",
      fix: {
        kind: "shell",
        shell:
          'openclaw config set agents.defaults.heartbeat.every "1m"',
      },
    });
  }

  return issues;
}

function policyIssues(c: SetupChecks): SetupIssue[] {
  const out: SetupIssue[] = [];
  if (!c.security_policy_present || !c.policy_seeded) {
    out.push({
      code: "policy_files_missing",
      severity: "error",
      message:
        "One or both bundled policy files are missing from the"
        + " user policies dir. Re-seed them non-destructively.",
      fix: { kind: "tool", tool: "klodi_setup_reseed_policies" },
    });
    return out;
  }
  if (!c.policy_filled) {
    out.push({
      code: "policy_unfilled",
      severity: "error",
      message:
        "negotiation_style.md still contains template placeholders."
        + " Have a short conversation with the user and rewrite"
        + " the file in their own words.",
      fix: {
        kind: "dialog",
        dialog:
          "Ask: Posture (firm/flexible/aggressive), Authorization"
          + " overrides, Always-Ask additions, Logistics (pickup"
          + " areas, shipping carriers, payment methods),"
          + " Communication (tone, SLA, walk-away rule).",
      },
    });
  }
  return out;
}

function deriveNextStep(
  phase: SetupPhase,
  issues: SetupIssue[],
): string {
  switch (phase) {
    case "unregistered":
      return (
        "Call klodi_register and wait for a system wake event."
        + " klodi_register_poll is a manual fallback only."
      );
    case "corrupt":
      return "Call klodi_setup_repair, then klodi_register.";
    case "degraded":
      return "Investigate NATS connectivity; retry klodi_health.";
    case "needs_heartbeat":
      return (
        "Ask user to run: openclaw config set"
        + " agents.defaults.heartbeat.target \"last\"."
      );
    case "needs_policy": {
      const first = issues[0]?.fix;
      if (first?.kind === "tool" && first.tool) {
        return `Call ${first.tool} to restore bundled policy files.`;
      }
      return first?.dialog
        ?? "Fill the negotiation_style.md template via dialog.";
    }
    case "ready":
      return "Setup complete. Delete SETUP.md.";
    default: {
      const _exhaustive: never = phase;
      throw new Error(`Unhandled phase: ${String(_exhaustive)}`);
    }
  }
}
