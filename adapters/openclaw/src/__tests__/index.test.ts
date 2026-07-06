/**
 * Tests for adapters/openclaw/src/index.ts (plugin entry point).
 *
 * Locks the registration contract: definePluginEntry receives a
 * register() callback that wires up every tool group and applies
 * pluginConfig overrides. The wake-pump start path is best-effort
 * here — non-gateway runtimes log skip and continue.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { PluginAPI } from "openclaw/plugin-sdk";

vi.mock("../lib/client.js", () =>
  import("./helpers/mock-nats.js"),
);

let capturedRegisterFn: ((api: PluginAPI) => void) | null = null;

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: vi.fn(
    (entry: { register: (api: PluginAPI) => void }) => {
      capturedRegisterFn = entry.register;
    },
  ),
}));

vi.mock("../tools/identity.js", () => ({ registerIdentityTools: vi.fn() }));
vi.mock("../tools/listings.js", () => ({ registerListingTools: vi.fn() }));
vi.mock("../tools/discovery.js", () => ({ registerDiscoveryTools: vi.fn() }));
vi.mock("../tools/negotiation.js", () => ({ registerNegotiationTools: vi.fn() }));
vi.mock("../tools/offers.js", () => ({ registerOfferTools: vi.fn() }));
vi.mock("../tools/transactions.js", () => ({ registerTransactionTools: vi.fn() }));
vi.mock("../tools/setup.js", () => ({ registerSetupTools: vi.fn() }));
vi.mock("../service/wake-pump.js", () => ({
  startWakePumpIfPossible: vi.fn().mockResolvedValue(null),
  stopWakePump: vi.fn().mockResolvedValue(undefined),
  scheduleWakePumpRetry: vi.fn(),
}));

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerIdentityTools } from "../tools/identity.js";
import { registerListingTools } from "../tools/listings.js";
import { registerDiscoveryTools } from "../tools/discovery.js";
import { registerNegotiationTools } from "../tools/negotiation.js";
import { registerOfferTools } from "../tools/offers.js";
import { registerTransactionTools } from "../tools/transactions.js";
import { registerSetupTools } from "../tools/setup.js";
import {
  scheduleWakePumpRetry,
  startWakePumpIfPossible,
} from "../service/wake-pump.js";
import { setKlodiHome, setApiUrl, getKlodiHome, getApiUrl } from "../lib/paths.js";
import { createMockPluginApi } from "./helpers/mock-plugin-api.js";

beforeAll(async () => {
  await import("../index.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module-level state in paths.ts so the tests start at "default".
  setKlodiHome("");
  setApiUrl("");
});

describe("plugin entry", () => {
  it("captures a register function from definePluginEntry", () => {
    // Note: beforeEach clears the call history of definePluginEntry, but
    // the captured register function survives across resets.
    expect(capturedRegisterFn).toBeTypeOf("function");
  });

  it("registers all 7 tool groups with the api", () => {
    // klodi_assets_upload_url and its registerMediaTools wrapper were
    // removed when uploads were folded into the listing tools — listings.ts
    // now handles photo uploads internally via tools/photos.ts.
    const api = createMockPluginApi();
    capturedRegisterFn!(api);
    expect(registerIdentityTools).toHaveBeenCalledWith(api);
    expect(registerListingTools).toHaveBeenCalledWith(api);
    expect(registerDiscoveryTools).toHaveBeenCalledWith(api);
    expect(registerNegotiationTools).toHaveBeenCalledWith(api);
    expect(registerOfferTools).toHaveBeenCalledWith(api);
    expect(registerTransactionTools).toHaveBeenCalledWith(api);
    expect(registerSetupTools).toHaveBeenCalledWith(api);
  });

  it("kicks off the wake pump (best-effort)", () => {
    const api = createMockPluginApi();
    capturedRegisterFn!(api);
    expect(startWakePumpIfPossible).toHaveBeenCalledWith(api);
  });

  it("schedules a background retry when register-time start throws", async () => {
    // Already-registered personas never re-enter klodi_register, so a
    // boot-time NATS-WS handshake failure must arm a retry from here —
    // otherwise the persona stays inbound-deaf until process restart.
    vi.mocked(startWakePumpIfPossible).mockRejectedValueOnce(
      new Error("ws timeout"),
    );
    const api = createMockPluginApi();
    capturedRegisterFn!(api);
    // The catch handler runs on the rejection microtask — flush it.
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleWakePumpRetry).toHaveBeenCalledWith(api);
    expect(api.logger.warn).toHaveBeenCalledWith(
      "wake_pump_register_start_failed",
      expect.objectContaining({ error: "ws timeout" }),
    );
  });

  it("does not schedule a retry on the success path", async () => {
    vi.mocked(startWakePumpIfPossible).mockResolvedValueOnce(null);
    const api = createMockPluginApi();
    capturedRegisterFn!(api);
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduleWakePumpRetry).not.toHaveBeenCalled();
  });

  it("applies klodi_home override from pluginConfig", () => {
    const api = createMockPluginApi({
      pluginConfig: { klodi_home: "/custom/klodi/home" },
    });
    capturedRegisterFn!(api);
    expect(getKlodiHome()).toBe("/custom/klodi/home");
  });

  it("applies klodi_api_url override from pluginConfig", () => {
    const api = createMockPluginApi({
      pluginConfig: { klodi_api_url: "https://api.staging.example.com" },
    });
    capturedRegisterFn!(api);
    expect(getApiUrl()).toBe("https://api.staging.example.com");
  });

  it("ignores klodi_api_url at the top of api.config (only pluginConfig is plugin-scoped)", () => {
    const api = createMockPluginApi({
      config: { klodi_api_url: "https://wrong-source.example.com" },
      pluginConfig: {},
    });
    capturedRegisterFn!(api);
    // The override never landed — getApiUrl falls back to env or default.
    expect(getApiUrl()).not.toBe("https://wrong-source.example.com");
  });

  it("ignores empty-string overrides", () => {
    const api = createMockPluginApi({
      pluginConfig: { klodi_api_url: "", klodi_home: "" },
    });
    capturedRegisterFn!(api);
    // Default path lives under ~/.openclaw/workspace/.klodi
    expect(getKlodiHome()).toContain(".klodi");
  });

  it("logs klodi_plugin_loaded with full observability payload", () => {
    const api = createMockPluginApi();
    capturedRegisterFn!(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      "klodi_plugin_loaded",
      expect.objectContaining({
        message: expect.stringContaining("klodi marketplace plugin registered"),
        api_url: expect.any(String),
        api_url_source: expect.any(String),
        klodi_home: expect.any(String),
        klodi_home_source: expect.any(String),
        plugin_source: expect.any(String),
        plugin_source_source: expect.any(String),
      }),
    );
  });
});
