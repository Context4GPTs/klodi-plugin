/**
 * Notification routing tests.
 * The code-vs-LLM boundary: deterministic auto-reject in code,
 * everything else wakes the agent for LLM judgment.
 *
 * wakeAgent signature contract (locked down by src/service/wake.ts):
 *   enqueueSystemEvent(text, { sessionKey })
 *   requestHeartbeatNow({ reason, sessionKey })
 * The default mock config is {}, so the resolved sessionKey is
 * "agent:main:main" (FALLBACK_DEFAULT_AGENT_ID + fallback mainKey).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  createMockPluginApi,
  type MockPluginAPI,
} from "../helpers/mock-plugin-api.js";

const DEFAULT_SESSION_KEY = "agent:main:main";

// ── Boundary mocks ─────────────────────────────────────────────────────────

vi.mock("../../lib/nats-client.js", () => ({
  request: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../lib/config.js", () => ({
  findSellFileByListingId: vi.fn(),
  deleteSellFile: vi.fn(),
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
  getSellDir: vi.fn(() => "/test/sell"),
  getBuyDir: vi.fn(() => "/test/buy"),
}));

import {
  initNotifications,
  handleNotification,
  type MarketplaceEvent,
} from "../../service/notifications.js";
import { request } from "../../lib/nats-client.js";
import { findSellFileByListingId } from "../../lib/config.js";

const mockRequest = vi.mocked(request);
const mockFindSellFile = vi.mocked(findSellFileByListingId);

// ── Helpers ────────────────────────────────────────────────────────────────

let api: MockPluginAPI;

function sellFile(overrides: Record<string, unknown> = {}) {
  return {
    listing_id: "lst-1",
    slug: "test-item",
    min_acceptable_price: null,
    auto_reject_below: null,
    check_every: "2h",
    body: "",
    ...overrides,
  };
}

function event(overrides: Partial<MarketplaceEvent> = {}): MarketplaceEvent {
  return { event: "offer.proposed", ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  api = createMockPluginApi();
  initNotifications(api);
});

describe("handleNotification", () => {
  // ── offer.proposed: deterministic auto-reject ──────────────────────────

  describe("offer.proposed -- deterministic auto-reject", () => {
    it("auto-rejects when amount < auto_reject_below", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(mockRequest).toHaveBeenCalledWith("p2p.v1.offers.respond", {
        offer_id: "off-1",
        action: "reject",
      });
    });

    it("calls p2p.v1.offers.respond with action: reject", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 20000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-2",
          listing_id: "lst-1",
          amount: 15000,
          buyer_handle: "buyer2",
        }),
      );

      // 15000 < 20000 -> auto-reject
      expect(mockRequest).toHaveBeenCalledWith("p2p.v1.offers.respond", {
        offer_id: "off-2",
        action: "reject",
      });
    });

    it("does NOT call enqueueSystemEvent for auto-rejected offers", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
    });

    it("logs auto_rejected with offer_id and amount", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.logger.info).toHaveBeenCalledWith("auto_rejected", {
        offer_id: "off-1",
        amount: 5000,
      });
    });
  });

  // ── offer.proposed: needs LLM judgment ─────────────────────────────────

  describe("offer.proposed -- needs judgment", () => {
    it("wakes agent when amount >= auto_reject_below", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 15000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("wakes agent when amount equals auto_reject_below (boundary)", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 10000,
          buyer_handle: "buyer1",
        }),
      );

      // amount == floor is NOT below floor, so agent is woken
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("wakes agent when auto_reject_below is null", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: null }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 500,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("wakes agent when no sell file found", async () => {
      mockFindSellFile.mockReturnValue(null);

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-unknown",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("does not expose pricing context in notification text", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({
          auto_reject_below: null,
          min_acceptable_price: 12000,
        }) as any,
      );

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 8000,
          buyer_handle: "buyer1",
        }),
      );

      // New SDK shape: enqueueSystemEvent(text, { sessionKey }) — text is
      // the FIRST positional arg, not a property on the options object.
      const text = (
        api.runtime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>
      ).mock.calls[0][0] as string;
      // P1-1: min_acceptable_price must not appear in notification text
      expect(text).not.toContain("$120.00");
      expect(text).not.toContain("min acceptable");
      // Verify the notification still contains the expected offer details
      expect(text).toContain("$80.00");
      expect(text).toContain("@buyer1");
      expect(text).toContain("lst-1");
      expect(text).toContain("klodi_offer_respond");
    });

    it(
      "calls enqueueSystemEvent with (text, { sessionKey }) — the SDK " +
        "throws 'system events require a sessionKey' otherwise",
      async () => {
        mockFindSellFile.mockReturnValue(null);

        await handleNotification(
          event({
            offer_id: "off-1",
            listing_id: "lst-1",
            amount: 5000,
            buyer_handle: "buyer1",
          }),
        );

        expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
          expect.any(String),
          { sessionKey: DEFAULT_SESSION_KEY },
        );
      },
    );

    it(
      "calls requestHeartbeatNow with { reason: " +
        "'hook:klodi:klodi-notification', sessionKey } — heartbeat " +
        "must target the same session that enqueue populated, and the " +
        "'hook:klodi:' prefix routes OpenClaw's classifier to " +
        "kind='hook' so the preflight bypasses HEARTBEAT.md gating",
      async () => {
        mockFindSellFile.mockReturnValue(null);

        await handleNotification(
          event({
            offer_id: "off-1",
            listing_id: "lst-1",
            amount: 5000,
            buyer_handle: "buyer1",
          }),
        );

        expect(
          api.runtime.system.requestHeartbeatNow,
        ).toHaveBeenCalledWith({
          reason: "hook:klodi:klodi-notification",
          sessionKey: DEFAULT_SESSION_KEY,
        });
      },
    );
  });

  // ── offer.proposed: missing fields -> wake agent as fallback ───────────

  describe("offer.proposed -- missing fields fallback", () => {
    it("wakes agent when listing_id is missing", async () => {
      await handleNotification(
        event({
          offer_id: "off-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("wakes agent when offer_id is missing", async () => {
      await handleNotification(
        event({
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("wakes agent when amount is undefined", async () => {
      await handleNotification(
        event({
          listing_id: "lst-1",
          offer_id: "off-1",
          buyer_handle: "buyer1",
        }),
      );

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── offer.proposed: auto-reject NATS failure ──────────────────────────

  describe("offer.proposed -- auto-reject failure", () => {
    it("wakes agent when auto-reject NATS request fails", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );
      mockRequest.mockRejectedValueOnce(new Error("NATS timeout"));

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      // Falls back to waking agent
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("logs error when auto-reject NATS request fails", async () => {
      mockFindSellFile.mockReturnValue(
        sellFile({ auto_reject_below: 10000 }) as any,
      );
      mockRequest.mockRejectedValueOnce(new Error("NATS timeout"));

      await handleNotification(
        event({
          offer_id: "off-1",
          listing_id: "lst-1",
          amount: 5000,
          buyer_handle: "buyer1",
        }),
      );

      expect(api.logger.error).toHaveBeenCalledWith(
        "auto_reject_failed",
        expect.objectContaining({ offer_id: "off-1" }),
      );
    });
  });

  // ── channel.opened ─────────────────────────────────────────────────────

  describe("channel.opened", () => {
    it("wakes agent with buyer_handle and listing_id", async () => {
      await handleNotification({
        event: "channel.opened",
        buyer_handle: "alice",
        listing_id: "lst-42",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@alice"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("lst-42"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── channel.message ────────────────────────────────────────────────────

  describe("channel.message", () => {
    it("wakes agent with sender_handle and channel_id", async () => {
      await handleNotification({
        event: "channel.message",
        sender_handle: "bob",
        channel_id: "ch-99",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@bob"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("ch-99"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── comment.created ────────────────────────────────────────────────────

  describe("comment.created", () => {
    it("wakes agent with handle and listing_id", async () => {
      await handleNotification({
        event: "comment.created",
        handle: "carol",
        listing_id: "lst-7",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@carol"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("lst-7"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("includes mentions in notification text", async () => {
      await handleNotification({
        event: "comment.created",
        handle: "carol",
        listing_id: "lst-7",
        mentions: ["dave", "eve"],
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("dave"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("eve"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── offer.accepted ─────────────────────────────────────────────────────

  describe("offer.accepted", () => {
    it("wakes agent with seller_handle, amount, and transaction_id", async () => {
      await handleNotification({
        event: "offer.accepted",
        seller_handle: "frank",
        listing_id: "lst-10",
        amount: 25000,
        transaction_id: "tx-1",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@frank"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("$250.00"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("tx-1"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── offer.rejected ─────────────────────────────────────────────────────

  describe("offer.rejected", () => {
    it("wakes agent with seller_handle and listing_id", async () => {
      await handleNotification({
        event: "offer.rejected",
        seller_handle: "grace",
        listing_id: "lst-11",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@grace"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("lst-11"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── transaction.confirmed ──────────────────────────────────────────────

  describe("transaction.confirmed", () => {
    it("wakes agent with confirmed_by_handle", async () => {
      await handleNotification({
        event: "transaction.confirmed",
        confirmed_by_handle: "helen",
        transaction_id: "tx-5",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@helen"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── transaction.completed ──────────────────────────────────────────────

  describe("transaction.completed", () => {
    it("wakes agent with transaction_id and listing_id", async () => {
      await handleNotification({
        event: "transaction.completed",
        transaction_id: "tx-5",
        listing_id: "lst-20",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("tx-5"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("lst-20"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── transaction.cancelled ──────────────────────────────────────────────

  describe("transaction.cancelled", () => {
    it("wakes agent with cancelled_by_handle and reason", async () => {
      await handleNotification({
        event: "transaction.cancelled",
        cancelled_by_handle: "ivan",
        transaction_id: "tx-6",
        reason: "Item no longer available",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("@ivan"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Item no longer available"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── listing.status_changed ─────────────────────────────────────────────

  describe("listing.status_changed", () => {
    it("wakes agent with old_status and new_status", async () => {
      await handleNotification({
        event: "listing.status_changed",
        listing_id: "lst-30",
        old_status: "active",
        new_status: "sold",
      });

      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("active"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("sold"),
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });
  });

  // ── unknown event ──────────────────────────────────────────────────────

  describe("unknown event", () => {
    it("logs warning and does not wake agent", async () => {
      await handleNotification({
        event: "something.weird",
      });

      expect(api.logger.warn).toHaveBeenCalledWith(
        "unknown_event",
        expect.objectContaining({ event: "something.weird" }),
      );
      expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(
        api.runtime.system.requestHeartbeatNow,
      ).not.toHaveBeenCalled();
    });
  });

  // ── Guard: pluginApi not initialized ───────────────────────────────────

  describe("guard: uninitialized", () => {
    it("throws when initNotifications was never called", async () => {
      // Re-import a fresh module to get uninitialized state
      vi.resetModules();

      // Re-mock after resetModules
      vi.doMock("../../lib/nats-client.js", () => ({
        request: vi.fn().mockResolvedValue({}),
      }));
      vi.doMock("../../lib/config.js", () => ({
        findSellFileByListingId: vi.fn(),
        hasCredentials: vi.fn(() => true),
        loadConfig: vi.fn(),
        setKlodiHome: vi.fn(),
        getNegotiationStylePath: vi.fn(
          () => "/test/policies/negotiation_style.md",
        ),
        getSellFilePath: vi.fn(
          (slug: string) => `/test/sell/${slug}.md`,
        ),
        getSellDir: vi.fn(() => "/test/sell"),
        getBuyDir: vi.fn(() => "/test/buy"),
      }));
      vi.doMock("./state.js", () => ({
        onListingWithdrawn: vi.fn(),
        onTransactionTerminal: vi.fn(),
      }));

      const mod = await import("../../service/notifications.js");
      // Do NOT call initNotifications — pluginApi remains null
      await expect(
        mod.handleNotification({ event: "offer.proposed" }),
      ).rejects.toThrow("initNotifications");
    });
  });
});
