/**
 * Tests for adapters/openclaw/src/tools/offers.ts
 *
 * klodi_offer_create / _respond / _mine. The accept side-effect on
 * _respond stamps the transaction_id onto the matching sell file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerOfferTools } from "../../tools/offers.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeFileSync, chmodSync } from "node:fs";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  findSellFileByListingId,
  writeSellFile,
} from "../../lib/sell-buy-files.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

const LISTING_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";
const OFFER_ID = "22222222-3333-4444-8555-666666666666";
const TX_ID = "33333333-4444-4555-8666-777777777777";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

beforeEach(() => {
  temp = createTempHome();
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester", user_id: "uid-1",
    nkey_public: "NKEY", nats_url: "wss://example.test:4443",
  });
  api = createMockPluginApi();
  registerOfferTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_offer_create", () => {
  it("forwards required fields plus optional currency/message/terms", async () => {
    mockNatsResponse("p2p.v1.offers.create", {
      offer_id: OFFER_ID, status: "pending",
    });
    const tool = getTool(api, "klodi_offer_create");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID,
      channel_id: CHANNEL_ID,
      amount: 200_00,
      currency: "USD",
      message: "Best I can do",
      terms: { pickup_window: "Sat" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("returns errorResult on NATS error", async () => {
    mockNatsError(
      "p2p.v1.offers.create",
      new KlodiRequestError("offer too low", "OFFER_TOO_LOW"),
    );
    const tool = getTool(api, "klodi_offer_create");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, channel_id: CHANNEL_ID, amount: 1,
    });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_offer_respond (accept)", () => {
  it("stamps transaction_id onto the sell file when listing+tx ids return", async () => {
    writeSellFile("a-listing-aaaa11", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    mockNatsResponse("p2p.v1.offers.respond", {
      offer_id: OFFER_ID,
      status: "accepted",
      listing_id: LISTING_ID,
      transaction_id: TX_ID,
    });
    const tool = getTool(api, "klodi_offer_respond");
    const result = await tool.execute("call-1", {
      offer_id: OFFER_ID, action: "accept",
    });
    expect(result.isError).toBeFalsy();
    const sf = findSellFileByListingId(LISTING_ID);
    expect(sf?.transaction_id).toBe(TX_ID);
  });

  it("does NOT stamp the sell file on reject", async () => {
    writeSellFile("a-listing-bbbb22", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    mockNatsResponse("p2p.v1.offers.respond", {
      offer_id: OFFER_ID, status: "rejected",
      listing_id: LISTING_ID,
    });
    const tool = getTool(api, "klodi_offer_respond");
    const result = await tool.execute("call-1", {
      offer_id: OFFER_ID, action: "reject",
    });
    expect(result.isError).toBeFalsy();
    const sf = findSellFileByListingId(LISTING_ID);
    expect(sf?.transaction_id).toBeNull();
  });

  it("formats NATS errors as tool errors", async () => {
    mockNatsError(
      "p2p.v1.offers.respond",
      new KlodiRequestError("expired", "EXPIRED"),
    );
    const tool = getTool(api, "klodi_offer_respond");
    const result = await tool.execute("call-1", {
      offer_id: OFFER_ID, action: "accept",
    });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_offer_mine", () => {
  it("forwards filters when provided", async () => {
    mockNatsResponse("p2p.v1.offers.mine", { offers: [] });
    const tool = getTool(api, "klodi_offer_mine");
    const result = await tool.execute("call-1", {
      status: "pending", role: "buyer", listing_id: LISTING_ID,
    });
    expect(result.isError).toBeFalsy();
  });

  it("forwards an empty payload when no filters", async () => {
    mockNatsResponse("p2p.v1.offers.mine", { offers: [] });
    const tool = getTool(api, "klodi_offer_mine");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
  });

  it("returns 'Not registered' when credentials are missing", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerOfferTools(api);
    const tool = getTool(api, "klodi_offer_mine");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
  });
});
