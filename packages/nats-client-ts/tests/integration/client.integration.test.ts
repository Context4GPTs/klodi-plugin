/**
 * Decision 13 — D.1.ts: per-language client cycle (TypeScript).
 *
 * Real NATS via `pnpm setup:dev`. Gated by INTEGRATION=1.
 *
 * Acceptance criteria (from Decision 13 row D.1.{ts,py,rs}):
 *   - Connect with NKey + WS
 *   - whoami request (or any synthetic request/reply) round-trip < 2s
 *   - Subscribe; synthetic publisher fires 5 events; handler invoked
 *     5× in order with full payloads, all acked
 *   - Disconnect → reconnect → 3-event backlog drains in order
 *
 * The KlodiClient pins its notifications consumer's filter_subject to
 * `p2p.v1.notifications.<user_id>`, so the per-test isolation pattern
 * is "one test = one freshly-minted user_id". The durable consumer
 * name then namespaces automatically (`klodi-notifications-${userId}`).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { credsAuthenticator } from "@nats-io/nats-core";
import { connect as nodeConnect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";

import { KlodiClient } from "../../src/client.js";
import { makeSyntheticPublisher, type SyntheticPublisher } from "./synthetic-publisher.js";

// Allow the suite to be skipped when NATS is not running. The Decision 5
// pattern: tests reuse `pnpm setup:dev`. Without it, dev keys + Docker
// NATS won't exist, and these tests can't run.
const INTEGRATION = process.env["INTEGRATION"] === "1";

// Re-homed off ws://localhost onto the surviving tls:// transport
// (remove-dead-ws-localhost-nats-transport-bypass). Requires a dev-CA
// tls://localhost NATS + the CA PEM path in KLODI_NATS_CA_FILE (same env
// the KlodiClient resolves its CA from).
const NATS_TLS_URL = process.env["TEST_NATS_TLS_URL"] ?? "tls://localhost:4222";
const CA_FILE = process.env["KLODI_NATS_CA_FILE"] ?? "";

// Repo-rooted dev keys path. Test runs from the package dir, so walk up.
// (__dirname is set by tsc/vitest at runtime.)
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const DEV_KEYS_DIR = join(REPO_ROOT, "infra", "nats", "dev-keys");
const SERVICE_CREDS_PATH = join(DEV_KEYS_DIR, "service.creds");

function devKeysPresent(): boolean {
  return existsSync(SERVICE_CREDS_PATH);
}

const SHOULD_RUN = INTEGRATION && devKeysPresent() && CA_FILE !== "";

// Each test owns a unique user_id; the KlodiClient's per-user durable
// consumer keys off it, giving us per-test isolation on the shared
// P2P_NOTIFICATIONS stream (Decision 5's pattern).
function newUserId(): string {
  return randomUUID();
}

interface TestUser {
  userId: string;
  handle: string;
  nkeyPublic: string;
  homeDir: string;
  configPath: string;
  credsPath: string;
}

function makeTestUser(): TestUser {
  const userId = newUserId();
  const handle = `nctest_${userId.slice(0, 8)}`;
  const home = mkdtempSync(join(tmpdir(), `klodi-nc-${handle}-`));

  // Reuse the broad-permission service creds for the test client. The
  // KlodiClient's per-user durable consumer name still keys off
  // userId via subscribeNotifications(); per-test isolation comes
  // from minting a fresh userId per test (Decision 5 pattern).
  // Per-user JWT scoping is exercised by D.7 (side-consumer drop) — out
  // of scope here. The placeholder nkey_public is fine: the integration
  // assertions (subscribe + receive) don't go through the marketplace
  // request handler that reads the X-Nkey-Public header.
  const credsPath = join(home, "nats.creds");
  const configPath = join(home, "config.json");
  const creds = readFileSync(SERVICE_CREDS_PATH);
  writeFileSync(credsPath, creds, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    handle,
    user_id: userId,
    nkey_public: "test-placeholder-nkey",
    nats_url: NATS_TLS_URL,
  }));

  return {
    userId,
    handle,
    nkeyPublic: "test-placeholder-nkey",
    homeDir: home,
    configPath,
    credsPath,
  };
}

async function deleteConsumer(durableName: string): Promise<void> {
  const creds = readFileSync(SERVICE_CREDS_PATH);
  // Mirror src/client.ts connectTcp: the Node TCP transport over tls://,
  // trusting the private dev CA (verification always ON).
  const nc = await nodeConnect({
    servers: NATS_TLS_URL,
    authenticator: credsAuthenticator(creds),
    tls: CA_FILE !== "" ? { ca: readFileSync(CA_FILE) } : undefined,
  });
  try {
    const jsm = await jetstreamManager(nc);
    try {
      await jsm.consumers.delete("P2P_NOTIFICATIONS", durableName);
    } catch {
      /* already gone — best-effort */
    }
  } finally {
    await nc.drain();
  }
}

describe.skipIf(!SHOULD_RUN)("KlodiClient integration (D.1.ts)", () => {
  let publisher: SyntheticPublisher;

  beforeAll(async () => {
    publisher = await makeSyntheticPublisher({
      natsUrl: NATS_TLS_URL,
      credsPath: SERVICE_CREDS_PATH,
      caFile: CA_FILE,
    });
  }, 30_000);

  afterAll(async () => {
    if (publisher) await publisher.close();
  });

  let user: TestUser;
  let client: KlodiClient | null = null;

  beforeEach(() => {
    user = makeTestUser();
  });

  afterEach(async () => {
    if (client) {
      try { await client.close(); } catch { /* best-effort */ }
      client = null;
    }
    await deleteConsumer(`klodi-notifications-${user.userId}`);
    if (existsSync(user.homeDir)) {
      rmSync(user.homeDir, { recursive: true, force: true });
    }
  });

  it("connects via tls:// + NKey credentials", async () => {
    client = new KlodiClient({
      configPath: user.configPath,
      credsPath: user.credsPath,
    });

    await client.connect();

    expect(client.isConnected()).toBe(true);
  }, 15_000);

  it("delivers 5 published events to the handler in order", async () => {
    client = new KlodiClient({
      configPath: user.configPath,
      credsPath: user.credsPath,
    });
    await client.connect();

    const received: Array<Record<string, unknown>> = [];
    let resolveAll: () => void;
    const allReceived = new Promise<void>((r) => { resolveAll = r; });

    await client.subscribeNotifications(async (event) => {
      received.push(event as unknown as Record<string, unknown>);
      if (received.length === 5) resolveAll();
    });

    // Give the consumer a moment to start its pull loop. The library's
    // ensureConsumer + consume() is async; if we publish before it's
    // attached, JetStream still buffers (Interest retention requires
    // at least one consumer present, which subscribeNotifications
    // already created) — but waiting reduces flakiness.
    await new Promise((r) => setTimeout(r, 250));

    const expectedKinds = [
      "channel.opened",
      "channel.message",
      "offer.proposed",
      "offer.accepted",
      "transaction.confirmed",
    ];
    const publishedIds: string[] = [];
    for (const kind of expectedKinds) {
      const { event_id } = await publisher.publishNotification({
        userId: user.userId,
        kind,
        payload: { marker: kind, sequenceTag: publishedIds.length },
      });
      publishedIds.push(event_id);
    }

    await Promise.race([
      allReceived,
      new Promise((_r, reject) => setTimeout(
        () => reject(new Error(`only received ${received.length}/5 events`)),
        10_000,
      )),
    ]);

    expect(received.map((e) => e["kind"])).toEqual(expectedKinds);
    expect(received.map((e) => e["event_id"])).toEqual(publishedIds);
    // Each handler invocation matches a synthetic publish — full payloads.
    for (let i = 0; i < expectedKinds.length; i++) {
      expect(received[i]["marker"]).toBe(expectedKinds[i]);
      expect(received[i]["sequenceTag"]).toBe(i);
    }
  }, 20_000);

  it("drains a 3-event backlog after reconnect, in order", async () => {
    // 1. Connect, subscribe (this creates the durable consumer).
    client = new KlodiClient({
      configPath: user.configPath,
      credsPath: user.credsPath,
    });
    await client.connect();
    let received: Array<Record<string, unknown>> = [];
    await client.subscribeNotifications(async (event) => {
      received.push(event as unknown as Record<string, unknown>);
    });
    await new Promise((r) => setTimeout(r, 250));

    // 2. Disconnect — durable consumer remains on the server.
    await client.close();
    client = null;

    // 3. Publish 3 events while the client is offline. Interest
    //    retention keeps them queued because the durable consumer
    //    hasn't acked them.
    received = [];
    const backlogKinds = ["search.match", "comment.posted", "rating.received"];
    const publishedIds: string[] = [];
    for (const kind of backlogKinds) {
      const { event_id } = await publisher.publishNotification({
        userId: user.userId,
        kind,
        payload: { backlogTag: kind },
      });
      publishedIds.push(event_id);
    }

    // 4. Reconnect + subscribe again. Backlog must drain in order.
    client = new KlodiClient({
      configPath: user.configPath,
      credsPath: user.credsPath,
    });
    await client.connect();

    let resolveAll: () => void;
    const allReceived = new Promise<void>((r) => { resolveAll = r; });
    await client.subscribeNotifications(async (event) => {
      received.push(event as unknown as Record<string, unknown>);
      if (received.length === 3) resolveAll();
    });

    await Promise.race([
      allReceived,
      new Promise((_r, reject) => setTimeout(
        () => reject(new Error(
          `reconnect drain only got ${received.length}/3 events`,
        )),
        10_000,
      )),
    ]);

    expect(received.map((e) => e["kind"])).toEqual(backlogKinds);
    expect(received.map((e) => e["event_id"])).toEqual(publishedIds);
  }, 30_000);
});

// qa-developer: 0012-gap-fixes-decision-13
