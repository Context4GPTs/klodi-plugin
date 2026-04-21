/**
 * Per-item periodic check timers.
 * Replaces OpenClaw crons with internal plugin timers.
 *
 * Sell-side: default 2h — check pending offers + unread messages.
 * Buy-side: default 4h — run standing search for new matches.
 *
 * Timers only wake the agent when something needs LLM judgment.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import {
  listSellSlugs,
  listBuySlugs,
  readSellFile,
  readBuyFile,
  writeBuyFile,
  getNegotiationStylePath,
  getSellFilePath,
  getBuyFilePath,
} from "../lib/config.js";
import { request } from "../lib/nats-client.js";
import { formatCents } from "./notifications.js";
import { wakeAgent } from "./wake.js";

const timers = new Map<string, ReturnType<typeof setInterval>>();
let pluginApi: PluginAPI | null = null;

/** Initialize the timer subsystem with the plugin API. */
export function initTimers(api: PluginAPI): void {
  pluginApi = api;
}

/** Parse interval string (e.g. "2h", "4h", "30m", "1d") to milliseconds. */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return 2 * 60 * 60 * 1000; // default 2h

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 2 * 60 * 60 * 1000;
  }
}

/** Create a timer for a sell-side listing. */
export function createSellTimer(slug: string, checkEvery: string = "2h"): void {
  clearItemTimer(slug);
  const ms = parseInterval(checkEvery);
  const timer = setInterval(() => void checkSellItem(slug), ms);
  timers.set(`sell:${slug}`, timer);
  pluginApi?.logger.debug("timer_created", { type: "sell", slug, interval: checkEvery });
}

/** Create a timer for a buy-side standing search. */
export function createBuyTimer(slug: string, checkEvery: string = "4h"): void {
  clearItemTimer(slug);
  const ms = parseInterval(checkEvery);
  const timer = setInterval(() => void checkBuyItem(slug), ms);
  timers.set(`buy:${slug}`, timer);
  pluginApi?.logger.debug("timer_created", { type: "buy", slug, interval: checkEvery });
}

/** Clear a timer for a specific item. */
export function clearItemTimer(slug: string): void {
  for (const prefix of ["sell:", "buy:"]) {
    const key = `${prefix}${slug}`;
    const timer = timers.get(key);
    if (timer) {
      clearInterval(timer);
      timers.delete(key);
      pluginApi?.logger.debug("timer_cleared", { key });
    }
  }
}

/** Clear all timers. Called on plugin stop(). */
export function clearAllTimers(): void {
  for (const [key, timer] of timers) {
    clearInterval(timer);
    pluginApi?.logger.debug("timer_cleared", { key });
  }
  timers.clear();
}

/**
 * Reconcile: scan sell/buy files and create timers for any missing ones.
 * Called on plugin start().
 */
export function reconcileTimers(): void {
  for (const slug of listSellSlugs()) {
    const key = `sell:${slug}`;
    if (timers.has(key)) continue;
    const file = readSellFile(slug);
    if (file) createSellTimer(slug, file.check_every);
  }

  for (const slug of listBuySlugs()) {
    const key = `buy:${slug}`;
    if (timers.has(key)) continue;
    const file = readBuyFile(slug);
    if (file) createBuyTimer(slug, file.check_every);
  }

  pluginApi?.logger.info("timers_reconciled", { count: timers.size });
}

// --- Timer check implementations ---

interface PendingOffer {
  offer_id: string;
  listing_id: string;
  amount: number;
  buyer_handle: string;
  status: string;
}

let offersCache: {
  data: PendingOffer[];
  fetchedAt: number;
} | null = null;
const OFFERS_CACHE_TTL_MS = 30_000;

async function getPendingOffers(): Promise<PendingOffer[]> {
  const now = Date.now();
  if (offersCache && now - offersCache.fetchedAt < OFFERS_CACHE_TTL_MS) {
    return offersCache.data;
  }
  const result = await request<{
    offers?: PendingOffer[];
  }>("p2p.v1.offers.mine", {
    role: "seller", status: "proposed",
  });
  const offers = (result.offers ?? [])
    .filter((o) => o.status === "proposed");
  offersCache = { data: offers, fetchedAt: now };
  return offers;
}

async function checkSellItem(slug: string): Promise<void> {
  const api = pluginApi;
  if (!api) {
    throw new Error("checkSellItem: timers not initialized");
  }

  const sellFile = readSellFile(slug);
  if (!sellFile) {
    clearItemTimer(slug);
    return;
  }

  try {
    const allOffers = await getPendingOffers();
    const pendingOffers = allOffers.filter(
      (o) => o.listing_id === sellFile.listing_id,
    );

    for (const offer of pendingOffers) {
      if (
        sellFile.auto_reject_below !== null
        && offer.amount < sellFile.auto_reject_below
      ) {
        await request("p2p.v1.offers.respond", {
          offer_id: offer.offer_id,
          action: "reject",
        });
        api.logger.info("auto_rejected", {
          offer_id: offer.offer_id,
          amount: offer.amount,
        });
      } else {
        const price = formatCents(offer.amount);
        await wakeAgent(
          api,
          `[Klodi] Pending offer of ${price}`
            + ` from @${offer.buyer_handle}`
            + ` on "${slug}" (${offer.offer_id}).`
            + ` Read ${getNegotiationStylePath()}`
            + ` and ${getSellFilePath(slug)}, then`
            + " respond per your negotiation style"
            + " using klodi_offer_respond.",
          "klodi-pending-offer",
        );
      }
    }
  } catch (err) {
    api.logger.error("sell_check_failed", {
      slug, error: String(err),
    });
  }
}

async function checkBuyItem(slug: string): Promise<void> {
  const api = pluginApi;
  if (!api) {
    throw new Error("checkBuyItem: timers not initialized");
  }

  const buyFile = readBuyFile(slug);
  if (!buyFile) {
    clearItemTimer(slug);
    return;
  }

  try {
    const payload: Record<string, unknown> = {};
    if (buyFile.query) payload["query"] = buyFile.query;
    if (
      buyFile.delivery_method
      && buyFile.delivery_method !== "any"
    ) {
      payload["delivery_method"] = buyFile.delivery_method;
    }
    if (buyFile.max_price !== null) {
      payload["max_price"] = buyFile.max_price;
    }
    if (buyFile.pickup_radius !== null) {
      payload["pickup_radius_km"] = buyFile.pickup_radius;
    }
    if (buyFile.ships_to !== null) {
      payload["ships_to"] = buyFile.ships_to;
    }
    if (buyFile.last_checked) {
      payload["since"] = buyFile.last_checked;
    }

    const result = await request<{
      results?: Array<{
        listing_id: string;
        title: string;
        asking_price: number;
        seller_handle: string;
      }>;
    }>("p2p.v1.listings.watch", payload);

    const matches = result.results ?? [];

    if (matches.length > 0) {
      const summary = matches
        .map((m) =>
          `- "${m.title}" by @${m.seller_handle}`
          + ` — ${formatCents(m.asking_price)}`,
        )
        .join("\n");

      const policyPath = getNegotiationStylePath();
      const buyPath = getBuyFilePath(slug);
      const action = buyFile.action_on_match === "negotiate"
        ? `Read ${policyPath} and ${buyPath}.`
          + " For each qualifying match, open a"
          + " channel with klodi_channel_create,"
          + " ask questions if criteria can't be"
          + " verified, negotiate within target_price"
          + " and max_price. Escalate to the user"
          + " before submitting any binding"
          + " klodi_offer_create unless the policy"
          + " authorizes auto-buy at or below"
          + " target_price."
        : `Read ${policyPath} and ${buyPath},`
          + " then present the matches to the user"
          + " per your policy.";

      await wakeAgent(
        api,
        `[Klodi] Standing search "${slug}"`
          + ` found ${matches.length} new match(es):\n`
          + summary + "\n\n" + action,
        "klodi-buy-match",
      );
    }

    const { slug: _s, ...data } = buyFile;
    data.last_checked = new Date().toISOString();
    writeBuyFile(slug, data);
  } catch (err) {
    api.logger.error("buy_check_failed", {
      slug, error: String(err),
    });
  }
}
