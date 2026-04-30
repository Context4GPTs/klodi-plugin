/**
 * Tests for adapters/openclaw/src/lib/sell-buy-files.ts
 *
 * Covers the on-disk policy file readers/writers for sell/<slug>.md
 * and buy/<slug>.md, plus the slugify + listing-id index helpers.
 *
 * Buy file shape changed in 0012: dropped check_every / last_checked /
 * seen_listings / pickup_radius / ships_to; added `delivery: DeliveryFilter`
 * and `action_on_match`. Tests cover only the new shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readSellFile,
  writeSellFile,
  deleteSellFile,
  readBuyFile,
  writeBuyFile,
  deleteBuyFile,
  findSellFileByListingId,
  listSellSlugs,
  listBuySlugs,
  slugify,
} from "../../lib/sell-buy-files.js";
import { getBuyDir, getSellDir } from "../../lib/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
});

describe("writeSellFile + readSellFile", () => {
  it("round-trips full sell file content", () => {
    writeSellFile("vintage-lamp-aaa111", {
      listing_id: "lst-aaa111",
      min_acceptable_price: 150_00,
      auto_reject_below: 100_00,
      transaction_id: null,
      body: "Will accept pickup only in SF.",
    });
    const sf = readSellFile("vintage-lamp-aaa111");
    expect(sf).not.toBeNull();
    expect(sf?.listing_id).toBe("lst-aaa111");
    expect(sf?.min_acceptable_price).toBe(150_00);
    expect(sf?.auto_reject_below).toBe(100_00);
    expect(sf?.transaction_id).toBeNull();
    expect(sf?.body).toBe("Will accept pickup only in SF.");
  });

  it("serializes nulls literally so floor secrecy survives an agent round-trip", () => {
    writeSellFile("nullable-bbb222", {
      listing_id: "lst-bbb222",
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    const raw = readFileSync(
      join(getSellDir(), "nullable-bbb222.md"),
      "utf-8",
    );
    expect(raw).toMatch(/min_acceptable_price: null/);
    expect(raw).toMatch(/auto_reject_below: null/);
    expect(raw).toMatch(/transaction_id: null/);
  });

  it("returns null when the slug does not exist", () => {
    expect(readSellFile("nope")).toBeNull();
  });

  it("preserves frontmatter ordering across round-trips", () => {
    writeSellFile("ordered-ccc333", {
      listing_id: "lst-ccc333",
      min_acceptable_price: 200_00,
      auto_reject_below: 150_00,
      transaction_id: "tx-1",
      body: "Some body",
    });
    const after = readSellFile("ordered-ccc333");
    expect(after?.listing_id).toBe("lst-ccc333");
    expect(after?.min_acceptable_price).toBe(200_00);
    expect(after?.auto_reject_below).toBe(150_00);
    expect(after?.transaction_id).toBe("tx-1");
  });

  it("creates the sell directory on first write", () => {
    writeSellFile("first-ddd444", {
      listing_id: "lst-ddd444",
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    expect(existsSync(join(getSellDir(), "first-ddd444.md"))).toBe(true);
  });
});

describe("deleteSellFile", () => {
  it("returns true and removes the file", () => {
    writeSellFile("doomed-eee555", {
      listing_id: "lst-eee555",
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    expect(deleteSellFile("doomed-eee555")).toBe(true);
    expect(readSellFile("doomed-eee555")).toBeNull();
  });

  it("returns false when the file does not exist", () => {
    expect(deleteSellFile("missing")).toBe(false);
  });
});

describe("findSellFileByListingId", () => {
  it("finds a sell file via the in-memory index after writeSellFile", () => {
    writeSellFile("alpha-fff666", {
      listing_id: "lst-fff666",
      min_acceptable_price: 100_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    const found = findSellFileByListingId("lst-fff666");
    expect(found?.slug).toBe("alpha-fff666");
    expect(found?.min_acceptable_price).toBe(100_00);
  });

  it("falls back to a directory scan when the index is cold", () => {
    // Write the file directly, bypassing writeSellFile's index update.
    const fmContent = [
      "---",
      "listing_id: lst-ggg777",
      "min_acceptable_price: 250",
      "auto_reject_below: null",
      "transaction_id: null",
      "---",
      "",
      "raw body",
    ].join("\n");
    writeFileSync(join(getSellDir(), "raw-ggg777.md"), fmContent + "\n");
    const found = findSellFileByListingId("lst-ggg777");
    expect(found?.slug).toBe("raw-ggg777");
    expect(found?.min_acceptable_price).toBe(250);
  });

  it("returns null when the sell directory is empty", () => {
    expect(findSellFileByListingId("nothing-here")).toBeNull();
  });
});

describe("listSellSlugs", () => {
  it("returns an empty list when the dir is empty", () => {
    expect(listSellSlugs()).toEqual([]);
  });

  it("returns slugs for every .md file in sell/", () => {
    writeSellFile("a-aaaa", {
      listing_id: "1", min_acceptable_price: null,
      auto_reject_below: null, transaction_id: null, body: "",
    });
    writeSellFile("b-bbbb", {
      listing_id: "2", min_acceptable_price: null,
      auto_reject_below: null, transaction_id: null, body: "",
    });
    expect(listSellSlugs().sort()).toEqual(["a-aaaa", "b-bbbb"]);
  });
});

describe("writeBuyFile + readBuyFile", () => {
  it("round-trips the new (0012) buy file shape", () => {
    writeBuyFile("gaming-laptop-hhh888", {
      query: "gaming laptop",
      max_price: 200_000,
      target_price: 150_000,
      delivery: { method: "pickup", radiusKm: 25 },
      action_on_match: "negotiate",
      body: "Prefer mechanical keyboard.",
    });
    const bf = readBuyFile("gaming-laptop-hhh888");
    expect(bf).not.toBeNull();
    expect(bf?.query).toBe("gaming laptop");
    expect(bf?.max_price).toBe(200_000);
    expect(bf?.target_price).toBe(150_000);
    expect(bf?.delivery).toEqual({ method: "pickup", radiusKm: 25 });
    expect(bf?.action_on_match).toBe("negotiate");
    expect(bf?.body).toBe("Prefer mechanical keyboard.");
  });

  it("defaults action_on_match to 'notify' when absent", () => {
    const fmContent = [
      "---",
      "query: vintage lamp",
      "max_price: null",
      "target_price: null",
      "delivery: null",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(getBuyDir(), "lamp-iii999.md"), fmContent + "\n");
    const bf = readBuyFile("lamp-iii999");
    expect(bf?.action_on_match).toBe("notify");
  });

  it("defaults delivery to { method: 'any' } when absent", () => {
    const fmContent = [
      "---",
      "query: vintage lamp",
      "max_price: null",
      "target_price: null",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(getBuyDir(), "lamp-jjj000.md"), fmContent + "\n");
    const bf = readBuyFile("lamp-jjj000");
    expect(bf?.delivery).toEqual({ method: "any" });
  });

  it("rejects an unknown action_on_match value with a clear error", () => {
    const fmContent = [
      "---",
      "query: bad",
      "max_price: null",
      "target_price: null",
      "delivery: null",
      "action_on_match: bogus",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(getBuyDir(), "bad-action-kkk111.md"), fmContent + "\n");
    expect(() => readBuyFile("bad-action-kkk111")).toThrow(
      /action_on_match/,
    );
  });

  it("rejects an invalid delivery JSON with a clear error", () => {
    const fmContent = [
      "---",
      "query: bad",
      "max_price: null",
      "target_price: null",
      "delivery: \"not-json{{{\"",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(getBuyDir(), "bad-delivery-lll222.md"), fmContent + "\n");
    expect(() => readBuyFile("bad-delivery-lll222")).toThrow(/delivery/);
  });

  it("returns null when the slug does not exist", () => {
    expect(readBuyFile("nope")).toBeNull();
  });

  it("creates the buy directory on first write", () => {
    writeBuyFile("first-mmm333", {
      query: "x", max_price: null, target_price: null,
      delivery: { method: "any" }, action_on_match: "notify", body: "",
    });
    expect(existsSync(join(getBuyDir(), "first-mmm333.md"))).toBe(true);
  });
});

describe("deleteBuyFile", () => {
  it("returns true and removes the file", () => {
    writeBuyFile("bye-nnn444", {
      query: "x", max_price: null, target_price: null,
      delivery: { method: "any" }, action_on_match: "notify", body: "",
    });
    expect(deleteBuyFile("bye-nnn444")).toBe(true);
    expect(readBuyFile("bye-nnn444")).toBeNull();
  });

  it("returns false when the file does not exist", () => {
    expect(deleteBuyFile("missing")).toBe(false);
  });
});

describe("listBuySlugs", () => {
  it("returns an empty list when the dir is empty", () => {
    expect(listBuySlugs()).toEqual([]);
  });

  it("returns slugs for every .md file in buy/", () => {
    writeBuyFile("alpha-pppp", {
      query: "x", max_price: null, target_price: null,
      delivery: { method: "any" }, action_on_match: "notify", body: "",
    });
    writeBuyFile("beta-qqqq", {
      query: "y", max_price: null, target_price: null,
      delivery: { method: "any" }, action_on_match: "notify", body: "",
    });
    expect(listBuySlugs().sort()).toEqual(["alpha-pppp", "beta-qqqq"]);
  });
});

describe("slugify", () => {
  it("lowercases, dedupes punctuation, and appends a 6-char listing suffix", () => {
    const slug = slugify("Vintage Lamp!! 1920", "abc123-deadbeef");
    expect(slug).toBe("vintage-lamp-1920-abc123");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("---hello---", "ffffff")).toBe("hello-ffffff");
  });

  it("caps the title portion at 53 characters", () => {
    const longTitle = "a".repeat(80);
    const slug = slugify(longTitle, "abcdef");
    // 53 a's then "-abcdef"
    expect(slug.length).toBe(53 + 1 + 6);
    expect(slug.endsWith("-abcdef")).toBe(true);
  });

  it("collapses consecutive non-alphanumerics", () => {
    expect(slugify("Hello!!!  World???", "zzzzzz")).toBe(
      "hello-world-zzzzzz",
    );
  });
});
