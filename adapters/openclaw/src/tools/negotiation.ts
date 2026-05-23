/**
 * Negotiation tools — channel create, list, history, close, message.
 *
 * `klodi_channel_message` replaces the legacy `klodi_channel_send`:
 * the agent publishes directly to JetStream (`p2p.v1.channels.<id>.<uid>.msg`)
 * via the client's publishChannelMessage, returning the JetStream
 * sequence as durability confirmation. The marketplace observes only
 * via its moderation side-consumer — no synchronous handler in the
 * send path.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { Uuid, klodiTools } from "@klodi/tool-catalog";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
} from "../lib/tool-result.js";
import { runPreCallGuardsResult } from "../lib/guards.js";
import { getClient } from "../lib/client.js";

// Per-host register CLI surfaced in `not_registered` recovery hints (R8).
const OPENCLAW_REGISTER_CLI = "klodi-openclaw-register";

export function registerNegotiationTools(api: PluginAPI): void {
  registerChannelCreate(api);
  registerChannelMine(api);
  registerChannelMessage(api);
  registerChannelHistory(api);
  registerChannelClose(api);
}

function registerChannelCreate(api: PluginAPI): void {
  const tool = klodiTools.klodi_channel_create;
  api.registerTool({
    name: "klodi_channel_create",
    label: "Open Negotiation Channel",
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

function registerChannelMine(api: PluginAPI): void {
  const tool = klodiTools.klodi_channel_mine;
  api.registerTool({
    name: "klodi_channel_mine",
    label: "My Channels",
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

function registerChannelMessage(api: PluginAPI): void {
  // Local-only tool — no NATS subject. Direct JetStream publish via
  // client.publishChannelMessage. Returns the stream sequence as
  // durability confirmation.
  api.registerTool({
    name: "klodi_channel_message",
    label: "Send Channel Message",
    description:
      "Send a message in a negotiation channel. Max 2000 chars."
      + " Read your policies before sending — protect price floors."
      + " Publishes directly to JetStream; the recipient's wake fires"
      + " as soon as the stream stores the message.",
    parameters: Type.Object({
      channel_id: Uuid,
      content: Type.String({
        description: "Message text (1-2000 chars)",
        minLength: 1,
        maxLength: 2000,
      }),
    }),
    async execute(_id, params) {
      // Adapter-side schema check mirrors the Rust dispatcher's
      // `dispatch_channel_message` and the Python `handle_channel_message`
      // / `handle()` paths — every adapter rejects the same malformed
      // input with the same `invalid_request` envelope (R1 cross-adapter
      // parity). The wire-boundary check in `publishChannelMessage` is
      // a defence-in-depth backstop for non-adapter callers.
      const guard = runPreCallGuardsResult(
        params,
        [
          { field: "channel_id", kind: "uuid" },
          { field: "content", kind: "non_empty_string" },
        ],
        { registerCli: OPENCLAW_REGISTER_CLI },
      );
      if (guard) return guard;
      const channelId = params["channel_id"] as string;
      const content = params["content"] as string;
      try {
        const ack = await getClient().publishChannelMessage(channelId, {
          content,
        });
        api.logger.info("channel_message_published", {
          channel_id: channelId, sequence: ack.sequence,
        });
        return jsonResult({
          channel_id: channelId,
          content,
          sequence: ack.sequence,
          sent_at: new Date().toISOString(),
        });
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerChannelHistory(api: PluginAPI): void {
  const tool = klodiTools.klodi_channel_history;
  api.registerTool({
    name: "klodi_channel_history",
    label: "Channel Message History",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const payload: Record<string, unknown> = {
        channel_id: params["channel_id"],
      };
      if (params["limit"] !== undefined) payload["limit"] = params["limit"];
      if (params["before"]) payload["before"] = params["before"];
      if (params["after"]) payload["after"] = params["after"];
      try {
        const result = await rawRequest<Record<string, unknown>>(
          tool.subject, payload,
        );
        if (Array.isArray(result["messages"])) {
          // Server returns desc; reverse so the agent reads in chronological
          // order, matching how a human would read a transcript.
          result["messages"] = [...(result["messages"] as unknown[])].reverse();
        }
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerChannelClose(api: PluginAPI): void {
  const tool = klodiTools.klodi_channel_close;
  api.registerTool({
    name: "klodi_channel_close",
    label: "Close Channel",
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
