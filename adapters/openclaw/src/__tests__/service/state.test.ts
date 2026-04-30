/**
 * P1-7 / D3 — onListingUpdated must NEVER derive `min_acceptable_price`
 * from `asking_price`.
 *
 * Background: previously `onListingUpdated` rewrote
 * `min_acceptable_price = asking_price` on every update. That collapsed
 * the floor-secrecy guarantee in SECURITY.md (the floor became identical
 * to the public asking the server already knows). The fix preserves the
 * existing floor literally and never touches it on an update.
 *
 * These tests lock that contract:
 *   1. updating asking_price MUST NOT mutate a non-null floor
 *   2. updating asking_price MUST NOT auto-fill a null floor
 *   3. updating auto_reject_below works AND preserves the floor
 *   4. an empty update preserves every field
 *   5. a non-existent listing id is a no-op (no throw, no file created)
 *
 * Tests touch real disk via lib/config.ts (mock-the-boundaries-only
 * policy). Each test gets its own KLODI_HOME tmp dir to keep the
 * sell-file dir, and the in-memory sell index inside config.ts, isolated.
 * Listing ids are unique per test so the index can't leak entries
 * across tests within the same vitest worker.
 */

import {
  describe, it, expect, beforeEach, afterEach,
} from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, existsSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onListingUpdated, type ListingUpdateFields } from "../../service/state.js";
import { writeSellFile, readSellFile } from "../../lib/sell-buy-files.js";
import { setKlodiHome, getSellDir } from "../../lib/paths.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "klodi-state-test-"));
  process.env["KLODI_HOME"] = tmpHome;
  // Defensive: clear any closure override that a prior test in this
  // worker might have set via setKlodiHome — we want the env var to be
  // the only source of truth for this test.
  setKlodiHome("");
});

afterEach(() => {
  delete process.env["KLODI_HOME"];
  setKlodiHome("");
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("onListingUpdated — floor-secrecy regression (P1-7 / D3)", () => {
  it("does NOT overwrite an existing min_acceptable_price when asking_price changes", () => {
    // Arrange — seed a sell file whose floor (150_00) differs from the
    // (future) asking_price (200_00). If the implementation ever
    // re-derives the floor from asking_price, this test fails because
    // the on-disk floor would become 200_00.
    const slug = "vintage-lamp-aaa111";
    const listingId = "listing-floor-preserved";
    writeSellFile(slug, {
      listing_id: listingId,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });

    // Act — we pass `asking_price` via a cast even though the type
    // rejects it, because the regression we're locking is runtime
    // behavior: the function MUST NOT read this field even if a future
    // change re-adds it to the interface.
    onListingUpdated(
      listingId,
      { asking_price: 200_00 } as unknown as ListingUpdateFields,
    );

    // Assert — floor stays at the seeded value, not the new asking.
    const after = readSellFile(slug);
    expect(after).not.toBeNull();
    expect(after?.min_acceptable_price).toBe(150_00);
    // Adversarial: also verify via raw frontmatter that the literal
    // bytes "200" never appear under the min_acceptable_price key.
    // Catches any future serializer that smuggles asking back in.
    const raw = readFileSync(join(getSellDir(), `${slug}.md`), "utf-8");
    expect(raw).toMatch(/min_acceptable_price: 15000\b/);
    expect(raw).not.toMatch(/min_acceptable_price: 20000\b/);
  });

  it("does NOT auto-fill a null min_acceptable_price from asking_price", () => {
    // Arrange — floor is explicitly null (seller has no firm floor;
    // every offer routes to negotiation). Updating asking_price must
    // not silently establish a floor.
    const slug = "open-floor-bbb222";
    const listingId = "listing-null-floor";
    writeSellFile(slug, {
      listing_id: listingId,
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });

    // Act — cast bypasses the type narrowing on purpose; see test 1.
    onListingUpdated(
      listingId,
      { asking_price: 200_00 } as unknown as ListingUpdateFields,
    );

    // Assert — floor remains null.
    const after = readSellFile(slug);
    expect(after).not.toBeNull();
    expect(after?.min_acceptable_price).toBeNull();
    // Raw check: the frontmatter must serialize null literally, not the
    // asking price masquerading as a floor.
    const raw = readFileSync(join(getSellDir(), `${slug}.md`), "utf-8");
    expect(raw).toMatch(/min_acceptable_price: null\b/);
    expect(raw).not.toMatch(/min_acceptable_price: 20000\b/);
  });

  it("updates auto_reject_below and preserves min_acceptable_price", () => {
    // Arrange — both fields seeded; auto_reject_below is the one we
    // expect to change. Floor must survive untouched.
    const slug = "preserve-floor-ccc333";
    const listingId = "listing-auto-reject-update";
    writeSellFile(slug, {
      listing_id: listingId,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });

    // Act
    onListingUpdated(listingId, { auto_reject_below: 100_00 });

    // Assert — auto_reject_below set, floor untouched, other fields
    // preserved.
    const after = readSellFile(slug);
    expect(after).not.toBeNull();
    expect(after?.auto_reject_below).toBe(100_00);
    expect(after?.min_acceptable_price).toBe(150_00);
    expect(after?.transaction_id).toBeNull();
    expect(after?.listing_id).toBe(listingId);
  });

  it("leaves every field unchanged on an empty update", () => {
    // Arrange — give the file a non-trivial state (all four fields
    // populated) so a regression that drops or rewrites any single one
    // would be caught.
    const slug = "untouched-ddd444";
    const listingId = "listing-empty-update";
    writeSellFile(slug, {
      listing_id: listingId,
      min_acceptable_price: 150_00,
      auto_reject_below: 80_00,
      transaction_id: "tx-already-accepted",
      body: "Negotiation log line 1\nLine 2",
    });

    // Act
    onListingUpdated(listingId, {});

    // Assert — every field equals the seeded value.
    const after = readSellFile(slug);
    expect(after).not.toBeNull();
    expect(after?.listing_id).toBe(listingId);
    expect(after?.min_acceptable_price).toBe(150_00);
    expect(after?.auto_reject_below).toBe(80_00);
    expect(after?.transaction_id).toBe("tx-already-accepted");
    expect(after?.body).toBe("Negotiation log line 1\nLine 2");
  });

  it("is a no-op when the listing id has no sell file (no throw, no file created)", () => {
    // Arrange — no seed. The sell dir may not even exist yet.
    const missingId = "listing-does-not-exist-eee555";
    const sellDirBefore = existsSync(getSellDir());

    // Act + Assert — must not throw. Cast bypasses the type narrowing on
    // purpose; see test 1 — even with `asking_price` smuggled in, the
    // function must remain a no-op for unknown ids.
    expect(() =>
      onListingUpdated(
        missingId,
        {
          asking_price: 999_99,
          auto_reject_below: 500_00,
        } as unknown as ListingUpdateFields,
      ),
    ).not.toThrow();

    // Assert — no file appeared. If the implementation ever started
    // creating files for unknown ids, this guard catches it.
    expect(readSellFile(missingId)).toBeNull();
    // And the sell dir wasn't spuriously created (or, if it was, it's
    // still empty — either is fine; what matters is no orphan file).
    if (existsSync(getSellDir())) {
      expect(readdirSync(getSellDir())).toHaveLength(0);
    } else {
      expect(sellDirBefore).toBe(false);
    }
  });
});

// qa-developer: P1-7 / D3 (2026-04-26-klodi-plugin-multi-lens-review)
