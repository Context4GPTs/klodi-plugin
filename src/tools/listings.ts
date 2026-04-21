/**
 * Listing tools: create, get, mine, update, withdraw, relist.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  Uuid, Cents, Currency, Category,
  DeliveryMethod, Condition, ListingStatus,
} from "../lib/schemas.js";
import { request } from "../lib/nats-client.js";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
  handleResponse,
} from "../lib/tool-result.js";
import {
  onListingCreated,
  onListingUpdated,
  onListingWithdrawn,
  onListingRelisted,
} from "../service/state.js";
import { createSellTimer } from "../service/timers.js";
import { getSellFilePath } from "../lib/config.js";

const SELL_FILE_HINT =
  "Write private context (floor price, logistics,"
  + " private facts) into this file's body."
  + " Never create a separate per-listing file.";

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
  api.registerTool({
    name: "klodi_list_create",
    label: "Create Listing",
    description:
      "Create a new marketplace listing. Prices in integer cents (15000 = $150). " +
      "Condition required for pickup/ship, rejected for digital. " +
      "ships_to required for ship only (ISO 3166 codes).",
    parameters: Type.Object({
      title: Type.String({ description: "Item title (1-200 chars)" }),
      description: Type.String({ description: "Item description (1-2000 chars)" }),
      category: Category,
      asking_price: Cents,
      delivery_method: DeliveryMethod,
      condition: Type.Optional(Condition),
      location_area: Type.Optional(Type.String({ description: "Override pickup/ship location" })),
      ships_to: Type.Optional(Type.Array(
        Type.String(),
        { description: "ISO 3166 codes for ship" },
      )),
      photos: Type.Optional(Type.Array(
        Type.String(),
        { description: "Photo URLs" },
      )),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Search tags" })),
      currency: Type.Optional(Currency),
      expires_hours: Type.Optional(Type.Integer({
        description: "Hours until expiry (default 1440)",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        title: params["title"],
        description: params["description"],
        category: params["category"],
        asking_price: params["asking_price"],
        delivery_method: params["delivery_method"],
      };

      for (const f of [
        "condition", "location_area", "ships_to",
        "photos", "tags", "currency", "expires_hours",
      ] as const) {
        if (params[f] !== undefined) payload[f] = params[f];
      }

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.listings.create", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (!("error" in result) && result["listing_id"]) {
        try {
          const slug = onListingCreated(
            params["title"] as string,
            result["listing_id"] as string,
          );
          createSellTimer(slug);
          api.logger.info("sell_file_created", {
            slug,
            listing_id: result["listing_id"],
          });
          result["sell_file"] = {
            slug,
            path: getSellFilePath(slug),
            hint: SELL_FILE_HINT,
          };
        } catch (sideEffectErr) {
          api.logger.error("sell_file_create_failed", {
            listing_id: result["listing_id"],
            error: String(sideEffectErr),
            remediation: "Run klodi_list_mine to find"
              + " the listing, then klodi_list_withdraw"
              + " and klodi_list_relist to recreate"
              + " the sell file.",
          });
        }
      }

      return handleResponse(result);
    },
  });
}

function registerGet(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_get",
    label: "Get Listing",
    description:
      "Get full listing details including"
      + " seller profile and comments.",
    parameters: Type.Object({
      listing_id: Uuid,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle("p2p.v1.listings.get", {
        listing_id: params["listing_id"],
      });
    },
  });
}

function registerMine(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_mine",
    label: "My Listings",
    description:
      "Get your own listings. Filter by status.",
    parameters: Type.Object({
      status: Type.Optional(ListingStatus),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {};
      if (params["status"]) {
        payload["status"] = params["status"];
      }

      return requestAndHandle(
        "p2p.v1.listings.mine", payload,
      );
    },
  });
}

function registerUpdate(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_update",
    label: "Update Listing",
    description:
      "Update an existing listing."
      + " Cannot change delivery_method or category"
      + " (withdraw and relist instead)."
      + " Prices in integer cents.",
    parameters: Type.Object({
      listing_id: Uuid,
      title: Type.Optional(Type.String({
        description: "New title (1-200 chars)",
      })),
      description: Type.Optional(Type.String({
        description: "New description (1-2000 chars)",
      })),
      asking_price: Type.Optional(Cents),
      condition: Type.Optional(Condition),
      location_area: Type.Optional(Type.String()),
      ships_to: Type.Optional(Type.Array(Type.String())),
      photos: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      currency: Type.Optional(Currency),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        listing_id: params["listing_id"],
      };

      for (const field of [
        "title", "description", "asking_price",
        "condition", "location_area", "ships_to",
        "photos", "tags", "currency",
      ] as const) {
        if (params[field] !== undefined) {
          payload[field] = params[field];
        }
      }

      let result: Record<string, unknown>;
      try {
        result = await request(
          "p2p.v1.listings.update", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (!("error" in result)) {
        const askingPrice = params["asking_price"];
        if (typeof askingPrice === "number") {
          try {
            onListingUpdated(
              params["listing_id"] as string,
              { asking_price: askingPrice },
            );
            api.logger.info("sell_file_updated", {
              listing_id: params["listing_id"],
              asking_price: askingPrice,
            });
          } catch (sideEffectErr) {
            api.logger.error("sell_file_update_failed", {
              listing_id: params["listing_id"],
              error: String(sideEffectErr),
            });
          }
        }
      }

      return handleResponse(result);
    },
  });
}

function registerWithdraw(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_withdraw",
    label: "Withdraw Listing",
    description:
      "Withdraw a listing. Cancels active"
      + " transactions, rejects pending offers,"
      + " closes channels.",
    parameters: Type.Object({
      listing_id: Uuid,
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const listingId = params["listing_id"] as string;
      let result: Record<string, unknown>;
      try {
        result = await request(
          "p2p.v1.listings.update",
          { listing_id: listingId, status: "withdrawn" },
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (!("error" in result)) {
        onListingWithdrawn(listingId);
        api.logger.info("sell_file_deleted", {
          listing_id: listingId,
        });
      }

      return handleResponse(result);
    },
  });
}

function registerComments(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_comments",
    label: "List Listing Comments",
    description:
      "Fetch the comment history on a listing."
      + " Use before replying to a comment so you don't"
      + " answer a question that's already been answered."
      + " Chronological order.",
    parameters: Type.Object({
      listing_id: Uuid,
      limit: Type.Optional(Type.Integer({
        description: "Max comments (default 50, max 200)",
      })),
      before: Type.Optional(Type.String({
        description: "Cursor — comment_id, return older",
      })),
      after: Type.Optional(Type.String({
        description: "Cursor — comment_id, return newer",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload: Record<string, unknown> = {
        listing_id: params["listing_id"],
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

      return requestAndHandle(
        "p2p.v1.comments.list", payload,
      );
    },
  });
}

function registerRelist(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_list_relist",
    label: "Relist Listing",
    description:
      "Relist a withdrawn listing."
      + " Optionally set a new asking price"
      + " (integer cents).",
    parameters: Type.Object({
      listing_id: Uuid,
      asking_price: Type.Optional(Cents),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const listingId = params["listing_id"] as string;
      const payload: Record<string, unknown> = {
        listing_id: listingId,
        status: "active",
      };
      if (params["asking_price"] !== undefined) {
        payload["asking_price"] = params["asking_price"];
      }

      let result: Record<string, unknown>;
      try {
        result = await request<Record<string, unknown>>(
          "p2p.v1.listings.update", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (!("error" in result)) {
        const title =
          (result["title"] as string) ?? listingId;
        const slug = onListingRelisted(
          listingId, title,
        );
        createSellTimer(slug);
        api.logger.info("sell_file_ensured", {
          slug, listing_id: listingId,
        });
        result["sell_file"] = {
          slug,
          path: getSellFilePath(slug),
          hint: SELL_FILE_HINT,
        };
      }

      return handleResponse(result);
    },
  });
}
