/**
 * Plugin entry point tests.
 * Verifies that definePluginEntry is called correctly and
 * all tool/service registrations are invoked.
 *
 * Config source contract: plugin-scoped keys (`klodi_api_url`,
 * `klodi_home`) MUST come from `api.pluginConfig` — which OpenClaw
 * populates from `plugins.klodi.config.*` and validates against
 * `openclaw.plugin.json#configSchema`. The plugin must NOT read
 * these from the global `api.config` tree; that would make a user
 * override at `plugins.klodi.config.klodi_api_url` silently ignored.
 */

import { vi, describe, it, expect, beforeAll } from "vitest";
import { createMockPluginApi } from "./helpers/mock-plugin-api.js";

// ── Capture the register function ──────────────────────────────────────────

let capturedRegisterFn: ((api: any) => void) | null = null;

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: vi.fn(
    (entry: { register: (api: any) => void }) => {
      capturedRegisterFn = entry.register;
    },
  ),
}));

// NOTE on the applyPluginConfigOverrides mock below:
// The proposed `vi.importActual` + spread pattern does NOT work here —
// when vitest spreads the real `applyPluginConfigOverrides` into the
// mock, its internal ES binding to `setApiUrl` / `setKlodiHome` remains
// bound to the real module's original exports, not the mocks. The
// expectations on `setApiUrl` / `setKlodiHome` would never fire.
// Instead we mock `applyPluginConfigOverrides` with a faithful
// re-implementation of its contract (see lib/config.ts), so every
// delegation assertion below runs end-to-end via the mocks. The
// contract of the real `applyPluginConfigOverrides` is covered
// directly in `__tests__/lib/config.test.ts`.
vi.mock("../lib/config.js", () => {
  const setKlodiHome = vi.fn();
  const setApiUrl = vi.fn();
  const applyPluginConfigOverrides = vi.fn(
    (pluginConfig: Record<string, unknown> | undefined) => {
      if (!pluginConfig) return;
      const home = pluginConfig["klodi_home"];
      if (typeof home === "string" && home.length > 0) {
        setKlodiHome(home);
      }
      const apiUrl = pluginConfig["klodi_api_url"];
      if (typeof apiUrl === "string" && apiUrl.length > 0) {
        setApiUrl(apiUrl);
      }
    },
  );
  return {
    setKlodiHome,
    setApiUrl,
    applyPluginConfigOverrides,
    hasCredentials: vi.fn(() => true),
    loadConfig: vi.fn(() => ({
      handle: "test",
      user_id: "uid",
      nkey_public: "nk",
      nats_url: "nats://localhost",
    })),
    // Observability getters consumed by `klodi_plugin_loaded` log
    // payload in src/index.ts. Fixed values — the contract under
    // test is that the log includes all four fields; the underlying
    // source-tracking logic is covered in lib/config.test.ts.
    getApiUrl: vi.fn(() => "https://klodi.4gpts.com"),
    getApiUrlSource: vi.fn(() => "default"),
    getKlodiHome: vi.fn(() => "/tmp/.klodi"),
    getKlodiHomeSource: vi.fn(() => "default"),
  };
});

vi.mock("../service/nats.js", () => ({
  registerNatsService: vi.fn(),
}));

vi.mock("../tools/identity.js", () => ({ registerIdentityTools: vi.fn() }));
vi.mock("../tools/listings.js", () => ({ registerListingTools: vi.fn() }));
vi.mock("../tools/discovery.js", () => ({ registerDiscoveryTools: vi.fn() }));
vi.mock("../tools/negotiation.js", () => ({ registerNegotiationTools: vi.fn() }));
vi.mock("../tools/offers.js", () => ({ registerOfferTools: vi.fn() }));
vi.mock("../tools/transactions.js", () => ({ registerTransactionTools: vi.fn() }));
vi.mock("../tools/media.js", () => ({ registerMediaTools: vi.fn() }));
vi.mock("../tools/pending.js", () => ({ registerPendingTool: vi.fn() }));
vi.mock("../tools/setup.js", () => ({ registerSetupTools: vi.fn() }));

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { setKlodiHome, setApiUrl } from "../lib/config.js";
import { registerNatsService } from "../service/nats.js";
import { registerIdentityTools } from "../tools/identity.js";
import { registerListingTools } from "../tools/listings.js";
import { registerDiscoveryTools } from "../tools/discovery.js";
import { registerNegotiationTools } from "../tools/negotiation.js";
import { registerOfferTools } from "../tools/offers.js";
import { registerTransactionTools } from "../tools/transactions.js";
import { registerMediaTools } from "../tools/media.js";
import { registerPendingTool } from "../tools/pending.js";
import { registerSetupTools } from "../tools/setup.js";

// ── Trigger module import ──────────────────────────────────────────────────

beforeAll(async () => {
  await import("../index.js");
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("plugin registration", () => {
  it("calls definePluginEntry with register function", () => {
    expect(definePluginEntry).toHaveBeenCalledTimes(1);
    expect(capturedRegisterFn).toBeTypeOf("function");
  });

  it("applies klodi_home pluginConfig override when set", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: { klodi_home: "/custom/klodi/home" },
    });

    capturedRegisterFn!(api);

    expect(setKlodiHome).toHaveBeenCalledWith("/custom/klodi/home");
  });

  it("does not call setKlodiHome when pluginConfig is empty", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi();

    capturedRegisterFn!(api);

    expect(setKlodiHome).not.toHaveBeenCalled();
  });

  it("applies klodi_api_url pluginConfig override when set", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: { klodi_api_url: "https://api.staging.example.com" },
    });

    capturedRegisterFn!(api);

    expect(setApiUrl).toHaveBeenCalledWith("https://api.staging.example.com");
    expect(setKlodiHome).not.toHaveBeenCalled();
  });

  // Regression: the production bug this suite exists to prevent.
  // User sets plugins.klodi.config.klodi_api_url = "http://host.docker.internal:3000"
  // in OpenClaw. Before the fix, the plugin read `api.config` (the full
  // OpenClawConfig tree — top-level keys like `agents`, `plugins`) and
  // silently ignored the scoped override, falling back to the hardcoded
  // default. The scoped config is populated into `api.pluginConfig`.
  it("applies klodi_api_url from pluginConfig for docker host override (regression)", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: {
        klodi_api_url: "http://host.docker.internal:3000",
      },
    });

    capturedRegisterFn!(api);

    expect(setApiUrl).toHaveBeenCalledWith("http://host.docker.internal:3000");
  });

  it("ignores klodi_api_url nested under api.config (global tree is NOT plugin-scoped)", () => {
    // If a user mistakenly put klodi_api_url at the top of the global
    // OpenClaw config tree instead of under plugins.klodi.config, the
    // plugin must NOT pick it up. Only pluginConfig is authoritative.
    vi.clearAllMocks();
    const api = createMockPluginApi({
      config: { klodi_api_url: "https://wrong-source.example.com" },
      pluginConfig: {},
    });

    capturedRegisterFn!(api);

    expect(setApiUrl).not.toHaveBeenCalled();
  });

  it("does not call setApiUrl when klodi_api_url is absent", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi();

    capturedRegisterFn!(api);

    expect(setApiUrl).not.toHaveBeenCalled();
  });

  it("does not call setApiUrl when klodi_api_url is an empty string", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: { klodi_api_url: "" },
    });

    capturedRegisterFn!(api);

    expect(setApiUrl).not.toHaveBeenCalled();
  });

  it("does not call setKlodiHome when klodi_home is an empty string", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: { klodi_home: "" },
    });

    capturedRegisterFn!(api);

    expect(setKlodiHome).not.toHaveBeenCalled();
  });

  it("applies both overrides when set together", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi({
      pluginConfig: {
        klodi_api_url: "https://api.staging.example.com",
        klodi_home: "/tmp/custom-home",
      },
    });

    capturedRegisterFn!(api);

    expect(setApiUrl).toHaveBeenCalledWith("https://api.staging.example.com");
    expect(setKlodiHome).toHaveBeenCalledWith("/tmp/custom-home");
  });

  it("registers NATS service", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi();

    capturedRegisterFn!(api);

    expect(registerNatsService).toHaveBeenCalledWith(api);
  });

  it("registers all 9 tool groups", () => {
    vi.clearAllMocks();
    const api = createMockPluginApi();

    capturedRegisterFn!(api);

    expect(registerIdentityTools).toHaveBeenCalledWith(api);
    expect(registerListingTools).toHaveBeenCalledWith(api);
    expect(registerDiscoveryTools).toHaveBeenCalledWith(api);
    expect(registerNegotiationTools).toHaveBeenCalledWith(api);
    expect(registerOfferTools).toHaveBeenCalledWith(api);
    expect(registerTransactionTools).toHaveBeenCalledWith(api);
    expect(registerMediaTools).toHaveBeenCalledWith(api);
    expect(registerPendingTool).toHaveBeenCalledWith(api);
    expect(registerSetupTools).toHaveBeenCalledWith(api);
  });

  it("logs klodi_plugin_loaded on success with full observability payload", () => {
    // Locks in the observability contract: the plugin-loaded log MUST
    // include api_url/klodi_home values AND their *_source fields so an
    // operator can see at a glance whether the plugin is running on
    // defaults or user-provided overrides. A future refactor that drops
    // any of these keys will break this test — that is the point.
    vi.clearAllMocks();
    const api = createMockPluginApi();

    capturedRegisterFn!(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      "klodi_plugin_loaded",
      expect.objectContaining({
        message: expect.stringContaining("Klodi marketplace plugin registered"),
        api_url: expect.any(String),
        api_url_source: expect.any(String),
        klodi_home: expect.any(String),
        klodi_home_source: expect.any(String),
      }),
    );
  });
});
