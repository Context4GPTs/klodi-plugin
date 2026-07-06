/**
 * Tests for adapters/openclaw/src/tools/register-poller.ts
 *
 * Covers the synchronous claim path against fetch (mocked) — every
 * branch of `claimRegisterSession` plus a startRegisterPoll lifecycle
 * smoke test (start, replace, stop). The full timer-driven 10-minute
 * timeout sweep is out of scope here; the coverage that matters for
 * the adapter is correctness of the per-tick claim mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import {
  claimRegisterSession,
  startRegisterPoll,
  stopRegisterPoll,
} from "../../tools/register-poller.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getCredsPath, getConfigPath } from "../../lib/paths.js";
import { __resetWakePumpRegistryForTests } from "@klodi/nats-client";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

// nats_url is the pinned tls:// L4 proxy — the tls-only cutover
// makes the persist-time shared
// guard reject a wss://<non-localhost> url, so the happy-path payload must
// carry the accepted tls:// scheme.
const COMPLETED_PAYLOAD = {
  status: "completed",
  nats_creds: "creds-bytes",
  handle: "newuser",
  user_id: "uid-new",
  nkey_public: "NKEY",
  nats_url: "tls://hayabusa.proxy.rlwy.net:32770",
};

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

function mockFetchOnce(
  status: number,
  body: unknown,
): void {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(body),
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    response as unknown as Response,
  );
}

beforeEach(() => {
  temp = createTempHome();
  api = createMockPluginApi();
  __resetWakePumpRegistryForTests();
});

afterEach(() => {
  stopRegisterPoll("test-cleanup");
  __resetWakePumpRegistryForTests();
  temp.cleanup();
  vi.restoreAllMocks();
});

describe("claimRegisterSession (terminal kinds)", () => {
  it("returns 'registered' and writes creds + config on completed payload", async () => {
    mockFetchOnce(200, COMPLETED_PAYLOAD);
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.handle).toBe("newuser");
    expect(result.negotiation_style_seeded).toBe(true);
    expect(result.security_policy_seeded).toBe(true);
    // creds + config landed on disk at 0o600.
    expect(existsSync(getCredsPath())).toBe(true);
    expect(existsSync(getConfigPath())).toBe(true);
    const credsMode = statSync(getCredsPath()).mode & 0o777;
    expect(credsMode & 0o077).toBe(0);
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(cfg.handle).toBe("newuser");
    expect(cfg.nats_url).toBe("tls://hayabusa.proxy.rlwy.net:32770");
  });

  it("rejects a wss:// non-localhost nats_url via the shared guard (tls-only cutover)", async () => {
    // [integration] tls-only cutover: a stale /
    // compromised /register returning a wss://<non-localhost> nats_url is
    // now refused at persist by the SHARED guard (no adapter-local scheme
    // check). Fails closed — nothing on disk.
    mockFetchOnce(200, {
      ...COMPLETED_PAYLOAD,
      nats_url: "wss://klodi-net.4gpts.com",
    });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("invalid_response");
    expect(existsSync(getCredsPath())).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("rejects a plaintext non-localhost nats_url with invalid_response", async () => {
    mockFetchOnce(200, {
      ...COMPLETED_PAYLOAD,
      nats_url: "ws://attacker.example.com:4222",
    });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("invalid_response");
    if (result.kind === "invalid_response") {
      expect(result.message).toMatch(/plaintext nats_url/);
    }
    // Nothing on disk.
    expect(existsSync(getCredsPath())).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("returns expired on status=expired", async () => {
    mockFetchOnce(200, { status: "expired" });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("expired");
  });

  it("returns invalid_response when completed payload is missing fields", async () => {
    mockFetchOnce(200, {
      status: "completed", nats_creds: "x",
      // handle/user_id absent
    });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("invalid_response");
  });
});

describe("claimRegisterSession (non-terminal kinds)", () => {
  it("returns 'pending' on status=pending", async () => {
    mockFetchOnce(200, { status: "pending" });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("pending");
  });

  it("returns 'already_claimed' on 409 with CREDENTIALS_ALREADY_CLAIMED body", async () => {
    mockFetchOnce(409, { error: "CREDENTIALS_ALREADY_CLAIMED" });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("already_claimed");
  });

  it("returns http_error on a generic 500", async () => {
    mockFetchOnce(500, { error: "internal" });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("http_error");
    if (result.kind === "http_error") {
      expect(result.status).toBe(500);
    }
  });

  it("returns transport_error on fetch rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNRESET"),
    );
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.message).toContain("ECONNRESET");
    }
  });
});

describe("startRegisterPoll lifecycle", () => {
  it("starts and stops cleanly", () => {
    startRegisterPoll(api, SESSION_ID);
    // No throw on the second start (replaces the active session).
    startRegisterPoll(api, "22222222-3333-4444-8555-666666666666");
    stopRegisterPoll("test-end");
  });

  it("stopRegisterPoll is idempotent when no poll is active", () => {
    stopRegisterPoll("noop-1");
    stopRegisterPoll("noop-2");
  });
});
