/**
 * Sell- and buy-file I/O.
 *
 * Sell files (`${klodi_home}/sell/<slug>.md`) are the seller-local
 * policy + dialogue digest for an active listing. They carry the
 * floor price (`min_acceptable_price`), an optional auto-reject
 * threshold, the linked transaction id when an offer has been
 * accepted, and a freeform body the agent appends to during
 * negotiation. The floor MUST stay on disk only — see ADR-0005 +
 * the SECURITY.md guarantee that the floor never tracks the public
 * `asking_price`.
 *
 * Buy files (`${klodi_home}/buy/<slug>.md`) mirror standing-search
 * configuration. 0012 dropped client-side cron / dedup state — these
 * files are pure on-disk policy now.
 *
 * Both file types use YAML frontmatter for the structured fields and
 * markdown for the body. Parsing goes through `gray-matter` so CRLF
 * line endings, quoted strings, and other YAML edge cases are handled
 * by a dedicated parser instead of the prior ad-hoc regex.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import matter from "gray-matter";

import type { DeliveryFilter } from "@klodi/tool-catalog";

import { getBuyDir, getSellDir } from "./paths.js";

export interface SellFile {
  listing_id: string;
  min_acceptable_price: number | null;
  auto_reject_below: number | null;
  transaction_id: string | null;
  slug: string;
  /** Freeform markdown content below frontmatter */
  body: string;
}

export type ActionOnMatch = "notify" | "negotiate";

/**
 * 0012 dropped `check_every`, `last_checked`, and `seen_listings`:
 * standing searches are server-side and matches arrive as wakes with
 * full payloads. The buy file is a pure on-disk policy + dialogue
 * digest — no cron state, no client-side dedup.
 */
export interface BuyFile {
  query: string;
  max_price: number | null;
  target_price: number | null;
  delivery: DeliveryFilter;
  action_on_match: ActionOnMatch;
  slug: string;
  /** Freeform markdown content below frontmatter */
  body: string;
}

interface ParsedFrontmatter {
  meta: Record<string, string>;
  body: string;
}

/**
 * Parse YAML frontmatter via `gray-matter`, then string-coerce every
 * scalar so downstream readers can rely on a uniform `Record<string, string>`
 * shape. Numeric/null values are coerced to their literal string form
 * ("150", "null") so the existing readSellFile / readBuyFile narrowing
 * logic keeps working without conditional type juggling at every key.
 *
 * `gray-matter` types `data` as `{ [key: string]: any }`. We treat the
 * parsed object as `unknown` and walk it with explicit guards so the
 * rest of the codebase never sees an `any`.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    meta[key] = stringifyMetaValue(value);
  }
  return { meta, body: parsed.content.trim() };
}

function stringifyMetaValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Arrays / nested objects aren't part of the sell/buy schemas; if
  // someone hand-edits one in, JSON-stringify it so the value round-
  // trips back to disk losslessly via buildFrontmatter below.
  return JSON.stringify(value);
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

function parseDelivery(raw: string | undefined, slug: string): DeliveryFilter {
  if (!raw || raw === "null") return { method: "any" };
  try {
    const parsed = JSON.parse(raw) as DeliveryFilter;
    if (
      parsed && typeof parsed === "object" && typeof parsed.method === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new Error(
    `Invalid delivery in buy/${slug}.md: "${raw}". Must be a JSON`
    + ` object: { "method": "any" } | { "method": "pickup", "radiusKm"?: ... }`
    + ` | { "method": "ship", "to"?: ... } | { "method": "digital" }.`,
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
    delivery: parseDelivery(meta["delivery"], slug),
    action_on_match: parseActionOnMatch(meta["action_on_match"], slug),
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
    delivery: JSON.stringify(data.delivery),
    action_on_match: data.action_on_match,
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
