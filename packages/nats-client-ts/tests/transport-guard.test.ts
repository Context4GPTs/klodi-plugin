/**
 * Transport guard collapsed to `tls://` only (ts client).
 *
 * Card: collapse-nats-transport-guard-to-tls-only. The ts arm of the
 * py/rs guard matrix — flips the prior wss://-acceptance suite to
 * wss://-rejection:
 *
 *   - `tls://<non-localhost>`  → accepts (the sole prod transport)
 *   - `wss://<non-localhost>`  → REJECTS (was accepted; the collapse)
 *   - `ws://<non-localhost>`   → REJECTS (unchanged)
 *   - `nats://<non-localhost>` → REJECTS (unchanged)
 *   - any scheme @ localhost   → accepts (localhost bypass unchanged)
 *
 * COORDINATION: the guard is renamed in-dev `assertEncryptedOrLocalhost`
 * → `assertTlsOrLocalhost` (once wss:// is rejected off-localhost,
 * "encrypted" misleads). This file imports the NEW name; the module fails
 * to resolve it until the rename lands (expected RED — the rename IS the
 * deliverable). No re-export shim for the old name (CLAUDE.md: no
 * backwards-compat).
 *
 * QA-owned (adversarial-testing). NEVER weaken these asserts.
 */

import { describe, expect, it } from "vitest";

import { assertTlsOrLocalhost } from "../src/index.js";

// The pinned prod endpoint: Railway's L4 TCP proxy in front of NATS
// (devops §1 — NOT `kodama`, which is pgvector's Postgres proxy).
const TLS_PROD = "tls://hayabusa.proxy.rlwy.net:32770";
const WSS_PROD = "wss://klodi-net.4gpts.com";
const NATS_PLAINTEXT = "nats://hayabusa.proxy.rlwy.net:4222";
const WS_PLAINTEXT = "ws://attacker.example.com:8080";

describe("assertTlsOrLocalhost — tls:// is the sole accepted scheme", () => {
  it("accepts tls:// on a non-localhost host", () => {
    expect(() => assertTlsOrLocalhost(TLS_PROD)).not.toThrow();
  });

  it("accepts an arbitrary tls:// non-localhost host", () => {
    expect(() =>
      assertTlsOrLocalhost("tls://nats.example.com:4222"),
    ).not.toThrow();
  });
});

describe("assertTlsOrLocalhost — wss:// / ws:// / nats:// reject off-localhost", () => {
  it("REJECTS wss:// on a non-localhost host (the collapse)", () => {
    expect(() => assertTlsOrLocalhost(WSS_PROD)).toThrow();
  });

  it("rejects plaintext nats:// on a non-localhost host", () => {
    expect(() => assertTlsOrLocalhost(NATS_PLAINTEXT)).toThrow();
  });

  it("rejects bare ws:// on a non-localhost host", () => {
    expect(() => assertTlsOrLocalhost(WS_PLAINTEXT)).toThrow();
  });

  it("names tls:// as required + wss:// as rejected + re-register as the remedy", () => {
    let message = "";
    try {
      assertTlsOrLocalhost(WSS_PROD);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names tls:// as the sole required non-localhost scheme.
    expect(message).toContain("tls://");
    // Lists wss:// among the rejected schemes.
    expect(message).toContain("wss://");
    // No longer frames wss:// as acceptable alongside tls://.
    expect(message).not.toContain("wss:// or tls://");
    expect(message).not.toContain("must use wss://");
    // Names re-register as the (benign, migration) remedy, not a
    // compromise-only one.
    expect(message).toMatch(/re-?register/i);
    expect(message.toLowerCase()).not.toContain("compromis");
  });
});

describe("assertTlsOrLocalhost — localhost bypass unchanged", () => {
  it.each([
    "ws://localhost:8080",
    "nats://127.0.0.1:4222",
    "tls://localhost:4222",
    "wss://localhost",
    "ws://0.0.0.0:8080",
    "nats://dev.localhost:4222",
  ])("accepts %s (any scheme against localhost)", (url) => {
    expect(() => assertTlsOrLocalhost(url)).not.toThrow();
  });
});
