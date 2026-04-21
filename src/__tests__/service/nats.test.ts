/**
 * NATS service lifecycle tests.
 * All external dependencies are mocked -- this tests registration, start, and stop behavior.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  createMockPluginApi,
  getService,
  type MockPluginAPI,
} from "../helpers/mock-plugin-api.js";

// ── Boundary mocks ─────────────────────────────────────────────────────────

// vi.hoisted runs before vi.mock factories, so mockNc is available at hoist time
const { mockJetstream, mockJetstreamManager, mockNc } = vi.hoisted(() => {
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
  return { mockJetstream, mockJetstreamManager, mockNc };
});

vi.mock("../../lib/nats-client.js", () => ({
  getConnection: vi.fn().mockResolvedValue(mockNc),
  drain: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(() => true),
  request: vi.fn(),
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
    user_id: "uid-123",
    nkey_public: "nk-abc",
    nats_url: "nats://localhost:4222",
  })),
  setKlodiHome: vi.fn(),
}));

vi.mock("../../service/notifications.js", () => ({
  initNotifications: vi.fn(),
  handleNotification: vi.fn(),
}));

vi.mock("../../service/timers.js", () => ({
  initTimers: vi.fn(),
  reconcileTimers: vi.fn(),
  clearAllTimers: vi.fn(),
}));

import {
  registerNatsService,
  ensureNatsRunning,
  resetNatsState,
} from "../../service/nats.js";
import { getConnection, drain, isConnected } from "../../lib/nats-client.js";
import { hasCredentials } from "../../lib/config.js";
import { initNotifications } from "../../service/notifications.js";
import { initTimers, reconcileTimers, clearAllTimers } from "../../service/timers.js";

const mockHasCredentials = vi.mocked(hasCredentials);
const mockGetConnection = vi.mocked(getConnection);
const mockDrain = vi.mocked(drain);
const mockIsConnected = vi.mocked(isConnected);

// ── Setup ──────────────────────────────────────────────────────────────────

let api: MockPluginAPI;

/** Apply the default mock wiring for getConnection + jetstream. */
function primeMocks(): void {
  mockHasCredentials.mockReturnValue(true);
  mockIsConnected.mockReturnValue(true);
  mockGetConnection.mockResolvedValue(mockNc as any);

  // Mock jetstream to return a consume that hangs (simulates active consumer)
  mockJetstream.mockReturnValue({
    consumers: {
      get: vi.fn().mockResolvedValue({
        consume: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<never>(() => {}),
          }),
        }),
      }),
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  api = createMockPluginApi();
  primeMocks();

  // Reset module-level consuming/starting flags by stopping any
  // prior test's in-memory service state.
  registerNatsService(api);
  const svc = getService(api, "klodi-nats");
  await svc.stop();

  // Re-prime after the stop cleared mock call history.
  vi.clearAllMocks();
  api = createMockPluginApi();
  primeMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("registerNatsService", () => {
  it("registers service with id: klodi-nats", () => {
    registerNatsService(api);

    const service = getService(api, "klodi-nats");
    expect(service.id).toBe("klodi-nats");
  });

  it("initializes notifications and timers on registration", () => {
    registerNatsService(api);

    expect(initNotifications).toHaveBeenCalledWith(api);
    expect(initTimers).toHaveBeenCalledWith(api);
  });

  describe("start", () => {
    it("skips NATS connection when credentials missing", async () => {
      mockHasCredentials.mockReturnValue(false);
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.start();

      expect(mockGetConnection).not.toHaveBeenCalled();
      expect(api.logger.info).toHaveBeenCalledWith(
        "nats_skipped",
        expect.objectContaining({
          message: expect.stringContaining("No credentials"),
        }),
      );
    });

    it("connects to NATS when credentials exist", async () => {
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.start();

      expect(mockGetConnection).toHaveBeenCalled();
      expect(api.logger.info).toHaveBeenCalledWith(
        "nats_connected",
        expect.objectContaining({ server: "nats://localhost:4222" }),
      );
    });

    it("reconciles timers after connection", async () => {
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.start();

      expect(reconcileTimers).toHaveBeenCalled();
    });

    it("logs error when connection fails", async () => {
      mockGetConnection.mockRejectedValueOnce(new Error("Connection refused"));
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.start();

      expect(api.logger.error).toHaveBeenCalledWith(
        "nats_connect_failed",
        expect.objectContaining({
          error: expect.stringContaining("Connection refused"),
          error_name: "Error",
          error_message: "Connection refused",
          error_cause: null,
          error_stack: expect.stringContaining("Error"),
          server: "nats://localhost:4222",
        }),
      );
    });
  });

  describe("stop", () => {
    it("clears all timers", async () => {
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.stop();

      expect(clearAllTimers).toHaveBeenCalled();
    });

    it("drains NATS connection", async () => {
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.stop();

      expect(mockDrain).toHaveBeenCalled();
    });

    it("logs nats_stopped", async () => {
      registerNatsService(api);

      const service = getService(api, "klodi-nats");
      await service.stop();

      expect(api.logger.info).toHaveBeenCalledWith("nats_stopped");
    });
  });
});

// ── ensureNatsRunning ──────────────────────────────────────────────────────

describe("ensureNatsRunning", () => {
  // Top-level beforeEach already primes mocks + resets module state.
  // Nothing more needed here.

  it("returns skipped with reason=no_credentials when creds absent", async () => {
    mockHasCredentials.mockReturnValue(false);

    const result = await ensureNatsRunning(api);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_credentials");
    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      "nats_skipped",
      expect.objectContaining({
        message: expect.stringContaining("No credentials"),
      }),
    );
  });

  it("enqueues onboarding system event when credentials missing", async () => {
    mockHasCredentials.mockReturnValue(false);

    await ensureNatsRunning(api);
    // Flush the fire-and-forget promptOnboarding microtask so the
    // post-await requestHeartbeatNow call has landed.
    await Promise.resolve();
    await Promise.resolve();

    // wakeAgent signature: enqueueSystemEvent(text, { sessionKey }),
    // requestHeartbeatNow({ reason: "hook:klodi:<reason>", sessionKey }).
    // Default mock config is empty so sessionKey resolves to
    // "agent:main:main". Heartbeat reason carries the "hook:klodi:"
    // prefix per wake.ts invariant #5 so OpenClaw's classifier routes
    // it as a wake trigger instead of skipping with
    // "empty-heartbeat-file".
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("not registered"),
      { sessionKey: "agent:main:main" },
    );
    expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "hook:klodi:klodi-onboarding-needed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("does not prompt onboarding when credentials exist", async () => {
    mockHasCredentials.mockReturnValue(true);

    await ensureNatsRunning(api);
    await Promise.resolve();

    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("returns running after a successful first connect", async () => {
    mockHasCredentials.mockReturnValue(true);

    const result = await ensureNatsRunning(api);

    expect(result.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    expect(reconcileTimers).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: second call does not reconnect", async () => {
    mockHasCredentials.mockReturnValue(true);

    await ensureNatsRunning(api);
    await ensureNatsRunning(api);

    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    expect(reconcileTimers).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent callers via the starting promise", async () => {
    mockHasCredentials.mockReturnValue(true);
    let resolveConn: (v: unknown) => void = () => {};
    mockGetConnection.mockImplementationOnce(
      () => new Promise<never>((r) => { resolveConn = r as (v: unknown) => void; }),
    );

    const a = ensureNatsRunning(api);
    const b = ensureNatsRunning(api);

    resolveConn(mockNc);
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.status).toBe("running");
    expect(rb.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });

  it("returns failed with reason when connect throws", async () => {
    mockHasCredentials.mockReturnValue(true);
    mockGetConnection.mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const result = await ensureNatsRunning(api);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Connection refused");
    expect(api.logger.error).toHaveBeenCalledWith(
      "nats_connect_failed",
      expect.objectContaining({
        error: expect.stringContaining("Connection refused"),
        error_name: "Error",
        error_message: "Connection refused",
        error_cause: null,
        error_stack: expect.stringContaining("Error"),
        server: "nats://localhost:4222",
      }),
    );
  });

  it(
    "captures error_name/message/cause/stack and server on a structured " +
      "connect failure — the fields that let us diagnose bare " +
      "ConnectionError crashes where String(err) returned only the class name",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      // Custom subclass with a non-null cause + real stack. Mirrors the
      // shape nats-core throws when the ws handshake rejects: `name`
      // carries the subclass, `cause` carries the underlying transport
      // error. Bootstrap must preserve all four so the log line is
      // actionable instead of the previous hollow "ConnectionError".
      class ConnectionError extends Error {
        constructor(message: string, options?: { cause: unknown }) {
          super(message, options);
          this.name = "ConnectionError";
        }
      }
      const underlying = new Error("ECONNRESET");
      const thrown = new ConnectionError("ws handshake failed", {
        cause: underlying,
      });
      mockGetConnection.mockRejectedValueOnce(thrown);

      await ensureNatsRunning(api);

      expect(api.logger.error).toHaveBeenCalledWith(
        "nats_connect_failed",
        expect.objectContaining({
          error: expect.stringContaining("ws handshake failed"),
          error_name: "ConnectionError",
          error_message: "ws handshake failed",
          error_cause: expect.stringContaining("ECONNRESET"),
          error_stack: expect.stringContaining("ConnectionError"),
          server: "nats://localhost:4222",
        }),
      );
    },
  );

  it(
    "records error_cause: null when the thrown error has no cause " +
      "(plain new Error) — prevents accidental 'undefined' string leakage",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      mockGetConnection.mockRejectedValueOnce(new Error("simple failure"));

      await ensureNatsRunning(api);

      expect(api.logger.error).toHaveBeenCalledWith(
        "nats_connect_failed",
        expect.objectContaining({
          error_cause: null,
        }),
      );
    },
  );

  it("re-attempts after a prior failure when called again", async () => {
    mockHasCredentials.mockReturnValue(true);
    mockGetConnection
      .mockRejectedValueOnce(new Error("net down"))
      .mockResolvedValueOnce(mockNc as any);

    const first = await ensureNatsRunning(api);
    const second = await ensureNatsRunning(api);

    expect(first.status).toBe("failed");
    expect(second.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });

  it("logs error when heartbeat.target is missing", async () => {
    mockHasCredentials.mockReturnValue(true);
    // api.config is empty — readApiConfig walks into nothing.
    api = createMockPluginApi({ config: {} });

    await ensureNatsRunning(api);

    expect(api.logger.error).toHaveBeenCalledWith(
      "heartbeat_not_last",
      expect.anything(),
    );
  });

  it("logs error when heartbeat.target is the literal 'none'", async () => {
    mockHasCredentials.mockReturnValue(true);
    api = createMockPluginApi({
      config: { agents: { defaults: { heartbeat: { target: "none" } } } },
    });

    await ensureNatsRunning(api);

    expect(api.logger.error).toHaveBeenCalledWith(
      "heartbeat_not_last",
      expect.anything(),
    );
  });

  it("logs error when heartbeat.target is 'first' (legacy / mistaken value)", async () => {
    mockHasCredentials.mockReturnValue(true);
    api = createMockPluginApi({
      config: { agents: { defaults: { heartbeat: { target: "first" } } } },
    });

    await ensureNatsRunning(api);

    expect(api.logger.error).toHaveBeenCalledWith(
      "heartbeat_not_last",
      expect.anything(),
    );
  });

  it("logs error when heartbeat.target is an empty string", async () => {
    mockHasCredentials.mockReturnValue(true);
    api = createMockPluginApi({
      config: { agents: { defaults: { heartbeat: { target: "" } } } },
    });

    await ensureNatsRunning(api);

    expect(api.logger.error).toHaveBeenCalledWith(
      "heartbeat_not_last",
      expect.anything(),
    );
  });

  it("does not log the heartbeat error when heartbeat.target is 'last'", async () => {
    mockHasCredentials.mockReturnValue(true);
    api = createMockPluginApi({
      config: { agents: { defaults: { heartbeat: { target: "last" } } } },
    });

    await ensureNatsRunning(api);

    expect(api.logger.error).not.toHaveBeenCalledWith(
      "heartbeat_not_last",
      expect.anything(),
    );
  });

  // ── heartbeat.every validation ───────────────────────────────────────────
  // OpenClaw defaults heartbeat.every to "30m". When requestHeartbeatNow
  // silently no-ops (SDK #29215/#34338/#14191), queued wakes stall for up
  // to that interval. Bootstrap must surface the misconfiguration as a
  // structured error so the user sees it in the first boot log.

  it(
    "logs heartbeat_interval_too_long when heartbeat.every is absent " +
      "from the config tree",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      // target is "last" so the target-gate error stays quiet; only
      // the `every` gate should fire.
      api = createMockPluginApi({
        config: { agents: { defaults: { heartbeat: { target: "last" } } } },
      });

      await ensureNatsRunning(api);

      expect(api.logger.error).toHaveBeenCalledWith(
        "heartbeat_interval_too_long",
        expect.anything(),
      );
    },
  );

  it(
    "logs heartbeat_interval_too_long when heartbeat.every is '0m' " +
      "(zero cadence is unusable)",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      api = createMockPluginApi({
        config: {
          agents: {
            defaults: { heartbeat: { target: "last", every: "0m" } },
          },
        },
      });

      await ensureNatsRunning(api);

      expect(api.logger.error).toHaveBeenCalledWith(
        "heartbeat_interval_too_long",
        expect.anything(),
      );
    },
  );

  it(
    "logs heartbeat_interval_too_long when heartbeat.every exceeds the " +
      "2-minute ceiling (OpenClaw default '30m' = 1_800_000 ms)",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      api = createMockPluginApi({
        config: {
          agents: {
            defaults: { heartbeat: { target: "last", every: "30m" } },
          },
        },
      });

      await ensureNatsRunning(api);

      expect(api.logger.error).toHaveBeenCalledWith(
        "heartbeat_interval_too_long",
        expect.anything(),
      );
    },
  );

  it(
    "does NOT log heartbeat_interval_too_long when heartbeat.every is " +
      "valid (negative case — '1m' is well under the ceiling)",
    async () => {
      mockHasCredentials.mockReturnValue(true);
      api = createMockPluginApi({
        config: {
          agents: {
            defaults: { heartbeat: { target: "last", every: "1m" } },
          },
        },
      });

      await ensureNatsRunning(api);

      expect(api.logger.error).not.toHaveBeenCalledWith(
        "heartbeat_interval_too_long",
        expect.anything(),
      );
    },
  );
});

// ── resetNatsState ─────────────────────────────────────────────────────────

describe("resetNatsState", () => {
  it("drains and resets module state so next ensureNatsRunning re-bootstraps", async () => {
    mockHasCredentials.mockReturnValue(true);

    // First bootstrap: gets a connection, marks consuming=true.
    const first = await ensureNatsRunning(api);
    expect(first.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(1);

    await resetNatsState();

    expect(mockDrain).toHaveBeenCalled();

    // Second bootstrap after reset must open a fresh connection
    // (the guard against stale-state short-circuit).
    const second = await ensureNatsRunning(api);
    expect(second.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });

  it("is safe to call when nothing is running", async () => {
    // No prior ensureNatsRunning — consuming is false, connection is null.
    await expect(resetNatsState()).resolves.toBeUndefined();
    expect(mockDrain).toHaveBeenCalled();
  });
});

// ── consumeLoop liveness ───────────────────────────────────────────────────

describe("consumeLoop exit clears consuming flag", () => {
  it("re-bootstraps after the consume loop exits via the outer catch", async () => {
    mockHasCredentials.mockReturnValue(true);

    // consume() throws — the outer catch sees the error, checks
    // `if (!consuming || !isConnected()) break;`, and with
    // isConnected flipped to false, it breaks. The finally block
    // then sets consuming=false, closing the P2-1 gap.
    const consumeThrower = vi.fn().mockRejectedValue(
      new Error("connection reset by peer"),
    );
    mockJetstream.mockReturnValue({
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: consumeThrower,
        }),
      },
    });
    // Call 1 = while-check (enter loop as consuming=true, link up).
    // Call 2 = catch-branch break check — false triggers `break`,
    // preventing the 5s retry setTimeout.
    mockIsConnected.mockReturnValueOnce(true).mockReturnValue(false);

    await ensureNatsRunning(api);
    // Let the scheduled consumeLoop run + finally-block execute.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Reset isConnected so the next bootstrap observes a live link.
    mockIsConnected.mockReturnValue(true);
    const second = await ensureNatsRunning(api);

    expect(second.status).toBe("running");
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });
});
