/**
 * Tests for src/lib/nats-client.ts
 *
 * Boundary: we trust `@nats-io/nats-core` and the `ws` package themselves —
 * all we're asserting here is that `doConnect` (called via `getConnection`)
 * hands nats-core the options the plugin promises: a 10s connect timeout and
 * a `wsFactory` that produces Node `ws` WebSockets with the correct
 * `encrypted` flag derived from the URL scheme.
 *
 * Why this matters: the wsFactory exists because Node 24's built-in
 * WebSocket routes through undici 7.21, which fails RFC 8441 Extended
 * CONNECT against Fastly (Railway's edge). If a future refactor drops the
 * wsFactory or forgets the `ws`-backed socket, plugin connections would
 * silently regress to a bare `ConnectionError` in prod.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Boundary mocks (hoisted before imports) ───────────────────────────────

vi.mock("@nats-io/nats-core", () => ({
  wsconnect: vi.fn(),
  credsAuthenticator: vi.fn(() => "mock-authenticator"),
  headers: vi.fn(() => ({
    set: vi.fn(),
  })),
}));

vi.mock("ws", () => {
  // The factory calls `new NodeWebSocket(url)`. A plain vi.fn() is not
  // constructable with `new`; we need a real class so the `new` expression
  // in doConnect works and we can still spy on invocation via the class's
  // own mock.
  class MockWebSocket {
    public __mockWs = true;
    constructor(public url: string) {
      MockWebSocket.ctor(url);
    }
    static ctor = vi.fn();
  }
  return { WebSocket: MockWebSocket };
});

vi.mock("../../lib/config.js", () => ({
  loadConfig: vi.fn(() => ({
    handle: "testuser",
    user_id: "uid-1",
    nkey_public: "NKEY1",
    nats_url: "wss://nats.example.com",
  })),
  loadCreds: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { wsconnect } from "@nats-io/nats-core";
import { WebSocket as NodeWebSocket } from "ws";
import { getConnection, drain } from "../../lib/nats-client.js";

const mockWsconnect = vi.mocked(wsconnect);
// Our mock exposes a static `ctor` spy on the class (see vi.mock("ws") above).
// Cast through unknown because the real `ws` type doesn't declare it.
const mockWsCtor = (NodeWebSocket as unknown as { ctor: ReturnType<typeof vi.fn> }).ctor;

// ── Setup ─────────────────────────────────────────────────────────────────

const fakeNc = {
  isClosed: () => false,
  drain: vi.fn().mockResolvedValue(undefined),
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockWsCtor.mockClear();
  // Reset the module's shared connection so every test starts cold. The
  // simplest way: drain() clears the cached handle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockWsconnect.mockResolvedValue(fakeNc as any);
  await drain();
  vi.clearAllMocks();
  mockWsCtor.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockWsconnect.mockResolvedValue(fakeNc as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("doConnect options", () => {
  it("passes the 10s connect timeout to wsconnect", async () => {
    await getConnection();

    expect(mockWsconnect).toHaveBeenCalledTimes(1);
    expect(mockWsconnect).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("supplies a wsFactory function to wsconnect", async () => {
    await getConnection();

    const opts = mockWsconnect.mock.calls[0]?.[0] as {
      wsFactory?: unknown;
    };
    expect(opts).toBeDefined();
    expect(typeof opts.wsFactory).toBe("function");
  });

  it("forwards the configured nats_url as servers", async () => {
    await getConnection();

    expect(mockWsconnect).toHaveBeenCalledWith(
      expect.objectContaining({ servers: "wss://nats.example.com" }),
    );
  });
});

describe("wsFactory behavior", () => {
  it(
    "produces a socket via the `ws` WebSocket constructor and reports " +
      "encrypted=true for wss:// URLs",
    async () => {
      await getConnection();

      const opts = mockWsconnect.mock.calls[0]?.[0] as {
        wsFactory: (url: string) => Promise<{
          socket: unknown;
          encrypted: boolean;
        }>;
      };

      const result = await opts.wsFactory("wss://example.com/");

      expect(mockWsCtor).toHaveBeenCalledWith("wss://example.com/");
      expect(mockWsCtor).toHaveBeenCalledTimes(1);
      expect(result.socket).toMatchObject({
        __mockWs: true,
        url: "wss://example.com/",
      });
      expect(result.encrypted).toBe(true);
    },
  );

  it("reports encrypted=false for plain ws:// URLs", async () => {
    await getConnection();

    const opts = mockWsconnect.mock.calls[0]?.[0] as {
      wsFactory: (url: string) => Promise<{
        socket: unknown;
        encrypted: boolean;
      }>;
    };

    const result = await opts.wsFactory("ws://example.com/");

    expect(mockWsCtor).toHaveBeenCalledWith("ws://example.com/");
    expect(result.encrypted).toBe(false);
  });

  it("resolves to a Promise (nats-core expects an async factory)", async () => {
    await getConnection();

    const opts = mockWsconnect.mock.calls[0]?.[0] as {
      wsFactory: (url: string) => unknown;
    };

    const returned = opts.wsFactory("wss://example.com/");
    expect(returned).toBeInstanceOf(Promise);
    await returned; // must settle cleanly
  });
});
