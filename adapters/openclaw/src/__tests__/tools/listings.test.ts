/**
 * Tests for adapters/openclaw/src/tools/listings.ts
 *
 * Covers the catalog pass-throughs plus the local sell-file side
 * effects on create, withdraw, relist. Listing update has no local
 * mirror after D3 — that's locked down in service/state.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerListingTools } from "../../tools/listings.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeFileSync, chmodSync } from "node:fs";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  findSellFileByListingId,
  listSellSlugs,
  writeSellFile,
} from "../../lib/sell-buy-files.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  getClient,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

const LISTING_ID = "550e8400-e29b-41d4-a716-446655440000";

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
  registerListingTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_list_create", () => {
  it("creates a sell file on success and returns sell_file metadata", async () => {
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Vintage Lamp",
      asking_price: 200_00,
    });
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-1", {
      title: "Vintage Lamp",
      description: "1920s art deco",
      category: "home",
      asking_price: 200_00,
      fulfillment: [{ method: "pickup" }],
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.sell_file).toBeDefined();
    expect(data.sell_file.slug).toContain("vintage-lamp");
    expect(data.sell_file.hint).toContain("Never create a separate");
    const slugs = listSellSlugs();
    expect(slugs).toHaveLength(1);
    const sf = findSellFileByListingId(LISTING_ID);
    expect(sf?.listing_id).toBe(LISTING_ID);
    expect(sf?.min_acceptable_price).toBeNull();
  });

  it("does not write a sell file when the server call fails", async () => {
    mockNatsError(
      "p2p.v1.listings.create",
      new KlodiRequestError({ error: "INVALID", message: "invalid" }),
    );
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-1", {
      title: "x", description: "x", category: "home",
      asking_price: 100, fulfillment: [{ method: "pickup" }],
    });
    expect(result.isError).toBe(true);
    expect(listSellSlugs()).toHaveLength(0);
  });

  it("returns the not_registered envelope when credentials are missing", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerListingTools(api);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-1", {
      title: "x", description: "x", category: "home",
      asking_price: 100, fulfillment: [{ method: "pickup" }],
    });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("not_registered");
  });
});

describe("klodi_list_get", () => {
  it("forwards listing_id to p2p.v1.listings.get", async () => {
    mockNatsResponse("p2p.v1.listings.get", { listing_id: LISTING_ID });
    const tool = getTool(api, "klodi_list_get");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBeFalsy();
  });
});

describe("klodi_list_mine", () => {
  it("forwards status when provided", async () => {
    mockNatsResponse("p2p.v1.listings.mine", { listings: [] });
    const tool = getTool(api, "klodi_list_mine");
    const result = await tool.execute("call-1", { status: "active" });
    expect(result.isError).toBeFalsy();
  });

  it("forwards an empty payload when status is omitted", async () => {
    mockNatsResponse("p2p.v1.listings.mine", { listings: [] });
    const tool = getTool(api, "klodi_list_mine");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
  });
});

describe("klodi_list_update", () => {
  it("forwards full payload (incl. category) and does NOT touch the sell file", async () => {
    // Card: make-category-editable-in-plugin-surface-and-docs, acceptance #7.
    // registerUpdate is a pure raw pass-through (ADR-0012): it binds
    // tool.params → parameters and forwards the whole params object via
    // rawRequest. The NEW `category` param must therefore reach the
    // marketplace unaltered, with the adapter neither stripping it nor
    // mutating the local sell file as a side effect. `category` is a valid
    // Category union member here (the schema-level enum guard lives in the
    // tool-catalog tests; this test pins the wire pass-through).
    writeSellFile("vintage-lamp-aaaa11", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "private",
    });
    mockNatsResponse("p2p.v1.listings.update", { listing_id: LISTING_ID });
    const tool = getTool(api, "klodi_list_update");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, asking_price: 250_00, category: "furniture",
    });
    expect(result.isError).toBeFalsy();

    // The forwarded NATS payload (2nd arg to client.request) must carry
    // category verbatim — no strip, no rename, no coercion.
    const requestMock = getClient().request;
    const call = requestMock.mock.calls.find(
      (c) => c[0] === "p2p.v1.listings.update",
    );
    expect(
      call,
      "registerUpdate should have dispatched to p2p.v1.listings.update",
    ).toBeDefined();
    const forwardedPayload = call![1] as Record<string, unknown>;
    expect(
      forwardedPayload.category,
      "category must reach the forwarded marketplace payload unaltered",
    ).toBe("furniture");
    // The rest of the payload still rides along (proves it's a whole-object
    // pass-through, not a cherry-picked allowlist that happened to add category).
    expect(forwardedPayload.listing_id).toBe(LISTING_ID);
    expect(forwardedPayload.asking_price).toBe(250_00);

    const sf = findSellFileByListingId(LISTING_ID);
    // Floor preserved; asking_price never derives the floor. A category edit
    // is a server-side concern — there is nothing category-shaped on disk to
    // mutate, and the floor/body must be left exactly as the user wrote them.
    expect(sf?.min_acceptable_price).toBe(150_00);
    expect(sf?.body).toBe("private");
  });
});

describe("klodi_list_withdraw", () => {
  it("calls listings.update with status=withdrawn and removes the local sell file", async () => {
    writeSellFile("vintage-lamp-bbbb22", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    mockNatsResponse("p2p.v1.listings.update", { listing_id: LISTING_ID });
    const tool = getTool(api, "klodi_list_withdraw");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBeFalsy();
    expect(findSellFileByListingId(LISTING_ID)).toBeNull();
  });

  it("propagates NATS errors and leaves the sell file in place", async () => {
    writeSellFile("vintage-lamp-cccc33", {
      listing_id: LISTING_ID,
      min_acceptable_price: 150_00,
      auto_reject_below: null,
      transaction_id: null,
      body: "",
    });
    mockNatsError(
      "p2p.v1.listings.update",
      new KlodiRequestError({ error: "FORBIDDEN", message: "not yours" }),
    );
    const tool = getTool(api, "klodi_list_withdraw");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBe(true);
    expect(findSellFileByListingId(LISTING_ID)).not.toBeNull();
  });
});

describe("klodi_list_relist", () => {
  it("ensures a sell file exists and attaches sell_file metadata", async () => {
    mockNatsResponse("p2p.v1.listings.update", {
      listing_id: LISTING_ID, title: "Reborn Lamp", status: "active",
    });
    const tool = getTool(api, "klodi_list_relist");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.sell_file.slug).toContain("reborn-lamp");
    expect(findSellFileByListingId(LISTING_ID)).not.toBeNull();
  });

  it("includes asking_price in payload when provided", async () => {
    mockNatsResponse("p2p.v1.listings.update", {
      listing_id: LISTING_ID, title: "Lamp",
    });
    const tool = getTool(api, "klodi_list_relist");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, asking_price: 300_00,
    });
    expect(result.isError).toBeFalsy();
  });
});

describe("klodi_list_comments", () => {
  it("forwards listing_id and pagination cursors", async () => {
    mockNatsResponse("p2p.v1.comments.list", { comments: [] });
    const tool = getTool(api, "klodi_list_comments");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, limit: 10, before: "cmt-99",
    });
    expect(result.isError).toBeFalsy();
  });
});
