/**
 * Offer tools: create, respond, mine.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  Uuid, Cents, Currency, OfferAction,
} from "../lib/schemas.js";
import { request } from "../lib/nats-client.js";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
  handleResponse,
} from "../lib/tool-result.js";
import { onOfferAccepted } from "../service/state.js";

export function registerOfferTools(
  api: PluginAPI,
): void {
  registerOfferCreate(api);
  registerOfferRespond(api);
  registerOfferMine(api);
}

function registerOfferCreate(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_offer_create",
    label: "Make Offer",
    description:
      "Submit a formal offer on a listing."
      + " Amount in integer cents."
      + " Requires a channel_id."
      + " One pending offer per listing."
      + " Optional `terms` captures the structured"
      + " deal contract (fulfillment, payment,"
      + " inclusions/exclusions, inspection)."
      + " See SKILL.md Section 9 for shape. Max 4KB.",
    parameters: Type.Object({
      listing_id: Uuid,
      channel_id: Uuid,
      amount: Cents,
      currency: Currency,
      message: Type.Optional(Type.String({
        description: "Optional message (max 500 chars)",
      })),
      terms: Type.Optional(Type.Object({}, {
        additionalProperties: true,
        description:
          "Structured deal terms. Opaque to server, max 4KB."
          + " Keys conventional to plugin (condition_confirmed,"
          + " fulfillment, payment, inclusions, exclusions,"
          + " inspection, notes).",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        listing_id: params["listing_id"],
        channel_id: params["channel_id"],
        amount: params["amount"],
        currency: params["currency"],
      };
      if (params["message"]) {
        payload["message"] = params["message"];
      }
      if (params["terms"]) {
        payload["terms"] = params["terms"];
      }

      return requestAndHandle(
        "p2p.v1.offers.create", payload,
      );
    },
  });
}

function registerOfferRespond(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_offer_respond",
    label: "Respond to Offer",
    description:
      "Accept or reject an offer."
      + " Only the seller can respond."
      + " Accepting creates a transaction.",
    parameters: Type.Object({
      offer_id: Uuid,
      action: OfferAction,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.offers.respond",
          {
            offer_id: params["offer_id"],
            action: params["action"],
          },
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (
        !("error" in result)
        && params["action"] === "accept"
        && result["listing_id"]
        && result["transaction_id"]
      ) {
        onOfferAccepted(
          result["listing_id"] as string,
          result["transaction_id"] as string,
        );
      }

      return handleResponse(result);
    },
  });
}

function registerOfferMine(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_offer_mine",
    label: "My Offers",
    description:
      "Get your offers. Filter by status and role.",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([
        Type.Literal("proposed"),
        Type.Literal("accepted"),
        Type.Literal("rejected"),
      ], { description: "Offer status" })),
      role: Type.Optional(Type.Union([
        Type.Literal("buyer"),
        Type.Literal("seller"),
      ], { description: "Your role" })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {};
      if (params["status"]) {
        payload["status"] = params["status"];
      }
      if (params["role"]) {
        payload["role"] = params["role"];
      }

      return requestAndHandle(
        "p2p.v1.offers.mine", payload,
      );
    },
  });
}
