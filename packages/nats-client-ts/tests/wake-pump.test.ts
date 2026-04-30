/**
 * Unit tests for the host-agnostic `WakePump`
 * (per `docs/plans/2026-04-28-host-agnostic-wake-pump.md`).
 *
 * The pump owns subscribe ownership for both notification and channel
 * consumers and exposes a uniform start/stop/health surface that every
 * adapter (openclaw, hermes, future Rust daemon) plugs handlers into.
 * These tests pin the contract: idempotent start, deterministic
 * dispatch order, throw-propagation so the inner consume loop can nak,
 * idempotent stop, per-`user_id` singleton with registry release on
 * stop, retry-on-transient-subscribe-failure, and faithful health
 * reporting from the inner subscriptions.
 *
 * The implementation does not exist yet — running this suite is
 * expected to fail (RED phase of TDD).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetWakePumpRegistryForTests,
  createWakePump,
  type WakePumpClient,
  type WakePumpHandlers,
} from "../src/wake-pump.js";

interface InnerSub {
  stop: ReturnType<typeof vi.fn>;
  getLastEventAt: ReturnType<typeof vi.fn>;
  getInactiveThresholdMs: ReturnType<typeof vi.fn>;
}

interface FakeClient {
  client: WakePumpClient;
  /** Captures the wrapped handler the pump passes to subscribeNotifications. */
  notifyHandler(): (event: unknown) => Promise<void>;
  /** Captures the wrapped handler the pump passes to subscribeChannels. */
  channelHandler(): (event: unknown) => Promise<void>;
  notifySub: InnerSub;
  channelSub: InnerSub;
  /** vi.fn instances for assertion. */
  subscribeNotifications: ReturnType<typeof vi.fn>;
  subscribeChannels: ReturnType<typeof vi.fn>;
  /**
   * If non-null, the next subscribeNotifications call rejects with this
   * error and resets the knob to null. Lets a test drive a transient
   * failure followed by a successful retry without rebuilding the fake.
   */
  setPendingNotifyError(err: Error | null): void;
}

function makeInnerSub(overrides?: Partial<{
  lastEventAt: Date | null;
  inactiveThresholdMs: number | null;
}>): InnerSub {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
    getLastEventAt: vi.fn().mockReturnValue(overrides?.lastEventAt ?? null),
    getInactiveThresholdMs: vi.fn().mockReturnValue(
      overrides?.inactiveThresholdMs ?? null,
    ),
  };
}

function makeFakeClient(opts?: {
  notifySub?: InnerSub;
  channelSub?: InnerSub;
  isConnected?: boolean;
}): FakeClient {
  const notifySub = opts?.notifySub ?? makeInnerSub();
  const channelSub = opts?.channelSub ?? makeInnerSub();
  let capturedNotify: ((event: unknown) => Promise<void>) | null = null;
  let capturedChannel: ((event: unknown) => Promise<void>) | null = null;
  let pendingNotifyError: Error | null = null;

  const subscribeNotifications = vi.fn(
    async (handler: (event: unknown) => Promise<void>) => {
      if (pendingNotifyError !== null) {
        const err = pendingNotifyError;
        pendingNotifyError = null;
        throw err;
      }
      capturedNotify = handler;
      return notifySub;
    },
  );

  const subscribeChannels = vi.fn(
    async (handler: (event: unknown) => Promise<void>) => {
      capturedChannel = handler;
      return channelSub;
    },
  );

  const client: WakePumpClient = {
    isConnected: () => opts?.isConnected ?? true,
    subscribeNotifications,
    subscribeChannels,
  };

  return {
    client,
    notifyHandler(): (event: unknown) => Promise<void> {
      if (capturedNotify === null) {
        throw new Error("notification handler not yet captured");
      }
      return capturedNotify;
    },
    channelHandler(): (event: unknown) => Promise<void> {
      if (capturedChannel === null) {
        throw new Error("channel handler not yet captured");
      }
      return capturedChannel;
    },
    notifySub,
    channelSub,
    subscribeNotifications,
    subscribeChannels,
    setPendingNotifyError(err: Error | null): void {
      pendingNotifyError = err;
    },
  };
}

function makeHandlers(): {
  handlers: WakePumpHandlers;
  onNotification: ReturnType<typeof vi.fn>;
  onChannelEvent: ReturnType<typeof vi.fn>;
} {
  const onNotification = vi.fn(async (_event: unknown) => undefined);
  const onChannelEvent = vi.fn(async (_event: unknown) => undefined);
  return {
    handlers: { onNotification, onChannelEvent },
    onNotification,
    onChannelEvent,
  };
}

describe("WakePump", () => {
  beforeEach(() => {
    __resetWakePumpRegistryForTests();
  });

  it("start subscribes both consumers exactly once when called twice", async () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);

    await pump.start();
    await pump.start();

    expect(fake.subscribeNotifications).toHaveBeenCalledTimes(1);
    expect(fake.subscribeChannels).toHaveBeenCalledTimes(1);
    expect(pump.health().running).toBe(true);
  });

  it("dispatches notifications through the configured handler", async () => {
    const fake = makeFakeClient();
    const { handlers, onNotification, onChannelEvent } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);
    await pump.start();

    const eventA = { event_id: "evt-1", kind: "channel.message" };
    const eventB = { event_id: "evt-2", kind: "search.match" };
    await fake.notifyHandler()(eventA);
    await fake.notifyHandler()(eventB);

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification.mock.calls[0]?.[0]).toBe(eventA);
    expect(onNotification.mock.calls[1]?.[0]).toBe(eventB);
    expect(onChannelEvent).not.toHaveBeenCalled();
  });

  it("dispatches channel events through the configured handler", async () => {
    const fake = makeFakeClient();
    const { handlers, onNotification, onChannelEvent } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);
    await pump.start();

    const eventA = { event_id: "evt-1", kind: "channel.opened" };
    const eventB = { event_id: "evt-2", kind: "channel.message" };
    await fake.channelHandler()(eventA);
    await fake.channelHandler()(eventB);

    expect(onChannelEvent).toHaveBeenCalledTimes(2);
    expect(onChannelEvent.mock.calls[0]?.[0]).toBe(eventA);
    expect(onChannelEvent.mock.calls[1]?.[0]).toBe(eventB);
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("propagates handler throws so the consume loop can nak", async () => {
    const fake = makeFakeClient();
    const onNotification = vi.fn(async (_event: unknown) => {
      throw new Error("handler boom");
    });
    const onChannelEvent = vi.fn(async (_event: unknown) => undefined);
    const pump = createWakePump(fake.client, "user-a", {
      onNotification,
      onChannelEvent,
    });
    await pump.start();

    await expect(fake.notifyHandler()({ event_id: "evt-1" })).rejects.toThrow(
      "handler boom",
    );
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  it("stop() stops both inner subscriptions and flips running flag", async () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);

    await pump.start();
    await pump.stop();

    expect(fake.notifySub.stop).toHaveBeenCalledTimes(1);
    expect(fake.channelSub.stop).toHaveBeenCalledTimes(1);
    expect(pump.health().running).toBe(false);
  });

  it("stop() is idempotent — second call is a no-op", async () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);

    await pump.start();
    await pump.stop();
    await pump.stop();

    expect(fake.notifySub.stop).toHaveBeenCalledTimes(1);
    expect(fake.channelSub.stop).toHaveBeenCalledTimes(1);
  });

  it("returns the same singleton for the same user_id on a second call", () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();

    const first = createWakePump(fake.client, "user-x", handlers);
    const second = createWakePump(fake.client, "user-x", handlers);

    expect(second).toBe(first);
  });

  it("returns distinct pumps for different user ids", () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();

    const userA = createWakePump(fake.client, "user-a", handlers);
    const userB = createWakePump(fake.client, "user-b", handlers);

    expect(userA).not.toBe(userB);
  });

  it("retries subscribe with backoff after a transient error", async () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();
    fake.setPendingNotifyError(new Error("transient: socket closed"));
    const retryDelayMs = vi.fn((_attempt: number) => 1);
    const pump = createWakePump(fake.client, "user-a", handlers, {
      retryDelayMs,
    });

    await expect(pump.start()).resolves.toBeUndefined();

    expect(fake.subscribeNotifications).toHaveBeenCalledTimes(2);
    expect(retryDelayMs).toHaveBeenCalled();
    expect(pump.health().running).toBe(true);
  });

  it("health() reports last-event timestamps from inner subscriptions", async () => {
    const notifyAt = new Date("2026-04-28T10:00:00Z");
    const channelAt = new Date("2026-04-28T10:05:00Z");
    const fake = makeFakeClient({
      notifySub: makeInnerSub({
        lastEventAt: notifyAt,
        inactiveThresholdMs: 30_000,
      }),
      channelSub: makeInnerSub({
        lastEventAt: channelAt,
        inactiveThresholdMs: 60_000,
      }),
    });
    const { handlers } = makeHandlers();
    const pump = createWakePump(fake.client, "user-a", handlers);
    await pump.start();

    const health = pump.health();

    expect(health.user_id).toBe("user-a");
    expect(health.running).toBe(true);
    expect(health.notifications_last_event_at).toEqual(notifyAt);
    expect(health.channels_last_event_at).toEqual(channelAt);
    expect(health.notifications_inactive_threshold_ms).toBe(30_000);
    expect(health.channels_inactive_threshold_ms).toBe(60_000);
  });

  it("disposed pump can be re-created (registry releases on stop)", async () => {
    const fake = makeFakeClient();
    const { handlers } = makeHandlers();

    const first = createWakePump(fake.client, "user-a", handlers);
    await first.start();
    await first.stop();
    const second = createWakePump(fake.client, "user-a", handlers);

    expect(second).not.toBe(first);
  });
});
