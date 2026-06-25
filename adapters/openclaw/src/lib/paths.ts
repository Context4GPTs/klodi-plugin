/**
 * Path resolution and plugin-config overrides for the Klodi plugin.
 *
 * Every on-disk artifact (creds, config, sell/buy files, policies)
 * lives under `${klodi_home}` (default `~/.openclaw/workspace/.klodi/`).
 * The home dir resolves at call time from three sources, in order:
 *
 *   1. plugin-config override (`api.pluginConfig.klodi_home`)
 *   2. `KLODI_HOME` env var
 *   3. `DEFAULT_KLODI_HOME`
 *
 * The override and env var routes coexist so tests can drive isolation
 * via env (the cheapest knob) while production deployments configure
 * via OpenClaw's pluginConfig surface (the discoverable knob).
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { KLODI_DEFAULT_API_URL } from "@klodi/tool-catalog";

const DEFAULT_KLODI_HOME = join(homedir(), ".openclaw", "workspace", ".klodi");
// Source of truth for the canonical API URL is the catalog (D9). Override
// via plugin config (`klodi_api_url`) or env (`KLODI_API_URL`).
const DEFAULT_API_URL = KLODI_DEFAULT_API_URL;

let _klodiHome: string | null = null;
let _apiUrl: string | null = null;

export type ConfigSource = "config" | "env" | "default";

/**
 * Plugin-scoped config schema. Mirrors the JSON schema in
 * `openclaw.plugin.json#configSchema` 1:1. OpenClaw validates the
 * user's `plugins.klodi.config.*` block against that schema before
 * delivering it as `api.pluginConfig`, so by the time we receive
 * this object the field types are guaranteed — but we still
 * defensively narrow at the read site (see applyPluginConfigOverrides)
 * because the file lives on disk and could be edited between
 * validation and load.
 *
 * If you add a key here, add it to `openclaw.plugin.json` too. The
 * schema file is authoritative for the user-facing surface.
 */
export interface KlodiPluginConfig {
  klodi_home?: string;
  klodi_api_url?: string;
}

export function setKlodiHome(path: string): void {
  _klodiHome = path === "" ? null : path;
}

export function getKlodiHome(): string {
  return _klodiHome ?? process.env["KLODI_HOME"] ?? DEFAULT_KLODI_HOME;
}

export function getKlodiHomeSource(): ConfigSource {
  if (_klodiHome !== null) return "config";
  if (process.env["KLODI_HOME"]) return "env";
  return "default";
}

export function setApiUrl(url: string): void {
  _apiUrl = url === "" ? null : url;
}

export function getApiUrl(): string {
  return _apiUrl ?? process.env["KLODI_API_URL"] ?? DEFAULT_API_URL;
}

export function getApiUrlSource(): ConfigSource {
  if (_apiUrl !== null) return "config";
  if (process.env["KLODI_API_URL"]) return "env";
  return "default";
}

/**
 * Install channel this plugin was delivered through (`clawhub` / `npm` / …),
 * stamped as the `X-Klodi-Plugin-Source` analytics header on outbound RPCs.
 *
 * The channel cannot be baked into the artifact: one byte-identical tarball
 * ships to both npm and ClawHub (see the publish pipeline), so a build-time
 * constant can't distinguish them. The signal is known only to the installer
 * that fetched the plugin, which sets `KLODI_PLUGIN_SOURCE` out-of-band — no
 * file written, no probe, no first-run beacon. Absent that marker the floor is
 * the literal `unknown`: non-null and queryable, so the marketplace
 * registration row's `plugin_source` is always source-segmentable rather than
 * null — and never silently mis-attributed to `npm`. There is no config/
 * pluginConfig override route (unlike home/api-url) — the installer owns it.
 */
export function getPluginSource(): string {
  return process.env["KLODI_PLUGIN_SOURCE"] ?? "unknown";
}

export function getPluginSourceSource(): ConfigSource {
  if (process.env["KLODI_PLUGIN_SOURCE"]) return "env";
  return "default";
}

/**
 * Apply plugin-scoped config overrides from `api.pluginConfig`.
 * OpenClaw populates this object from `plugins.klodi.config.*` after
 * validation against `openclaw.plugin.json#configSchema`. Reading from
 * `api.config` instead would silently ignore the user's overrides —
 * that tree is the FULL OpenClawConfig, not the plugin's scoped block.
 *
 * Idempotent: safe to call from both the plugin entry point and from
 * `registerSetupTools` so test paths that exercise only the latter
 * still see the override take effect.
 */
export function applyPluginConfigOverrides(
  pluginConfig: KlodiPluginConfig | undefined,
): void {
  if (!pluginConfig) return;

  // Defensive runtime narrowing despite the typed parameter: the
  // SDK's PluginAPI.pluginConfig is `Record<string, unknown>` because
  // the SDK can't know each plugin's schema, so callers cast to
  // KlodiPluginConfig at the boundary. The cast trusts a JSON file
  // that ultimately lives on disk — keep the typeof guards.
  const { klodi_home, klodi_api_url } = pluginConfig;
  if (typeof klodi_home === "string" && klodi_home.length > 0) {
    setKlodiHome(klodi_home);
  }
  if (typeof klodi_api_url === "string" && klodi_api_url.length > 0) {
    setApiUrl(klodi_api_url);
  }
}

export function getCredsPath(): string {
  return join(getKlodiHome(), "nats.creds");
}

export function getConfigPath(): string {
  return join(getKlodiHome(), "config.json");
}

export function getSellDir(): string {
  return join(getKlodiHome(), "sell");
}

export function getBuyDir(): string {
  return join(getKlodiHome(), "buy");
}

export function getPoliciesDir(): string {
  return join(getKlodiHome(), "policies");
}

export function getNegotiationStylePath(): string {
  return join(getPoliciesDir(), "negotiation_style.md");
}

export function getSecurityPolicyPath(): string {
  return join(getPoliciesDir(), "security.md");
}

/**
 * Locate the plugin's bundled skill dir.
 * Compiled as dist/lib/paths.js; skill lives at ../../skill
 * relative to this module.
 */
export function getBundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "skill");
}

export function getNegotiationStyleTemplatePath(): string {
  return join(
    getBundledSkillDir(),
    "templates",
    "negotiation_style.template.md",
  );
}

export function getSecurityPolicyTemplatePath(): string {
  return join(getBundledSkillDir(), "policies", "security.md");
}

export function getSellFilePath(slug: string): string {
  return join(getSellDir(), `${slug}.md`);
}

export function getBuyFilePath(slug: string): string {
  return join(getBuyDir(), `${slug}.md`);
}
