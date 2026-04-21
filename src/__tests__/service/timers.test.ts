/**
 * Timer subsystem tests.
 * Uses vi.useFakeTimers() to control setInterval/clearInterval.
 * NATS and config are mocked (boundaries).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockPluginApi,
  type MockPluginAPI,
} from "../helpers/mock-plugin-api.js";

// ── Boundary mocks ─────────────────────────────────────────────────────────

vi.mock("../../lib/nats-client.js", () => ({
  request: vi.fn().mockResolvedValue({ offers: [] }),
}));

vi.mock("../../lib/config.js", () => ({
  listSellSlugs: vi.fn(() => []),
  listBuySlugs: vi.fn(() => []),
  readSellFile: vi.fn(),
  readBuyFile: vi.fn(),
  writeBuyFile: vi.fn(),
  findSellFileByListingId: vi.fn(),
  hasCredentials: vi.fn(() => true),
  loadConfig: vi.fn(() => ({
    handle: "test",
    user_id: "uid",
    nkey_public: "nk",
    nats_url: "nats://localhost",
  })),
  setKlodiHome: vi.fn(),
  getNegotiationStylePath: vi.fn(
    () => "/test/policies/negotiation_style.md",
  ),
  getSellFilePath: vi.fn(
    (slug: string) => `/test/sell/${slug}.md`,
  ),
  getBuyFilePath: vi.fn(
    (slug: string) => `/test/buy/${slug}.md`,
  ),
}));

vi.mock("../../service/notifications.js", () => ({
  formatCents: vi.fn((cents: number) => `$${(cents / 100).toFixed(2)}`),
  handleNotification: vi.fn(),
  initNotifications: vi.fn(),
}));

import {
  initTimers,
  createSellTimer,
  createBuyTimer,
  clearItemTimer,
  clearAllTimers,
  reconcileTimers,
} from "../../service/timers.js";
import { request } from "../../lib/nats-client.js";
import {
  listSellSlugs,
  listBuySlugs,
  readSellFile,
  readBuyFile,
  writeBuyFile,
} from "../../lib/config.js";

const mockRequest = vi.mocked(request);
const mockListSellSlugs = vi.mocked(listSellSlugs);
const mockListBuySlugs = vi.mocked(listBuySlugs);
const mockReadSellFile = vi.mocked(readSellFile);
const mockReadBuyFile = vi.mocked(readBuyFile);

// ── Setup ──────────────────────────────────────────────────────────────────

let api: MockPluginAPI;
// Each test gets a distinct base time to invalidate the offers cache (30s TTL).
// Without this, consecutive tests share cached data because fake timer bases
// are only milliseconds apart.
let testEpoch = 1_000_000_000_000;

beforeEach(() => {
  testEpoch += 120_000; // 2 minutes apart -- well past 30s cache TTL
  vi.useFakeTimers({ now: testEpoch });
  vi.resetAllMocks();
  // Restore defaults after reset clears all implementations
  mockRequest.mockResolvedValue({ offers: [] });
  api = createMockPluginApi();
  initTimers(api);
});

afterEach(() => {
  clearAllTimers();
  vi.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("parseInterval (tested indirectly via createSellTimer)", () => {
  it("parses '2h' to 7200000ms", () => {
    createSellTimer("test-2h", "2h");

    expect(vi.getTimerCount()).toBe(1);
    // Advance just under 2h -- callback should not fire
    vi.advanceTimersByTime(7199999);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("parses '30m' to 1800000ms", () => {
    mockReadSellFile.mockReturnValue(null); // will clear timer on callback
    createSellTimer("test-30m", "30m");

    vi.advanceTimersByTime(1799999);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("parses '1d' to 86400000ms", () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-1d", "1d");

    vi.advanceTimersByTime(86399999);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("defaults to 2h on invalid input", () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-invalid", "garbage");

    // Should default to 2h = 7200000ms
    vi.advanceTimersByTime(7199999);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("parseInterval — duration edges", () => {
  // Every test below pairs two assertions:
  //   1. "must not fire 1ms before interval" — catches an off-by-one
  //      that makes the timer fire early.
  //   2. "must fire and self-clear at interval" — catches a regression
  //      where parseInterval returns a value LARGER than expected
  //      (e.g. "1h" silently defaulting to 2h). The self-clear check
  //      uses `mockReadSellFile.mockReturnValue(null)` — when the
  //      callback fires, checkSellItem sees no sell file and calls
  //      clearItemTimer, dropping the active timer count to 0.

  it("parses '1h' to exactly 3600000ms (smallest h boundary)", async () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-1h", "1h");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3_599_999);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parses '1m' to exactly 60000ms (smallest m boundary)", async () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-1m", "1m");

    vi.advanceTimersByTime(59_999);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects seconds unit '1s' — regex only accepts m/h/d, falls to 2h default", async () => {
    // The parseInterval regex is ^(\d+)(m|h|d)$ — no seconds support.
    // If someone writes "1s" by mistake, we do NOT want a 1-second
    // busy-loop timer; default to 2h like any other malformed input.
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-1s", "1s");

    // Must NOT fire at 1s (1000ms)
    vi.advanceTimersByTime(1_000);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Must NOT fire just before 2h — this confirms the 2h default
    // was applied, not some other accidental interpretation.
    vi.advanceTimersByTime(7_199_999 - 1_000);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Must fire at exactly 2h
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to exactly 2h (7_200_000ms) on an empty string", async () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-empty", "");

    vi.advanceTimersByTime(7_199_999);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to exactly 2h on a malformed value with missing digit", async () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-no-digit", "h");

    vi.advanceTimersByTime(7_199_999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to exactly 2h on a malformed value with missing unit", async () => {
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-no-unit", "5");

    vi.advanceTimersByTime(7_199_999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to exactly 2h on whitespace padding (regex is strict)", async () => {
    // Regex is anchored: "^(\d+)(m|h|d)$". Surrounding whitespace
    // breaks the match. This documents the current contract.
    mockReadSellFile.mockReturnValue(null);
    createSellTimer("test-whitespace", " 2h ");

    vi.advanceTimersByTime(7_199_999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createSellTimer", () => {
  it("creates an interval timer", () => {
    createSellTimer("my-item", "2h");

    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears existing timer before creating new one", () => {
    createSellTimer("my-item", "2h");
    expect(vi.getTimerCount()).toBe(1);

    createSellTimer("my-item", "1h");
    // Should still be 1 timer, not 2
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("createBuyTimer", () => {
  it("creates an interval timer", () => {
    createBuyTimer("my-search", "4h");

    expect(vi.getTimerCount()).toBe(1);
  });

  it("defaults to 4h interval", () => {
    mockReadBuyFile.mockReturnValue(null);
    createBuyTimer("my-search");

    // 4h = 14400000ms -- callback should not fire before that
    vi.advanceTimersByTime(14399999);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("clearItemTimer", () => {
  it("clears timer and removes from map", () => {
    createSellTimer("item-a", "2h");
    expect(vi.getTimerCount()).toBe(1);

    clearItemTimer("item-a");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears sell: prefix timer for a given slug", () => {
    createSellTimer("sold-thing", "2h");
    expect(vi.getTimerCount()).toBe(1);

    clearItemTimer("sold-thing");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears buy: prefix timer for a given slug", () => {
    createBuyTimer("wanted-thing", "4h");
    expect(vi.getTimerCount()).toBe(1);

    clearItemTimer("wanted-thing");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("createBuyTimer clears existing sell timer for the same slug", () => {
    // clearItemTimer inside createBuyTimer checks both prefixes
    createSellTimer("shared-slug", "2h");
    expect(vi.getTimerCount()).toBe(1);

    createBuyTimer("shared-slug", "4h");
    // sell timer was cleared by createBuyTimer's internal clearItemTimer call
    // only the buy timer remains
    expect(vi.getTimerCount()).toBe(1);
  });

  it("is idempotent -- no error on missing timer", () => {
    expect(() => clearItemTimer("nonexistent")).not.toThrow();
  });
});

describe("clearAllTimers", () => {
  it("clears all active timers", () => {
    createSellTimer("item-1", "2h");
    createSellTimer("item-2", "1h");
    createBuyTimer("search-1", "4h");
    expect(vi.getTimerCount()).toBe(3);

    clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reconcileTimers", () => {
  it("creates timers for sell files without active timers", () => {
    mockListSellSlugs.mockReturnValue(["item-a", "item-b"]);
    mockReadSellFile.mockImplementation((slug: string) => ({
      listing_id: `lst-${slug}`,
      slug,
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      check_every: "2h",
      body: "",
    }));
    mockListBuySlugs.mockReturnValue([]);

    reconcileTimers();

    expect(vi.getTimerCount()).toBe(2);
  });

  it("creates timers for buy files without active timers", () => {
    mockListSellSlugs.mockReturnValue([]);
    mockListBuySlugs.mockReturnValue(["search-x"]);
    mockReadBuyFile.mockReturnValue({
      query: "laptop",
      slug: "search-x",
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

    reconcileTimers();

    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips items that already have active timers", () => {
    createSellTimer("item-a", "2h");
    expect(vi.getTimerCount()).toBe(1);

    mockListSellSlugs.mockReturnValue(["item-a"]);
    mockListBuySlugs.mockReturnValue([]);

    reconcileTimers();

    // Should still be 1, not 2
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("checkSellItem (via timer fire)", () => {
  it("auto-rejects pending offers below floor", async () => {
    mockReadSellFile.mockReturnValue({
      listing_id: "lst-sell-1",
      slug: "sell-timer-item",
      min_acceptable_price: null,
      auto_reject_below: 10000,
      transaction_id: null,
      check_every: "2h",
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      offers: [
        { offer_id: "off-low", listing_id: "lst-sell-1", amount: 5000, buyer_handle: "cheapo", status: "proposed" },
      ],
    });

    createSellTimer("sell-timer-item", "2h");
    await vi.advanceTimersByTimeAsync(7200000);

    expect(mockRequest).toHaveBeenCalledWith("p2p.v1.offers.mine", {
      role: "seller",
      status: "proposed",
    });
    expect(mockRequest).toHaveBeenCalledWith("p2p.v1.offers.respond", {
      offer_id: "off-low",
      action: "reject",
    });
  });

  it("wakes agent for viable offers (above floor)", async () => {
    mockReadSellFile.mockReturnValue({
      listing_id: "lst-sell-2",
      slug: "viable-item",
      min_acceptable_price: null,
      auto_reject_below: 5000,
      transaction_id: null,
      check_every: "2h",
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      offers: [
        { offer_id: "off-good", listing_id: "lst-sell-2", amount: 15000, buyer_handle: "bigspender", status: "proposed" },
      ],
    });

    createSellTimer("viable-item", "2h");
    await vi.advanceTimersByTimeAsync(7200000);

    // wakeAgent shape: enqueueSystemEvent(text, { sessionKey }),
    // requestHeartbeatNow({ reason: "hook:klodi:<reason>", sessionKey }).
    // Mock config is empty so sessionKey resolves to "agent:main:main".
    // The "hook:klodi:" prefix routes the reason through OpenClaw's
    // classifier as kind="hook" — without it the heartbeat no-ops and
    // the queued event stalls until the next heartbeat.every tick.
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.any(String),
      { sessionKey: "agent:main:main" },
    );
    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith(
      {
        reason: "hook:klodi:klodi-pending-offer",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("clears timer when sell file is gone", async () => {
    mockReadSellFile.mockReturnValue(null);

    createSellTimer("deleted-item", "2h");
    const countBefore = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(7200000);

    // Timer should self-clear via clearItemTimer when file not found
    expect(vi.getTimerCount()).toBeLessThan(countBefore);
  });

  it("only processes offers matching the sell file listing_id", async () => {
    mockReadSellFile.mockReturnValue({
      listing_id: "lst-target",
      slug: "target-item",
      min_acceptable_price: null,
      auto_reject_below: 5000,
      transaction_id: null,
      check_every: "2h",
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      offers: [
        { offer_id: "off-match", listing_id: "lst-target", amount: 3000, buyer_handle: "buyer1", status: "proposed" },
        { offer_id: "off-other", listing_id: "lst-different", amount: 2000, buyer_handle: "buyer2", status: "proposed" },
      ],
    });

    createSellTimer("target-item", "2h");
    await vi.advanceTimersByTimeAsync(7200000);

    // Only the matching offer should be auto-rejected
    expect(mockRequest).toHaveBeenCalledWith("p2p.v1.offers.respond", {
      offer_id: "off-match",
      action: "reject",
    });
    // The non-matching offer should NOT be processed
    expect(mockRequest).not.toHaveBeenCalledWith("p2p.v1.offers.respond", {
      offer_id: "off-other",
      action: "reject",
    });
  });

  it("ignores offers for different listing_ids entirely", async () => {
    mockReadSellFile.mockReturnValue({
      listing_id: "lst-mine",
      slug: "my-item",
      min_acceptable_price: null,
      auto_reject_below: null,
      transaction_id: null,
      check_every: "2h",
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      offers: [
        { offer_id: "off-foreign", listing_id: "lst-someone-else", amount: 99999, buyer_handle: "stranger", status: "proposed" },
      ],
    });

    createSellTimer("my-item", "2h");
    await vi.advanceTimersByTimeAsync(7200000);

    // No offer processing -- no reject, no wake
    expect(mockRequest).toHaveBeenCalledTimes(1); // only the offers.mine call
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

describe("checkBuyItem (via timer fire)", () => {
  it("runs watch query with buy file search params", async () => {
    mockReadBuyFile.mockReturnValue({
      query: "gaming laptop",
      slug: "gaming-laptop",
      max_price: 200000,
      target_price: 150000,
      delivery_method: "shipping",
      pickup_radius: null,
      ships_to: null,
      action_on_match: "notify",
      check_every: "4h",
      last_checked: "2026-04-15T00:00:00.000Z",
      body: "",
    });
    mockRequest.mockResolvedValueOnce({ results: [] });

    createBuyTimer("gaming-laptop", "4h");
    await vi.advanceTimersByTimeAsync(14400000);

    expect(mockRequest).toHaveBeenCalledWith(
      "p2p.v1.listings.watch",
      expect.objectContaining({
        query: "gaming laptop",
        max_price: 200000,
        delivery_method: "shipping",
        since: "2026-04-15T00:00:00.000Z",
      }),
    );
  });

  it("wakes agent when matches found", async () => {
    mockReadBuyFile.mockReturnValue({
      query: "keyboard",
      slug: "keyboard",
      max_price: 30000,
      target_price: 20000,
      delivery_method: "any",
      pickup_radius: null,
      ships_to: null,
      action_on_match: "notify",
      check_every: "4h",
      last_checked: null,
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      results: [
        {
          listing_id: "lst-kb-1",
          title: "Mechanical Keyboard",
          asking_price: 25000,
          seller_handle: "keymaker",
        },
      ],
    });

    createBuyTimer("keyboard", "4h");
    await vi.advanceTimersByTimeAsync(14400000);

    // wakeAgent shape: enqueueSystemEvent(text, { sessionKey }).
    // Heartbeat reason carries the "hook:klodi:" prefix per wake.ts
    // invariant #5 so OpenClaw's classifier treats this as a wake
    // trigger (not a generic heartbeat).
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Mechanical Keyboard"),
      { sessionKey: "agent:main:main" },
    );
    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith(
      {
        reason: "hook:klodi:klodi-buy-match",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("uses negotiate-branch wake text when action_on_match is 'negotiate'", async () => {
    mockReadBuyFile.mockReturnValue({
      query: "keyboard",
      slug: "keyboard",
      max_price: 30000,
      target_price: 20000,
      delivery_method: "any",
      pickup_radius: null,
      ships_to: null,
      action_on_match: "negotiate",
      check_every: "4h",
      last_checked: null,
      body: "",
    });
    mockRequest.mockResolvedValueOnce({
      results: [
        {
          listing_id: "lst-kb-1",
          title: "Mechanical Keyboard",
          asking_price: 25000,
          seller_handle: "keymaker",
        },
      ],
    });

    createBuyTimer("keyboard", "4h");
    await vi.advanceTimersByTimeAsync(14400000);

    // wakeAgent shape: text is the FIRST positional arg to
    // enqueueSystemEvent, options ({ sessionKey }) is the second.
    // Cast via unknown: the SDK types still declare the single-arg
    // SystemEvent shape, but the runtime accepts (text, options).
    const call = vi.mocked(api.runtime.system.enqueueSystemEvent)
      .mock.calls[0];
    expect(call).toBeDefined();
    const [text, options] = call as unknown as [
      string,
      { sessionKey: string },
    ];
    expect(text).toContain("klodi_channel_create");
    expect(text).toContain("target_price");
    expect(options).toEqual({ sessionKey: "agent:main:main" });
    // Heartbeat reason carries "hook:klodi:" prefix — see wake.ts
    // invariant #5. The plain "klodi-buy-match" is reserved for the
    // plugin-side wake_enqueued log.
    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith(
      {
        reason: "hook:klodi:klodi-buy-match",
        sessionKey: "agent:main:main",
      },
    );
  });

  it("updates last_checked timestamp after check", async () => {
    mockReadBuyFile.mockReturnValue({
      query: "monitors",
      slug: "monitors",
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
    mockRequest.mockResolvedValueOnce({ results: [] });

    const mockWriteBuyFile = vi.mocked(writeBuyFile);

    createBuyTimer("monitors", "4h");
    await vi.advanceTimersByTimeAsync(14400000);

    expect(mockWriteBuyFile).toHaveBeenCalledWith(
      "monitors",
      expect.objectContaining({
        last_checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });

  it("includes pickup_radius_km and ships_to in NATS payload when set", async () => {
    mockReadBuyFile.mockReturnValue({
      query: "local furniture",
      slug: "local-furniture",
      max_price: 50000,
      target_price: 30000,
      delivery_method: "pickup",
      pickup_radius: 25,
      ships_to: "US",
      action_on_match: "notify",
      check_every: "4h",
      last_checked: null,
      body: "",
    });
    mockRequest.mockResolvedValueOnce({ results: [] });

    createBuyTimer("local-furniture", "4h");
    await vi.advanceTimersByTimeAsync(14400000);

    expect(mockRequest).toHaveBeenCalledWith(
      "p2p.v1.listings.watch",
      expect.objectContaining({
        pickup_radius_km: 25,
        ships_to: "US",
      }),
    );
  });

  it("clears timer when buy file is gone", async () => {
    mockReadBuyFile.mockReturnValue(null);

    createBuyTimer("gone-search", "4h");
    const countBefore = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(14400000);

    expect(vi.getTimerCount()).toBeLessThan(countBefore);
  });
});
