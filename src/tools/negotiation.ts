/**
 * Negotiation tools: channel create, mine, send, history.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { Uuid } from "../lib/schemas.js";
import { request } from "../lib/nats-client.js";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
  handleResponse,
} from "../lib/tool-result.js";

export function registerNegotiationTools(
  api: PluginAPI,
): void {
  registerChannelCreate(api);
  registerChannelMine(api);
  registerChannelSend(api);
  registerChannelHistory(api);
}

function registerChannelCreate(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_channel_create",
    label: "Open Negotiation Channel",
    description:
      "Open a private negotiation channel."
      + " Returns existing if one exists."
      + " Cannot open on your own listing.",
    parameters: Type.Object({
      listing_id: Uuid,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.channels.create",
        { listing_id: params["listing_id"] },
      );
    },
  });
}

function registerChannelMine(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_channel_mine",
    label: "My Channels",
    description:
      "Get your negotiation channels."
      + " Filter by status (open/closed).",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([
        Type.Literal("open"),
        Type.Literal("closed"),
      ], { description: "Channel status" })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {};
      if (params["status"]) {
        payload["status"] = params["status"];
      }

      return requestAndHandle(
        "p2p.v1.channels.mine", payload,
      );
    },
  });
}

function registerChannelSend(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_channel_send",
    label: "Send Channel Message",
    description:
      "Send a message in a negotiation channel."
      + " Max 2000 chars. Read your policies"
      + " before sending — protect price floors.",
    parameters: Type.Object({
      channel_id: Uuid,
      content: Type.String({
        description: "Message text (max 2000 chars)",
      }),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.channels.send",
        {
          channel_id: params["channel_id"],
          content: params["content"],
        },
      );
    },
  });
}

function registerChannelHistory(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_channel_history",
    label: "Channel Message History",
    description:
      "Get message history for a channel."
      + " Chronological order. Use before/after"
      + " cursors for pagination.",
    parameters: Type.Object({
      channel_id: Uuid,
      limit: Type.Optional(Type.Integer({
        description: "Max messages (default 50)",
      })),
      before: Type.Optional(Type.String({
        description: "Cursor — messages before this",
      })),
      after: Type.Optional(Type.String({
        description: "Cursor — messages after this",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        channel_id: params["channel_id"],
      };
      if (params["limit"] !== undefined) {
        payload["limit"] = params["limit"];
      }
      if (params["before"]) {
        payload["before"] = params["before"];
      }
      if (params["after"]) {
        payload["after"] = params["after"];
      }

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.channels.history", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (!("error" in result) && Array.isArray(result["messages"])) {
        result["messages"] = [...(result["messages"] as unknown[])].reverse();
      }

      return handleResponse(result);
    },
  });
}
