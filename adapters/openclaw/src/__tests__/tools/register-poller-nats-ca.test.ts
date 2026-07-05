/**
 * RED — openclaw persists the register-response nats_ca (register-poller.ts).
 *
 * Card: auto-trust-nats-ca-from-register.
 * openclaw half of the six-adapter symmetry audit (Scenario 1 persist +
 * Scenario 3 no-regression):
 *
 *   - response carries a PEM nats_ca → ${klodi_home}/nats-ca.pem written
 *     alongside config.json; claimRegisterSession returns `registered`.
 *   - response omits nats_ca → nothing new persisted; config still lands
 *     (older @klodi/web ⇒ no regression); an existing persisted CA is not
 *     deleted on a later omission.
 *
 * nats_ca is OPTIONAL — never added to the required-field check, so an absent
 * value never fails registration. RED today: persistCompleted ignores nats_ca.
 *
 * Mirrors register-poller-tls.test.ts (fetch mocked, temp KLODI_HOME, nats
 * client mocked). QA-owned. NEVER weaken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../lib/client.js", () => import("../helpers/mock-nats.js"));

import { claimRegisterSession } from "../../tools/register-poller.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getConfigPath, getCredsPath, getKlodiHome } from "../../lib/paths.js";
import { __resetWakePumpRegistryForTests } from "@klodi/nats-client";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TLS_PROD_URL = "tls://hayabusa.proxy.rlwy.net:32770";
const REG_CA = "-----BEGIN CERTIFICATE-----\nMIICopenclawRegisterCa\n-----END CERTIFICATE-----\n";

const BASE_PAYLOAD = {
  status: "completed",
  nats_creds: "creds-bytes",
  handle: "newuser",
  user_id: "uid-new",
  nkey_public: "NKEY",
  nats_url: TLS_PROD_URL,
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
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response as unknown as Response);
}

function natsCaFile(): string {
  return join(getKlodiHome(), "nats-ca.pem");
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

describe("claimRegisterSession — nats_ca persistence", () => {
  it("persists a register nats_ca to ${klodi_home}/nats-ca.pem", async () => {
    mockFetchOnce(200, { ...BASE_PAYLOAD, nats_ca: REG_CA });
    const result = await claimRegisterSession(api, SESSION_ID);

    expect(result.kind).toBe("registered");
    expect(existsSync(natsCaFile())).toBe(true);
    expect(readFileSync(natsCaFile(), "utf-8")).toBe(REG_CA);
    expect(existsSync(getConfigPath())).toBe(true);
  });

  it("omits nats_ca → nothing new persisted, but creds + config still land", async () => {
    mockFetchOnce(200, { ...BASE_PAYLOAD }); // older @klodi/web
    const result = await claimRegisterSession(api, SESSION_ID);

    expect(result.kind).toBe("registered");
    expect(existsSync(natsCaFile())).toBe(false);
    expect(existsSync(getConfigPath())).toBe(true);
    expect(existsSync(getCredsPath())).toBe(true);
  });
});
