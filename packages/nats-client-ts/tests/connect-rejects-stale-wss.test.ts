/**
 * RED [unit] — a stale persisted `wss://` nats_url is rejected at
 * `connect()` BEFORE any transport dispatch (ts client).
 *
 * Card: collapse-nats-transport-guard-to-tls-only.
 *
 * Scenario: `config.json` still carries a `wss://<non-localhost>` nats_url
 * (persisted before the cutover), the host is upgraded to the tls-only
 * client without re-registering. `doConnect` runs `assertTlsOrLocalhost`
 * before the transport branch, so the stale url must throw synchronously
 * with NO `wsconnect` and NO node-TCP `connect` attempt (both mocked;
 * assert neither fired) — no hang against a dead wss:// endpoint.
 *
 * Mirrors the mocking seam of scheme-dispatch.test.ts.
 *
 * QA-owned (adversarial-testing). NEVER weaken.
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

describe("connect() rejects a stale persisted wss:// before transport dispatch", () => {
  it("throws and dispatches neither transport (no wsconnect, no node-TCP, no hang)", async () => {
    const client = makeClient("wss://klodi-net.4gpts.com");
    await expect(client.connect()).rejects.toThrow();
    expect(wsMock).not.toHaveBeenCalled();
    expect(tcpMock).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });
});
