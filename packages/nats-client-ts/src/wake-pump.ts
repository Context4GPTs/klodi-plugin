/**
 * Host-agnostic wake pump.
 *
 * Subscribe ownership lives here rather than in each adapter's lifecycle
 * wiring. The pump composes the two underlying subscribe calls
 * (notifications + channels) on a `WakePumpClient`-shaped client into
 * one cohesive lifecycle (start / stop / health) and singletonises per
 * `user_id` so the same persona never accidentally runs two competing
 * pumps inside the same process.
 *
 * The pump is intentionally NOT responsible for the inner consume
 * loop, the durable consumer assertion, or the ack/nak flow — those
 * already live in `consumers.ts`. The pump is the lifecycle wrapper
 * adapters were each re-implementing badly.
 */

import type {
  ChannelMessageEvent,
  NotificationEvent,
} from "@klodi/tool-catalog";
import type { ActiveSubscription } from "./consumers.js";

/**
 * Adapter-supplied wake handlers.
 *
 * `onNotification` receives `p2p.v1.notifications.<user_id>` events;
 * `onChannelEvent` receives `p2p.v1.channels.*` events. A throw from
 * either handler propagates out so the underlying consume loop can nak
 * the message — JetStream then redelivers per the durable's `max_deliver`.
 */
export interface WakePumpHandlers {
  onNotification(event: NotificationEvent): Promise<void>;
  onChannelEvent(event: ChannelMessageEvent): Promise<void>;
}

/** Diagnostic snapshot of pump state. */
export interface WakePumpHealth {
  running: boolean;
  user_id: string;
  notifications_last_event_at: Date | null;
  channels_last_event_at: Date | null;
  notifications_inactive_threshold_ms: number | null;
  channels_inactive_threshold_ms: number | null;
}

/**
 * Minimal client surface the pump depends on. Production passes a real
 * `KlodiClient`; tests pass a fake. Keeping this narrow lets the test
 * suite avoid spinning up nats-server while still exercising the full
 * pump contract.
 */
export interface WakePumpClient {
  isConnected(): boolean;
  subscribeNotifications(
    handler: (event: NotificationEvent) => Promise<void>,
  ): Promise<ActiveSubscription>;
  subscribeChannels(
    handler: (event: ChannelMessageEvent) => Promise<void>,
  ): Promise<ActiveSubscription>;
}

export interface WakePumpOptions {
  /**
   * Override the retry-delay schedule (1-based attempt index → ms).
   * Defaults to `attempt * 1000ms`, capped at 30s. Tests inject `() => 1`
   * for fast retry assertions.
   */
  retryDelayMs?: (attempt: number) => number;
  /** Cap retry attempts before surfacing the error. Defaults to 5. */
  maxStartAttempts?: number;
}

export interface WakePump {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): WakePumpHealth;
}

const registry = new Map<string, WakePump>();

const DEFAULT_RETRY_DELAY_MS = (attempt: number): number => {
  return Math.min(attempt * 1_000, 30_000);
};

const DEFAULT_MAX_START_ATTEMPTS = 5;

/**
 * Construct (or reuse) the pump for `userId`. Subsequent calls with the
 * same `userId` return the existing instance unchanged — the second
 * caller's handlers are silently discarded so two adapter wirings for
 * the same persona can never interleave.
 */
export function createWakePump(
  client: WakePumpClient,
  userId: string,
  handlers: WakePumpHandlers,
  options: WakePumpOptions = {},
): WakePump {
  const existing = registry.get(userId);
  if (existing !== undefined) return existing;

  const pump = buildPump(client, userId, handlers, options);
  registry.set(userId, pump);
  return pump;
}

/**
 * Internal — drop the singleton registry. Exported for unit tests so a
 * fresh `createWakePump` call returns a brand-new instance between test
 * cases.
 */
export function __resetWakePumpRegistryForTests(): void {
  registry.clear();
}

interface PumpState {
  running: boolean;
  notificationsSub: ActiveSubscription | null;
  channelsSub: ActiveSubscription | null;
}

function buildPump(
  client: WakePumpClient,
  userId: string,
  handlers: WakePumpHandlers,
  options: WakePumpOptions,
): WakePump {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxStartAttempts ?? DEFAULT_MAX_START_ATTEMPTS;
  const state: PumpState = {
    running: false,
    notificationsSub: null,
    channelsSub: null,
  };

  const start = async (): Promise<void> => {
    if (state.running) return;
    await attachWithRetry({
      attach: () =>
        client.subscribeNotifications(handlers.onNotification),
      label: "notifications",
      maxAttempts,
      retryDelayMs,
    }).then((sub) => { state.notificationsSub = sub; });
    try {
      state.channelsSub = await attachWithRetry({
        attach: () => client.subscribeChannels(handlers.onChannelEvent),
        label: "channels",
        maxAttempts,
        retryDelayMs,
      });
    } catch (err) {
      // Notifications attached but channels failed: tear notifications
      // down so the pump never half-starts. Surface the channel error
      // to the caller so the adapter can log + retry.
      if (state.notificationsSub !== null) {
        await safeStop(state.notificationsSub);
        state.notificationsSub = null;
      }
      throw err;
    }
    state.running = true;
  };

  const stop = async (): Promise<void> => {
    if (!state.running && state.notificationsSub === null
        && state.channelsSub === null) {
      registry.delete(userId);
      return;
    }
    if (state.notificationsSub !== null) {
      await safeStop(state.notificationsSub);
      state.notificationsSub = null;
    }
    if (state.channelsSub !== null) {
      await safeStop(state.channelsSub);
      state.channelsSub = null;
    }
    state.running = false;
    registry.delete(userId);
  };

  const health = (): WakePumpHealth => {
    return {
      running: state.running,
      user_id: userId,
      notifications_last_event_at: state.notificationsSub?.getLastEventAt()
        ?? null,
      channels_last_event_at: state.channelsSub?.getLastEventAt() ?? null,
      notifications_inactive_threshold_ms: state.notificationsSub
        ?.getInactiveThresholdMs() ?? null,
      channels_inactive_threshold_ms: state.channelsSub
        ?.getInactiveThresholdMs() ?? null,
    };
  };

  return { start, stop, health };
}

interface AttachArgs {
  attach: () => Promise<ActiveSubscription>;
  label: string;
  maxAttempts: number;
  retryDelayMs: (attempt: number) => number;
}

/**
 * Try to attach an inner subscription, retrying on transient errors with
 * a caller-supplied backoff schedule. The plan calls out reconnect-safety
 * as a wake-pump responsibility: the underlying NATS-WS client owns the
 * socket reconnect, but the consumer pull-loop binding can still fail
 * during the recovery window. Retrying here closes that gap.
 */
async function attachWithRetry(args: AttachArgs): Promise<ActiveSubscription> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    try {
      return await args.attach();
    } catch (err) {
      lastErr = err;
      if (attempt === args.maxAttempts) break;
      const delay = args.retryDelayMs(attempt);
      await sleep(delay);
    }
  }
  throw new Error(
    `wake_pump_${args.label}_attach_failed: `
    + `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function safeStop(sub: ActiveSubscription): Promise<void> {
  try {
    await sub.stop();
  } catch {
    // Stop is best-effort; an inner-stop failure must not block the
    // pump shutdown path. The inner consume loop's onError sink already
    // surfaced the underlying issue.
  }
}
