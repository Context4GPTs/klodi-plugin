/**
 * Transaction tools — pass-through to the marketplace via the catalog.
 *
 * Cancel and rate side-effect: clean up the local sell file once the
 * transaction reaches a terminal state.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { klodiTools } from "@klodi/tool-catalog";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
  requireCredsEnvelope,
} from "../lib/tool-result.js";
import { onTransactionTerminal } from "../service/state.js";

export function registerTransactionTools(api: PluginAPI): void {
  registerTxConfirm(api);
  registerTxCancel(api);
  registerTxRate(api);
  registerTxStatus(api);
}

function registerTxConfirm(api: PluginAPI): void {
  const tool = klodiTools.klodi_tx_confirm;
  api.registerTool({
    name: "klodi_tx_confirm",
    label: "Confirm Exchange",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = requireCredsEnvelope();
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

function registerTxCancel(api: PluginAPI): void {
  const tool = klodiTools.klodi_tx_cancel;
  api.registerTool({
    name: "klodi_tx_cancel",
    label: "Cancel Transaction",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = requireCredsEnvelope();
      if (guard) return guard;
      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, params);
      } catch (e) {
        return envelopeToolResult(e);
      }
      if (typeof result["listing_id"] === "string") {
        onTransactionTerminal(result["listing_id"]);
      }
      return jsonResult(result);
    },
  });
}

function registerTxRate(api: PluginAPI): void {
  const tool = klodiTools.klodi_tx_rate;
  api.registerTool({
    name: "klodi_tx_rate",
    label: "Rate Other Party",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = requireCredsEnvelope();
      if (guard) return guard;
      const payload: Record<string, unknown> = {
        transaction_id: params["transaction_id"],
        rating: params["rating"],
      };
      if (params["comment"]) payload["comment"] = params["comment"];
      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, payload);
      } catch (e) {
        return envelopeToolResult(e);
      }
      if (typeof result["listing_id"] === "string") {
        onTransactionTerminal(result["listing_id"]);
        api.logger.info("sell_file_cleaned", {
          listing_id: result["listing_id"],
        });
      }
      return jsonResult(result);
    },
  });
}

function registerTxStatus(api: PluginAPI): void {
  const tool = klodiTools.klodi_tx_status;
  api.registerTool({
    name: "klodi_tx_status",
    label: "Transaction Status",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = requireCredsEnvelope();
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
