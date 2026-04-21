/**
 * Parse-and-dispatch integration: consumeLoop inside nats.ts must decode
 * the marketplace JetStream wire envelope ({type, recipients, payload})
 * into the shape handleNotification switches on.
 *
 * This exercises the seam between two real modules (nats.ts + notifications.ts)
 * against a mocked JetStream consumer that yields the ACTUAL marketplace
 * wire format. Any schema mismatch surfaces as "agent never woken".
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  createMockPluginApi,
  type MockPluginAPI,
} from "../helpers/mock-plugin-api.js";

// ── Boundary mocks ─────────────────────────────────────────────────────────

const { mockJetstream, mockJetstreamManager, mockNc, mockIsConnectedFn } =
  vi.hoisted(() => {
    const mockJetstream = vi.fn();
    const mockJetstreamManager = vi.fn();
    const mockNc = {
      isClosed: () => false,
      status: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<never>(() => {}),
        }),
      }),
      drain: vi.fn(),
    };
    const mockIsConnectedFn = vi.fn(() => true);
    return { mockJetstream, mockJetstreamManager, mockNc, mockIsConnectedFn };
  });

vi.mock("../../lib/nats-client.js", () => ({
  getConnection: vi.fn().mockResolvedValue(mockNc),
  drain: vi.fn().mockResolvedValue(undefined),
  isConnected: mockIsConnectedFn,
  request: vi.fn().mockResolvedValue({}),
}));

// @nats-io/jetstream@3 exposes jetstream() and jetstreamManager() as free
// functions (no longer instance methods on the NATS connection).
vi.mock("@nats-io/jetstream", () => ({
  jetstream: mockJetstream,
  jetstreamManager: mockJetstreamManager,
  AckPolicy: { Explicit: "explicit" },
  DeliverPolicy: { New: "new" },
}));

vi.mock("../../lib/config.js", () => ({
  hasCredentials: vi.fn(() => true),
  loadConfig: vi.fn(() => ({
    handle: "test",
    user_id: "user-123",
    nkey_public: "nk-abc",
    nats_url: "nats://localhost:4222",
  })),
  setKlodiHome: vi.fn(),
  findSellFileByListingId: vi.fn(() => null),
  getNegotiationStylePath: vi.fn(() => "/test/policies/negotiation_style.md"),
  getSellFilePath: vi.fn((slug: string) => `/test/sell/${slug}.md`),
  getSellDir: vi.fn(() => "/test/sell"),
  getBuyDir: vi.fn(() => "/test/buy"),
}));

vi.mock("../../service/state.js", () => ({
  onListingWithdrawn: vi.fn(),
  onTransactionTerminal: vi.fn(),
}));

vi.mock("../../service/timers.js", () => ({
  initTimers: vi.fn(),
  reconcileTimers: vi.fn(),
  clearAllTimers: vi.fn(),
}));

import {
  ensureNatsRunning,
  resetNatsState,
  registerNatsService,
} from "../../service/nats.js";
import { initNotifications } from "../../service/notifications.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Install a single-message consumer. After the message is delivered, the
 * iterator completes; isConnected flips to false so the outer while-check
 * breaks instead of retrying. Keeps the test finite and deterministic.
 */
function installSingleMessageConsumer(wireJson: string): void {
  const encoder = new TextEncoder();
  const msg = {
    data: encoder.encode(wireJson),
    ack: vi.fn(),
    nak: vi.fn(),
  };
  let delivered = false;
  const messages = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (!delivered) {
          delivered = true;
          return { value: msg, done: false };
        }
        return { value: undefined, done: true };
      },
    }),
  };
  mockJetstream.mockReturnValue({
    consumers: {
      get: vi.fn().mockResolvedValue({
        consume: vi.fn().mockResolvedValue(messages),
      }),
    },
  });
  // First call (while-check entering loop) returns true; after that, false
  // so the while-loop exits cleanly via the finally block.
  mockIsConnectedFn.mockReturnValueOnce(true).mockReturnValue(false);
}

/** Flush the scheduled consumeLoop microtasks so the message is dispatched. */
async function flushConsumeLoop(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

let api: MockPluginAPI;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetNatsState();
  mockIsConnectedFn.mockReturnValue(true);
  // heartbeat.target = "last" so bootstrap does not log the warning.
  // Production reads this via readApiConfig which walks the plain
  // config object tree — no `.get()` method exists on api.config.
  api = createMockPluginApi({
    config: { agents: { defaults: { heartbeat: { target: "last" } } } },
  });
  // The real notifications module must hold a reference to this api so
  // handleNotification's wakeAgent() can call enqueueSystemEvent on it.
  initNotifications(api);
  registerNatsService(api);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("consumeLoop parse-and-dispatch", () => {
  // wakeAgent signature: enqueueSystemEvent(text, { sessionKey }) —
  // text is the FIRST positional arg. mock.calls[0][0] is the text
  // string, mock.calls[0][1] is the options { sessionKey }. The
  // config seeded above has no agents.list, so sessionKey falls back
  // to "agent:main:main".
  const EXPECTED_SESSION_KEY = "agent:main:main";

  it("parses the marketplace wire format and wakes the agent for channel.opened", async () => {
    const wire = JSON.stringify({
      type: "channel.opened",
      recipients: ["user-123"],
      payload: {
        channel_id: "ch-1",
        listing_id: "li-1",
        buyer_handle: "buyer",
      },
    });
    installSingleMessageConsumer(wire);

    await ensureNatsRunning(api);
    await flushConsumeLoop();

    expect(api.logger.warn).not.toHaveBeenCalledWith(
      "unknown_event",
      expect.anything(),
    );
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // Cast via unknown: the SDK types in @openclaw/plugin-sdk still
    // type enqueueSystemEvent as (event: SystemEvent) but the runtime
    // signature is (text, { sessionKey }) — see src/service/wake.ts.
    const [text, options] = vi.mocked(
      api.runtime.system.enqueueSystemEvent,
    ).mock.calls[0] as unknown as [string, { sessionKey: string }];
    expect(text).toContain("@buyer");
    expect(text).toContain("listing li-1");
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY });
  });

  it("parses channel.message and wakes the agent", async () => {
    const wire = JSON.stringify({
      type: "channel.message",
      recipients: ["user-123"],
      payload: {
        channel_id: "ch-1",
        sender_handle: "buyer",
      },
    });
    installSingleMessageConsumer(wire);

    await ensureNatsRunning(api);
    await flushConsumeLoop();

    expect(api.logger.warn).not.toHaveBeenCalledWith(
      "unknown_event",
      expect.anything(),
    );
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // Cast via unknown: the SDK types in @openclaw/plugin-sdk still
    // type enqueueSystemEvent as (event: SystemEvent) but the runtime
    // signature is (text, { sessionKey }) — see src/service/wake.ts.
    const [text, options] = vi.mocked(
      api.runtime.system.enqueueSystemEvent,
    ).mock.calls[0] as unknown as [string, { sessionKey: string }];
    expect(text).toContain("@buyer");
    expect(text).toContain("ch-1");
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY });
  });

  it("parses offer.proposed and routes to the auto-reject/wake decision", async () => {
    // No sell file on disk => no auto-reject config => must wake the agent
    // with the formatted amount included.
    const wire = JSON.stringify({
      type: "offer.proposed",
      recipients: ["user-123"],
      payload: {
        offer_id: "of-1",
        listing_id: "li-1",
        buyer_handle: "buyer",
        amount: 5000,
      },
    });
    installSingleMessageConsumer(wire);

    await ensureNatsRunning(api);
    await flushConsumeLoop();

    expect(api.logger.warn).not.toHaveBeenCalledWith(
      "unknown_event",
      expect.anything(),
    );
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // Cast via unknown: the SDK types in @openclaw/plugin-sdk still
    // type enqueueSystemEvent as (event: SystemEvent) but the runtime
    // signature is (text, { sessionKey }) — see src/service/wake.ts.
    const [text, options] = vi.mocked(
      api.runtime.system.enqueueSystemEvent,
    ).mock.calls[0] as unknown as [string, { sessionKey: string }];
    expect(text).toContain("$50.00");
    expect(text).toContain("@buyer");
    expect(options).toEqual({ sessionKey: EXPECTED_SESSION_KEY });
  });
});
