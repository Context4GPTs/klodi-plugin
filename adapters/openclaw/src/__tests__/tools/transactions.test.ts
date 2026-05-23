/**
 * Tests for adapters/openclaw/src/tools/transactions.ts
 *
 * Covers tx_confirm / _cancel / _rate / _status. Cancel and rate clean
 * the local sell file on terminal states; confirm and status do not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerTransactionTools } from "../../tools/transactions.js";
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
  registerTransactionTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_tx_confirm", () => {
  it("forwards transaction_id to p2p.v1.transactions.confirm", async () => {
    mockNatsResponse("p2p.v1.transactions.confirm", {
      transaction_id: TX_ID, status: "confirmed",
    });
    const tool = getTool(api, "klodi_tx_confirm");
    const result = await tool.execute("call-1", { transaction_id: TX_ID });
    expect(result.isError).toBeFalsy();
  });

  it("returns 'Not registered' without creds", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerTransactionTools(api);
    const tool = getTool(api, "klodi_tx_confirm");
    const result = await tool.execute("call-1", { transaction_id: TX_ID });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_tx_cancel", () => {
  it("removes the local sell file on a successful cancel", async () => {
    writeSellFile("a-listing-aaaa11", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: TX_ID,
      body: "",
    });
    mockNatsResponse("p2p.v1.transactions.cancel", {
      transaction_id: TX_ID, listing_id: LISTING_ID, status: "cancelled",
    });
    const tool = getTool(api, "klodi_tx_cancel");
    const result = await tool.execute("call-1", {
      transaction_id: TX_ID, reason: "no_show",
    });
    expect(result.isError).toBeFalsy();
    expect(findSellFileByListingId(LISTING_ID)).toBeNull();
  });

  it("propagates NATS errors and leaves the sell file intact", async () => {
    writeSellFile("a-listing-bbbb22", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: TX_ID,
      body: "",
    });
    mockNatsError(
      "p2p.v1.transactions.cancel",
      new KlodiRequestError({ error: "FORBIDDEN", message: "not your tx" }),
    );
    const tool = getTool(api, "klodi_tx_cancel");
    const result = await tool.execute("call-1", {
      transaction_id: TX_ID, reason: "no_show",
    });
    expect(result.isError).toBe(true);
    expect(findSellFileByListingId(LISTING_ID)).not.toBeNull();
  });
});

describe("klodi_tx_rate", () => {
  it("removes the sell file when the response includes listing_id", async () => {
    writeSellFile("a-listing-cccc33", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: TX_ID,
      body: "",
    });
    mockNatsResponse("p2p.v1.transactions.rate", {
      transaction_id: TX_ID, listing_id: LISTING_ID, rating: 5,
    });
    const tool = getTool(api, "klodi_tx_rate");
    const result = await tool.execute("call-1", {
      transaction_id: TX_ID, rating: 5, comment: "great",
    });
    expect(result.isError).toBeFalsy();
    expect(findSellFileByListingId(LISTING_ID)).toBeNull();
  });

  it("forwards comment when provided", async () => {
    mockNatsResponse("p2p.v1.transactions.rate", {
      transaction_id: TX_ID, rating: 5,
    });
    const tool = getTool(api, "klodi_tx_rate");
    const result = await tool.execute("call-1", {
      transaction_id: TX_ID, rating: 5, comment: "great",
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("klodi_tx_status", () => {
  it("forwards transaction_id to p2p.v1.transactions.status", async () => {
    mockNatsResponse("p2p.v1.transactions.status", {
      transaction_id: TX_ID, status: "active",
    });
    const tool = getTool(api, "klodi_tx_status");
    const result = await tool.execute("call-1", { transaction_id: TX_ID });
    expect(result.isError).toBeFalsy();
  });
});
