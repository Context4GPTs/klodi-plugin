/**
 * Listing tools — pass-through to the marketplace via the catalog.
 *
 * The local sell-file side-effect on create / withdraw / relist stays:
 * sell/<slug>.md is the on-disk policy file the agent reads when
 * deciding how to negotiate.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { klodiTools } from "@klodi/tool-catalog";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
} from "../lib/tool-result.js";
import { runPreCallGuardsResult } from "../lib/guards.js";
import {
  onListingCreated,
  onListingRelisted,
  onListingWithdrawn,
} from "../service/state.js";
import { getSellFilePath } from "../lib/paths.js";

// Per-host register CLI surfaced in `not_registered` recovery hints (R8).
const OPENCLAW_REGISTER_CLI = "klodi-openclaw-register";

const SELL_FILE_HINT =
  "Write private context (floor price, logistics, private facts) into"
  + " this file's body. Never create a separate per-listing file.";

export function registerListingTools(api: PluginAPI): void {
  registerCreate(api);
  registerGet(api);
  registerMine(api);
  registerUpdate(api);
  registerWithdraw(api);
  registerRelist(api);
  registerComments(api);
}

function registerCreate(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_create;
  api.registerTool({
    name: "klodi_list_create",
    label: "Create Listing",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;

      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, params);
      } catch (e) {
        return envelopeToolResult(e);
      }

      if (typeof result["listing_id"] === "string") {
        try {
          const slug = onListingCreated(
            params["title"] as string,
            result["listing_id"] as string,
          );
          api.logger.info("sell_file_created", {
            slug, listing_id: result["listing_id"],
          });
          result["sell_file"] = {
            slug, path: getSellFilePath(slug), hint: SELL_FILE_HINT,
          };
        } catch (sideEffectErr) {
          api.logger.error("sell_file_create_failed", {
            listing_id: result["listing_id"],
            error: String(sideEffectErr),
            remediation:
              "Run klodi_list_mine to find the listing, then"
              + " klodi_list_withdraw and klodi_list_relist to recreate"
              + " the sell file.",
          });
        }
      }
      return jsonResult(result);
    },
  });
}

function registerGet(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_get;
  api.registerTool({
    name: "klodi_list_get",
    label: "Get Listing",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      try {
        const result = await rawRequest(tool.subject, params);
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerMine(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_mine;
  api.registerTool({
    name: "klodi_list_mine",
    label: "My Listings",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const payload: Record<string, unknown> = {};
      if (params["status"]) payload["status"] = params["status"];
      try {
        const result = await rawRequest(tool.subject, payload);
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerUpdate(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_update;
  api.registerTool({
    name: "klodi_list_update",
    label: "Update Listing",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, params);
      } catch (e) {
        return envelopeToolResult(e);
      }
      // Note: no local sell-file mirror happens here. After D3 the floor
      // is preserved literally on disk; deriving it from `asking_price`
      // (the previous behavior) collapsed the SECURITY.md guarantee
      // that the floor never tracks the public price. The floor + body
      // are user-edited directly under `${klodi_home}/sell/<slug>.md`;
      // there's nothing for a server-side update to mirror.
      return jsonResult(result);
    },
  });
}

function registerWithdraw(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_withdraw;
  api.registerTool({
    name: "klodi_list_withdraw",
    label: "Withdraw Listing",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const listingId = params["listing_id"] as string;
      try {
        const result = await rawRequest(tool.subject, {
          listing_id: listingId, status: "withdrawn",
        });
        onListingWithdrawn(listingId);
        api.logger.info("sell_file_deleted", { listing_id: listingId });
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerRelist(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_relist;
  api.registerTool({
    name: "klodi_list_relist",
    label: "Relist Listing",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const listingId = params["listing_id"] as string;
      const payload: Record<string, unknown> = {
        listing_id: listingId, status: "active",
      };
      if (params["asking_price"] !== undefined) {
        payload["asking_price"] = params["asking_price"];
      }
      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, payload);
      } catch (e) {
        return envelopeToolResult(e);
      }
      const title = (result["title"] as string) ?? listingId;
      const slug = onListingRelisted(listingId, title);
      api.logger.info("sell_file_ensured", { slug, listing_id: listingId });
      result["sell_file"] = {
        slug, path: getSellFilePath(slug), hint: SELL_FILE_HINT,
      };
      return jsonResult(result);
    },
  });
}

function registerComments(api: PluginAPI): void {
  const tool = klodiTools.klodi_list_comments;
  api.registerTool({
    name: "klodi_list_comments",
    label: "List Listing Comments",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const payload: Record<string, unknown> = {
        listing_id: params["listing_id"],
      };
      if (params["limit"] !== undefined) payload["limit"] = params["limit"];
      if (params["before"]) payload["before"] = params["before"];
      if (params["after"]) payload["after"] = params["after"];
      try {
        const result = await rawRequest(tool.subject, payload);
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}
