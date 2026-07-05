/**
 * Scheme dispatch in `doConnect` (ts client).
 *
 * Card: support-tls-nats-transport-with-private-ca-trust — Test strategy:
 * "TS scheme dispatch". Criterion:
 *
 *   - `tls://` / `nats://` route to the node TCP transport
 *     (`@nats-io/transport-node`'s `connect`).
 *   - `wss://` / `ws://` route to nats-core's `wsconnect`.
 *
 * Behavioural test: both transport entry points are mocked; a KlodiClient is
 * pointed at a config whose `nats_url` carries each scheme, `connect()` is
 * driven, and we assert exactly one transport fired. This is the seam that a
 * regression (e.g. sending `tls://` through the WS transport, which
 * nats-core v3 cannot speak) would break.
 *
 * QA-owned (adversarial-testing). NEVER weaken.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake NatsConnection sufficient for doConnect's tail (watchStatus +
// isClosed). Shared by both mocked transports.
const { wsMock, tcpMock } = vi.hoisted(() => {
  const fakeNc = {
    isClosed: () => false,
    // Empty status stream — watchStatus's `for await` completes at once.
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
    // Neutralise creds parsing — the connect itself is mocked, so the
    // authenticator value is never exercised.
    credsAuthenticator: vi.fn(() => vi.fn()),
  };
});

vi.mock("@nats-io/transport-node", () => ({ connect: tcpMock }));

// Import AFTER the mocks are registered.
const { KlodiClient } = await import("../src/client.js");

let home: string;

function makeClient(natsUrl: string): InstanceType<typeof KlodiClient> {
  home = mkdtempSync(join(tmpdir(), "klodi-dispatch-"));
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

describe("doConnect scheme dispatch", () => {
  it("routes tls:// to the node TCP transport (not wsconnect)", async () => {
    const client = makeClient("tls://hayabusa.proxy.rlwy.net:32770");
    await client.connect();
    expect(tcpMock).toHaveBeenCalledTimes(1);
    expect(wsMock).not.toHaveBeenCalled();
  });

  it("routes nats://localhost to the node TCP transport (not wsconnect)", async () => {
    const client = makeClient("nats://127.0.0.1:4222");
    await client.connect();
    expect(tcpMock).toHaveBeenCalledTimes(1);
    expect(wsMock).not.toHaveBeenCalled();
  });

  it("routes wss://localhost to wsconnect (not the node TCP transport)", async () => {
    // Retargeted to localhost for the tls-only cutover
    // (collapse-nats-transport-guard-to-tls-only): the collapsed guard
    // rejects wss://<non-localhost>, so the surviving wss://→wsconnect
    // dispatch branch is exercised via the localhost bypass. The routing
    // contract (wss:// → wsconnect, never the node TCP transport) is
    // unchanged.
    const client = makeClient("wss://localhost");
    await client.connect();
    expect(wsMock).toHaveBeenCalledTimes(1);
    expect(tcpMock).not.toHaveBeenCalled();
  });

  it("routes ws://localhost to wsconnect (not the node TCP transport)", async () => {
    const client = makeClient("ws://localhost:8080");
    await client.connect();
    expect(wsMock).toHaveBeenCalledTimes(1);
    expect(tcpMock).not.toHaveBeenCalled();
  });

  it("passes a tls config (CA object or undefined) — never rejectUnauthorized:false", async () => {
    const client = makeClient("tls://hayabusa.proxy.rlwy.net:32770");
    await client.connect();
    const opts = tcpMock.mock.calls[0]?.[0] as { tls?: unknown } | undefined;
    // The tls field is either a { ca } object or undefined (fall-through to
    // system store) — it must NEVER carry a verification-off toggle.
    const tls = opts?.tls as Record<string, unknown> | undefined;
    if (tls) {
      expect(tls).not.toHaveProperty("rejectUnauthorized", false);
    }
  });
});
