/**
 * Adapter-wiring unit tests for runtime-analytics header injection —
 * card stamp-plugin-source-and-runtime-headers.
 *
 * RED-first. `adapters/openclaw/src/lib/client.ts` constructs the shared
 * `KlodiClient` at two sites (`connectClient` L25, `getClient` L54) passing
 * only `{ credsPath, configPath, onError }`. This card requires both sites to
 * also pass `runtimeHeaders` carrying:
 *   - `X-Klodi-Runtime`        = the static adapter literal "openclaw"
 *   - `X-Klodi-Plugin-Source`  = the resolved install source, from
 *                                `getPluginSource()` in `lib/paths.ts`:
 *       process.env.KLODI_PLUGIN_SOURCE set   → that value (e.g. "clawhub"/"npm")
 *       process.env.KLODI_PLUGIN_SOURCE unset → the literal "unknown"
 *
 * The source key is ALWAYS present — never omitted, never silently defaulted
 * to "npm". `unknown` is the floor (a queryable cohort, not null), so the
 * marketplace registration row's `plugin_source` is always non-null.
 *
 * We SPY ON THE KlodiClient CONSTRUCTOR ARGS by mocking `@klodi/nats-client`,
 * rather than standing up a real NATS connection — the wiring under test is
 * "what args does the adapter hand the shared client", which is fully
 * observable at the constructor boundary. The `openclaw` literal and the
 * plugin-source concept must live ONLY here in the adapter, never in the
 * shared client (asserted in the sibling shared-client test).
 *
 * Per the adversarial-testing skill: NEVER weaken these asserts. If the
 * implementation omits the source key when the env var is unset, or defaults
 * it to "npm", the implementation is wrong — these tests stay strict.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the shared client so we can capture the constructor args the adapter
// hands it. The mock records every `new KlodiClient(args)` call; `connect()` /
// `close()` are inert so `connectClient` / `closeClient` run without I/O.
const constructorArgs: Array<Record<string, unknown>> = [];

vi.mock("@klodi/nats-client", () => {
  class MockKlodiClient {
    public readonly args: Record<string, unknown>;
    constructor(args: Record<string, unknown>) {
      this.args = args;
      constructorArgs.push(args);
    }
    async connect(): Promise<void> {
      return undefined;
    }
    async close(): Promise<void> {
      return undefined;
    }
    isConnected(): boolean {
      return true;
    }
  }
  class KlodiRequestError extends Error {}
  return { KlodiClient: MockKlodiClient, KlodiRequestError };
});

import { connectClient, getClient, closeClient } from "../../lib/client.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";

function lastRuntimeHeaders(): Record<string, string> {
  const args = constructorArgs.at(-1);
  expect(args, "expected at least one KlodiClient construction").toBeDefined();
  // RED: `runtimeHeaders` is not yet passed by the adapter, so this is
  // undefined until the GREEN wiring lands.
  return args!["runtimeHeaders"] as Record<string, string>;
}

beforeEach(async () => {
  constructorArgs.length = 0;
  delete process.env["KLODI_PLUGIN_SOURCE"];
  // Reset the module-level singleton so each test constructs fresh.
  await closeClient();
});

afterEach(async () => {
  delete process.env["KLODI_PLUGIN_SOURCE"];
  await closeClient();
});

describe("connectClient — runtime header injection", () => {
  it("always stamps X-Klodi-Runtime=openclaw", async () => {
    const api = createMockPluginApi();
    await connectClient(api);

    const hdrs = lastRuntimeHeaders();
    expect(hdrs).toBeDefined();
    expect(hdrs["X-Klodi-Runtime"]).toBe("openclaw");
  });

  it("X-Klodi-Plugin-Source=clawhub when KLODI_PLUGIN_SOURCE=clawhub", async () => {
    process.env["KLODI_PLUGIN_SOURCE"] = "clawhub";
    const api = createMockPluginApi();
    await connectClient(api);

    const hdrs = lastRuntimeHeaders();
    expect(hdrs["X-Klodi-Plugin-Source"]).toBe("clawhub");
    expect(hdrs["X-Klodi-Runtime"]).toBe("openclaw");
  });

  it("X-Klodi-Plugin-Source=npm when KLODI_PLUGIN_SOURCE=npm", async () => {
    process.env["KLODI_PLUGIN_SOURCE"] = "npm";
    const api = createMockPluginApi();
    await connectClient(api);

    expect(lastRuntimeHeaders()["X-Klodi-Plugin-Source"]).toBe("npm");
  });

  it("X-Klodi-Plugin-Source=unknown when KLODI_PLUGIN_SOURCE is unset (never omitted, never npm)", async () => {
    delete process.env["KLODI_PLUGIN_SOURCE"];
    const api = createMockPluginApi();
    await connectClient(api);

    const hdrs = lastRuntimeHeaders();
    // The source key is ALWAYS present.
    expect("X-Klodi-Plugin-Source" in hdrs).toBe(true);
    // It is the honest `unknown` sentinel — NOT a fabricated `npm`.
    expect(hdrs["X-Klodi-Plugin-Source"]).toBe("unknown");
    expect(hdrs["X-Klodi-Plugin-Source"]).not.toBe("npm");
    // Runtime is still stamped — the call stays attributable.
    expect(hdrs["X-Klodi-Runtime"]).toBe("openclaw");
  });
});

describe("getClient — runtime header injection at the lazy-construct site", () => {
  it("stamps the same runtime + source headers as connectClient", async () => {
    process.env["KLODI_PLUGIN_SOURCE"] = "clawhub";
    const api = createMockPluginApi();
    // connectClient primes the module-level `pluginApi`. closeClient clears the
    // constructed `client` (but not `pluginApi`), so a subsequent getClient()
    // takes its OWN lazy-construct branch — exactly the production path where a
    // tool calls getClient() after the singleton was dropped. We then observe
    // the args getClient() handed the shared client.
    await connectClient(api);
    await closeClient();
    constructorArgs.length = 0;

    getClient();

    const hdrs = lastRuntimeHeaders();
    expect(hdrs["X-Klodi-Runtime"]).toBe("openclaw");
    expect(hdrs["X-Klodi-Plugin-Source"]).toBe("clawhub");
  });
});
