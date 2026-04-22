/**
 * klodi OpenClaw Plugin — entry point.
 *
 * Turns an OpenClaw host into a peer-to-peer marketplace agent. Everything
 * the agent needs ships in this one package: typed tools, a real-time
 * service, and a bundled skill.
 *
 * What this file wires up at load time:
 *   - 32 `klodi_*` tools (listings, offers, channels, transactions, media,
 *     identity, setup, pending) — see `contracts.tools` in
 *     `openclaw.plugin.json` for the authoritative list.
 *   - One service (`id: "klodi-nats"`) that maintains a persistent
 *     WebSocket to the configured klodi backend and drives the JetStream
 *     consumer + periodic timers. Registered here via
 *     `registerNatsService(api)`; lifecycle owned by the OpenClaw runtime.
 *   - A bundled skill at `./skill` (SKILL.md playbook + SETUP.md
 *     onboarding + `policies/security.md` hard-rule template).
 *
 * Network posture:
 *   - Exactly one outbound host: the configured klodi backend
 *     (`klodi.4gpts.com` by default, overridable via `klodi_api_url` config
 *     or `KLODI_API_URL` env). All traffic is NATS over WebSocket,
 *     authenticated by the NKey in `nats.creds`.
 *   - No other hosts contacted. No telemetry, no analytics, no
 *     third-party beacons.
 *
 * Disk posture:
 *   - All state under `$klodi_home` (default `~/.openclaw/workspace/.klodi/`,
 *     overridable via `klodi_home` config or `KLODI_HOME` env).
 *   - Credentials (`nats.creds`, `config.json`) written at mode 0600.
 *   - Private content (floor prices, policy bodies, `## Private Facts`,
 *     `## Logistics Plan`) never leaves the host — enforced by the bundled
 *     `policies/security.md` hard rules.
 *
 * Operational notes live in `SECURITY.md` at the repo root. Architecture
 * diagrams and the tool surface ride in the README.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyPluginConfigOverrides,
  getApiUrl,
  getApiUrlSource,
  getKlodiHome,
  getKlodiHomeSource,
  type KlodiPluginConfig,
} from "./lib/config.js";
import { registerNatsService } from "./service/nats.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerListingTools } from "./tools/listings.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerNegotiationTools } from "./tools/negotiation.js";
import { registerOfferTools } from "./tools/offers.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerMediaTools } from "./tools/media.js";
import { registerPendingTool } from "./tools/pending.js";
import { registerSetupTools } from "./tools/setup.js";

export default definePluginEntry({
  id: "klodi",
  name: "klodi",
  description: "P2P marketplace tools and real-time notifications via NATS",
  register(api) {
    // Plugin-scoped overrides (klodi_home, klodi_api_url) come from
    // api.pluginConfig — OpenClaw populates this from
    // plugins.klodi.config.* after schema validation. Reading
    // api.config would walk the FULL OpenClawConfig tree and silently
    // ignore the user's overrides; see lib/config.ts for the contract.
    applyPluginConfigOverrides(api.pluginConfig as KlodiPluginConfig | undefined);

    // Register NATS service (connection + JetStream consumer + timers)
    registerNatsService(api);

    // Register all marketplace tools
    registerIdentityTools(api);
    registerListingTools(api);
    registerDiscoveryTools(api);
    registerNegotiationTools(api);
    registerOfferTools(api);
    registerTransactionTools(api);
    registerMediaTools(api);
    registerPendingTool(api);
    registerSetupTools(api);

    api.logger.info("klodi_plugin_loaded", {
      message: "klodi marketplace plugin registered.",
      api_url: getApiUrl(),
      api_url_source: getApiUrlSource(),
      klodi_home: getKlodiHome(),
      klodi_home_source: getKlodiHomeSource(),
    });
  },
});
