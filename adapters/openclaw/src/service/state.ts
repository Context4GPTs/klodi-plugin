/**
 * Sell/buy file management as tool side-effects.
 *
 * Tools call these after successful NATS operations to keep local state
 * in sync. 0012 dropped the per-item timers (no cron), so this file no
 * longer wires up `createSellTimer` / `clearItemTimer` — the on-disk
 * file is the only state.
 */

import {
  type BuyFile,
  deleteBuyFile,
  deleteSellFile,
  findSellFileByListingId,
  readBuyFile,
  readSellFile,
  slugify,
  writeBuyFile,
  writeSellFile,
} from "../lib/sell-buy-files.js";

/** Create a sell file after listing creation. */
export function onListingCreated(
  title: string,
  listingId: string,
): string {
  const slug = slugify(title, listingId);
  writeSellFile(slug, {
    listing_id: listingId,
    min_acceptable_price: null,
    auto_reject_below: null,
    transaction_id: null,
    body: "",
  });
  return slug;
}

export interface ListingUpdateFields {
  auto_reject_below?: number | null;
}

/**
 * Mirror an `auto_reject_below` update onto the local sell file.
 *
 * Floor price (`min_acceptable_price`) is preserved literally — this
 * function never reads or writes it. Per ADR-0005 / SECURITY.md the
 * floor is purely seller-local and lives only in the on-disk sell
 * file the seller edits directly. Deriving it from server-known
 * fields like `asking_price` (the prior buggy behavior) collapsed
 * the secrecy guarantee.
 *
 * `asking_price` is intentionally absent from this interface —
 * server-side updates do not mirror onto local state because the
 * sell-file body and floor are user-owned, not derived.
 */
export function onListingUpdated(
  listingId: string,
  updates: ListingUpdateFields,
): void {
  const existing = findSellFileByListingId(listingId);
  if (!existing) return;
  writeSellFile(existing.slug, {
    listing_id: existing.listing_id,
    min_acceptable_price: existing.min_acceptable_price,
    auto_reject_below:
      updates.auto_reject_below ?? existing.auto_reject_below,
    transaction_id: existing.transaction_id,
    body: existing.body,
  });
}

/** Delete sell file after withdrawal. */
export function onListingWithdrawn(listingId: string): void {
  const existing = findSellFileByListingId(listingId);
  if (!existing) return;
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
    body: existing.body,
  });
}

/** Clean up sell file on terminal transaction state. */
export function onTransactionTerminal(listingId: string): void {
  const sellFile = findSellFileByListingId(listingId);
  if (sellFile) deleteSellFile(sellFile.slug);
}

/** Create a buy file for a standing search. */
export function onBuySearchCreated(
  slug: string,
  data: Omit<BuyFile, "slug">,
): void {
  writeBuyFile(slug, data);
}

/** Clean up buy file. */
export function onBuySearchRemoved(slug: string): void {
  deleteBuyFile(slug);
}

export { readSellFile, readBuyFile };
