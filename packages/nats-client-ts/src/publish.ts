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

// ─── Match-feedback publish (SC8 flywheel emit) ───────────────────────
//
// Reports an agent's pursue/dismiss verdict on a standing-search match to
// `p2p.v1.searches.match_feedback`, where the marketplace records it as a
// training example. Mirrors `publishChannelMessage`'s spine (mint event_id,
// encode body once, pass it as the `Nats-Msg-Id` dedup header) but diverges
// deliberately in validation: `search_slug` / `listing_id` ride in the BODY,
// not the subject, so the strict UUID-v4 guard is NOT reused — a non-UUID
// listing id the marketplace accepts must be accepted here too. See ADR-0013.

/** The closed outcome set. Matches the marketplace's `labelForOutcome`. */
const MATCH_FEEDBACK_OUTCOMES = ["pursued", "dismissed"] as const;
export type MatchFeedbackOutcome = (typeof MATCH_FEEDBACK_OUTCOMES)[number];

/** Subject the marketplace's SC8a capture-consumer drains. */
const MATCH_FEEDBACK_SUBJECT = "p2p.v1.searches.match_feedback";

/**
 * Marketplace slug pattern (`^[a-z0-9][a-z0-9._-]{0,119}$`). The slug never
 * enters a subject path here, but validating it before the wire write keeps
 * the plugin half byte-aligned with the marketplace schema (and rejects an
 * empty / whitespace / uppercase / over-long slug at the boundary).
 */
const MATCH_FEEDBACK_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

const MAX_LISTING_ID_LENGTH = 64;

export interface PublishMatchFeedbackArgs {
  js: JetStreamClient;
  searchSlug: string;
  listingId: string;
  outcome: MatchFeedbackOutcome;
  /** The buy file's action_on_match mode in effect; omitted from the wire when absent. */
  actionOnMatch?: string;
}

export interface PublishMatchFeedbackResult {
  sequence: number;
  event_id: string;
}

/**
 * Publish a match-feedback verdict. Stateless: each call mints a fresh
 * `event_id` (the `Nats-Msg-Id` dedup header), so a redelivered wake or a
 * flipped verdict re-emits safely — the marketplace upsert is idempotent
 * per (user, search, listing), last-verdict-wins. The body is EXACTLY
 * `{ search_slug, listing_id, outcome, action_on_match? }` — no ± label
 * (server-derived), no `listing_summary` (server re-read).
 */
export async function publishMatchFeedback(
  args: PublishMatchFeedbackArgs,
): Promise<PublishMatchFeedbackResult> {
  if (!MATCH_FEEDBACK_SLUG_RE.test(args.searchSlug)) {
    throw new Error(
      `publishMatchFeedback: search_slug must match ${MATCH_FEEDBACK_SLUG_RE.source}`
      + ` (got ${JSON.stringify(args.searchSlug)})`,
    );
  }
  if (args.listingId.length === 0 || args.listingId.length > MAX_LISTING_ID_LENGTH) {
    throw new Error(
      `publishMatchFeedback: listing_id must be 1..${MAX_LISTING_ID_LENGTH} chars`
      + ` (got length ${args.listingId.length})`,
    );
  }
  if (!(MATCH_FEEDBACK_OUTCOMES as readonly string[]).includes(args.outcome)) {
    throw new Error(
      `publishMatchFeedback: outcome must be one of ${MATCH_FEEDBACK_OUTCOMES.join(", ")}`
      + ` (got ${JSON.stringify(args.outcome)})`,
    );
  }

  const eventId = randomUUID();

  // Build the body with field order matching the Py/Rust halves. The optional
  // provenance is OMITTED entirely when absent — never serialized as null.
  const body: Record<string, string> = {
    search_slug: args.searchSlug,
    listing_id: args.listingId,
    outcome: args.outcome,
  };
  if (args.actionOnMatch !== undefined) {
    body["action_on_match"] = args.actionOnMatch;
  }

  const ack = await args.js.publish(
    MATCH_FEEDBACK_SUBJECT,
    encoder.encode(JSON.stringify(body)),
    { msgID: eventId },
  );

  return { sequence: ack.seq, event_id: eventId };
}
