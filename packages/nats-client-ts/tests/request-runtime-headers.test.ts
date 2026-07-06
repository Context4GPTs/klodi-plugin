/**
 * Boundary unit tests for runtime-analytics header stamping on the
 * tool-call request path.
 *
 * RED-first. `KlodiClient.request()` today builds `hdrs` with ONLY the two
 * auth headers (`X-User-Id`, `X-Nkey-Public`) — see `src/client.ts:238-240`.
 * The shared, adapter-agnostic client (`@klodi/nats-client`) must gain one
 * optional constructor field, `runtimeHeaders?: Record<string, string>`, and
 * stamp each entry on every outbound RPC *after* the auth headers. This file
 * specifies that behavior; the assertions FAIL until `KlodiClientArgs` carries
 * `runtimeHeaders` and `request()` iterates it onto `hdrs`.
 *
 * WE MOCK THE NATS BOUNDARY, NOT LOGIC — mirroring
 * `publish-match-feedback.test.ts` / `publish-uuid.test.ts`: a fake
 * `NatsConnection` whose `request(subject, data, opts)` captures the real
 * `MsgHdrs` the production code attached, so the assertions are about the
 * exact header bytes that hit the wire. Per the adversarial-testing skill,
 * NEVER weaken these asserts to match an implementation that omits a header,
 * leaks the `openclaw` literal into this shared package, or stamps only the
 * first call. The shared client must stamp *whatever keys it was handed* and
 * know nothing about adapters or install sources.
 *
 * Seam (confirmed): `request()` calls
 * `requireConnection()` (`client.ts:456`) and `requireConfig()` /
 * `loadConfigFromDisk()`. We inject the fake `nc` and a cached `config`
 * directly via the private fields so neither performs real I/O — this is a
 * test-only reach into private state, NOT a production-only code path added to
 * the class. No production code is touched to make these tests runnable.
 */

import { type Msg, type MsgHdrs, type NatsConnection } from "@nats-io/nats-core";
import { describe, it, expect, vi } from "vitest";

import { KlodiClient, type KlodiClientArgs, type KlodiConfig } from "../src/index.js";

const CONFIG: KlodiConfig = {
  handle: "tester",
  user_id: "user-abc-123",
  nkey_public: "NKEYPUBLIC123",
  nats_url: "wss://example.test:4443",
};

interface CapturedRequest {
  subject: string;
  headers: MsgHdrs | undefined;
}

/**
 * A fake NatsConnection that satisfies the only two members `request()` exercises:
 *   - isClosed() → false, so `requireConnection()` returns it without connecting.
 *   - request(subject, data, opts) → captures `opts.headers` (the real MsgHdrs the
 *     production code built) and replies with a benign JSON envelope.
 *
 * It deliberately exposes NO second socket/endpoint — the privacy guard is that
 * every RPC rides this one captured connection.
 */
function fakeConnection(captures: CapturedRequest[]): {
  nc: NatsConnection;
  openCount: { value: number };
} {
  const openCount = { value: 1 }; // the single connection opened by connect()
  const requestFn = vi.fn(
    async (
      subject: string,
      _data: Uint8Array,
      opts?: { headers?: MsgHdrs },
    ): Promise<Msg> => {
      captures.push({ subject, headers: opts?.headers });
      return {
        data: new TextEncoder().encode(JSON.stringify({ ok: true })),
      } as unknown as Msg;
    },
  );
  const nc = {
    isClosed: () => false,
    request: requestFn,
  } as unknown as NatsConnection;
  return { nc, openCount };
}

/**
 * Build a KlodiClient with the fake connection + cached config wired into the
 * private fields, so `request()` runs against the fake without real I/O.
 * `runtimeHeaders` is threaded through the constructor args (RED: the field
 * does not exist on `KlodiClientArgs` yet).
 */
function makeClient(
  captures: CapturedRequest[],
  runtimeHeaders?: Record<string, string>,
): KlodiClient {
  const args: KlodiClientArgs = {
    credsPath: "/nonexistent/nats.creds",
    configPath: "/nonexistent/config.json",
    // RED: `runtimeHeaders` is not yet a member of KlodiClientArgs.
    runtimeHeaders,
  };
  const client = new KlodiClient(args);
  const { nc } = fakeConnection(captures);
  // Test-only injection of private state — avoids a real connect/disk read.
  const internals = client as unknown as {
    nc: NatsConnection;
    config: KlodiConfig;
  };
  internals.nc = nc;
  internals.config = CONFIG;
  return client;
}

describe("request() — runtime headers stamped alongside auth headers", () => {
  it("stamps injected runtimeHeaders PLUS the unchanged auth headers", async () => {
    const captures: CapturedRequest[] = [];
    const client = makeClient(captures, {
      "X-Klodi-Runtime": "openclaw",
      "X-Klodi-Plugin-Source": "clawhub",
    });

    await client.request("p2p.v1.users.whoami", {});

    expect(captures.length).toBe(1);
    const hdrs = captures[0].headers;
    expect(hdrs).toBeDefined();

    // The two runtime/analytics headers are present with the exact values.
    expect(hdrs!.get("X-Klodi-Runtime")).toBe("openclaw");
    expect(hdrs!.get("X-Klodi-Plugin-Source")).toBe("clawhub");

    // The two auth headers survive byte-for-byte — additive, never substituted.
    expect(hdrs!.get("X-User-Id")).toBe(CONFIG.user_id);
    expect(hdrs!.get("X-Nkey-Public")).toBe(CONFIG.nkey_public);

    // Exactly the four expected keys ride the wire — no extras, none dropped.
    expect(hdrs!.keys().sort()).toEqual([
      "X-Klodi-Plugin-Source",
      "X-Klodi-Runtime",
      "X-Nkey-Public",
      "X-User-Id",
    ]);
  });

  it("npm source value rides verbatim (no enum rewrite by the shared client)", async () => {
    const captures: CapturedRequest[] = [];
    const client = makeClient(captures, {
      "X-Klodi-Runtime": "openclaw",
      "X-Klodi-Plugin-Source": "npm",
    });

    await client.request("p2p.v1.users.whoami", {});

    expect(captures[0].headers!.get("X-Klodi-Plugin-Source")).toBe("npm");
  });
});

describe("request() — anti-leak guard: inert without injection", () => {
  it("stamps ONLY the two auth headers when no runtimeHeaders are given", async () => {
    const captures: CapturedRequest[] = [];
    const client = makeClient(captures); // no runtimeHeaders

    await client.request("p2p.v1.users.whoami", {});

    const hdrs = captures[0].headers;
    expect(hdrs).toBeDefined();

    // Auth headers present...
    expect(hdrs!.get("X-User-Id")).toBe(CONFIG.user_id);
    expect(hdrs!.get("X-Nkey-Public")).toBe(CONFIG.nkey_public);

    // ...and NOTHING else. The shared, adapter-agnostic client must not invent
    // `X-Klodi-Runtime` / `X-Klodi-Plugin-Source` on its own — the `openclaw`
    // literal lives only in the adapter. A second TS adapter that vendors this
    // client and passes no runtimeHeaders must emit a clean two-header set.
    expect(hdrs!.has("X-Klodi-Runtime")).toBe(false);
    expect(hdrs!.has("X-Klodi-Plugin-Source")).toBe(false);
    expect(hdrs!.keys().sort()).toEqual(["X-Nkey-Public", "X-User-Id"]);
  });
});

describe("request() — stamped on EVERY call, not first-call-only", () => {
  it("two sequential requests both carry the runtime headers", async () => {
    const captures: CapturedRequest[] = [];
    const client = makeClient(captures, {
      "X-Klodi-Runtime": "openclaw",
      "X-Klodi-Plugin-Source": "clawhub",
    });

    await client.request("p2p.v1.users.whoami", {});
    await client.request("p2p.v1.listings.search", { q: "x" });

    expect(captures.length).toBe(2);
    for (const cap of captures) {
      expect(cap.headers!.get("X-Klodi-Runtime")).toBe("openclaw");
      expect(cap.headers!.get("X-Klodi-Plugin-Source")).toBe("clawhub");
      // Auth headers must persist across every call too.
      expect(cap.headers!.get("X-User-Id")).toBe(CONFIG.user_id);
      expect(cap.headers!.get("X-Nkey-Public")).toBe(CONFIG.nkey_public);
    }
  });
});

describe("request() — privacy guard: one connection, no second socket", () => {
  it("reuses the single injected connection for every RPC (no new endpoint opened)", async () => {
    const captures: CapturedRequest[] = [];
    const client = makeClient(captures, {
      "X-Klodi-Runtime": "openclaw",
      "X-Klodi-Plugin-Source": "clawhub",
    });

    // The fake exposes exactly one `request` method on one `nc`. If the
    // implementation tried to open a second socket / endpoint to emit these
    // headers, the captures would not all land on this single connection.
    const internals = client as unknown as { nc: { request: ReturnType<typeof vi.fn> } };
    const requestSpy = internals.nc.request;

    await client.request("p2p.v1.users.whoami", {});
    await client.request("p2p.v1.users.whoami", {});

    // Both RPCs went through the same injected connection's request fn — the
    // headers ride the already-authenticated connection, never a new beacon.
    expect(requestSpy.mock.calls.length).toBe(2);
    expect(captures.length).toBe(2);
  });
});
