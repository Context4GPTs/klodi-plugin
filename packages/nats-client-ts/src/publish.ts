/**
 * Direct JetStream publish for channel messages.
 *
 * 0012 removes `p2p.v1.channels.send` as a request/reply tool. Instead,
 * each participant publishes a fully-formed `ChannelMessageEvent`
 * directly to:
 *
 *   p2p.v1.channels.<channel_id>.<sender_user_id>.msg
 *
 * The marketplace's side-consumer observes the publish for moderation
 * and history-index. The recipient's `klodi-channels-<recipient_id>`
 * consumer delivers the message as a wake.
 *
 * The event_id and message_id are minted client-side here so dedup
 * works against the redelivery-on-reconnect path.
 */

import type { JetStreamClient } from "@nats-io/jetstream";
import { randomUUID } from "node:crypto";

import { MAX_CHANNEL_MESSAGE_CHARS } from "@klodi/tool-catalog";

const encoder = new TextEncoder();

export interface PublishChannelArgs {
  js: JetStreamClient;
  channelId: string;
  senderUserId: string;
  senderHandle: string;
  content: string;
}

export interface PublishChannelResult {
  sequence: number;
  event_id: string;
  message_id: string;
  created_at: string;
}

/**
 * Per **D § D14**: count Unicode code-points, NOT UTF-16 code units.
 * `content.length` returns code units — `"😀".repeat(1000)` would
 * surface as 2000 in TS (code units) but 1000 in Postgres + Py + Rust
 * (code points). Iterating with `[...content]` segments by code-point
 * so all four halves agree.
 */
const MAX_CONTENT_LENGTH = MAX_CHANNEL_MESSAGE_CHARS;

/**
 * UUID v4 regex (case-insensitive). Channel and sender IDs flow into a
 * NATS subject — `.`-separated tokens. An unvalidated id containing
 * `\r\n`, whitespace, or wildcards (`*`, `>`) could foul up the
 * marketplace's side-consumer subject parsing. Strict v4 matches the
 * `klodi_channel_create` output shape and the catalog `Uuid`
 * descriptor — see P1-11.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuidV4(value: string, field: string): void {
  if (!UUID_V4_RE.test(value)) {
    throw new Error(
      `publishChannelMessage: ${field} must be a UUID v4 (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Publish a channel message. Returns the JetStream sequence as proof of
 * durability — the message is now in P2P_CHANNELS storage and will fan
 * out to the recipient's consumer (or queue for redelivery).
 */
export async function publishChannelMessage(
  args: PublishChannelArgs,
): Promise<PublishChannelResult> {
  assertUuidV4(args.channelId, "channelId");
  assertUuidV4(args.senderUserId, "senderUserId");
  const codePointCount = [...args.content].length;
  if (codePointCount === 0) {
    throw new Error("publishChannelMessage: content must not be empty");
  }
  if (codePointCount > MAX_CONTENT_LENGTH) {
    throw new Error(
      `publishChannelMessage: content exceeds ${MAX_CONTENT_LENGTH} code-points (got ${codePointCount})`,
    );
  }

  const eventId = randomUUID();
  const messageId = randomUUID();
  const createdAt = new Date().toISOString();
  const subject = `p2p.v1.channels.${args.channelId}.${args.senderUserId}.msg`;

  const body = {
    kind: "channel.message" as const,
    event_id: eventId,
    channel_id: args.channelId,
    message_id: messageId,
    sender_user_id: args.senderUserId,
    sender_handle: args.senderHandle,
    content: args.content,
    created_at: createdAt,
  };

  // The body is encoded once and the sequence is returned in the
  // result struct (not embedded in the body). The marketplace
  // side-consumer (`services/marketplace/src/channels-stream-consumer.ts`)
  // parses event_id / message_id / content / created_at from the
  // body and the channel_id / sender_user_id from the subject — those
  // four fields are the side-consumer's contract.
  const ack = await args.js.publish(subject, encoder.encode(JSON.stringify(body)), {
    msgID: eventId,
  });

  return {
    sequence: ack.seq,
    event_id: eventId,
    message_id: messageId,
    created_at: createdAt,
  };
}
