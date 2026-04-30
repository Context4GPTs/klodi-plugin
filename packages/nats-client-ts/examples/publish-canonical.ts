/**
 * Cross-language wire test publisher (TS half).
 *
 * Per **R § P2-9**: TS / Py / Rust publish_channel_message MUST emit
 * byte-equivalent wire output for the same logical event. This script
 * is the TS publisher half — it builds the production channel-message
 * body shape with externally-supplied (deterministic) inputs and
 * publishes once to a designated subject. The orchestrator at
 * `tests/integration/cross-language-wire/orchestrator.py` drives all
 * three publishers with the same inputs and asserts byte-equivalence
 * after subscription capture.
 *
 * Why bypass `publishChannelMessage`'s built-in event_id / message_id
 * minting: the contract under test is "given the same inputs, all
 * three serializers produce the same JSON bytes". The randomness
 * inside the production helper is correct for production but defeats
 * a wire-equivalence test. The body assembly + serializer choice is
 * what's actually under test here — and this script mirrors the
 * production layout in `src/publish.ts` byte-for-byte.
 *
 * Transport note: this example uses the legacy `nats` package (TCP
 * port 4222) so the orchestrator can subscribe with the same dev
 * creds. The production wire shape is identical between TCP and
 * WebSocket transports — the serialization step is what's under test.
 *
 * Usage (driven by orchestrator.py):
 *   tsx publish-canonical.ts --nats-url <url> --creds-path <path> \\
 *     --subject <subject> --channel-id <id> --sender-user-id <id> \\
 *     --sender-handle <handle> --content <content> \\
 *     --event-id <id> --message-id <id> --created-at <iso8601>
 */

import { connect, credsAuthenticator } from "nats";
import { readFileSync } from "node:fs";

interface CanonicalArgs {
  natsUrl: string;
  credsPath: string;
  subject: string;
  channelId: string;
  senderUserId: string;
  senderHandle: string;
  content: string;
  eventId: string;
  messageId: string;
  createdAt: string;
}

function parseArgs(argv: string[]): CanonicalArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const val = argv[i + 1];
    if (!key || val === undefined) {
      throw new Error(
        `Bad argv pair near index ${i}: ${argv[i]} ${argv[i + 1]}`,
      );
    }
    out[key] = val;
  }
  const required = [
    "nats-url", "creds-path", "subject", "channel-id", "sender-user-id",
    "sender-handle", "content", "event-id", "message-id", "created-at",
  ];
  for (const k of required) {
    if (!out[k]) throw new Error(`Missing --${k}`);
  }
  return {
    natsUrl: out["nats-url"]!,
    credsPath: out["creds-path"]!,
    subject: out["subject"]!,
    channelId: out["channel-id"]!,
    senderUserId: out["sender-user-id"]!,
    senderHandle: out["sender-handle"]!,
    content: out["content"]!,
    eventId: out["event-id"]!,
    messageId: out["message-id"]!,
    createdAt: out["created-at"]!,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const creds = readFileSync(args.credsPath);

  const nc = await connect({
    servers: args.natsUrl,
    authenticator: credsAuthenticator(creds),
  });

  try {
    // Mirror `publishChannelMessage` byte-for-byte. Field order matches
    // production (see klodi-plugin/packages/nats-client-ts/src/publish.ts).
    const body = {
      kind: "channel.message" as const,
      event_id: args.eventId,
      channel_id: args.channelId,
      message_id: args.messageId,
      sender_user_id: args.senderUserId,
      sender_handle: args.senderHandle,
      content: args.content,
      created_at: args.createdAt,
    };
    const encoder = new TextEncoder();
    // Use core publish (not JetStream) so the orchestrator's plain
    // subscription captures the bytes verbatim. The wire bytes that
    // matter are the JSON body — JetStream just adds an Ack envelope
    // around the same payload, which would confuse byte-equivalence.
    nc.publish(args.subject, encoder.encode(JSON.stringify(body)));
    await nc.flush();
    console.log("ts:published");
  } finally {
    await nc.drain();
  }
}

main().catch((err: unknown) => {
  console.error(
    `ts:error ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
