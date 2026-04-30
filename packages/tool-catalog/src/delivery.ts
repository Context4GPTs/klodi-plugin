/**
 * Discriminated unions for delivery semantics on listings and searches.
 *
 * Replaces the prior flat triple of (delivery_method, ships_to,
 * location_*) with a union the type system can check. A listing offers
 * a `DeliveryOffer[]` (multi-mode); a search filter is a single
 * `DeliveryFilter`. `shipsTo` exists ONLY on `ship` variants — the
 * agent cannot set it on a `pickup` filter without a type error.
 */

import { Type, type Static } from "@sinclair/typebox";

const IsoCountry = Type.String({
  pattern: "^[A-Z]{2}$",
  description: "ISO 3166-1 alpha-2 country code (e.g. GR, US)",
});

const IsoCountryOrSubdivision = Type.String({
  pattern: "^[A-Z]{2}(-[A-Z0-9]{1,5})?$",
  description: "ISO 3166 country or country-subdivision (e.g. US, US-NY)",
});

/**
 * A seller's delivery offer on a listing. Listings carry
 * `DeliveryOffer[]` (one entry per method, no duplicates).
 *
 * Each variant rejects extra properties (`additionalProperties: false`)
 * — `shipsTo` exists ONLY on the `ship` variant, not on `pickup` or
 * `digital`. The agent cannot smuggle fields across variants.
 */
export const DeliveryOffer = Type.Union(
  [
    Type.Object(
      {
        method: Type.Literal("pickup"),
        location: Type.Object(
          {
            lat: Type.Number({ minimum: -90, maximum: 90 }),
            lng: Type.Number({ minimum: -180, maximum: 180 }),
            area: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        method: Type.Literal("ship"),
        from: Type.Object(
          { country: IsoCountry },
          { additionalProperties: false },
        ),
        shipsTo: Type.Array(IsoCountryOrSubdivision, {
          minItems: 1,
          maxItems: 250,
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { method: Type.Literal("digital") },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "One delivery option a seller offers on a listing. The 'ship'"
      + " variant carries shipsTo and the source country; 'pickup'"
      + " carries the meeting-point coordinates and area; 'digital'"
      + " has no extra fields.",
  },
);
export type DeliveryOffer = Static<typeof DeliveryOffer>;

/** Listing fulfillment array — `DeliveryOffer[]` with at most one entry per method. */
export const Fulfillment = Type.Array(DeliveryOffer, {
  minItems: 1,
  maxItems: 3,
  description:
    "Delivery options the seller advertises. At most one entry per"
    + " method. Buyers match if the listing's fulfillment intersects"
    + " their delivery filter.",
});
export type Fulfillment = Static<typeof Fulfillment>;

/**
 * A buyer's delivery filter on a search. Matches a listing when the
 * filter's method appears in the listing's fulfillment array AND the
 * variant-specific conditions (radius, destination) are satisfied.
 *
 * The `any` variant is explicit (not nullable). Buyers must opt in to
 * "I'm flexible" rather than communicate flexibility through nullables.
 */
export const DeliveryFilter = Type.Union(
  [
    Type.Object(
      {
        method: Type.Literal("pickup"),
        radiusKm: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 1000,
            description:
              "Km radius around buyer's profile location. Omit for"
              + " any-distance pickup match.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        method: Type.Literal("ship"),
        to: Type.Optional(IsoCountryOrSubdivision),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { method: Type.Literal("digital") },
      { additionalProperties: false },
    ),
    Type.Object(
      { method: Type.Literal("any") },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Buyer's delivery preference. Pick the variant matching the"
      + " buyer's intent — fields from one variant cannot appear on"
      + " another (the type system rejects it).",
  },
);
export type DeliveryFilter = Static<typeof DeliveryFilter>;

/**
 * Throws if the offers array contains more than one entry for the same
 * method. Cheaper than encoding uniqueness in TypeBox (which would
 * force tuple types). Called by every handler that accepts a
 * fulfillment array.
 */
export function assertUniqueMethods(offers: DeliveryOffer[]): void {
  const seen = new Set<string>();
  for (const offer of offers) {
    if (seen.has(offer.method)) {
      throw new Error(
        `Duplicate delivery method '${offer.method}' in fulfillment array.`,
      );
    }
    seen.add(offer.method);
  }
}
