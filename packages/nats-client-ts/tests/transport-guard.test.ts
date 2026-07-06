/**
 * Transport guard collapsed to `tls://` ONLY, no localhost bypass (ts).
 *
 * Card: remove-dead-ws-localhost-nats-transport-bypass. The ts arm of the
 * py/rs guard matrix — flips the prior *localhost-accepts-any-scheme*
 * premise to *localhost-is-no-longer-a-bypass*. The guard's sole rule is
 * now `scheme === tls://`; `tls://localhost` (dev CA) is accepted because
 * it is `tls://`, not via a host carve-out.
 *
 *   - `tls://<non-localhost>`  → accepts (the sole prod transport)
 *   - `tls://localhost`        → accepts (dev-CA loopback — it is tls://)
 *   - `ws://localhost`         → REJECTS (was accepted; bypass dead)
 *   - `wss://localhost`        → REJECTS (was accepted; bypass dead)
 *   - `nats://localhost`       → REJECTS (was accepted; bypass dead)
 *   - `ws://<non-localhost>`   → REJECTS (unchanged)
 *   - `wss://<non-localhost>`  → REJECTS (unchanged)
 *   - `nats://<non-localhost>` → REJECTS (unchanged)
 *
 * COORDINATION: the guard is renamed in-dev `assertTlsOrLocalhost` →
 * `assertTls` (once the localhost bypass is gone, the `OrLocalhost` suffix
 * misleads). This file imports the NEW name; the module fails to resolve it
 * until the rename lands (expected RED — the rename IS part of the
 * deliverable). No re-export shim for the old name (CLAUDE.md: no
 * backwards-compat). `isLocalhost` is deleted — never import it again.
 *
 * QA-owned (adversarial-testing). NEVER weaken these asserts. In particular:
 * do NOT re-widen the guard to accept `ws://localhost` so an old assertion
 * passes — the localhost bypass is the plaintext surface this card deletes.
 */

import { describe, expect, it } from "vitest";

import { assertTls } from "../src/index.js";

// The pinned prod endpoint: Railway's L4 TCP proxy in front of NATS
// (devops §1 — NOT `kodama`, which is pgvector's Postgres proxy).
const TLS_PROD = "tls://hayabusa.proxy.rlwy.net:32770";
const WSS_PROD = "wss://klodi-net.4gpts.com";
const NATS_PLAINTEXT = "nats://hayabusa.proxy.rlwy.net:4222";
const WS_PLAINTEXT = "ws://attacker.example.com:8080";

describe("assertTls — tls:// is the sole accepted transport", () => {
  it("accepts tls:// on a non-localhost host", () => {
    expect(() => assertTls(TLS_PROD)).not.toThrow();
  });

  it("accepts an arbitrary tls:// non-localhost host", () => {
    expect(() => assertTls("tls://nats.example.com:4222")).not.toThrow();
  });

  it("accepts tls://localhost (dev-CA loopback — because it is tls://)", () => {
    expect(() => assertTls("tls://localhost:4222")).not.toThrow();
  });
});

describe("assertTls — every non-tls scheme rejects off-localhost", () => {
  it("rejects wss:// on a non-localhost host", () => {
    expect(() => assertTls(WSS_PROD)).toThrow();
  });

  it("rejects plaintext nats:// on a non-localhost host", () => {
    expect(() => assertTls(NATS_PLAINTEXT)).toThrow();
  });

  it("rejects bare ws:// on a non-localhost host", () => {
    expect(() => assertTls(WS_PLAINTEXT)).toThrow();
  });
});

describe("assertTls — THE FLIP: localhost is no longer a bypass", () => {
  it.each([
    "ws://localhost:8080",
    "wss://localhost",
    "nats://localhost:4222",
    "nats://127.0.0.1:4222",
    "ws://0.0.0.0:8080",
    "nats://dev.localhost:4222",
  ])("rejects %s (non-tls against localhost — the bypass is dead)", (url) => {
    // Under the old `assertTlsOrLocalhost` these were accepted via the
    // host carve-out; the collapse removes it. Only `tls://` accepts now.
    expect(() => assertTls(url)).toThrow();
  });
});

describe("assertTls — rejection message names tls:// only, no localhost", () => {
  it("names tls:// as required + the remedy, with no localhost bypass", () => {
    let message = "";
    try {
      // Non-localhost offending url so echoing it can never re-introduce
      // the word "localhost" into the message.
      assertTls(WS_PLAINTEXT);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Names tls:// as the required transport.
    expect(message).toContain("tls://");
    // No longer presents localhost as an acceptable bypass — the old
    // "…only accepted when the host resolves to localhost" clause is gone.
    expect(message.toLowerCase()).not.toContain("localhost");
    // Names re-register as the (benign, migration) remedy, not a
    // compromise-only one.
    expect(message).toMatch(/re-?register/i);
    expect(message.toLowerCase()).not.toContain("compromis");
  });
});
