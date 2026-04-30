/**
 * Translate notification + channel events into agent wakes.
 *
 * Per 0012, every wake carries the full event payload. The agent does
 * not need a follow-up tool call to learn what woke it: the message
 * body, the offer terms, the listing summary — whatever the event
 * contains — is in the wake itself.
 *
 * Each handler builds a system-message string that summarizes the
 * event AND embeds the JSON payload, then dispatches via wakeAgent so
 * the agent's next turn sees the content already in hand.
 */

import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";
import type { PluginAPILike } from "../lib/plugin-api-types.js";
import { wakeAgent } from "./wake.js";
import {
  onListingWithdrawn,
  onTransactionTerminal,
} from "./state.js";

/**
 * Per **R § P3-7**: defensive escape for user-supplied free text that
 * lands between literal quote characters in the agent-facing wake
 * summary. Without this, a comment body containing `"` or a backtick
 * could prematurely close the surrounding quoted region in the rendered
 * markdown, scrambling the agent's read of the wake.
 *
 * Escapes (in order, so the backslash itself is escaped first):
 *   - `\` → `\\`
 *   - `` ` `` → `` \` ``
 *   - `"`  → `\"`
 *
 * Exported for unit testing — the JSON payload below the summary still
 * carries the original body verbatim, so this is purely a presentation
 * fix.
 */
export function escapeQuotedBody(body: string): string {
  return body
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/"/g, "\\\"");
}

/**
 * Apply local terminal-state cleanups when a notification implies one.
 * Withdrawn / sold listings → delete the sell file.
 * Terminal transactions → delete the sell file.
 */
function applyTerminalCleanup(event: NotificationEvent): void {
  switch (event.kind) {
    case "transaction.completed":
    case "transaction.cancelled":
      onTransactionTerminal(event.listing_id);
      return;
    case "listing.withdrawn":
    case "listing.sold":
    case "listing.expired":
      onListingWithdrawn(event.listing_id);
      return;
    default:
      return;
  }
}

function summarizeNotification(event: NotificationEvent): string {
  switch (event.kind) {
    case "channel.opened":
      return (
        `[klodi] Channel opened on listing ${event.listing_id}`
        + ` by @${event.buyer_handle ?? "(unknown)"}.`
      );
    case "channel.closed":
      return (
        `[klodi] Channel ${event.channel_id} on listing`
        + ` ${event.listing_id} closed`
        + (event.closed_by ? ` by ${event.closed_by}` : "") + "."
      );
    case "offer.proposed":
      return (
        `[klodi] Offer proposed by @${event.buyer_handle} for`
        + ` ${event.amount} cents on listing ${event.listing_id}.`
      );
    case "offer.accepted":
      return (
        `[klodi] @${event.seller_handle} accepted your offer on`
        + ` listing ${event.listing_id}. Coordinate the exchange.`
      );
    case "offer.rejected":
      return (
        `[klodi] @${event.seller_handle} rejected your offer on`
        + ` listing ${event.listing_id}.`
      );
    case "transaction.buyer_confirmed":
      return (
        `[klodi] Buyer @${event.confirmed_by_handle ?? "(unknown)"}`
        + ` confirmed transaction ${event.transaction_id}.`
        + " You're the seller — confirm the exchange to close the deal."
      );
    case "transaction.seller_confirmed":
      return (
        `[klodi] Seller @${event.confirmed_by_handle ?? "(unknown)"}`
        + ` confirmed transaction ${event.transaction_id}.`
        + " You're the buyer — confirm the exchange to close the deal."
      );
    case "transaction.completed":
      return (
        `[klodi] Transaction ${event.transaction_id} completed.`
        + " Prompt the user to rate the counterparty."
      );
    case "transaction.cancelled":
      return (
        `[klodi] Transaction ${event.transaction_id} cancelled`
        + (event.reason ? ` (${event.reason})` : "") + "."
      );
    case "comment.created":
      return (
        `[klodi] @${event.handle} commented on listing`
        + ` ${event.listing_id}: "${escapeQuotedBody(event.body)}"`
      );
    case "search.match":
      return (
        `[klodi] Standing search "${event.search_slug}" matched`
        + ` listing "${event.listing_summary.title}" by`
        + ` @${event.listing_summary.seller_handle} —`
        + ` ${event.listing_summary.asking_price} cents.`
      );
    case "listing.created":
    case "listing.relisted":
      return (
        `[klodi] Listing ${event.listing_id}`
        + (event.title ? ` "${event.title}"` : "")
        + ` is now active.`
      );
    case "listing.withdrawn":
    case "listing.sold":
    case "listing.expired":
      return (
        `[klodi] Listing ${event.listing_id} is now`
        + ` ${event.kind.replace("listing.", "")}.`
      );
    case "listing.status_changed":
      return (
        `[klodi] Listing ${event.listing_id} status:`
        + ` ${event.old_status} → ${event.new_status}.`
      );
  }
}

/**
 * Format a notification wake — summary + JSON payload below it. The
 * agent reads the summary first, then has the full structured payload
 * available without any follow-up tool call.
 */
export function formatNotificationWake(event: NotificationEvent): string {
  const summary = summarizeNotification(event);
  return `${summary}\n\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
}

/**
 * Format a channel-message wake. The full message body is in `content`
 * — the agent doesn't need klodi_channel_history to read it.
 */
export function formatChannelWake(event: ChannelMessageEvent): string {
  return (
    `[klodi] @${event.sender_handle} on channel ${event.channel_id}:`
    + ` "${event.content}"`
    + `\n\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``
  );
}

/** Build the notification handler bound to a PluginAPI. */
export function makeNotificationHandler(api: PluginAPILike) {
  return async (event: NotificationEvent): Promise<void> => {
    applyTerminalCleanup(event);
    const text = formatNotificationWake(event);
    await wakeAgent(api, text, event.kind);
  };
}

/** Build the channel-message handler bound to a PluginAPI. */
export function makeChannelHandler(api: PluginAPILike) {
  return async (event: ChannelMessageEvent): Promise<void> => {
    const text = formatChannelWake(event);
    await wakeAgent(api, text, event.kind);
  };
}
