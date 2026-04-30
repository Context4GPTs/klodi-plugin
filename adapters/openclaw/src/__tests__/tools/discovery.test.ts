/**
 * Tests for adapters/openclaw/src/tools/discovery.ts
 * Tools: klodi_search, klodi_watch, klodi_unwatch, klodi_searches_list,
 *        klodi_comment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerDiscoveryTools } from "../../tools/discovery.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeConfig } from "../../lib/config.js";
import { writeFileSync } from "node:fs";
import { getCredsPath } from "../../lib/paths.js";
import { listBuySlugs, readBuyFile } from "../../lib/sell-buy-files.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

const LISTING_ID = "550e8400-e29b-41d4-a716-446655440000";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

beforeEach(() => {
  temp = createTempHome();
  // Seed credentials so requireCreds() passes.
  writeFileSync(getCredsPath(), "creds-bytes");
  writeConfig({
    handle: "tester",
    user_id: "uid-1",
    nkey_public: "NKEY",
    nats_url: "nats://localhost:4222",
  });
  api = createMockPluginApi();
  registerDiscoveryTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_search", () => {
  it("forwards filters to p2p.v1.listings.search", async () => {
    mockNatsResponse("p2p.v1.listings.search", { results: [], total: 0 });
    const tool = getTool(api, "klodi_search");
    const result = await tool.execute("call-1", {
      query: "laptop",
      max_price: 200_000,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data).toEqual({ results: [], total: 0 });
  });

  it("returns errorResult on NATS error", async () => {
    mockNatsError(
      "p2p.v1.listings.search",
      new KlodiRequestError("Bad query", "INVALID"),
    );
    const tool = getTool(api, "klodi_search");
    const result = await tool.execute("call-1", { query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INVALID: Bad query");
  });

  it("returns 'Not registered' when credentials are missing", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerDiscoveryTools(api);
    const tool = getTool(api, "klodi_search");
    const result = await tool.execute("call-1", { query: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not registered");
  });
});

describe("klodi_watch (one-shot)", () => {
  it("dispatches to klodi_search subject when persist is not set", async () => {
    mockNatsResponse("p2p.v1.listings.search", { results: [{}], total: 1 });
    const tool = getTool(api, "klodi_watch");
    const result = await tool.execute("call-1", { query: "vintage" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data).not.toHaveProperty("buy_file");
    expect(data.total).toBe(1);
  });
});

describe("klodi_watch (persistent)", () => {
  it("creates a buy file with the requested action_on_match", async () => {
    mockNatsResponse("p2p.v1.searches.create", {
      search_id: "srch-1",
      slug: "ignored-from-server",
      status: "active",
      criteria: {
        query: "gaming laptop",
        category: null,
        delivery: { method: "any" },
        min_price: null,
        max_price: 250_000,
      },
    });
    const tool = getTool(api, "klodi_watch");
    const result = await tool.execute("call-1", {
      query: "gaming laptop",
      max_price: 250_000,
      target_price: 200_000,
      persist: true,
      action_on_match: "negotiate",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.buy_file).toMatchObject({
      slug: expect.stringContaining("gaming-laptop"),
      hint: expect.stringContaining("Never create a separate"),
    });
    const slugs = listBuySlugs();
    expect(slugs).toHaveLength(1);
    const buyFile = readBuyFile(slugs[0]!);
    expect(buyFile?.query).toBe("gaming laptop");
    expect(buyFile?.max_price).toBe(250_000);
    expect(buyFile?.target_price).toBe(200_000);
    expect(buyFile?.action_on_match).toBe("negotiate");
  });

  it("defaults action_on_match to 'notify' when omitted", async () => {
    mockNatsResponse("p2p.v1.searches.create", {
      search_id: "srch-2",
      slug: "x", status: "active",
      criteria: {
        query: "watch", category: null,
        delivery: { method: "any" }, min_price: null, max_price: null,
      },
    });
    const tool = getTool(api, "klodi_watch");
    await tool.execute("call-1", { query: "watch", persist: true });
    const slugs = listBuySlugs();
    const bf = readBuyFile(slugs[0]!);
    expect(bf?.action_on_match).toBe("notify");
  });

  it("does not write a buy file when the server call fails", async () => {
    mockNatsError(
      "p2p.v1.searches.create",
      new KlodiRequestError("Already exists", "ALREADY_EXISTS"),
    );
    const tool = getTool(api, "klodi_watch");
    const result = await tool.execute("call-1", {
      query: "watch", persist: true,
    });
    expect(result.isError).toBe(true);
    expect(listBuySlugs()).toHaveLength(0);
  });
});

describe("klodi_unwatch", () => {
  it("calls searches.delete and removes the buy file", async () => {
    mockNatsResponse("p2p.v1.searches.create", {
      search_id: "srch-3", slug: "x", status: "active",
      criteria: {
        query: "to-remove", category: null,
        delivery: { method: "any" }, min_price: null, max_price: null,
      },
    });
    const watchTool = getTool(api, "klodi_watch");
    await watchTool.execute("call-1", { query: "to-remove", persist: true });
    const [slug] = listBuySlugs();
    expect(slug).toBeTruthy();

    mockNatsResponse("p2p.v1.searches.delete", {
      slug, status: "deleted", deleted: 1,
    });
    const unwatchTool = getTool(api, "klodi_unwatch");
    const result = await unwatchTool.execute("call-1", { buy_slug: slug });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.removed).toBe(true);
    expect(data.slug).toBe(slug);
    expect(listBuySlugs()).toHaveLength(0);
  });

  it("returns errorResult when the server delete fails", async () => {
    mockNatsError(
      "p2p.v1.searches.delete",
      new KlodiRequestError("not found", "NOT_FOUND"),
    );
    const tool = getTool(api, "klodi_unwatch");
    const result = await tool.execute("call-1", { buy_slug: "missing" });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_searches_list", () => {
  it("forwards an empty payload to p2p.v1.searches.list", async () => {
    mockNatsResponse("p2p.v1.searches.list", { searches: [] });
    const tool = getTool(api, "klodi_searches_list");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text!)).toEqual({ searches: [] });
  });
});

describe("klodi_comment", () => {
  it("forwards listing_id and body to p2p.v1.comments.create", async () => {
    mockNatsResponse("p2p.v1.comments.create", {
      comment_id: "cmt-1",
      listing_id: LISTING_ID,
      handle: "tester",
      body: "Nice item",
      mentions: [],
      created_at: "2026-04-30T00:00:00Z",
    });
    const tool = getTool(api, "klodi_comment");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, body: "Nice item",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.comment_id).toBe("cmt-1");
  });

  it("returns errorResult on NATS error", async () => {
    mockNatsError(
      "p2p.v1.comments.create",
      new KlodiRequestError("rate limited", "RATE_LIMIT"),
    );
    const tool = getTool(api, "klodi_comment");
    const result = await tool.execute("call-1", {
      listing_id: LISTING_ID, body: "Hi",
    });
    expect(result.isError).toBe(true);
  });
});
