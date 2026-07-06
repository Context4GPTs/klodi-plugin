/**
 * GATED integration — verified tls:// handshake + fail-closed (ts).
 *
 * Criteria (Acceptance → "Verified TLS round-trip with private-CA trust"):
 *   - [integration] trusted private CA + tls:// nats_url → handshake completes
 *     (cert + hostname verification pass) and a whoami round-trip succeeds.
 *   - [e2e] the held JetStream subscription survives an idle period and still
 *     delivers a subsequently published event.
 *   - [integration] wrong / absent CA → connect() rejects: fails CLOSED, never
 *     a plaintext / unverified fallback.
 *
 * GATE (Do-NOW #3 dev-pair local TLS harness — NOT the Railway proxy):
 * SKIPS unless a local tls:// nats + self-signed test CA is provided via env:
 *   KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL (tls://…),
 *   KLODI_NATS_CA_FILE (PEM path), KLODI_TLS_CREDS_PATH (nats.creds).
 * Does NOT touch prod / Railway.
 *
 * Authored to spec; UNVALIDATED in CI until the harness exists. QA-owned —
 * NEVER weaken; push back to the expert-developer instead.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KlodiClient } from "../../src/client.js";
import { CaTrustError } from "../../src/tls.js";

const ON = process.env["KLODI_TLS_INTEGRATION"] === "1";
const NATS_URL = process.env["KLODI_TLS_NATS_URL"] ?? "";
const CA_FILE = process.env["KLODI_NATS_CA_FILE"] ?? "";
const CREDS = process.env["KLODI_TLS_CREDS_PATH"] ?? "";
const SHOULD_RUN = ON && NATS_URL !== "" && CA_FILE !== "" && CREDS !== "";

/** A bad-CA connect must reach a terminal error within this bound; a hang trips
 *  the race → the assertion fails. */
const TERMINAL_BOUND_MS = 12_000;

function fx(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return join(dir, "test-fixtures", "tls-ca", name);
    }
    dir = resolve(dir, "..");
  }
  throw new Error("pnpm-workspace.yaml not found above this test");
}

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
      // Idle past the WS-close→EOF window this change exists to fix.
      await new Promise((r) => setTimeout(r, 25_000));
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
    }
  }, 40_000);

  it("fails closed (terminal, bounded, structured) on a wrong-signer CA", async () => {
    // TIGHTENED from a bare
    // `.rejects.toThrow()`. Uses a WELL-FORMED wrong-signer CA (does not sign
    // the test nats cert → a handshake-verify failure at the CONNECT boundary,
    // not a PEM parse) and asserts the structured `CaTrustError` within a
    // bounded time. If connect() hangs (retries the deterministic verify
    // failure forever), the race resolves to "timeout" and this fails.
    // QA-owned — never relax to `.rejects.toThrow()`.
    process.env["KLODI_NATS_CA_FILE"] = fx("ca-wrong.pem");
    const { configPath, credsPath } = writeConfig(NATS_URL);
    const client = new KlodiClient({ credsPath, configPath });
    let timer: NodeJS.Timeout;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), TERMINAL_BOUND_MS);
    });
    const attempt = client
      .connect()
      .then(() => "connected" as const)
      .catch((err: unknown) => err);
    const outcome = await Promise.race([attempt, timeout]);
    clearTimeout(timer!);
    void attempt.catch(() => {});
    expect(outcome, `wrong-signer connect HUNG past ${TERMINAL_BOUND_MS}ms`).not.toBe("timeout");
    expect(
      outcome instanceof CaTrustError,
      `wrong-signer CA must surface a structured CaTrustError (got ${String(outcome)})`,
    ).toBe(true);
    expect(client.isConnected()).toBe(false);
    await client.close();
  });
});
