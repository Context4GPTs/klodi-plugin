/**
 * RED — the PluginAPI-free register core (src/lib/register-core.ts).
 *
 * This module is the single claim + persist-to-disk path, EXTRACTED (moved,
 * not copied) out of tools/register-poller.ts. It is the TS analogue of the
 * rust `run_register` core: it claims a session, validates + persists creds /
 * config / optional CA, and returns a `ClaimResult` — and does NOTHING that
 * touches the plugin runtime (no PluginAPI, no NATS connect, no wake pump).
 * See ADR-0015 (loaded ≠ armed): a short-lived register process must never
 * arm a JetStream consumer, so the persist/claim logic lives here, free of
 * every plugin-runtime side effect.
 *
 * This file ABSORBS the coverage that previously lived in
 * register-poller-tls.test.ts and register-poller-nats-ca.test.ts (deleted):
 * the tls:// fail-fast guard and the optional-`nats_ca` contract move here
 * because the persist code that enforces them moved here. The module boundary
 * moved; the assertions did not weaken.
 *
 * Contract asserted:
 *   - `claimRegisterSession(sessionId, logger?)` — NO PluginAPI parameter.
 *     Callable with just a session id. This is the "PluginAPI-free" proof.
 *   - completed + tls:// + nats_ca → nats.creds (0600) + config.json +
 *     ${KLODI_HOME}/nats-ca.pem written; returns `registered`.
 *   - the `registered` variant DROPS `nats_connected` / `nats_reason` — those
 *     are plugin-runtime fields, re-attached only by the register-poller
 *     wrapper (claimAndBringUp). The core never sets them.
 *   - persisting arms NO wake pump and opens NO client — proven by spies on
 *     the (mocked) wake-pump + client modules that must stay UNCALLED.
 *   - non-tls:// nats_url (nats:// / ws:// / wss://non-localhost / ws://localhost)
 *     → invalid_response, NOTHING on disk (bare assertTls, no localhost bypass).
 *   - missing required fields → invalid_response.
 *   - optional CA: absent nats_ca → creds + config land, NO nats-ca.pem, still
 *     `registered`.
 *   - non-terminal kind mapping: pending / expired / already_claimed (409) /
 *     http_error (500) / transport_error (fetch reject).
 *
 * QA-owned (adversarial-testing). NEVER weaken. Do NOT re-introduce a
 * PluginAPI parameter, a localhost bypass, or a required-`nats_ca` check to
 * make any assertion pass — the implementation is the servant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Regression tripwires: the core must not reach into the plugin runtime. If
// the implementation ever imports + calls these, the spies here fire and the
// "no bring-up" assertion in the happy-path test FAILS. The core does not
// import these modules today, so the spies stay uncalled (pass).
vi.mock("../../lib/client.js", () => ({
  connectClient: vi.fn(),
  closeClient: vi.fn(),
  getClient: vi.fn(),
  isClientConnected: vi.fn(() => false),
  KlodiRequestError: class extends Error {},
}));
vi.mock("../../service/wake-pump.js", () => ({
  startWakePump: vi.fn(),
  stopWakePump: vi.fn(),
  startWakePumpIfPossible: vi.fn(),
  getWakePump: vi.fn(() => null),
  scheduleWakePumpRetry: vi.fn(),
}));

import { claimRegisterSession } from "../../lib/register-core.js";
import { connectClient, closeClient } from "../../lib/client.js";
import { startWakePump, stopWakePump } from "../../service/wake-pump.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getCredsPath, getConfigPath, getKlodiHome } from "../../lib/paths.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TLS_PROD_URL = "tls://hayabusa.proxy.rlwy.net:32770";
const REG_CA =
  "-----BEGIN CERTIFICATE-----\nMIICopenclawRegisterCa\n-----END CERTIFICATE-----\n";

// The required-field envelope minus nats_url (added per-case).
const BASE_PAYLOAD = {
  status: "completed",
  nats_creds: "creds-bytes",
  handle: "newuser",
  user_id: "uid-new",
  nkey_public: "NKEY",
};

const COMPLETED_PAYLOAD = { ...BASE_PAYLOAD, nats_url: TLS_PROD_URL };

let temp: TempHome;

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

function natsCaFile(): string {
  return join(getKlodiHome(), "nats-ca.pem");
}

beforeEach(() => {
  temp = createTempHome();
});

afterEach(() => {
  temp.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("register-core.claimRegisterSession — happy path (PluginAPI-free)", () => {
  it("completed+tls+ca → creds(0600) + config + nats-ca.pem, registered, NO bring-up", async () => {
    mockFetchOnce(200, { ...COMPLETED_PAYLOAD, nats_ca: REG_CA });

    // Called with a session id ONLY — no PluginAPI. If the core still requires
    // an `api` first-arg, TS + runtime will reject this call.
    const result = await claimRegisterSession(SESSION_ID);

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.handle).toBe("newuser");
    expect(result.negotiation_style_seeded).toBe(true);
    expect(result.security_policy_seeded).toBe(true);

    // The registered variant is the CORE shape: plugin-runtime fields dropped.
    expect("nats_connected" in result).toBe(false);
    expect("nats_reason" in result).toBe(false);

    // Files on disk.
    expect(existsSync(getCredsPath())).toBe(true);
    expect(statSync(getCredsPath()).mode & 0o077).toBe(0); // 0600 — no group/world
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(cfg.handle).toBe("newuser");
    expect(cfg.nats_url).toBe(TLS_PROD_URL);
    expect(existsSync(natsCaFile())).toBe(true);
    expect(readFileSync(natsCaFile(), "utf-8")).toBe(REG_CA);

    // The core arms NO pump and opens NO client — the whole point of the
    // extraction (ADR-0015). These spies must never have fired.
    expect(stopWakePump).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();
    expect(connectClient).not.toHaveBeenCalled();
    expect(startWakePump).not.toHaveBeenCalled();
  });
});

describe("register-core.claimRegisterSession — tls:// fail-fast (bare assertTls)", () => {
  for (const [label, natsUrl] of [
    ["plaintext nats://", "nats://hayabusa.proxy.rlwy.net:4222"],
    ["plaintext ws:// non-localhost", "ws://attacker.example.com:8080"],
    ["wss:// non-localhost", "wss://klodi-net.4gpts.com"],
    // The flip: localhost is NOT a bypass. Never re-add a localhost carve-out
    // so this case passes.
    ["ws://localhost", "ws://localhost:8080"],
  ] as const) {
    it(`rejects a ${label} nats_url → invalid_response, nothing persisted`, async () => {
      mockFetchOnce(200, { ...BASE_PAYLOAD, nats_url: natsUrl });
      const result = await claimRegisterSession(SESSION_ID);
      expect(result.kind).toBe("invalid_response");
      expect(existsSync(getCredsPath())).toBe(false);
      expect(existsSync(getConfigPath())).toBe(false);
      expect(existsSync(natsCaFile())).toBe(false);
    });
  }

  it("returns invalid_response when required fields are missing", async () => {
    mockFetchOnce(200, { status: "completed", nats_creds: "x" }); // handle/user_id absent
    const result = await claimRegisterSession(SESSION_ID);
    expect(result.kind).toBe("invalid_response");
    expect(existsSync(getCredsPath())).toBe(false);
  });
});

describe("register-core.claimRegisterSession — optional nats_ca (ADR-0022)", () => {
  it("omits nats_ca → creds + config land, NO nats-ca.pem, still registered", async () => {
    mockFetchOnce(200, { ...COMPLETED_PAYLOAD }); // older @klodi/web: no nats_ca
    const result = await claimRegisterSession(SESSION_ID);
    expect(result.kind).toBe("registered");
    expect(existsSync(getCredsPath())).toBe(true);
    expect(existsSync(getConfigPath())).toBe(true);
    expect(existsSync(natsCaFile())).toBe(false);
  });
});

describe("register-core.claimRegisterSession — non-terminal / transient kinds", () => {
  it("returns pending on status=pending", async () => {
    mockFetchOnce(200, { status: "pending" });
    expect((await claimRegisterSession(SESSION_ID)).kind).toBe("pending");
  });

  it("returns expired on status=expired", async () => {
    mockFetchOnce(200, { status: "expired" });
    expect((await claimRegisterSession(SESSION_ID)).kind).toBe("expired");
  });

  it("returns already_claimed on 409 CREDENTIALS_ALREADY_CLAIMED", async () => {
    mockFetchOnce(409, { error: "CREDENTIALS_ALREADY_CLAIMED" });
    expect((await claimRegisterSession(SESSION_ID)).kind).toBe("already_claimed");
  });

  it("returns http_error on a generic 500", async () => {
    mockFetchOnce(500, { error: "internal" });
    const result = await claimRegisterSession(SESSION_ID);
    expect(result.kind).toBe("http_error");
    if (result.kind === "http_error") expect(result.status).toBe(500);
  });

  it("returns transport_error on fetch rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await claimRegisterSession(SESSION_ID);
    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.message).toContain("ECONNRESET");
    }
  });
});
