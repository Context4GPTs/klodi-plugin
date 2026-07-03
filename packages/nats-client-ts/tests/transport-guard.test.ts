/**
 * Transport guard widened to accept `tls://` (ts client).
 *
 * Card: support-tls-nats-transport-with-private-ca-trust.
 * Criteria (Acceptance → "Transport guard — widen to tls://…"), the ts arm
 * of the py/rs guard matrix:
 *
 *   - `tls://<non-localhost>`  → accepts (the new prod transport)
 *   - `wss://<non-localhost>`  → still accepts (widening must not drop wss)
 *   - `nats://<non-localhost>` → rejects; message names both secure schemes
 *   - `ws://<non-localhost>`   → rejects (D §D10 control intact)
 *   - any scheme @ localhost   → accepts (localhost bypass unchanged)
 *
 * QA-owned (adversarial-testing). NEVER weaken these asserts to match a
 * narrower implementation.
 */

import { describe, expect, it } from "vitest";

import { assertEncryptedOrLocalhost } from "../src/index.js";

const TLS_PROD = "tls://kodama.proxy.rlwy.net:37360";
const WSS_PROD = "wss://klodi-net.4gpts.com";
const NATS_PLAINTEXT = "nats://kodama.proxy.rlwy.net:4222";
const WS_PLAINTEXT = "ws://attacker.example.com:8080";

describe("assertEncryptedOrLocalhost — tls:// widening", () => {
  it("accepts tls:// on a non-localhost host", () => {
    expect(() => assertEncryptedOrLocalhost(TLS_PROD)).not.toThrow();
  });

  it("accepts an arbitrary tls:// non-localhost host", () => {
    expect(() =>
      assertEncryptedOrLocalhost("tls://nats.example.com:4222"),
    ).not.toThrow();
  });

  it("still accepts wss:// on a non-localhost host", () => {
    expect(() => assertEncryptedOrLocalhost(WSS_PROD)).not.toThrow();
  });
});

describe("assertEncryptedOrLocalhost — plaintext non-localhost still rejected", () => {
  it("rejects plaintext nats:// on a non-localhost host", () => {
    expect(() => assertEncryptedOrLocalhost(NATS_PLAINTEXT)).toThrow();
  });

  it("names BOTH secure schemes in the nats:// rejection message", () => {
    let message = "";
    try {
      assertEncryptedOrLocalhost(NATS_PLAINTEXT);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("wss://");
    expect(message).toContain("tls://");
  });

  it("rejects bare ws:// on a non-localhost host", () => {
    expect(() => assertEncryptedOrLocalhost(WS_PLAINTEXT)).toThrow();
  });
});

describe("assertEncryptedOrLocalhost — localhost bypass unchanged", () => {
  it.each([
    "ws://localhost:8080",
    "nats://127.0.0.1:4222",
    "tls://localhost:4222",
    "wss://localhost",
    "ws://0.0.0.0:8080",
    "nats://dev.localhost:4222",
  ])("accepts %s (any scheme against localhost)", (url) => {
    expect(() => assertEncryptedOrLocalhost(url)).not.toThrow();
  });
});
