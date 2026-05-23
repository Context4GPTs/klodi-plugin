/**
 * Setup-phase tools: klodi_setup_status, klodi_setup_repair,
 * klodi_setup_reseed_policies, klodi_setup_reseed_skill.
 *
 * Phases: unregistered → corrupt → degraded → needs_policy → ready.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  cpSync, existsSync, readdirSync, rmSync, statSync, unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  applyPluginConfigOverrides,
  getApiUrl,
  getApiUrlSource,
  getBundledSkillDir,
  getConfigPath,
  getCredsPath,
  getKlodiHome,
  getKlodiHomeSource,
  type KlodiPluginConfig,
} from "../lib/paths.js";
import { clearConfigCache } from "../lib/config.js";
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../lib/policy-seeding.js";
import {
  gatherChecks,
  derivePhase,
  safeLoadConfig,
  type SetupChecks,
  type SetupPhase,
} from "../lib/setup-state.js";
import { closeClient } from "../lib/client.js";
import { stopWakePump, wakePumpHealth } from "../service/wake-pump.js";
import { stopRegisterPoll } from "./register-poller.js";
import { jsonResult } from "../lib/tool-result.js";
import { envelopeToToolResult, makeEnvelope } from "../lib/envelope.js";

interface SetupIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
  fix: {
    kind: "tool" | "shell" | "dialog";
    tool?: string;
    tool_args?: Record<string, unknown>;
    shell?: string;
    dialog?: string;
  };
}

export function registerSetupTools(api: PluginAPI): void {
  applyPluginConfigOverrides(api.pluginConfig as KlodiPluginConfig | undefined);
  registerSetupStatus(api);
  registerSetupRepair(api);
  registerSetupReseedPolicies(api);
  registerSetupReseedSkill(api);
}

function registerSetupStatus(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_setup_status",
    label: "Setup Status",
    description:
      "Return the current setup phase and the exact next step."
      + " skill/references/setup_first_run.md dispatches on the `phase`"
      + " field and applies the `fix` action of each issue.",
    parameters: Type.Object({}),
    async execute() {
      const checks = await gatherChecks(api);
      const issues = deriveIssues(checks);
      const phase = derivePhase(checks);
      const config = safeLoadConfig();
      const wake = wakePumpHealth();

      api.logger.info("setup_status_probed", {
        phase, issue_codes: issues.map((i) => i.code),
        wake_pump_running: wake.running,
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
        checks, issues,
        wake_pump: {
          running: wake.running,
          user_id: wake.user_id,
          notifications_last_event_at: wake.notifications_last_event_at?.toISOString() ?? null,
          channels_last_event_at: wake.channels_last_event_at?.toISOString() ?? null,
        },
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
      "Drain the NATS connection, clear the config cache, and remove"
      + " nats.creds + config.json so klodi_register can run cleanly."
      + " Never touches sell/, buy/, or policies/.",
    parameters: Type.Object({}),
    async execute() {
      const priorUserId = safeLoadConfig()?.user_id ?? null;

      stopRegisterPoll("setup_repair");
      await stopWakePump(api);
      await closeClient();
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
          prior_user_id: priorUserId, removed, failures,
        });
        const paths = failures.map((f) => f.path).join(", ");
        return envelopeToToolResult(
          makeEnvelope({
            error: "internal_error",
            message:
              `Repair incomplete. Failed to remove: ${paths}. Check ` +
              `filesystem permissions on the klodi home dir ` +
              `(${getKlodiHome()}), then retry klodi_setup_repair.`,
            details: { failures, removed },
            recovery_hint: {
              kind: "tool",
              tool: "klodi_setup_repair",
              message: "Retry after fixing filesystem permissions.",
            },
          }),
        );
      }

      api.logger.warn("setup_repaired", {
        prior_user_id: priorUserId, removed,
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
      "Non-destructive: restores negotiation_style.md and security.md"
      + " from bundled templates if absent. Never overwrites existing.",
    parameters: Type.Object({}),
    async execute() {
      const negotiation_style_seeded = seedNegotiationStyleIfAbsent();
      const security_policy_seeded = seedSecurityPolicyIfAbsent();
      api.logger.info("policies_reseeded", {
        negotiation_style_seeded, security_policy_seeded,
      });
      return jsonResult({
        negotiation_style_seeded, security_policy_seeded,
      });
    },
  });
}

function registerSetupReseedSkill(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_setup_reseed_skill",
    label: "Re-seed Klodi Skill",
    description:
      "Force-copy the canonical klodi skill bundle from the plugin's"
      + " bundled skill/ tree into ${klodi_home}/skill/. Use after a"
      + " plugin upgrade where the on-disk skill drifted from the new"
      + " plugin version. Policies, sell/, and buy/ files are untouched.",
    parameters: Type.Object({}),
    async execute() {
      const reseededFiles = reseedSkillBundle();
      const timestamp = new Date().toISOString();
      api.logger.info("skill_reseeded", {
        file_count: reseededFiles.length, timestamp,
      });
      return jsonResult({ reseeded_files: reseededFiles, timestamp });
    },
  });
}

function reseedSkillBundle(): string[] {
  const sourceDir = getBundledSkillDir();
  const targetDir = join(getKlodiHome(), "skill");
  if (!existsSync(sourceDir)) {
    throw new Error(
      `bundled skill dir not found at ${sourceDir} — plugin install corrupt`,
    );
  }
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  cpSync(sourceDir, targetDir, { recursive: true, dereference: false });
  return walkRelative(targetDir, targetDir);
}

function walkRelative(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walkRelative(root, path));
    } else {
      out.push(relative(root, path));
    }
  }
  return out.sort();
}

function deriveIssues(c: SetupChecks): SetupIssue[] {
  const reg = registrationIssues(c);
  if (reg.length > 0) return reg;
  return [
    ...credPermIssues(c),
    ...natsIssues(c),
    ...policyIssues(c),
  ];
}

function registrationIssues(c: SetupChecks): SetupIssue[] {
  if (!c.credentials_present && !c.config_present) {
    return [{
      code: "not_registered", severity: "error",
      message: "No credentials found. Run klodi_register to sign up.",
      fix: { kind: "tool", tool: "klodi_register" },
    }];
  }
  if (c.credentials_present !== c.config_present) {
    const missing = c.credentials_present ? "config.json" : "nats.creds";
    const present = c.credentials_present ? "nats.creds" : "config.json";
    return [{
      code: "partial_credentials", severity: "error",
      message:
        `Partial state: ${present} present, ${missing} missing.`
        + " Clear before re-registering.",
      fix: { kind: "tool", tool: "klodi_setup_repair" },
    }];
  }
  if (!c.config_valid) {
    return [{
      code: "invalid_config", severity: "error",
      message:
        "config.json is missing required fields. Clear and re-register.",
      fix: { kind: "tool", tool: "klodi_setup_repair" },
    }];
  }
  return [];
}

function credPermIssues(c: SetupChecks): SetupIssue[] {
  if (c.creds_mode_secure) return [];
  return [{
    code: "creds_perms", severity: "warn",
    message:
      "nats.creds has group or world bits set. Tighten to 0600 (or"
      + " stricter, e.g. 0400) so other local users cannot read it.",
    fix: { kind: "shell", shell: `chmod 600 ${getCredsPath()}` },
  }];
}

function natsIssues(c: SetupChecks): SetupIssue[] {
  if (!c.nats_connected) {
    return [{
      code: "nats_disconnected", severity: "error",
      message:
        "NATS not connected. The service will retry on the next"
        + " credential-touching tool call.",
      fix: { kind: "tool", tool: "klodi_health" },
    }];
  }
  if (c.nats_whoami_ok === false) {
    return [{
      code: "whoami_failed", severity: "error",
      message:
        "NATS connected but whoami round-trip failed. Credentials"
        + " may be revoked or the server is down.",
      fix: { kind: "tool", tool: "klodi_health" },
    }];
  }
  return [];
}

function policyIssues(c: SetupChecks): SetupIssue[] {
  const out: SetupIssue[] = [];
  if (!c.security_policy_present || !c.policy_seeded) {
    out.push({
      code: "policy_files_missing", severity: "error",
      message:
        "One or both bundled policy files are missing from the user"
        + " policies dir. Re-seed them non-destructively.",
      fix: { kind: "tool", tool: "klodi_setup_reseed_policies" },
    });
    return out;
  }
  if (!c.policy_filled) {
    out.push({
      code: "policy_unfilled", severity: "error",
      message:
        "negotiation_style.md still contains template placeholders."
        + " Have a short conversation with the user and rewrite the"
        + " file in their own words.",
      fix: {
        kind: "dialog",
        dialog:
          "Ask: Posture (firm/flexible/aggressive), Authorization"
          + " overrides, Always-Ask additions, Logistics (pickup areas,"
          + " shipping carriers, payment methods), Communication (tone,"
          + " SLA, walk-away rule).",
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
    case "needs_policy": {
      const first = issues[0]?.fix;
      if (first?.kind === "tool" && first.tool) {
        return `Call ${first.tool} to restore bundled policy files.`;
      }
      return first?.dialog
        ?? "Fill the negotiation_style.md template via dialog.";
    }
    case "ready":
      return "Setup complete. Resume normal operation per SKILL.md.";
    default: {
      const _exhaustive: never = phase;
      throw new Error(`Unhandled phase: ${String(_exhaustive)}`);
    }
  }
}
