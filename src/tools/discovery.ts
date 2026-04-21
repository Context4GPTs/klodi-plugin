/**
 * Discovery tools: search, watch, comment.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { Uuid, Cents, DeliveryMethod } from "../lib/schemas.js";
import { request } from "../lib/nats-client.js";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
  handleResponse,
  jsonResult,
} from "../lib/tool-result.js";
import {
  slugify, getBuyFilePath, type ActionOnMatch,
} from "../lib/config.js";
import {
  onBuySearchCreated,
  onBuySearchRemoved,
} from "../service/state.js";
import { createBuyTimer } from "../service/timers.js";

const BUY_FILE_HINT =
  "Write evaluation criteria and logistics"
  + " constraints into this file's body."
  + " Never create a separate per-search file.";

export function registerDiscoveryTools(
  api: PluginAPI,
): void {
  registerSearch(api);
  registerWatch(api);
  registerUnwatch(api);
  registerComment(api);
}

function buildSearchPayload(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (params["query"]) {
    payload["query"] = params["query"];
  }
  if (params["delivery_method"]) {
    payload["delivery_method"] = params["delivery_method"];
  }
  if (params["min_price"] !== undefined) {
    payload["min_price"] = params["min_price"];
  }
  if (params["max_price"] !== undefined) {
    payload["max_price"] = params["max_price"];
  }
  if (params["pickup_radius"] !== undefined) {
    payload["pickup_radius_km"] = params["pickup_radius"];
  }
  if (params["ships_to"]) {
    payload["ships_to"] = params["ships_to"];
  }
  if (params["limit"] !== undefined) {
    payload["limit"] = params["limit"];
  }
  return payload;
}

function registerSearch(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_search",
    label: "Search Marketplace",
    description:
      "Search active listings. At least one"
      + " filter required. Prices in integer"
      + " cents. Sorted by asking_price asc.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Text search",
      })),
      delivery_method: Type.Optional(DeliveryMethod),
      min_price: Type.Optional(Cents),
      max_price: Type.Optional(Cents),
      pickup_radius: Type.Optional(Type.Number({
        description: "Km radius from profile location",
      })),
      ships_to: Type.Optional(Type.String({
        description: "ISO 3166 code (e.g. US, US-NY)",
      })),
      limit: Type.Optional(Type.Integer({
        description: "Result cap (default 20)",
        default: 20,
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.listings.search",
        buildSearchPayload(params),
      );
    },
  });
}

function registerWatch(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_watch",
    label: "Watch for New Listings",
    description:
      "Persistent search — returns listings"
      + " created since the given timestamp."
      + " Set persist=true to save as standing"
      + " search with periodic checks.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Text search",
      })),
      delivery_method: Type.Optional(DeliveryMethod),
      min_price: Type.Optional(Cents),
      max_price: Type.Optional(Cents),
      pickup_radius: Type.Optional(Type.Number({
        description: "Km radius from profile location",
      })),
      ships_to: Type.Optional(Type.String({
        description: "ISO 3166 code",
      })),
      since: Type.Optional(Type.String({
        description: "ISO timestamp — only after this",
      })),
      limit: Type.Optional(Type.Integer({
        description: "Result cap (default 20)",
        default: 20,
      })),
      persist: Type.Optional(Type.Boolean({
        description: "Save as standing search",
      })),
      target_price: Type.Optional(Cents),
      action_on_match: Type.Optional(Type.Union([
        Type.Literal("notify"),
        Type.Literal("negotiate"),
      ], {
        description: "What to do on match (default notify)",
      })),
      check_every: Type.Optional(Type.String({
        description: "Check interval e.g. 4h (default 4h)",
      })),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const payload = buildSearchPayload(params);
      if (params["since"]) {
        payload["since"] = params["since"];
      }

      let result: Record<string, unknown>;
      try {
        result = await request(
          "p2p.v1.listings.watch", payload,
        );
      } catch (err) {
        return errorResult(
          `Request failed: ${String(err)}`,
        );
      }

      if (params["persist"] && !("error" in result)) {
        const query = (params["query"] as string) ?? "";
        const buySlug = slugify(
          query || "watch",
          crypto.randomUUID(),
        );
        const checkEvery =
          (params["check_every"] as string) ?? "4h";

        onBuySearchCreated(buySlug, {
          query,
          max_price:
            (params["max_price"] as number) ?? null,
          target_price:
            (params["target_price"] as number) ?? null,
          delivery_method:
            (params["delivery_method"] as string)
            ?? "any",
          pickup_radius:
            (params["pickup_radius"] as number) ?? null,
          ships_to:
            (params["ships_to"] as string) ?? null,
          action_on_match:
            (params["action_on_match"] as ActionOnMatch)
            ?? "notify",
          check_every: checkEvery,
          last_checked: new Date().toISOString(),
          body: "",
        });
        createBuyTimer(buySlug, checkEvery);
        api.logger.info("buy_file_created", {
          slug: buySlug,
        });
        result["buy_file"] = {
          slug: buySlug,
          path: getBuyFilePath(buySlug),
          hint: BUY_FILE_HINT,
        };
      }

      return handleResponse(result);
    },
  });
}

function registerUnwatch(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_unwatch",
    label: "Stop Standing Search",
    description:
      "Close out a standing search: deletes the"
      + " buy/<slug>.md file and stops its periodic"
      + " check timer. Call after the search's goal"
      + " is met (e.g. transaction completed) or"
      + " the search is abandoned. Irreversible —"
      + " use klodi_watch persist=true to recreate.",
    parameters: Type.Object({
      buy_slug: Type.String({
        description:
          "Slug of the buy file to remove"
          + " (e.g. gaming-laptop-abc123).",
      }),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      const slug = params["buy_slug"] as string;
      onBuySearchRemoved(slug);
      api.logger.info("buy_file_removed", { slug });
      return jsonResult({ removed: true, slug });
    },
  });
}

function registerComment(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_comment",
    label: "Comment on Listing",
    description:
      "Post a public comment on an active listing."
      + " Use @handle to mention. Max 1000 chars.",
    parameters: Type.Object({
      listing_id: Uuid,
      body: Type.String({
        description: "Comment text (max 1000 chars)",
      }),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.comments.create",
        {
          listing_id: params["listing_id"],
          body: params["body"],
        },
      );
    },
  });
}
