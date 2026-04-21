/**
 * NATS service lifecycle: registerService with JetStream consumer.
 * Manages connection, durable consumer, and notification routing.
 *
 * The service's start()/stop() are owned by the OpenClaw runtime.
 * ensureNatsRunning(api) is an idempotent, re-entrant bootstrap that
 * can also be called from tools — notably klodi_register_poll — so
 * a fresh user goes from registered → connected without a restart.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { type NatsConnection } from "@nats-io/nats-core";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type Consumer,
} from "@nats-io/jetstream";
import {
  getConnection,
  drain,
  isConnected,
} from "../lib/nats-client.js";
import { readApiConfig } from "../lib/api-config.js";
import {
  parseDurationMs,
  HEARTBEAT_EVERY_CEILING_MS,
} from "../lib/duration.js";
import { hasCredentials, loadConfig } from "../lib/config.js";
import {
  handleNotification,
  initNotifications,
  type MarketplaceEvent,
} from "./notifications.js";
import {
  initTimers,
  reconcileTimers,
  clearAllTimers,
} from "./timers.js";
import { wakeAgent } from "./wake.js";

const STREAM = "P2P_NOTIFICATIONS";
const CONSUME_RETRY_MS = 5_000;

let consuming = false;
let starting: Promise<EnsureResult> | null = null;

export interface EnsureResult {
  status: "running" | "skipped" | "failed";
  reason?: string;
}

export function registerNatsService(api: PluginAPI): void {
  initNotifications(api);
  initTimers(api);

  api.registerService({
    id: "klodi-nats",

    async start() {
      await ensureNatsRunning(api);
    },

    async stop() {
      // Flip intent FIRST so any in-flight bootstrap observes the
      // cancellation on its next checkpoint — must happen before any
      // await below, including the register-poller dynamic import.
      consuming = false;
      clearAllTimers();
      // Dynamic import: register-poller statically imports
      // resetNatsState + ensureNatsRunning from this file, so a static
      // import here would create an ESM cycle. The module is already in
      // the ESM cache (identity.ts loaded it at plugin init), so this
      // resolves synchronously from cache in practice.
      const { stopRegisterPoll } = await import(
        "../tools/register-poller.js"
      );
      stopRegisterPoll("service_stop");
      await drain();
      // Clear starting only after drain — any concurrent awaiter
      // resolves with the bootstrap's own terminal state.
      starting = null;
      api.logger.info("nats_stopped");
    },
  });
}

/**
 * Reset all module-level NATS state: stop consuming, drain the
 * connection, and forget any in-flight starting promise. Used by
 * klodi_setup_repair to guarantee the next ensureNatsRunning call
 * re-binds to fresh credentials instead of short-circuiting on
 * stale `consuming && isConnected()`.
 */
export async function resetNatsState(): Promise<void> {
  consuming = false;
  starting = null;
  await drain();
}

/**
 * Idempotent bootstrap: connects NATS, opens the durable JetStream
 * consumer, reconciles per-item timers, and starts connection
 * monitoring. Safe to call repeatedly — already-running returns
 * immediately; concurrent callers serialize on the same promise.
 */
export async function ensureNatsRunning(
  api: PluginAPI,
): Promise<EnsureResult> {
  if (consuming && isConnected()) {
    return { status: "running" };
  }
  if (starting !== null) {
    return starting;
  }
  if (!hasCredentials()) {
    api.logger.info("nats_skipped", {
      message: "No credentials. Use klodi_register.",
    });
    void promptOnboarding(api);
    return { status: "skipped", reason: "no_credentials" };
  }

  starting = bootstrap(api);
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * Push a system event instructing the agent to start onboarding.
 * Fires whenever the service boots without credentials — i.e.,
 * immediately after `openclaw plugins install @4gpts/klodi` reloads
 * the gateway, and on every subsequent restart until the user
 * registers. Re-firing on each boot is intentional: it surfaces the
 * pending setup to the agent without relying on the user remembering
 * to invoke the skill.
 */
async function promptOnboarding(api: PluginAPI): Promise<void> {
  await wakeAgent(
    api,
    "[Klodi] Plugin is installed but the user is not registered."
      + " Kick off onboarding now: call klodi_setup_status and"
      + " follow SETUP.md from the klodi skill.",
    "klodi-onboarding-needed",
  );
}

async function bootstrap(api: PluginAPI): Promise<EnsureResult> {
  const heartbeat = readApiConfig(api, "agents.defaults.heartbeat.target");
  if (heartbeat !== "last") {
    api.logger.error("heartbeat_not_last", {
      current: heartbeat ?? null,
      message: "agents.defaults.heartbeat.target is not \"last\"."
        + " Push notifications will NOT wake the agent between"
        + " user turns. Run:"
        + " openclaw config set agents.defaults.heartbeat.target \"last\"",
    });
  }

  const heartbeatEveryRaw = readApiConfig(
    api,
    "agents.defaults.heartbeat.every",
  );
  const heartbeatEveryMs = parseDurationMs(heartbeatEveryRaw);
  if (
    heartbeatEveryMs === null
    || heartbeatEveryMs === 0
    || heartbeatEveryMs > HEARTBEAT_EVERY_CEILING_MS
  ) {
    api.logger.error("heartbeat_interval_too_long", {
      current: heartbeatEveryRaw ?? null,
      current_ms: heartbeatEveryMs,
      ceiling_ms: HEARTBEAT_EVERY_CEILING_MS,
      message: "agents.defaults.heartbeat.every is the fallback cadence"
        + " when requestHeartbeatNow silently no-ops (OpenClaw SDK"
        + " #29215/#34338/#14191). Must be > 0 and ≤ 2 minutes;"
        + " the SDK default of \"30m\" stalls queued wakes for up to"
        + " half an hour. Run:"
        + " openclaw config set agents.defaults.heartbeat.every \"1m\"",
    });
  }

  const config = loadConfig();

  let nc: NatsConnection;
  try {
    nc = await getConnection();
  } catch (err) {
    // `String(err)` on a nats-core `ConnectionError` often renders as the bare
    // class name when the WebSocket event carried no message (see ws_transport
    // `new ConnectionError(evt.message)`). Capture the whole error shape so
    // future regressions surface the underlying cause instead of a hollow
    // "ConnectionError" string.
    const e = err as { name?: string; message?: string; stack?: string; cause?: unknown };
    api.logger.error("nats_connect_failed", {
      error: String(err),
      error_name: e?.name ?? null,
      error_message: e?.message ?? null,
      error_cause: e?.cause ? String(e.cause) : null,
      error_stack: e?.stack ?? null,
      server: config.nats_url,
    });
    return { status: "failed", reason: String(err) };
  }

  api.logger.info("nats_connected", { server: config.nats_url });

  // Invariant: `consuming = true` MUST stay AFTER the getConnection()
  // await. If stop() races past this point while bootstrap is still
  // awaiting connection, stop() sets consuming=false + drains; when
  // bootstrap resumes it re-sets consuming=true here, but drain()
  // already nulled the connection, so consumeLoop's first while-check
  // fails (isConnected() === false) and the finally block resets
  // consuming=false. That's the self-heal. Moving this line ABOVE
  // the getConnection() await breaks the invariant: stop() would
  // clear consuming while getConnection() is mid-flight, and a
  // zombie consumeLoop could observe a live connection with
  // consuming=true and never terminate.
  consuming = true;
  void consumeLoop(api, jetstream(nc), config.user_id);
  reconcileTimers();
  void monitorConnection(api, nc);

  return { status: "running" };
}

async function consumeLoop(
  api: PluginAPI,
  js: JetStreamClient,
  userId: string,
): Promise<void> {
  const consumerName = `klodi-${userId}`;
  const filterSubject = `p2p.v1.notifications.${userId}`;
  const decoder = new TextDecoder();

  try {
    while (consuming && isConnected()) {
      try {
        let consumer: Consumer;
        try {
          consumer = await js.consumers.get(STREAM, consumerName);
        } catch {
          const nc = await getConnection();
          const jsm = await jetstreamManager(nc);
          await jsm.consumers.add(STREAM, {
            durable_name: consumerName,
            filter_subject: filterSubject,
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.New,
            max_deliver: 3,
          });
          consumer = await js.consumers.get(STREAM, consumerName);
        }

        const messages = await consumer.consume();
        for await (const msg of messages) {
          if (!consuming) break;
          let parsed: MarketplaceEvent;
          try {
            parsed = parseWireEvent(msg.data, decoder);
          } catch (err) {
            api.logger.error("notification_parse_failed", {
              error: String(err),
            });
            msg.ack();
            continue;
          }
          try {
            await handleNotification(parsed);
            msg.ack();
          } catch (err) {
            api.logger.error("notification_handler_failed", {
              event: parsed.event,
              error: String(err),
            });
            msg.nak();
          }
        }
      } catch (err) {
        if (!consuming || !isConnected()) break;
        api.logger.error("consumer_interrupted", {
          error: String(err),
          action: `retrying in ${CONSUME_RETRY_MS / 1_000}s`,
        });
        await new Promise((r) => setTimeout(r, CONSUME_RETRY_MS));
      }
    }
  } finally {
    // Loop exited — either by stop() or a transient disconnect the
    // while-check caught. Flip consuming so the next ensureNatsRunning
    // call re-enters bootstrap instead of short-circuiting on a
    // stale consuming=true flag with a dead consumer.
    consuming = false;
  }
}

/**
 * Marketplace publishes `{type, recipients, payload}` on
 * `p2p.v1.notifications.<userId>`. The plugin's `MarketplaceEvent`
 * shape is flat — `{event, ...fields}`. Translate here so the
 * contract is enforced in exactly one place.
 */
function parseWireEvent(
  data: Uint8Array,
  decoder: TextDecoder,
): MarketplaceEvent {
  const raw = JSON.parse(decoder.decode(data)) as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  if (typeof raw.type !== "string") {
    throw new Error(
      "notification missing `type` field — wire format drift",
    );
  }
  return {
    event: raw.type,
    ...(raw.payload ?? {}),
  } as MarketplaceEvent;
}

async function monitorConnection(
  api: PluginAPI,
  nc: NatsConnection,
): Promise<void> {
  for await (const s of nc.status()) {
    if (!consuming) break;
    switch (s.type) {
      case "disconnect":
        api.logger.warn("nats_disconnected", {
          message: "Notifications paused. Reconnecting...",
        });
        break;
      case "reconnect":
        api.logger.info("nats_reconnected", {
          message: "Notifications resumed.",
        });
        break;
      case "error":
        api.logger.info("nats_monitor_exit", { type: s.type });
        return;
    }
  }
}
