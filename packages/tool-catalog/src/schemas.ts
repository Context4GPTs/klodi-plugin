/**
 * Shared TypeBox schema fragments for the canonical klodi_* tool surface.
 * Ported from `klodi-plugin/adapters/openclaw/src/lib/schemas.ts` so the
 * catalog and the openclaw adapter pull from the same source.
 *
 * All prices are integer cents. All IDs are UUIDs.
 */

import { type TLiteral, Type } from "@sinclair/typebox";

export const Uuid = Type.String({
  description: "UUID v4 identifier",
  // Strict v4 (lowercase) — matches the marketplace's ID-minting source
  // (Postgres `gen_random_uuid()` and Prisma `@default(uuid(4))`) and
  // the publish-path subject-interpolation guard in
  // `packages/nats-client-{ts,py,rs}/src/publish.*`. Tightening here
  // closes the divergence the publish-path guard was hardening against.
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

export const Handle = Type.String({
  description: "Marketplace handle (e.g. alice)",
});

export const Cents = Type.Integer({
  description: "Price in integer cents (e.g. 15000 = $150.00)",
  minimum: 0,
});

export const Currency = Type.String({
  description: "ISO 4217 currency code (e.g. USD)",
  default: "USD",
});

export const CATEGORY_VALUES = [
  "electronics",
  "furniture",
  "vehicles",
  "clothing",
  "home_garden",
  "sports",
  "collectibles",
  "digital_goods",
  "services",
  "free",
  "other",
] as const;

// Cast: `.map()` returns `TLiteral<string>[]` which TS can't narrow to
// the variadic tuple `[...Types]` that TypeBox's `Union()` expects.
// Runtime values are identical to the prior inline-literal form.
export const Category = Type.Union(
  CATEGORY_VALUES.map((v) => Type.Literal(v)) as TLiteral<string>[],
  { description: "Item category" },
);

export const Condition = Type.Union(
  [
    Type.Literal("new_item"),
    Type.Literal("like_new"),
    Type.Literal("good"),
    Type.Literal("fair"),
    Type.Literal("poor"),
  ],
  { description: "Item condition" },
);

export const ListingStatus = Type.Union(
  [
    Type.Literal("active"),
    Type.Literal("on_hold"),
    Type.Literal("sold"),
    Type.Literal("withdrawn"),
  ],
  { description: "Listing status filter" },
);

export const OfferAction = Type.Union(
  [Type.Literal("accept"), Type.Literal("reject")],
  { description: "Accept or reject the offer" },
);

export const CancelReason = Type.Union(
  [
    Type.Literal("no_show"),
    Type.Literal("item_not_received"),
    Type.Literal("payment_not_received"),
    Type.Literal("changed_mind"),
    Type.Literal("other"),
  ],
  { description: "Reason for cancellation" },
);

export const Rating = Type.Integer({
  description: "Rating from 1 to 5 stars",
  minimum: 1,
  maximum: 5,
});

export const ChannelStatus = Type.Union(
  [Type.Literal("open"), Type.Literal("closed")],
  { description: "Channel status filter" },
);

export const OfferStatus = Type.Union(
  [
    Type.Literal("proposed"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
  ],
  { description: "Offer status filter" },
);

export const OfferRole = Type.Union(
  [Type.Literal("buyer"), Type.Literal("seller")],
  { description: "Caller's role on the offer" },
);

/**
 * ISO 8601 timestamp string. Server-issued. Used in tool result schemas
 * where a free `string` would underspecify the contract.
 */
export const Iso8601 = Type.String({
  description: "ISO 8601 timestamp",
});
