/**
 * Durable JetStream consumer wiring + dedup LRU.
 *
 * Two consumers per user, both attached to host wake handlers via
 * KlodiClient:
 *
 *   - klodi-notifications-<user_id>  on P2P_NOTIFICATIONS
 *     filter_subject = p2p.v1.notifications.<user_id>     (fixed)
 *
 *   - klodi-channels-<user_id>       on P2P_CHANNELS
 *     filter_subjects = []                                (server-managed)
 *
 * Library responsibilities (per the shared-contracts doc):
 *   - Create the consumer if absent (matching the pinned config below);
 *     never mutate `filter_subjects` on the channels consumer.
 *   - Pull-consume in a background loop, parse the JSON body, dedup on
 *     `event_id`, invoke the handler, ack on resolve / nak on reject.
 *   - Stop cleanly when the caller closes the consumer.
 */

import {
  JetStreamApiCodes,
  JetStreamApiError,
  type Consumer,
  type ConsumerInfo,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import type { ChannelMessageEvent, NotificationEvent } from "@klodi/tool-catalog";
import type { KlodiMetrics } from "./metrics.js";

/**
 * Thrown when a server-managed durable consumer is missing.
 *
 * Per **D § D5 + D7** the per-user JWT no longer carries
 * `CONSUMER.CREATE` permissions; consumers are provisioned server-side
 * by the marketplace at user registration. If the client subscribes
 * before the marketplace has run its provisioning pass, this error
 * surfaces with a stable code so the host adapter can map it to a
 * `klodi_setup_status` issue (`consumer_missing`) and prompt the user
 * to re-register.
 */
export class KlodiSetupError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "KlodiSetupError";
  }
}

const decoder = new TextDecoder();

const NOTIFICATIONS_STREAM = "P2P_NOTIFICATIONS";
const CHANNELS_STREAM = "P2P_CHANNELS";

/** In-memory dedup window per consumer. */
const DEDUP_LRU_SIZE = 1_000;

export interface NotificationHandler {
  (event: NotificationEvent): Promise<void>;
}

export interface ChannelHandler {
  (event: ChannelMessageEvent): Promise<void>;
}

/**
 * Bounded LRU keyed by event_id. Backed by a Map: iteration order is
 * insertion order, and `delete + set` moves an entry to the back of
 * the order. `has()` on a recent hit and `remember()` on a duplicate
 * both refresh recency, matching `OrderedDict.move_to_end` (Python)
 * and the `lru` crate (Rust). Without the move-to-end, eviction would
 * degrade into FIFO and an event_id under sustained redelivery
 * pressure could be evicted while still being seen — causing the same
 * wake to fire the handler twice.
 *
 * Exported for unit testing; not part of the package's public API
 * surface (see `index.ts`).
 */
export class EventIdLru {
  private readonly seen = new Map<string, true>();

  has(id: string): boolean {
    if (!this.seen.has(id)) return false;
    this.seen.delete(id);
    this.seen.set(id, true);
    return true;
  }

  remember(id: string): void {
    if (this.seen.has(id)) {
      this.seen.delete(id);
    } else if (this.seen.size >= DEDUP_LRU_SIZE) {
      const oldest = this.seen.keys().next().value;
      if (typeof oldest === "string") this.seen.delete(oldest);
    }
    this.seen.set(id, true);
  }
}

/** Active consumer subscription handle. */
export interface ActiveSubscription {
  /** Stop the consumer loop. Idempotent. */
  stop(): Promise<void>;
  /**
   * Wall-clock timestamp of the last event the local handler processed
   * (post-dedup, pre-ack). `null` until the first event lands.
   *
   * Used by health probes to distinguish "consumer attached but quiet"
   * from "consumer attached but pull-loop wedged" — a wedged loop's
   * `lastEventAt` falls behind real time even though `consumer.info`
   * shows pending messages.
   */
  getLastEventAt(): Date | null;
  /**
   * Consumer's `inactive_threshold` (ms), captured from the JetStream
   * `consumer.info` response at subscribe time. `null` when the server
   * didn't include it (older nats-server) or it was unset.
   *
   * Comparing `Date.now() - getLastEventAt() > getInactiveThresholdMs()`
   * surfaces a stuck pull-loop before the server quietly tears the
   * consumer down on inactivity.
   */
  getInactiveThresholdMs(): number | null;
}

interface EnsureConsumerArgs {
  jsm: JetStreamManager;
  stream: string;
  durable: string;
}

/**
 * Defensive `INFO` check.
 *
 * Per **D § D5 + D7** the per-user JWT does not carry
 * `CONSUMER.CREATE`; consumers are server-managed. The client treats
 * absence as a setup-phase failure rather than silently fixing it —
 * a missing consumer means either the user never finished
 * registration, the marketplace didn't run its provisioning pass, or
 * a manual operator intervention deleted it. All three need a human
 * fix; the client must not paper over them.
 *
 * Throws [`KlodiSetupError`] with stable codes:
 * - `notifications_consumer_missing`
 * - `channels_consumer_missing`
 *
 * Catches the JetStream "consumer not found" code; everything else
 * surfaces as a transport error.
 */
async function assertConsumerExists(args: EnsureConsumerArgs): Promise<ConsumerInfo> {
  try {
    return await args.jsm.consumers.info(args.stream, args.durable);
  } catch (err) {
    const isNotFound =
      err instanceof JetStreamApiError
      && err.code === JetStreamApiCodes.ConsumerNotFound;
    if (isNotFound) {
      const code = args.stream === NOTIFICATIONS_STREAM
        ? "notifications_consumer_missing"
        : "channels_consumer_missing";
      throw new KlodiSetupError(
        code,
        `${code}: durable=${args.durable} stream=${args.stream}. `
          + `Consumers are server-managed (D5/D7) — re-run klodi_register or contact support.`,
      );
    }
    throw new Error(
      `consumer_info_failed: ${String(err)}`
      + ` (stream=${args.stream} consumer=${args.durable})`,
    );
  }
}

interface ConsumeArgs {
  consumer: Consumer;
  lru: EventIdLru;
  metrics: KlodiMetrics;
  /**
   * Mutable timestamp holder. The consume loop writes into
   * `holder.value` after each successful handler invocation so the
   * subscription's getLastEventAt() reflects the freshest activity.
   */
  lastEventHolder: { value: Date | null };
  onEvent(payload: unknown): Promise<void>;
  onError(err: unknown): void;
}

/**
 * Read the "this is the Nth redelivery" count off a JetStream message.
 *
 * `info.deliveryCount` is 1-based (first delivery = 1; second delivery
 * = 2 etc.), so the *redelivery* count is `deliveryCount - 1`. Mirrors
 * the Py `meta.num_delivered - 1` and Rust `info.delivered - 1`
 * accessors so the counter values are comparable across all three
 * languages.
 */
function redeliveryOf(msg: { info?: { deliveryCount?: number } }): number {
  const value = msg.info?.deliveryCount;
  return typeof value === "number" && value > 1 ? value - 1 : 0;
}

/** Read per-message pending count for the live `pending_count` gauge. */
function pendingOf(msg: { info?: { pending?: number } }): number | null {
  const value = msg.info?.pending;
  return typeof value === "number" && value >= 0 ? value : null;
}

/**
 * Background consume loop. Each delivered message is JSON-parsed,
 * deduped on event_id, dispatched to onEvent, and acked. A handler
 * exception triggers a nak so the server redelivers per max_deliver: 5.
 *
 * `msg.ack()` and `msg.nak()` return Promises in @nats-io/jetstream:
 * we MUST await them so the for-await loop blocks on the wire write
 * before pulling the next message. Without `await`, `max_ack_pending: 1`
 * delivers the next message before the prior ack lands and the parse-
 * failure / dedup-hit `continue` paths can race the iterator advance
 * past `return` / `cancel`. Ack/nak failures are routed through
 * `args.onError` so operator visibility matches the Py / Rust paths.
 */
async function safeAck(
  msg: { ack(): Promise<void> | void },
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await msg.ack();
  } catch (err) {
    onError(new Error(`consumer_ack_failed: ${String(err)}`));
  }
}

async function safeNak(
  msg: { nak(): Promise<void> | void },
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await msg.nak();
  } catch (err) {
    onError(new Error(`consumer_nak_failed: ${String(err)}`));
  }
}

async function ackAndCount(
  msg: { ack(): Promise<void> | void },
  metrics: KlodiMetrics,
  onError: (err: unknown) => void,
): Promise<void> {
  await safeAck(msg, onError);
  metrics.incAcked();
}

async function nakAndCount(
  msg: { nak(): Promise<void> | void },
  metrics: KlodiMetrics,
  onError: (err: unknown) => void,
): Promise<void> {
  await safeNak(msg, onError);
  metrics.incNaked();
}

async function consumeLoop(args: ConsumeArgs): Promise<ConsumerMessages> {
  const messages = await args.consumer.consume();
  void (async () => {
    for await (const msg of messages) {
      args.metrics.incConsumed();
      args.metrics.addRedelivery(redeliveryOf(msg));
      const pending = pendingOf(msg);
      if (pending !== null) args.metrics.setPending(pending);
      let payload: { event_id?: unknown } | null = null;
      try {
        payload = JSON.parse(decoder.decode(msg.data)) as { event_id?: unknown };
      } catch (err) {
        args.onError(new Error(
          `consumer_parse_failed: ${String(err)} subject=${msg.subject}`,
        ));
        // Malformed payloads can never succeed — ack so we don't loop on
        // them. The error log is the operator signal.
        await ackAndCount(msg, args.metrics, args.onError);
        continue;
      }

      const eventId = typeof payload.event_id === "string"
        ? payload.event_id
        : null;
      if (eventId !== null && args.lru.has(eventId)) {
        args.metrics.incDedupHit();
        await ackAndCount(msg, args.metrics, args.onError);
        continue;
      }

      try {
        await args.onEvent(payload);
        args.lastEventHolder.value = new Date();
        if (eventId !== null) args.lru.remember(eventId);
        await ackAndCount(msg, args.metrics, args.onError);
      } catch (err) {
        args.onError(err);
        await nakAndCount(msg, args.metrics, args.onError);
      }
    }
  })();
  return messages;
}

/**
 * Best-effort: pull a fresh `num_pending` from the consumer info and
 * publish into the metrics counter. Any error is swallowed (logged via
 * `onError`) — pending-count is observability, not a correctness signal.
 */
function refreshPending(
  info: ConsumerInfo,
  metrics: KlodiMetrics,
): void {
  const value = info.num_pending;
  if (typeof value === "number") {
    metrics.setPending(value);
  }
}

/**
 * JetStream returns `inactive_threshold` as nanoseconds. Convert to ms
 * for the `getInactiveThresholdMs()` getter so callers can compare
 * directly with `Date.now()` arithmetic.
 *
 * The field is optional in the wire schema; older nats-server may omit
 * it and a manually-managed consumer may not set it. Returns `null`
 * rather than 0 in those cases so the consumer surface can distinguish
 * "no threshold known" from "threshold of 0".
 */
function inactiveThresholdMsOf(info: ConsumerInfo): number | null {
  const ns = info.config.inactive_threshold;
  if (typeof ns !== "number" || !Number.isFinite(ns) || ns <= 0) {
    return null;
  }
  return Math.floor(ns / 1_000_000);
}

export interface SubscribeNotificationsArgs {
  js: JetStreamClient;
  jsm: JetStreamManager;
  userId: string;
  metrics: KlodiMetrics;
  handler: NotificationHandler;
  onError(err: unknown): void;
}

export async function subscribeNotifications(
  args: SubscribeNotificationsArgs,
): Promise<ActiveSubscription> {
  const durable = `klodi-notifications-${args.userId}`;

  const info = await assertConsumerExists({
    jsm: args.jsm,
    stream: NOTIFICATIONS_STREAM,
    durable,
  });
  refreshPending(info, args.metrics);
  const inactiveThresholdMs = inactiveThresholdMsOf(info);

  const consumer = await args.js.consumers.get(NOTIFICATIONS_STREAM, durable);
  const lru = new EventIdLru();
  const lastEventHolder: { value: Date | null } = { value: null };
  const messages = await consumeLoop({
    consumer,
    lru,
    metrics: args.metrics,
    lastEventHolder,
    onEvent: (payload) => args.handler(payload as NotificationEvent),
    onError: args.onError,
  });

  return {
    async stop(): Promise<void> {
      await messages.close();
    },
    getLastEventAt(): Date | null {
      return lastEventHolder.value;
    },
    getInactiveThresholdMs(): number | null {
      return inactiveThresholdMs;
    },
  };
}

export interface SubscribeChannelsArgs {
  js: JetStreamClient;
  jsm: JetStreamManager;
  userId: string;
  metrics: KlodiMetrics;
  handler: ChannelHandler;
  onError(err: unknown): void;
}

export async function subscribeChannels(
  args: SubscribeChannelsArgs,
): Promise<ActiveSubscription> {
  const durable = `klodi-channels-${args.userId}`;

  // filter_subjects is server-managed: the marketplace mutates it on
  // channel create/close. We never set or modify it here — see
  // 0012 § Per-user durable consumers.
  const info = await assertConsumerExists({
    jsm: args.jsm,
    stream: CHANNELS_STREAM,
    durable,
  });
  refreshPending(info, args.metrics);
  const inactiveThresholdMs = inactiveThresholdMsOf(info);

  const consumer = await args.js.consumers.get(CHANNELS_STREAM, durable);
  const lru = new EventIdLru();
  const lastEventHolder: { value: Date | null } = { value: null };
  const messages = await consumeLoop({
    consumer,
    lru,
    metrics: args.metrics,
    lastEventHolder,
    onEvent: (payload) => args.handler(payload as ChannelMessageEvent),
    onError: args.onError,
  });

  return {
    async stop(): Promise<void> {
      await messages.close();
    },
    getLastEventAt(): Date | null {
      return lastEventHolder.value;
    },
    getInactiveThresholdMs(): number | null {
      return inactiveThresholdMs;
    },
  };
}
