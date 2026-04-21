/**
 * Transaction tools: confirm, cancel, rate, status.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { Uuid, Rating, CancelReason } from "../lib/schemas.js";
import { request } from "../lib/nats-client.js";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
  handleResponse,
} from "../lib/tool-result.js";
import { onTransactionTerminal } from "../service/state.js";

export function registerTransactionTools(
  api: PluginAPI,
): void {
  registerTxConfirm(api);
  registerTxCancel(api);
  registerTxRate(api);
  registerTxStatus(api);
}

function registerTxConfirm(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_tx_confirm",
    label: "Confirm Exchange",
    description:
      "Confirm the exchange happened."
      + " Both parties must confirm."
      + " When both confirm, listing moves to sold.",
    parameters: Type.Object({
      transaction_id: Uuid,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.transactions.confirm",
        { transaction_id: params["transaction_id"] },
      );
    },
  });
}

function registerTxCancel(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_tx_cancel",
    label: "Cancel Transaction",
    description:
      "Cancel a transaction. Listing returns to"
      + " active. Penalized reasons auto-apply"
      + " a 1-star rating.",
    parameters: Type.Object({
      transaction_id: Uuid,
      reason: CancelReason,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.transactions.cancel",
          {
            transaction_id: params["transaction_id"],
            reason: params["reason"],
          },
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (
        !("error" in result) && result["listing_id"]
      ) {
        onTransactionTerminal(
          result["listing_id"] as string,
        );
      }

      return handleResponse(result);
    },
  });
}

function registerTxRate(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_tx_rate",
    label: "Rate Other Party",
    description:
      "Rate the other party (1-5 stars)"
      + " after confirming the exchange.",
    parameters: Type.Object({
      transaction_id: Uuid,
      rating: Rating,
      comment: Type.Optional(Type.String({
        description: "Optional rating comment",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        transaction_id: params["transaction_id"],
        rating: params["rating"],
      };
      if (params["comment"]) {
        payload["comment"] = params["comment"];
      }

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.transactions.rate", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (
        !("error" in result) && result["listing_id"]
      ) {
        onTransactionTerminal(
          result["listing_id"] as string,
        );
        api.logger.info("sell_file_cleaned", {
          listing_id: result["listing_id"],
        });
      }

      return handleResponse(result);
    },
  });
}

function registerTxStatus(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_tx_status",
    label: "Transaction Status",
    description:
      "Check transaction status, confirmations,"
      + " ratings, and next_action.",
    parameters: Type.Object({
      transaction_id: Uuid,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.transactions.status",
        { transaction_id: params["transaction_id"] },
      );
    },
  });
}
