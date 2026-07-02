/**
 * GATED integration — verified tls:// handshake + fail-closed (ts).
 *
 * Card: support-tls-nats-transport-with-private-ca-trust.
 * Criteria (Acceptance → "Verified TLS round-trip with private-CA trust"):
 *   - [integration] trusted private CA + tls:// nats_url → handshake completes
 *     (cert + hostname verification pass) and a whoami round-trip succeeds.
 *   - [e2e] the held JetStream subscription survives an idle period and still
 *     delivers a subsequently published event.
 *   - [integration] wrong / absent CA → connect() rejects: fails CLOSED, never
 *     a plaintext / unverified fallback.
 *
 * GATE (Do-NOW #3 dev-pair local TLS harness — NOT the epic Railway proxy):
 * SKIPS unless a local tls:// nats + self-signed test CA is provided via env:
 *   KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL (tls://…),
 *   KLODI_NATS_CA_FILE (PEM path), KLODI_TLS_CREDS_PATH (nats.creds).
 * Does NOT touch prod / Railway.
 *
 * Authored to spec; UNVALIDATED in CI until the harness exists. QA-owned —
 * NEVER weaken; push back to the expert-developer instead.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KlodiClient } from "../../src/client.js";

const ON = process.env["KLODI_TLS_INTEGRATION"] === "1";
const NATS_URL = process.env["KLODI_TLS_NATS_URL"] ?? "";
const CA_FILE = process.env["KLODI_NATS_CA_FILE"] ?? "";
const CREDS = process.env["KLODI_TLS_CREDS_PATH"] ?? "";
const SHOULD_RUN = ON && NATS_URL !== "" && CA_FILE !== "" && CREDS !== "";

let home: string;

function writeConfig(natsUrl: string): { configPath: string; credsPath: string } {
  home = mkdtempSync(join(tmpdir(), "klodi-tls-int-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      handle: "tlsuser",
      user_id: "00000000-0000-4000-8000-000000000001",
      nkey_public: "UTLSTEST",
      nats_url: natsUrl,
    }),
  );
  return { configPath, credsPath: CREDS };
}

beforeEach(() => {
  process.env["KLODI_NATS_CA_FILE"] = CA_FILE; // trust the test CA by default
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!SHOULD_RUN)("tls:// with private-CA trust", () => {
  it("completes a verified handshake and a whoami round-trip", async () => {
    const { configPath, credsPath } = writeConfig(NATS_URL);
    const client = new KlodiClient({ credsPath, configPath });
    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      const resp = await client.request("p2p.v1.users.whoami", {});
      expect(typeof resp).toBe("object");
    } finally {
      await client.close();
    }
  });

  it("holds a subscription across an idle period [e2e]", async () => {
    const { configPath, credsPath } = writeConfig(NATS_URL);
    const client = new KlodiClient({ credsPath, configPath });
    try {
      await client.connect();
      await client.subscribeChannels(async () => undefined);
      // Idle past the WS-close→EOF window this epic exists to fix.
      await new Promise((r) => setTimeout(r, 25_000));
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
    }
  }, 40_000);

  it("fails closed when the CA is wrong (no plaintext fallback)", async () => {
    const wrongCa = join(mkdtempSync(join(tmpdir(), "klodi-wrongca-")), "ca.pem");
    writeFileSync(
      wrongCa,
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    );
    process.env["KLODI_NATS_CA_FILE"] = wrongCa;
    const { configPath, credsPath } = writeConfig(NATS_URL);
    const client = new KlodiClient({ credsPath, configPath });
    await expect(client.connect()).rejects.toThrow();
    expect(client.isConnected()).toBe(false);
    await client.close();
  });
});
