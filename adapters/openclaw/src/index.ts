/**
 * klodi OpenClaw Plugin — entry point.
 *
 * Turns an OpenClaw host into a peer-to-peer marketplace agent.
 * Everything the agent needs ships in this one package: typed tools,
 * a single persistent NATS-WS connection that carries tool calls and
 * wakes, and a bundled skill.
 *
 * Wake delivery:
 *
 *   - Tool calls       → NATS request/reply (KlodiClient.request)
 *   - Notifications    → JetStream durable consumer
 *                        klodi-notifications-<user_id>
 *                        on the P2P_NOTIFICATIONS stream — wakes the
 *                        agent with the FULL event payload (no drain
 *                        step required, no klodi_pending tool).
 *   - Channel messages → JetStream durable consumer
 *                        klodi-channels-<user_id> on P2P_CHANNELS,
 *                        delivering each message as a wake with full
 *                        body. Outbound: direct JetStream publish
 *                        via klodi_channel_message (replaces
 *                        klodi_channel_send).
 *
 * Subscription lifecycle is owned by the shared `WakePump` in
 * `@klodi/nats-client`. The pump is eagerly started here at register()
 * time when credentials are present, and from `klodi_register`'s success
 * path on first-run. If the register-time start throws (flaky NATS-WS
 * handshake at boot), a backoff retry in `service/wake-pump.ts` revives
 * the pump without waiting for `klodi_register` — already-registered
 * personas never re-enter that path and would otherwise stay
 * inbound-deaf until process restart. There is no host-SDK lifecycle
 * dependency — the `gateway:startup` hook on OpenClaw v2026.4.15 fires
 * inconsistently and silently took wake delivery offline before this
 * refactor.
 *
 * Disk posture:
 *   - All state under `$klodi_home` (default
 *     `~/.openclaw/workspace/.klodi/`, overridable via `klodi_home`
 *     config or `KLODI_HOME` env).
 *   - Credentials (`nats.creds`, `config.json`) at mode 0600.
 *   - Private content (floor prices, policy bodies, `## Private
 *     Facts`, `## Logistics Plan`) never leaves the host.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyPluginConfigOverrides,
  getApiUrl,
  getApiUrlSource,
  getKlodiHome,
  getKlodiHomeSource,
  type KlodiPluginConfig,
} from "./lib/paths.js";
import type { PluginAPILike } from "./lib/plugin-api-types.js";
import { closeClient } from "./lib/client.js";
import {
  scheduleWakePumpRetry,
  startWakePumpIfPossible,
  stopWakePump,
} from "./service/wake-pump.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerListingTools } from "./tools/listings.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerNegotiationTools } from "./tools/negotiation.js";
import { registerOfferTools } from "./tools/offers.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerSetupTools } from "./tools/setup.js";

export default definePluginEntry({
  id: "klodi",
  name: "klodi",
  description:
    "P2P marketplace tools and JetStream-native wake delivery —"
    + " one persistent NATS-WS connection per session.",
  register(api) {
    applyPluginConfigOverrides(api.pluginConfig as KlodiPluginConfig | undefined);

    registerIdentityTools(api);
    registerListingTools(api);
    registerDiscoveryTools(api);
    registerNegotiationTools(api);
    registerOfferTools(api);
    registerTransactionTools(api);
    registerSetupTools(api);

    // Eager wake pump: start the JetStream consumers the moment
    // credentials are on disk. The shared library owns the subscribe +
    // reconnect lifecycle so we no longer depend on the host SDK
    // emitting a `gateway:startup` event (which OpenClaw v2026.4.15
    // does inconsistently).
    void startWakePumpIfPossible(api).catch((err) => {
      api.logger.warn("wake_pump_register_start_failed", {
        error: err instanceof Error ? err.message : String(err),
        message:
          "Wake pump did not start at register() — outbound tools still"
          + " work; retrying in the background.",
      });
      scheduleWakePumpRetry(api);
    });

    bindShutdown(api);

    api.logger.info("klodi_plugin_loaded", {
      message: "klodi marketplace plugin registered.",
      api_url: getApiUrl(),
      api_url_source: getApiUrlSource(),
      klodi_home: getKlodiHome(),
      klodi_home_source: getKlodiHomeSource(),
    });
  },
});

const SESSION_CLOSE_HOOKS: ReadonlyArray<string> = ["gateway:shutdown"];

/**
 * Drain on graceful shutdown. The shutdown hook is best-effort: on
 * SDK versions where it doesn't fire, the OS-level signal handler
 * (registered once per process) still reaches `stopWakePump`. The
 * pump's correctness no longer depends on either path firing.
 */
function bindShutdown(api: PluginAPILike): void {
  for (const hook of SESSION_CLOSE_HOOKS) {
    api.lifecycle?.on?.(hook, () => {
      void shutdown(api);
    });
  }
  installSignalHandlers(api);
}

let signalHandlersInstalled = false;

function installSignalHandlers(api: PluginAPILike): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const onSignal = (signal: NodeJS.Signals): void => {
    api.logger.info("wake_pump_signal_shutdown", { signal });
    void shutdown(api);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

async function shutdown(api: PluginAPILike): Promise<void> {
  try {
    await stopWakePump(api);
  } catch (err) {
    api.logger.warn("wake_pump_shutdown_stop_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await closeClient();
  } catch (err) {
    api.logger.warn("wake_pump_shutdown_close_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
