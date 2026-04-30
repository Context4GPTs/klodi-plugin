/**
 * Cross-language ack-ordering example (TS half).
 *
 * Per design Section 6 / P-ACK axis (P1-4 regression guard): under
 * `max_ack_pending: 1` redelivery pressure, the per-language consume
 * loop MUST honor handler-completion-happens-before-ack and
 * next-dispatch-happens-after-ack. The TS regression that produced
 * P1-4 fired-and-forgot the ack `Promise` — the next message
 * dispatched before the prior ack landed.
 *
 * Test pattern:
 *   1. Create a unique stream + durable consumer with
 *      `ack_policy: explicit, max_ack_pending: 1`.
 *   2. Publish 3 messages with body `{seq: 0|1|2}`.
 *   3. Consume one at a time via `fetch({max_messages: 1})`, awaiting
 *      each `msg.ack()` before the next pull resolves — same shape as
 *      the production consume loop in `src/consumers.ts`.
 *   4. Capture nanosecond timestamps at received + ack_returned.
 *   5. Cleanup (delete stream).
 *   6. Print `{"events": [...]}` to stdout.
 *
 * The orchestrator at
 * `tests/integration/nats-infra/cross-language-wire/orchestrator-ack.py`
 * asserts per-language `ack[i].t_ns < received[i+1].t_ns`. A no-await
 * regression flips that ordering and surfaces as exit 2.
 */

import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  ReplayPolicy,
  connect,
  credsAuthenticator,
} from "nats";
import { readFileSync } from "node:fs";
import { hrtime } from "node:process";
import { randomUUID } from "node:crypto";

interface Args {
  natsUrl: string;
  credsPath: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const val = argv[i + 1];
    if (!key || val === undefined) {
      throw new Error(`bad argv pair near index ${i}`);
    }
    out[key] = val;
  }
  if (!out["nats-url"] || !out["creds-path"]) {
    throw new Error("missing --nats-url or --creds-path");
  }
  return { natsUrl: out["nats-url"], credsPath: out["creds-path"] };
}

interface Event {
  event: "received" | "ack_returned";
  seq: number;
  t_ns: number;
}

const NUM_MESSAGES = 3;
const ACK_WAIT_NS = 30 * 1_000_000_000;
const STREAM_MAX_AGE_NS = 5 * 60 * 1_000_000_000; // 5 minutes
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const creds = readFileSync(args.credsPath);
  const nc = await connect({
    servers: args.natsUrl,
    authenticator: credsAuthenticator(creds),
  });

  const testId = randomUUID().slice(0, 8);
  const streamName = `ACK_TEST_TS_${testId.toUpperCase()}`;
  const subject = `cross.lang.ack.ts.${testId}`;
  const consumerName = `ack-test-ts-${testId}`;
  const events: Event[] = [];

  try {
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add({
      name: streamName,
      subjects: [subject],
      retention: RetentionPolicy.Limits,
      max_age: STREAM_MAX_AGE_NS,
    });
    await jsm.consumers.add(streamName, {
      durable_name: consumerName,
      ack_policy: AckPolicy.Explicit,
      ack_wait: ACK_WAIT_NS,
      max_ack_pending: 1,
      max_deliver: 5,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
    });

    const js = nc.jetstream();

    // Publish 3 messages in order. JetStream preserves stream order so
    // the consumer sees them as seq 0, 1, 2.
    for (let i = 0; i < NUM_MESSAGES; i++) {
      const body = JSON.stringify({ seq: i });
      await js.publish(subject, encoder.encode(body), {
        msgID: `msg-${testId}-${i}`,
      });
    }

    const consumer = await js.consumers.get(streamName, consumerName);

    // Fetch one message at a time so the consumer respects max_ack_pending=1
    // and the ack must land before the next pull resolves — same shape as
    // the production loop in `src/consumers.ts`. fetch() is preferred over
    // consume() here because it returns a bounded iterable that completes
    // when the requested batch is delivered or the expiry hits, instead of
    // running indefinitely.
    for (let i = 0; i < NUM_MESSAGES; i++) {
      const batch = await consumer.fetch({
        max_messages: 1,
        expires: 10_000,
      });
      let drained = false;
      for await (const msg of batch) {
        const tRecv = Number(hrtime.bigint());
        const payload = JSON.parse(decoder.decode(msg.data)) as { seq: number };
        events.push({ event: "received", seq: payload.seq, t_ns: tRecv });

        // Mirror production discipline: await the ack so the next pull
        // happens-after the prior ack.
        await msg.ack();
        const tAck = Number(hrtime.bigint());
        events.push({ event: "ack_returned", seq: payload.seq, t_ns: tAck });
        drained = true;
        break;
      }
      if (!drained) {
        throw new Error(`fetch[${i}] returned no messages within timeout`);
      }
    }

    // Cleanup so repeated runs don't accumulate streams.
    await jsm.streams.delete(streamName);
  } finally {
    await nc.drain();
  }

  process.stdout.write(JSON.stringify({ events }) + "\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ts:error ${message}\n`);
  process.exit(1);
});
