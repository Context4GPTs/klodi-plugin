/**
 * RED — AC4: the in-agent path (klodi_register_poll → claimAndBringUp) still
 * persists creds AND (re)arms the wake pump, in the pinned
 * `stop → close → connect → start` order.
 *
 * After the register-core extraction, register-poller.ts keeps the plugin
 * runtime and adds ONE thin wrapper: `claimAndBringUp(api, sessionId)`. It
 * calls the PluginAPI-free core to claim + persist, and on `registered`
 * performs the plugin post-persist NATS refresh, enriching the result with
 * `nats_connected` / `nats_reason`. Both plugin call sites (the background
 * poll tick and klodi_register_poll) go through this wrapper.
 *
 * The pinned ordering `stopWakePump → closeClient → connectClient →
 * startWakePump` is the parity contract hermes locks in test_register.py;
 * openclaw must match. Arming the pump BEFORE draining the stale one, or
 * connecting before closing, would leak a consumer / dial on a half-torn
 * client. This test freezes that order.
 *
 * The four bring-up steps are mocked with a shared order log so the sequence
 * is observable directly. The claim + persist runs against the REAL core
 * (temp KLODI_HOME, mocked fetch), proving the wrapper persists too.
 *
 * QA-owned (adversarial-testing). NEVER weaken. Do NOT relax the order to
 * whatever the implementation happens to emit — the order IS the spec.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";

// Shared, hoisted so the vi.mock factories (hoisted above imports) can push
// into it without a TDZ error.
const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("../../lib/client.js", () => ({
  connectClient: vi.fn(async () => {
    order.push("connect");
    return { isConnected: () => true };
  }),
  closeClient: vi.fn(async () => {
    order.push("close");
  }),
  getClient: vi.fn(),
  isClientConnected: vi.fn(() => true),
  KlodiRequestError: class extends Error {},
}));

vi.mock("../../service/wake-pump.js", () => ({
  startWakePump: vi.fn(async () => {
    order.push("start");
    return {};
  }),
  stopWakePump: vi.fn(async () => {
    order.push("stop");
  }),
  startWakePumpIfPossible: vi.fn(),
  getWakePump: vi.fn(() => null),
  scheduleWakePumpRetry: vi.fn(),
}));

import { claimAndBringUp } from "../../tools/register-poller.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getCredsPath, getConfigPath } from "../../lib/paths.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
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
  order.length = 0;
  temp = createTempHome();
  api = createMockPluginApi();
});

afterEach(() => {
  temp.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("claimAndBringUp — persist + wake-pump refresh (AC4)", () => {
  it("persists creds+config AND arms the pump via stop → close → connect → start", async () => {
    mockFetchOnce(200, COMPLETED_PAYLOAD);

    const result = await claimAndBringUp(api, SESSION_ID);

    expect(result.kind).toBe("registered");
    if (result.kind === "registered") {
      // The wrapper re-attaches the plugin-runtime field the core dropped.
      expect(result.nats_connected).toBe(true);
    }

    // Persist actually happened (the wrapper still writes creds via the core).
    expect(existsSync(getCredsPath())).toBe(true);
    expect(existsSync(getConfigPath())).toBe(true);

    // The pinned NATS-refresh order — the whole reason this test exists.
    expect(order).toEqual(["stop", "close", "connect", "start"]);
  });
});
