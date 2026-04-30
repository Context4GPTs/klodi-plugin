/**
 * Canonical wake event payloads.
 *
 * Authoritative source of truth — every wake delivered on the
 * notifications consumer (`subscribe_notifications`) or the channels
 * consumer (`subscribe_channels`) carries a payload of one of these
 * shapes. The Python and Rust adapters mirror these via codegen.
 *
 * See `docs/plans/2026-04-25-0012-shared-contracts.md` for the
 * authoritative list and `klodi-plugin/docs/plans/0012-nats-native-host-plugins.md`
 * § Wake payload contract for the rationale.
 */

/** UUID v4. Used by the consumer-side dedup against `max_deliver: 5`. */
export type EventId = string;

// ─── Channel stream events (delivered via subscribe_channels) ─────────

export interface ChannelMessageEvent {
  kind: "channel.message";
  event_id: EventId;
  channel_id: string;
  message_id: string;
  /** JetStream sequence within the channel subject. */
  sequence: number;
  sender_user_id: string;
  sender_handle: string;
  /** Up to 2000 chars (Channel.message schema cap). */
  content: string;
  /** ISO 8601. */
  created_at: string;
}

// ─── Notification stream events (delivered via subscribe_notifications) ─

export interface ListingStateEvent {
  kind:
    | "listing.created"
    | "listing.relisted"
    | "listing.withdrawn"
    | "listing.sold"
    | "listing.expired";
  event_id: EventId;
  listing_id: string;
  /** Present on listing.created / listing.relisted. */
  title?: string;
}

export interface ListingStatusChangedEvent {
  kind: "listing.status_changed";
  event_id: EventId;
  listing_id: string;
  old_status: string;
  new_status: string;
}

export interface OfferProposedEvent {
  kind: "offer.proposed";
  event_id: EventId;
  offer_id: string;
  listing_id: string;
  buyer_handle: string;
  /** Cents. */
  amount: number;
  /** Opaque structured terms. May be null. */
  terms: Record<string, unknown> | null;
}

export interface OfferRespondedEvent {
  kind: "offer.accepted" | "offer.rejected";
  event_id: EventId;
  offer_id: string;
  listing_id: string;
  seller_handle: string;
  /** Present on accept. */
  amount?: number;
  /** Present on accept. */
  transaction_id?: string;
}

export interface TransactionStateEvent {
  kind:
    | "transaction.buyer_confirmed"
    | "transaction.seller_confirmed"
    | "transaction.completed"
    | "transaction.cancelled";
  event_id: EventId;
  transaction_id: string;
  listing_id: string;
  /** Present on buyer_confirmed / seller_confirmed — handle of the
   * party that just confirmed. The recipient is the OTHER party. */
  confirmed_by_handle?: string;
  /** Present on cancelled. */
  cancelled_by_handle?: string;
  /** Present on cancelled. */
  reason?: string;
}

export interface CommentPostedEvent {
  kind: "comment.created";
  event_id: EventId;
  listing_id: string;
  comment_id: string;
  handle: string;
  body: string;
  mentions: string[];
  created_at: string;
}

export interface SearchMatchEvent {
  kind: "search.match";
  event_id: EventId;
  search_slug: string;
  listing_id: string;
  listing_summary: {
    title: string;
    asking_price: number;
    currency: string;
    /** DeliveryOffer[] — multi-mode listing fulfillment options. */
    fulfillment: Array<Record<string, unknown>>;
    seller_handle: string;
    photos: string[];
  };
}

export interface ChannelLifecycleEvent {
  kind: "channel.opened" | "channel.closed";
  event_id: EventId;
  channel_id: string;
  listing_id: string;
  /** Present on opened. */
  buyer_handle?: string;
  /** Present on closed. */
  closed_by?: string;
}

export type NotificationEvent =
  | ListingStateEvent
  | ListingStatusChangedEvent
  | OfferProposedEvent
  | OfferRespondedEvent
  | TransactionStateEvent
  | CommentPostedEvent
  | SearchMatchEvent
  | ChannelLifecycleEvent;

/** Discriminator string set on every notification kind. */
export type NotificationKind = NotificationEvent["kind"];
