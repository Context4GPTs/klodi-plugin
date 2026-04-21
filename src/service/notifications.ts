/**
 * Smart notification routing.
 * Deterministic actions handled silently in code.
 * Events needing LLM judgment wake the agent.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { request } from "../lib/nats-client.js";
import {
  findSellFileByListingId,
  getNegotiationStylePath,
  getSellFilePath,
  getSellDir,
  getBuyDir,
} from "../lib/config.js";
import {
  onListingWithdrawn,
  onTransactionTerminal,
} from "./state.js";
import { wakeAgent } from "./wake.js";

const NOTIFICATION_REASON = "klodi-notification";

/** Marketplace notification event from JetStream. */
export interface MarketplaceEvent {
  event: string;
  listing_id?: string;
  channel_id?: string;
  offer_id?: string;
  transaction_id?: string;
  buyer_handle?: string;
  seller_handle?: string;
  sender_handle?: string;
  confirmed_by_handle?: string;
  cancelled_by_handle?: string;
  handle?: string;
  comment_id?: string;
  message_id?: string;
  amount?: number;
  reason?: string;
  old_status?: string;
  new_status?: string;
  mentions?: string[];
  /** Inline comment body — present on comment.created. */
  body?: string;
  /** Structured offer terms — present on offer.proposed. */
  terms?: Record<string, unknown> | null;
  /** Comment timestamp — present on comment.created. */
  created_at?: string;
}

let pluginApi: PluginAPI | null = null;

export function initNotifications(api: PluginAPI): void {
  pluginApi = api;
}

/** Route a NATS notification. */
export async function handleNotification(
  event: MarketplaceEvent,
): Promise<void> {
  const api = pluginApi;
  if (!api) {
    throw new Error(
      "handleNotification called before initNotifications",
    );
  }

  api.logger.debug("notification_received", { event: event.event });

  switch (event.event) {
    case "offer.proposed":
      await handleOfferProposed(api, event);
      break;

    case "channel.opened":
      await wakeAgent(api, formatChannelOpened(event), NOTIFICATION_REASON);
      break;

    case "channel.message":
      await wakeAgent(api, formatChannelMessage(event), NOTIFICATION_REASON);
      break;

    case "comment.created":
      await wakeAgent(api, formatCommentCreated(event), NOTIFICATION_REASON);
      break;

    case "offer.accepted":
      await wakeAgent(api, formatOfferAccepted(event), NOTIFICATION_REASON);
      break;

    case "offer.rejected":
      await wakeAgent(api, formatOfferRejected(event), NOTIFICATION_REASON);
      break;

    case "transaction.confirmed":
      await wakeAgent(api, formatTransactionConfirmed(event), NOTIFICATION_REASON);
      break;

    case "transaction.completed":
      if (event.listing_id) {
        onTransactionTerminal(event.listing_id);
      }
      await wakeAgent(api, formatTransactionCompleted(event), NOTIFICATION_REASON);
      break;

    case "transaction.cancelled":
      if (event.listing_id) {
        onTransactionTerminal(event.listing_id);
      }
      await wakeAgent(api, formatTransactionCancelled(event), NOTIFICATION_REASON);
      break;

    case "listing.status_changed":
      if (
        event.listing_id
        && (event.new_status === "withdrawn"
          || event.new_status === "sold")
      ) {
        onListingWithdrawn(event.listing_id);
      }
      await wakeAgent(api, formatListingStatusChanged(event), NOTIFICATION_REASON);
      break;

    default:
      api.logger.warn("unknown_event", { event: event.event });
      break;
  }
}

// --- Deterministic handling ---

async function handleOfferProposed(api: PluginAPI, event: MarketplaceEvent): Promise<void> {
  if (!event.listing_id || !event.offer_id || event.amount === undefined) {
    await wakeAgent(api, formatOfferProposed(event), NOTIFICATION_REASON);
    return;
  }

  const sellFile = findSellFileByListingId(event.listing_id);

  // Auto-reject below floor price — no LLM needed
  if (sellFile?.auto_reject_below !== null && sellFile?.auto_reject_below !== undefined
    && event.amount < sellFile.auto_reject_below) {
    try {
      await request("p2p.v1.offers.respond", {
        offer_id: event.offer_id,
        action: "reject",
      });
      api.logger.info("auto_rejected", {
        offer_id: event.offer_id,
        amount: event.amount,
      });
    } catch (err) {
      api.logger.error("auto_reject_failed", {
        offer_id: event.offer_id,
        error: String(err),
      });
      // Fall through to wake agent on failure
      await wakeAgent(api, formatOfferProposed(event), NOTIFICATION_REASON);
    }
    return;
  }

  // Above floor or no floor set — needs LLM judgment
  await wakeAgent(api, formatOfferProposed(event), NOTIFICATION_REASON);
}

// --- Notification formatting ---

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatOfferProposed(
  event: MarketplaceEvent,
): string {
  const amount = event.amount !== undefined
    ? formatCents(event.amount)
    : "unknown amount";
  const buyer = event.buyer_handle ?? "unknown";
  const listing = event.listing_id ?? "unknown";
  const policyPath = getNegotiationStylePath();
  const sellRef = sellFileRef(event.listing_id);
  const termsBlock = event.terms && Object.keys(event.terms).length > 0
    ? `\nProposed terms:\n${JSON.stringify(event.terms, null, 2)}`
    : "";

  return `[Klodi] Offer of ${amount} from @${buyer}`
    + ` on listing ${listing}.${termsBlock}`
    + `\nRead ${policyPath} and ${sellRef},`
    + " then review and respond with"
    + " klodi_offer_respond.";
}

/** Path to the sell file for a listing, or directory if unresolved. */
function sellFileRef(listingId: string | undefined): string {
  if (!listingId) return getSellDir();
  const sellFile = findSellFileByListingId(listingId);
  return sellFile
    ? getSellFilePath(sellFile.slug)
    : getSellDir();
}

function formatChannelOpened(
  event: MarketplaceEvent,
): string {
  const buyer = event.buyer_handle ?? "unknown";
  const listing = event.listing_id ?? "unknown";
  const policyPath = getNegotiationStylePath();
  const sellRef = sellFileRef(event.listing_id);
  return `[Klodi] @${buyer} opened a negotiation`
    + ` channel on listing ${listing}.`
    + ` Read ${policyPath} and ${sellRef},`
    + " then respond per your negotiation style.";
}

function formatChannelMessage(
  event: MarketplaceEvent,
): string {
  const sender = event.sender_handle ?? "unknown";
  const channel = event.channel_id ?? "unknown";
  const policyPath = getNegotiationStylePath();
  return `[Klodi] New message from @${sender}`
    + ` in channel ${channel}.`
    + ` Read ${policyPath} and the matching`
    + ` ${getBuyDir()} or ${getSellDir()} file`
    + " for this channel's listing. Use"
    + " klodi_channel_history to read the"
    + " conversation, then respond per policy.";
}

function formatCommentCreated(
  event: MarketplaceEvent,
): string {
  const handle = event.handle ?? "unknown";
  const listing = event.listing_id ?? "unknown";
  const mentions = event.mentions?.length
    ? ` (mentions: ${event.mentions.join(", ")})`
    : "";
  const body = event.body ? `\n${quoteBody(event.body)}` : "";
  const policyPath = getNegotiationStylePath();
  const sellRef = sellFileRef(event.listing_id);
  return `[Klodi] @${handle} commented on`
    + ` listing ${listing}${mentions}:${body}`
    + `\nIf you're the seller, read ${policyPath}`
    + ` and ${sellRef}, classify the comment per`
    + " SKILL.md Section 5, then respond with"
    + " klodi_comment. Use klodi_list_comments if"
    + " you need the full thread.";
}

/**
 * Prefix every line with `> ` so multi-line counterparty text
 * cannot break out of the quote block and impersonate plugin
 * instructions in the agent's wake prompt.
 */
function quoteBody(body: string): string {
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatOfferAccepted(
  event: MarketplaceEvent,
): string {
  const amount = event.amount !== undefined
    ? ` for ${formatCents(event.amount)}` : "";
  const listing = event.listing_id ?? "unknown";
  const seller = event.seller_handle ?? "unknown";
  const tx = event.transaction_id ?? "unknown";
  return `[Klodi] Your offer on listing ${listing}`
    + ` was accepted by @${seller}${amount}.`
    + ` Transaction ${tx} created.`
    + " Coordinate the exchange and confirm"
    + " with klodi_tx_confirm when done.";
}

function formatOfferRejected(
  event: MarketplaceEvent,
): string {
  const listing = event.listing_id ?? "unknown";
  const seller = event.seller_handle ?? "unknown";
  return `[Klodi] Your offer on listing ${listing}`
    + ` was rejected by @${seller}.`
    + " Consider adjusting your offer"
    + " or moving on.";
}

function formatTransactionConfirmed(
  event: MarketplaceEvent,
): string {
  const handle = event.confirmed_by_handle ?? "unknown";
  const tx = event.transaction_id ?? "unknown";
  return `[Klodi] @${handle} confirmed`
    + ` transaction ${tx}.`
    + " If you haven't confirmed yet,"
    + " use klodi_tx_confirm.";
}

function formatTransactionCompleted(
  event: MarketplaceEvent,
): string {
  const tx = event.transaction_id ?? "unknown";
  const listing = event.listing_id ?? "unknown";
  return `[Klodi] Transaction ${tx}`
    + ` on listing ${listing} is complete!`
    + " Both parties confirmed."
    + " Rate the other party with klodi_tx_rate."
    + " If this fulfilled a standing search"
    + " (you were the buyer), close it out with"
    + " klodi_unwatch using the buy_slug from the"
    + " matching buy/<slug>.md file.";
}

function formatTransactionCancelled(
  event: MarketplaceEvent,
): string {
  const tx = event.transaction_id ?? "unknown";
  const handle = event.cancelled_by_handle ?? "unknown";
  const reason = event.reason
    ? ` Reason: ${event.reason}.` : "";
  return `[Klodi] Transaction ${tx}`
    + ` was cancelled by @${handle}.${reason}`;
}

function formatListingStatusChanged(
  event: MarketplaceEvent,
): string {
  const listing = event.listing_id ?? "unknown";
  const old = event.old_status ?? "?";
  const next = event.new_status ?? "?";
  return `[Klodi] Listing ${listing}`
    + ` status changed: ${old} → ${next}.`;
}
