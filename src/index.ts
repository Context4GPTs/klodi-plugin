/**
 * Klodi OpenClaw Plugin — entry point.
 * Registers all marketplace tools and the NATS notification service.
 * Everything the agent needs in one package: tools + service + bundled skill.
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
  name: "Klodi Marketplace",
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
      message: "Klodi marketplace plugin registered.",
      api_url: getApiUrl(),
      api_url_source: getApiUrlSource(),
      klodi_home: getKlodiHome(),
      klodi_home_source: getKlodiHomeSource(),
    });
  },
});
