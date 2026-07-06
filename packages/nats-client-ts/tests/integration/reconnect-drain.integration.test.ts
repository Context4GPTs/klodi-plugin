/**
 * Decision 13 — D.8.reconnect: reconnect + drain.
 *
 * Acceptance: Real NATS. Subscribe; 5 events fired; disconnect after 2
 * acked; reconnect; remaining 3 delivered in order, no duplicates
 * (dedup LRU works).
 *
 * The "no duplicates" assertion is the point of this test vs.
 * client.integration.test.ts — that file proves backlog drain happens,
 * but does not exercise the dedup path because all 3 events were
 * published while the client was offline (no chance for double-deliver).
 *
 * Here we publish all 5 BEFORE disconnect. The first 2 are acked
 * (won't redeliver). The next 3 might be in-flight when we close — on
 * reconnect, JetStream will redeliver any not-yet-acked, AND the
 * client's EventIdLru must skip ones the handler has already seen.
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
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { credsAuthenticator } from "@nats-io/nats-core";
import { connect as nodeConnect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";

import { KlodiClient } from "../../src/client.js";
import {
  makeSyntheticPublisher,
  type SyntheticPublisher,
} from "./synthetic-publisher.js";

const INTEGRATION = process.env["INTEGRATION"] === "1";
// Re-homed off ws://localhost onto the surviving tls:// transport.
// Requires a dev-CA
// tls://localhost NATS + the CA PEM path in KLODI_NATS_CA_FILE.
const NATS_TLS_URL = process.env["TEST_NATS_TLS_URL"] ?? "tls://localhost:4222";
const CA_FILE = process.env["KLODI_NATS_CA_FILE"] ?? "";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const SERVICE_CREDS_PATH = join(REPO_ROOT, "infra", "nats", "dev-keys", "service.creds");

const SHOULD_RUN = INTEGRATION && existsSync(SERVICE_CREDS_PATH) && CA_FILE !== "";

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
      /* best-effort */
    }
  } finally {
    await nc.drain();
  }
}

describe.skipIf(!SHOULD_RUN)("KlodiClient reconnect + drain (D.8)", () => {
  let publisher: SyntheticPublisher;
  let userId: string;
  let homeDir: string;
  let configPath: string;
  let credsPath: string;
  let client: KlodiClient | null = null;

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

  beforeEach(() => {
    userId = randomUUID();
    homeDir = mkdtempSync(join(tmpdir(), `klodi-reconnect-`));
    credsPath = join(homeDir, "nats.creds");
    configPath = join(homeDir, "config.json");
    const creds = readFileSync(SERVICE_CREDS_PATH);
    writeFileSync(credsPath, creds, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({
      handle: "d8_user",
      user_id: userId,
      nkey_public: "test-placeholder",
      nats_url: NATS_TLS_URL,
    }));
  });

  afterEach(async () => {
    if (client) {
      try { await client.close(); } catch { /* best-effort */ }
      client = null;
    }
    await deleteConsumer(`klodi-notifications-${userId}`);
    if (existsSync(homeDir)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("delivers remaining events in order on reconnect with no duplicates", async () => {
    // Phase 1: connect + subscribe + publish 5.
    client = new KlodiClient({ configPath, credsPath });
    await client.connect();

    const phase1Received: Array<Record<string, unknown>> = [];
    let phase1Resolve: () => void = () => undefined;
    const phase1HasTwo = new Promise<void>((r) => { phase1Resolve = r; });

    await client.subscribeNotifications(async (event) => {
      const e = event as unknown as Record<string, unknown>;
      phase1Received.push(e);
      if (phase1Received.length === 2) phase1Resolve();
    });
    await new Promise((r) => setTimeout(r, 250));

    const kinds = ["a.kind", "b.kind", "c.kind", "d.kind", "e.kind"];
    const publishedIds: string[] = [];
    for (let i = 0; i < kinds.length; i++) {
      const { event_id } = await publisher.publishNotification({
        userId,
        kind: kinds[i],
        payload: { idx: i },
      });
      publishedIds.push(event_id);
    }

    // Wait for the first 2 to be acked, then close.
    await Promise.race([
      phase1HasTwo,
      new Promise((_r, reject) => setTimeout(
        () => reject(new Error(
          `phase 1 only ack'd ${phase1Received.length}/2 before close`,
        )),
        10_000,
      )),
    ]);

    await client.close();
    client = null;

    // Phase 2: reconnect, resubscribe. The remaining 3 must drain in
    // order. JetStream may also redeliver any in-flight-on-close ones,
    // and the client's EventIdLru must collapse the duplicates so the
    // handler still sees each unique event_id at most once.
    client = new KlodiClient({ configPath, credsPath });
    await client.connect();

    const phase2Received: Array<Record<string, unknown>> = [];
    let phase2Resolve: () => void = () => undefined;
    const phase2Done = new Promise<void>((r) => { phase2Resolve = r; });

    await client.subscribeNotifications(async (event) => {
      const e = event as unknown as Record<string, unknown>;
      phase2Received.push(e);
      if (phase2Received.length === 3) phase2Resolve();
    });

    // ack_wait = 30s (consumers.ts:40); the in-flight msg at close is
    // pending in JetStream until that expires, then redelivers. 45s
    // covers ack_wait + pull-cycle slack.
    await Promise.race([
      phase2Done,
      new Promise((_r, reject) => setTimeout(
        () => reject(new Error(
          `phase 2 drained ${phase2Received.length}/3 in time`,
        )),
        45_000,
      )),
    ]);

    // Settle a beat: any duplicates would arrive shortly after the 3.
    await new Promise((r) => setTimeout(r, 1_000));

    // Order: must be the last 3 from publishedIds, in order.
    const expectedRemainingIds = publishedIds.slice(2);
    const phase2Ids = phase2Received.map((e) => e["event_id"]);

    // Dedup: the handler sees each unique event_id at most once.
    expect(new Set(phase2Ids).size).toBe(phase2Ids.length);

    // Order: every expected remaining id appears in order in phase2Ids
    // (allowing the LRU to filter duplicates that were also attempted).
    let cursor = 0;
    for (const id of phase2Ids) {
      if (id === expectedRemainingIds[cursor]) cursor++;
    }
    expect(cursor).toBe(expectedRemainingIds.length);

    // Cross-phase: total unique events delivered to the handler
    // should equal 5 (no dupes total either).
    const phase1Ids = phase1Received.map((e) => e["event_id"]);
    const allUnique = new Set([...phase1Ids, ...phase2Ids]);
    expect(allUnique.size).toBe(5);
  }, 90_000);
});
