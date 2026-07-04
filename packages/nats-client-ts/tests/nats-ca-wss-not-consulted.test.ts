/**
 * wss:// never consults the persisted nats_ca (ts).
 *
 * Card: auto-trust-nats-ca-from-register — boundary:
 *   [unit] response carries nats_ca but a wss:// (not tls://) nats_url →
 *   nats_ca is not consulted (private-CA trust is a tls://-only concern) and
 *   wss:// behaviour is unchanged.
 *
 * Behavioural proof without a fragile spy: a POISONED persisted CA (a directory
 * at ${KLODI_HOME}/nats-ca.pem, which throws EISDIR if read) is placed next to
 * the creds, then a wss:// connect is driven with both transports mocked. If
 * the wss path wrongly consulted the persisted CA, `resolveTlsCa` would read
 * the directory and throw; the connect must instead succeed via the WS
 * transport. The tls:// scheme routes through the node TCP transport where the
 * CA path lives — covered by scheme-dispatch + the gated tls integration.
 *
 * Guard: green today (wss never calls the CA resolver) and must stay green as
 * the level-2 persisted step lands.
 *
 * QA-owned. NEVER weaken.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return { ...orig, wsconnect: wsMock, credsAuthenticator: vi.fn(() => vi.fn()) };
});
vi.mock("@nats-io/transport-node", () => ({ connect: tcpMock }));

const { KlodiClient } = await import("../src/client.js");

let home: string;

function makeClient(natsUrl: string): InstanceType<typeof KlodiClient> {
  home = mkdtempSync(join(tmpdir(), "klodi-nats-ca-wss-"));
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
  writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nfake\n", { mode: 0o600 });
  // Poison the persisted-CA path: a directory throws if the CA resolver
  // reads it. klodi_home is derived from the creds-path parent (== home).
  mkdirSync(join(home, "nats-ca.pem"));
  return new KlodiClient({ credsPath, configPath });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("wss:// ignores the persisted nats_ca", () => {
  it("connects over wss:// despite a poisoned persisted CA (never consulted)", async () => {
    const client = makeClient("wss://klodi-net.4gpts.com");
    await client.connect();
    expect(wsMock).toHaveBeenCalledTimes(1);
    expect(tcpMock).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
  });
});
