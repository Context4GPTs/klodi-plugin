/**
 * Reusable TypeBox schema fragments for tool parameter definitions.
 * All prices are integer cents. All IDs are UUIDs.
 */

import { Type } from "@sinclair/typebox";

/** UUID string identifier. */
export const Uuid = Type.String({
  description: "UUID identifier",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

/** Marketplace user handle. */
export const Handle = Type.String({
  description: "Marketplace handle (e.g. alice)",
});

/** Price in integer cents (e.g. 15000 = $150). */
export const Cents = Type.Integer({
  description: "Price in integer cents (e.g. 15000 = $150.00)",
  minimum: 0,
});

/** ISO 4217 currency code. */
export const Currency = Type.String({
  description: "ISO 4217 currency code (e.g. USD)",
  default: "USD",
});

/** Listing category enum. */
export const Category = Type.Union([
  Type.Literal("electronics"),
  Type.Literal("furniture"),
  Type.Literal("vehicles"),
  Type.Literal("clothing"),
  Type.Literal("home_garden"),
  Type.Literal("sports"),
  Type.Literal("collectibles"),
  Type.Literal("digital_goods"),
  Type.Literal("services"),
  Type.Literal("free"),
  Type.Literal("other"),
], { description: "Item category" });

/** Delivery method enum. */
export const DeliveryMethod = Type.Union([
  Type.Literal("pickup"),
  Type.Literal("ship"),
  Type.Literal("digital"),
], { description: "Delivery method" });

/** Item condition enum. */
export const Condition = Type.Union([
  Type.Literal("new_item"),
  Type.Literal("like_new"),
  Type.Literal("good"),
  Type.Literal("fair"),
  Type.Literal("poor"),
], { description: "Item condition" });

/** Listing status enum. */
export const ListingStatus = Type.Union([
  Type.Literal("active"),
  Type.Literal("on_hold"),
  Type.Literal("sold"),
  Type.Literal("withdrawn"),
], { description: "Listing status filter" });

/** Offer action enum. */
export const OfferAction = Type.Union([
  Type.Literal("accept"),
  Type.Literal("reject"),
], { description: "Accept or reject the offer" });

/** Transaction cancellation reason enum. */
export const CancelReason = Type.Union([
  Type.Literal("no_show"),
  Type.Literal("item_not_received"),
  Type.Literal("payment_not_received"),
  Type.Literal("changed_mind"),
  Type.Literal("other"),
], { description: "Reason for cancellation" });

/** Star rating 1-5. */
export const Rating = Type.Integer({
  description: "Rating from 1 to 5 stars",
  minimum: 1,
  maximum: 5,
});
