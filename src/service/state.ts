/**
 * Sell/buy file management as tool side-effects.
 * Tools call these after successful NATS operations to keep local state in sync.
 */

import {
  type SellFile,
  type BuyFile,
  readSellFile,
  writeSellFile,
  deleteSellFile,
  readBuyFile,
  writeBuyFile,
  deleteBuyFile,
  findSellFileByListingId,
  slugify,
} from "../lib/config.js";
import { clearItemTimer } from "./timers.js";

/** Create a sell file after listing creation. */
export function onListingCreated(
  title: string,
  listingId: string,
  checkEvery: string = "2h",
): string {
  const slug = slugify(title, listingId);
  writeSellFile(slug, {
    listing_id: listingId,
    min_acceptable_price: null,
    auto_reject_below: null,
    transaction_id: null,
    check_every: checkEvery,
    body: "",
  });
  return slug;
}

/**
 * Mirror a listing update onto the local sell file.
 *
 * When `asking_price` is present, `min_acceptable_price` is
 * re-derived from it so the private floor tracks the public price
 * the server just accepted. `auto_reject_below` and `check_every`
 * are mirrored literally when provided.
 *
 * NOTE (P2 follow-up): every field uses `?? existing.X`, so a
 * caller passing `null` explicitly meaning "clear" is indistinguishable
 * from omitting the field. No current call site needs that distinction,
 * but a future clear-semantics fix should switch to `in`-based checks.
 */
export interface ListingUpdateFields {
  asking_price?: number;
  auto_reject_below?: number | null;
  check_every?: string;
}

export function onListingUpdated(
  listingId: string,
  updates: ListingUpdateFields,
): void {
  const existing = findSellFileByListingId(listingId);
  if (!existing) return;

  writeSellFile(existing.slug, {
    listing_id: existing.listing_id,
    min_acceptable_price:
      updates.asking_price ?? existing.min_acceptable_price,
    auto_reject_below:
      updates.auto_reject_below ?? existing.auto_reject_below,
    transaction_id: existing.transaction_id,
    check_every:
      updates.check_every ?? existing.check_every,
    body: existing.body,
  });
}

/** Delete sell file and clear timer after withdrawal. */
export function onListingWithdrawn(listingId: string): void {
  const existing = findSellFileByListingId(listingId);
  if (!existing) return;
  clearItemTimer(existing.slug);
  deleteSellFile(existing.slug);
}

/** Ensure sell file exists after relisting. */
export function onListingRelisted(
  listingId: string,
  title: string,
): string {
  const existing = findSellFileByListingId(listingId);
  if (existing) return existing.slug;

  const slug = slugify(title, listingId);
  writeSellFile(slug, {
    listing_id: listingId,
    min_acceptable_price: null,
    auto_reject_below: null,
    transaction_id: null,
    check_every: "2h",
    body: "",
  });
  return slug;
}

/** Record transaction_id in sell file when offer is accepted. */
export function onOfferAccepted(
  listingId: string,
  transactionId: string,
): void {
  const existing = findSellFileByListingId(listingId);
  if (!existing) return;

  writeSellFile(existing.slug, {
    listing_id: existing.listing_id,
    min_acceptable_price: existing.min_acceptable_price,
    auto_reject_below: existing.auto_reject_below,
    transaction_id: transactionId,
    check_every: existing.check_every,
    body: existing.body,
  });
}

/** Clean up sell/buy file and timer on terminal transaction state. */
export function onTransactionTerminal(listingId: string): void {
  const sellFile = findSellFileByListingId(listingId);
  if (sellFile) {
    clearItemTimer(sellFile.slug);
    deleteSellFile(sellFile.slug);
  }
}

/** Create a buy file for a standing search. */
export function onBuySearchCreated(
  slug: string,
  data: Omit<BuyFile, "slug">,
): void {
  writeBuyFile(slug, data);
}

/** Clean up buy file and timer. */
export function onBuySearchRemoved(slug: string): void {
  clearItemTimer(slug);
  deleteBuyFile(slug);
}

/** Get sell file by listing_id for notification handling. */
export function getSellFileForListing(listingId: string): SellFile | null {
  return findSellFileByListingId(listingId);
}

/** Get sell file by slug. */
export { readSellFile, readBuyFile };
