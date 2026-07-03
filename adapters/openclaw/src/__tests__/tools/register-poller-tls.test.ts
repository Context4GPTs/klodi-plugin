/**
 * openclaw persists a server-sent `tls://` nats_url (register-poller.ts).
 *
 * Card: support-tls-nats-transport-with-private-ca-trust.
 * Criteria (Acceptance → "Registration persists a server-sent tls:// endpoint"):
 *
 *   - marketplace returns `nats_url: tls://<svc>.proxy.rlwy.net:<port>` →
 *     `claimRegisterSession` returns `registered` and writes that exact url
 *     to `${klodi_home}/config.json`.
 *   - marketplace returns a plaintext non-localhost url (nats:// / ws://) →
 *     `invalid_response`; nothing persisted.
 *
 * `register-poller.ts:162` delegates to the shared `assertEncryptedOrLocalhost`
 * guard (the inline plaintext-refusal copy now points at the shared guard).
 * Mirrors the existing `register-poller.test.ts` harness (fetch mocked,
 * temp KLODI_HOME).
 *
 * QA-owned (adversarial-testing). NEVER weaken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../../lib/client.js", () => import("../helpers/mock-nats.js"));

import { claimRegisterSession } from "../../tools/register-poller.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getCredsPath, getConfigPath } from "../../lib/paths.js";
import { __resetWakePumpRegistryForTests } from "@klodi/nats-client";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TLS_PROD_URL = "tls://kodama.proxy.rlwy.net:37360";

const BASE_PAYLOAD = {
  status: "completed",
  nats_creds: "creds-bytes",
  handle: "newuser",
  user_id: "uid-new",
  nkey_public: "NKEY",
};

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

function mockFetchOnce(status: number, body: unknown): void {
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
  __resetWakePumpRegistryForTests();
  temp.cleanup();
  vi.restoreAllMocks();
});

describe("claimRegisterSession — tls:// nats_url", () => {
  it("persists a tls:// nats_url unchanged and returns registered", async () => {
    mockFetchOnce(200, { ...BASE_PAYLOAD, nats_url: TLS_PROD_URL });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("registered");
    expect(existsSync(getConfigPath())).toBe(true);
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(cfg.nats_url).toBe(TLS_PROD_URL);
  });

  it("rejects a plaintext nats:// url with invalid_response — nothing persisted", async () => {
    mockFetchOnce(200, {
      ...BASE_PAYLOAD,
      nats_url: "nats://kodama.proxy.rlwy.net:4222",
    });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("invalid_response");
    if (result.kind === "invalid_response") {
      expect(result.message).toMatch(/plaintext nats_url/);
    }
    expect(existsSync(getCredsPath())).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("rejects a plaintext ws:// url with invalid_response", async () => {
    mockFetchOnce(200, {
      ...BASE_PAYLOAD,
      nats_url: "ws://attacker.example.com:8080",
    });
    const result = await claimRegisterSession(api, SESSION_ID);
    expect(result.kind).toBe("invalid_response");
    expect(existsSync(getConfigPath())).toBe(false);
  });
});
