/**
 * Config, credentials, and sell/buy file I/O for the Klodi plugin.
 * All user-specific state lives under KLODI_HOME (~/.openclaw/workspace/.klodi/).
 */

import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync, unlinkSync, readdirSync, statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// --- Paths ---

const DEFAULT_KLODI_HOME = join(homedir(), ".openclaw", "workspace", ".klodi");
const DEFAULT_API_URL = "https://klodi.4gpts.com";

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
  clearConfigCache();
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
 * Compiled as dist/lib/config.js; skill lives at ../../skill
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

/**
 * Copy the negotiation_style template to the user's policies dir
 * if absent. Never overwrites an existing file. Returns true when
 * a copy was performed, false when the user already had the file.
 */
export function seedNegotiationStyleIfAbsent(): boolean {
  const target = getNegotiationStylePath();
  if (existsSync(target)) return false;

  const templatePath = getNegotiationStyleTemplatePath();
  if (!existsSync(templatePath)) {
    throw new Error(
      `Negotiation style template missing at ${templatePath}.`
      + " Plugin packaging is broken — reinstall klodi-plugin.",
    );
  }

  mkdirSync(getPoliciesDir(), { recursive: true });
  const contents = readFileSync(templatePath, "utf-8");
  writeFileSync(target, contents, "utf-8");
  return true;
}

/**
 * Copy the bundled security.md into the user's policies dir if absent.
 * Mirrors seedNegotiationStyleIfAbsent. security.md is static hard
 * rules — never edited by the user — so a straight copy is correct.
 */
export function seedSecurityPolicyIfAbsent(): boolean {
  const target = getSecurityPolicyPath();
  if (existsSync(target)) return false;

  const templatePath = getSecurityPolicyTemplatePath();
  if (!existsSync(templatePath)) {
    throw new Error(
      `Security policy template missing at ${templatePath}.`
      + " Plugin packaging is broken — reinstall klodi-plugin.",
    );
  }

  mkdirSync(getPoliciesDir(), { recursive: true });
  const contents = readFileSync(templatePath, "utf-8");
  writeFileSync(target, contents, "utf-8");
  return true;
}

/**
 * True when the user has replaced every placeholder token in the
 * seeded negotiation_style.md. Detects the original template by
 * scanning for any remaining `<e.g., ...>` angle-bracket placeholder
 * or the `firm | flexible | aggressive` Posture sentinel. A single
 * remaining placeholder marks the whole file as unfilled.
 */
export function isNegotiationStyleFilled(): boolean {
  const path = getNegotiationStylePath();
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf-8");
  if (/<e\.g\.,/i.test(text)) return false;
  if (/^firm \| flexible \| aggressive\s*$/m.test(text)) return false;
  return true;
}

export function getSellFilePath(slug: string): string {
  return join(getSellDir(), `${slug}.md`);
}

export function getBuyFilePath(slug: string): string {
  return join(getBuyDir(), `${slug}.md`);
}

// --- Config ---

export interface KlodiConfig {
  handle: string;
  user_id: string;
  nkey_public: string;
  nats_url: string;
  notification_channel?: string;
  notification_target?: string;
}

export function hasCredentials(): boolean {
  return existsSync(getCredsPath()) && existsSync(getConfigPath());
}

let cachedConfig: KlodiConfig | null = null;

export function loadConfig(): KlodiConfig {
  if (cachedConfig) return cachedConfig;
  const path = getConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      "Not registered. Use klodi_register to sign up.",
    );
  }
  cachedConfig = JSON.parse(
    readFileSync(path, "utf-8"),
  ) as KlodiConfig;
  return cachedConfig;
}

export function loadCreds(): Uint8Array {
  const path = getCredsPath();
  if (!existsSync(path)) {
    throw new Error(
      "Credentials not found. Use klodi_register to sign up.",
    );
  }
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    console.warn(
      `[klodi] WARNING: ${path} has permissions `
      + `${mode.toString(8)}, expected 600`,
    );
  }
  return readFileSync(path);
}

export function writeConfig(config: KlodiConfig): void {
  const dir = getKlodiHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getConfigPath(),
    JSON.stringify(config, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  cachedConfig = config;
}

/**
 * Drop the in-memory config cache. Called by klodi_setup_repair to
 * ensure a subsequent loadConfig() re-reads disk instead of serving
 * the deleted user's stale handle/user_id/nats_url.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

// --- Sell/Buy File I/O ---

export interface SellFile {
  listing_id: string;
  min_acceptable_price: number | null;
  auto_reject_below: number | null;
  transaction_id: string | null;
  check_every: string;
  slug: string;
  /** Freeform markdown content below frontmatter */
  body: string;
}

export type ActionOnMatch = "notify" | "negotiate";

export interface BuyFile {
  query: string;
  max_price: number | null;
  target_price: number | null;
  delivery_method: string;
  pickup_radius: number | null;
  ships_to: string | null;
  action_on_match: ActionOnMatch;
  check_every: string;
  last_checked: string | null;
  slug: string;
  /** Freeform markdown content below frontmatter */
  body: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function buildFrontmatter(meta: Record<string, string | number | null>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function readSellFile(slug: string): SellFile | null {
  const path = join(getSellDir(), `${slug}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const { meta, body } = parseFrontmatter(content);
  return {
    listing_id: meta["listing_id"] ?? "",
    min_acceptable_price:
      meta["min_acceptable_price"]
        && meta["min_acceptable_price"] !== "null"
        ? parseInt(meta["min_acceptable_price"], 10)
        : null,
    auto_reject_below:
      meta["auto_reject_below"]
        && meta["auto_reject_below"] !== "null"
        ? parseInt(meta["auto_reject_below"], 10)
        : null,
    transaction_id:
      meta["transaction_id"]
        && meta["transaction_id"] !== "null"
        ? meta["transaction_id"]
        : null,
    check_every: meta["check_every"] ?? "2h",
    slug,
    body,
  };
}

const sellIndex = new Map<string, string>();

export function writeSellFile(
  slug: string,
  data: Omit<SellFile, "slug">,
): void {
  mkdirSync(getSellDir(), { recursive: true });
  const fm = buildFrontmatter({
    listing_id: data.listing_id,
    min_acceptable_price: data.min_acceptable_price,
    auto_reject_below: data.auto_reject_below,
    transaction_id: data.transaction_id,
    check_every: data.check_every,
  });
  const content = data.body
    ? `${fm}\n\n${data.body}` : fm;
  writeFileSync(
    join(getSellDir(), `${slug}.md`),
    content + "\n",
    "utf-8",
  );
  sellIndex.set(data.listing_id, slug);
}

export function deleteSellFile(slug: string): boolean {
  const path = join(getSellDir(), `${slug}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  for (const [id, s] of sellIndex) {
    if (s === slug) { sellIndex.delete(id); break; }
  }
  return true;
}

function parseActionOnMatch(
  raw: string | undefined,
  slug: string,
): ActionOnMatch {
  if (raw === undefined) return "notify";
  if (raw === "notify" || raw === "negotiate") return raw;
  throw new Error(
    `Invalid action_on_match in buy/${slug}.md: `
    + `"${raw}". Must be "notify" or "negotiate".`,
  );
}

export function readBuyFile(slug: string): BuyFile | null {
  const path = join(getBuyDir(), `${slug}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const { meta, body } = parseFrontmatter(content);
  return {
    query: meta["query"] ?? "",
    max_price: meta["max_price"] && meta["max_price"] !== "null"
      ? parseInt(meta["max_price"], 10) : null,
    target_price: meta["target_price"] && meta["target_price"] !== "null"
      ? parseInt(meta["target_price"], 10) : null,
    delivery_method: meta["delivery_method"] ?? "any",
    pickup_radius: meta["pickup_radius"] && meta["pickup_radius"] !== "null"
      ? parseFloat(meta["pickup_radius"]) : null,
    ships_to: meta["ships_to"] && meta["ships_to"] !== "null"
      ? meta["ships_to"] : null,
    action_on_match: parseActionOnMatch(meta["action_on_match"], slug),
    check_every: meta["check_every"] ?? "4h",
    last_checked: meta["last_checked"] && meta["last_checked"] !== "null"
      ? meta["last_checked"] : null,
    slug,
    body,
  };
}

export function writeBuyFile(slug: string, data: Omit<BuyFile, "slug">): void {
  mkdirSync(getBuyDir(), { recursive: true });
  const fm = buildFrontmatter({
    query: data.query,
    max_price: data.max_price,
    target_price: data.target_price,
    delivery_method: data.delivery_method,
    pickup_radius: data.pickup_radius,
    ships_to: data.ships_to,
    action_on_match: data.action_on_match,
    check_every: data.check_every,
    last_checked: data.last_checked,
  });
  const content = data.body ? `${fm}\n\n${data.body}` : fm;
  writeFileSync(join(getBuyDir(), `${slug}.md`), content + "\n", "utf-8");
}

export function deleteBuyFile(slug: string): boolean {
  const path = join(getBuyDir(), `${slug}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Find a sell file by listing_id. Uses in-memory index. */
export function findSellFileByListingId(
  listingId: string,
): SellFile | null {
  const cached = sellIndex.get(listingId);
  if (cached) return readSellFile(cached);

  // Index miss — scan once and populate
  const dir = getSellDir();
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const slug = file.replace(/\.md$/, "");
    const sf = readSellFile(slug);
    if (sf) {
      sellIndex.set(sf.listing_id, slug);
      if (sf.listing_id === listingId) return sf;
    }
  }
  return null;
}

/** List all sell file slugs. */
export function listSellSlugs(): string[] {
  const dir = getSellDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

/** List all buy file slugs. */
export function listBuySlugs(): string[] {
  const dir = getBuyDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

/** Generate a URL-safe slug from a title + listing_id suffix. */
export function slugify(
  title: string,
  listingId: string,
): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 53);
  const suffix = listingId.slice(0, 6);
  return `${base}-${suffix}`;
}
