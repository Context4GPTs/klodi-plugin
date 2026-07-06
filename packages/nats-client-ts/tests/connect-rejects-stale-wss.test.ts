/**
 * RED [unit] — a stale persisted non-`tls://` nats_url is rejected at
 * `connect()` BEFORE any transport dispatch (ts client).
 *
 * Two cases: the `wss://`-non-localhost case (verify-only) AND the
 * NEW `ws://localhost` / `wss://localhost` cases — RED today, since localhost
 * is still a bypass on current `main`.
 *
 * Scenario: `config.json` still carries a non-`tls://` nats_url — either a
 * `wss://<non-localhost>` (persisted before the cutover) or a stale
 * `ws://localhost` / `wss://localhost` (persisted while localhost was a
 * plaintext bypass, before it was removed). The host is upgraded to the
 * guard-collapsed client without re-registering. `doConnect` runs the shared
 * guard before the transport branch, so the stale url must throw synchronously
 * with NO `wsconnect` and NO node-TCP `connect` attempt (both mocked; assert
 * neither fired) — no hang against a dead ws:// / wss:// endpoint.
 *
 * QA-owned (adversarial-testing). NEVER weaken. Do NOT re-widen the guard to
 * accept `ws://localhost` so the localhost cases pass — the bypass is deleted.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { wsMock, tcpMock } = vi.hoisted(() => {
  const fakeNc = {
    isClosed: () => false,
    status: async function* () {
      /* no status events */
    },
    drain: async () => undefined,
  };
  return {
    wsMock: vi.fn().mockResolvedValue(fakeNc),
    tcpMock: vi.fn().mockResolvedValue(fakeNc),
  };
});

vi.mock("@nats-io/nats-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@nats-io/nats-core")>();
  return {
    ...orig,
    wsconnect: wsMock,
    credsAuthenticator: vi.fn(() => vi.fn()),
  };
});
vi.mock("@nats-io/transport-node", () => ({ connect: tcpMock }));

const { KlodiClient } = await import("../src/client.js");

let home: string;

function makeClient(natsUrl: string): InstanceType<typeof KlodiClient> {
  home = mkdtempSync(join(tmpdir(), "klodi-stale-wss-"));
  const configPath = join(home, "config.json");
  const credsPath = join(home, "nats.creds");
  writeFileSync(
    configPath,
    JSON.stringify({
      handle: "alice",
      user_id: "u-1",
      nkey_public: "UAAAAAAAAAAAA",
      nats_url: natsUrl,
    }),
  );
  writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nfake\n", {
    mode: 0o600,
  });
  return new KlodiClient({ credsPath, configPath });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("connect() rejects a stale persisted non-tls:// url before transport dispatch", () => {
  // `wss://<non-localhost>` was already rejected by the guard collapse
  // (verify-only); the localhost forms are the flip introduced here.
  it.each([
    "wss://klodi-net.4gpts.com",
    "ws://localhost:8080",
    "wss://localhost",
  ])(
    "throws on %s and dispatches neither transport (no wsconnect, no node-TCP, no hang)",
    async (staleUrl) => {
      const client = makeClient(staleUrl);
      await expect(client.connect()).rejects.toThrow();
      expect(wsMock).not.toHaveBeenCalled();
      expect(tcpMock).not.toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    },
  );
});
