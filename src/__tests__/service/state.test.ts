/**
 * State management tests.
 * Uses real file I/O via createTempHome() to verify sell/buy file lifecycle.
 * Only timers are mocked (boundary).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock the timer boundary -- we don't test timer logic here
vi.mock("../../service/timers.js", () => ({
  createSellTimer: vi.fn(),
  createBuyTimer: vi.fn(),
  clearItemTimer: vi.fn(),
  clearAllTimers: vi.fn(),
  initTimers: vi.fn(),
  reconcileTimers: vi.fn(),
}));

import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import {
  onListingCreated,
  onListingUpdated,
  onListingWithdrawn,
  onListingRelisted,
  onOfferAccepted,
  onTransactionTerminal,
  onBuySearchCreated,
  onBuySearchRemoved,
} from "../../service/state.js";
import {
  readSellFile,
  readBuyFile,
  findSellFileByListingId,
  writeSellFile,
} from "../../lib/config.js";
import { clearItemTimer } from "../../service/timers.js";

// ── Setup ──────────────────────────────────────────────────────────────────

let tempHome: TempHome;

beforeEach(() => {
  vi.clearAllMocks();
  tempHome = createTempHome();
});

afterEach(() => {
  tempHome.cleanup();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("onListingCreated", () => {
  it("creates sell file with listing_id and slug", () => {
    const slug = onListingCreated("Vintage Camera", "lst-1");

    const file = readSellFile(slug);
    expect(file).not.toBeNull();
    expect(file!.listing_id).toBe("lst-1");
    expect(file!.slug).toBe(slug);
  });

  it("returns the generated slug", () => {
    const slug = onListingCreated("Vintage Camera", "lst-1");

    expect(slug).toBe("vintage-camera-lst-1");
  });

  it("sets default pricing fields to null", () => {
    const slug = onListingCreated("Test Item", "lst-2");

    const file = readSellFile(slug);
    expect(file!.min_acceptable_price).toBeNull();
    expect(file!.auto_reject_below).toBeNull();
  });

  it("sets default check_every to 2h", () => {
    const slug = onListingCreated("Test Item", "lst-3");

    const file = readSellFile(slug);
    expect(file!.check_every).toBe("2h");
  });

  it("accepts custom check_every", () => {
    const slug = onListingCreated("Test Item", "lst-4", "30m");

    const file = readSellFile(slug);
    expect(file!.check_every).toBe("30m");
  });
});

describe("onListingUpdated", () => {
  it("re-derives min_acceptable_price from asking_price when present", () => {
    const slug = onListingCreated("My Widget", "lst-10");

    onListingUpdated("lst-10", { asking_price: 12000 });

    const file = readSellFile(slug);
    expect(file!.min_acceptable_price).toBe(12000);
  });

  it("preserves min_acceptable_price when asking_price is omitted", () => {
    const slug = onListingCreated("My Widget", "lst-11");
    writeSellFile(slug, {
      listing_id: "lst-11",
      min_acceptable_price: 5000,
      auto_reject_below: 3000,
      transaction_id: null,
      check_every: "1h",
      body: "Important negotiation notes here.",
    });

    onListingUpdated("lst-11", { auto_reject_below: 4000 });

    const file = readSellFile(slug);
    expect(file!.min_acceptable_price).toBe(5000); // preserved
    expect(file!.auto_reject_below).toBe(4000); // updated
  });

  it("re-derives min_acceptable_price when asking_price equals current value", () => {
    // Defensive: even a no-op asking_price change overwrites the
    // floor. This documents current behavior — callers that want to
    // preserve a manually-set floor must omit asking_price entirely.
    const slug = onListingCreated("My Widget", "lst-12");
    writeSellFile(slug, {
      listing_id: "lst-12",
      min_acceptable_price: 8000,
      auto_reject_below: null,
      transaction_id: null,
      check_every: "2h",
      body: "",
    });

    onListingUpdated("lst-12", { asking_price: 8000 });

    const file = readSellFile(slug);
    expect(file!.min_acceptable_price).toBe(8000);
  });

  it("mirrors auto_reject_below and check_every when provided", () => {
    const slug = onListingCreated("My Widget", "lst-13");

    onListingUpdated("lst-13", {
      asking_price: 15000,
      auto_reject_below: 10000,
      check_every: "30m",
    });

    const file = readSellFile(slug);
    expect(file!.min_acceptable_price).toBe(15000);
    expect(file!.auto_reject_below).toBe(10000);
    expect(file!.check_every).toBe("30m");
  });

  it("preserves body and transaction_id across updates", () => {
    const slug = onListingCreated("My Widget", "lst-14");
    writeSellFile(slug, {
      listing_id: "lst-14",
      min_acceptable_price: 5000,
      auto_reject_below: 3000,
      transaction_id: "tx-abc",
      check_every: "1h",
      body: "Important negotiation notes here.",
    });

    onListingUpdated("lst-14", { asking_price: 7000 });

    const file = readSellFile(slug);
    expect(file!.transaction_id).toBe("tx-abc"); // preserved
    expect(file!.body).toBe("Important negotiation notes here."); // preserved
  });

  it("does nothing when no sell file found for listing_id", () => {
    // No file created for lst-999
    onListingUpdated("lst-999", { asking_price: 5000 });

    // Should not throw, no file created
    expect(findSellFileByListingId("lst-999")).toBeNull();
  });
});

describe("onListingWithdrawn", () => {
  it("deletes sell file", () => {
    const slug = onListingCreated("Old Listing", "lst-20");
    expect(readSellFile(slug)).not.toBeNull();

    onListingWithdrawn("lst-20");

    expect(readSellFile(slug)).toBeNull();
  });

  it("clears timer for the listing", () => {
    const slug = onListingCreated("Old Listing", "lst-20");

    onListingWithdrawn("lst-20");

    expect(clearItemTimer).toHaveBeenCalledWith(slug);
  });

  it("does nothing when no sell file found", () => {
    onListingWithdrawn("lst-nonexistent");

    expect(clearItemTimer).not.toHaveBeenCalled();
  });
});

describe("onListingRelisted", () => {
  it("returns existing slug when sell file exists", () => {
    const originalSlug = onListingCreated("My Item", "lst-30");

    const slug = onListingRelisted("lst-30", "My Item Relisted");

    // Should return the existing slug, NOT create a new one based on the new title
    expect(slug).toBe(originalSlug);
  });

  it("creates new sell file when none exists", () => {
    const slug = onListingRelisted("lst-31", "Brand New Listing");

    expect(slug).toBe("brand-new-listing-lst-31");
    const file = readSellFile(slug);
    expect(file).not.toBeNull();
    expect(file!.listing_id).toBe("lst-31");
  });
});

describe("onOfferAccepted", () => {
  it("does NOT delete sell file, records transaction_id", () => {
    const slug = onListingCreated("Active Item", "lst-40");

    onOfferAccepted("lst-40", "tx-40");

    // Sell file must remain -- needed until transaction completes
    const file = readSellFile(slug);
    expect(file).not.toBeNull();
    expect(file!.listing_id).toBe("lst-40");
    expect(file!.transaction_id).toBe("tx-40");
  });

  it("does not clear timer", () => {
    onListingCreated("Active Item", "lst-41");

    onOfferAccepted("lst-41", "tx-41");

    expect(clearItemTimer).not.toHaveBeenCalled();
  });
});

describe("onTransactionTerminal", () => {
  it("deletes sell file and clears timer", () => {
    const slug = onListingCreated("Sold Item", "lst-50");

    onTransactionTerminal("lst-50");

    expect(readSellFile(slug)).toBeNull();
    expect(clearItemTimer).toHaveBeenCalledWith(slug);
  });

  it("does nothing when no sell file found", () => {
    onTransactionTerminal("lst-nonexistent");

    expect(clearItemTimer).not.toHaveBeenCalled();
  });
});

describe("onBuySearchCreated", () => {
  it("writes buy file with all fields", () => {
    onBuySearchCreated("gaming-laptop", {
      query: "gaming laptop RTX 4090",
      max_price: 200000,
      target_price: 150000,
      delivery_method: "shipping",
      pickup_radius: null,
      ships_to: null,
      action_on_match: "notify",
      check_every: "4h",
      last_checked: null,
      body: "Must have 32GB RAM.",
    });

    const file = readBuyFile("gaming-laptop");
    expect(file).not.toBeNull();
    expect(file!.query).toBe("gaming laptop RTX 4090");
    expect(file!.max_price).toBe(200000);
    expect(file!.target_price).toBe(150000);
    expect(file!.delivery_method).toBe("shipping");
    expect(file!.pickup_radius).toBeNull();
    expect(file!.ships_to).toBeNull();
    expect(file!.action_on_match).toBe("notify");
    expect(file!.check_every).toBe("4h");
    expect(file!.last_checked).toBeNull();
    expect(file!.body).toBe("Must have 32GB RAM.");
  });
});

describe("onBuySearchRemoved", () => {
  it("deletes buy file and clears timer", () => {
    onBuySearchCreated("old-search", {
      query: "headphones",
      max_price: null,
      target_price: null,
      delivery_method: "any",
      pickup_radius: null,
      ships_to: null,
      action_on_match: "notify",
      check_every: "4h",
      last_checked: null,
      body: "",
    });
    expect(readBuyFile("old-search")).not.toBeNull();

    onBuySearchRemoved("old-search");

    expect(readBuyFile("old-search")).toBeNull();
    expect(clearItemTimer).toHaveBeenCalledWith("old-search");
  });
});
