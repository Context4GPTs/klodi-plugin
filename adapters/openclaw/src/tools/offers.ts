/**
 * Offer tools — pass-through to the marketplace via the catalog.
 *
 * Accept side-effect: when an offer is accepted, the matching sell file
 * gets the transaction_id stamped onto its frontmatter so subsequent
 * agent turns can find the open transaction.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { klodiTools } from "@klodi/tool-catalog";
import {
  errorResult,
  formatError,
  jsonResult,
  rawRequest,
  requireCreds,
} from "../lib/tool-result.js";
import { onOfferAccepted } from "../service/state.js";

export function registerOfferTools(api: PluginAPI): void {
  registerOfferCreate(api);
  registerOfferRespond(api);
  registerOfferMine(api);
}

function registerOfferCreate(api: PluginAPI): void {
  const tool = klodiTools.klodi_offer_create;
  api.registerTool({
    name: "klodi_offer_create",
    label: "Make Offer",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);
      const payload: Record<string, unknown> = {
        listing_id: params["listing_id"],
        channel_id: params["channel_id"],
        amount: params["amount"],
      };
      if (params["currency"]) payload["currency"] = params["currency"];
      if (params["message"]) payload["message"] = params["message"];
      if (params["terms"]) payload["terms"] = params["terms"];
      try {
        const result = await rawRequest(tool.subject, payload);
        return jsonResult(result);
      } catch (e) {
        return errorResult(formatError(e));
      }
    },
  });
}

function registerOfferRespond(api: PluginAPI): void {
  const tool = klodiTools.klodi_offer_respond;
  api.registerTool({
    name: "klodi_offer_respond",
    label: "Respond to Offer",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);
      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, params);
      } catch (e) {
        return errorResult(formatError(e));
      }
      if (
        params["action"] === "accept"
        && typeof result["listing_id"] === "string"
        && typeof result["transaction_id"] === "string"
      ) {
        onOfferAccepted(
          result["listing_id"],
          result["transaction_id"],
        );
      }
      return jsonResult(result);
    },
  });
}

function registerOfferMine(api: PluginAPI): void {
  const tool = klodiTools.klodi_offer_mine;
  api.registerTool({
    name: "klodi_offer_mine",
    label: "My Offers",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);
      const payload: Record<string, unknown> = {};
      if (params["status"]) payload["status"] = params["status"];
      if (params["role"]) payload["role"] = params["role"];
      if (params["listing_id"]) payload["listing_id"] = params["listing_id"];
      if (params["channel_id"]) payload["channel_id"] = params["channel_id"];
      try {
        const result = await rawRequest(tool.subject, payload);
        return jsonResult(result);
      } catch (e) {
        return errorResult(formatError(e));
      }
    },
  });
}
