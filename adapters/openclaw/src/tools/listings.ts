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
  errorResult,
  formatError,
  jsonResult,
  rawRequest,
  requireCreds,
} from "../lib/tool-result.js";
import {
  onListingCreated,
  onListingRelisted,
  onListingWithdrawn,
} from "../service/state.js";
import { getSellFilePath } from "../lib/paths.js";
import { PhotoResolutionError, resolvePhotos } from "./photos.js";

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
      const err = requireCreds();
      if (err) return errorResult(err);

      let resolvedPayload: Record<string, unknown>;
      try {
        resolvedPayload = await applyPhotos(params);
      } catch (e) {
        logPhotoFailure(api, "klodi_list_create", e);
        return errorResult(formatPhotoError(e));
      }

      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, resolvedPayload);
      } catch (e) {
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);
      try {
        const result = await rawRequest(tool.subject, params);
        return jsonResult(result);
      } catch (e) {
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);
      const payload: Record<string, unknown> = {};
      if (params["status"]) payload["status"] = params["status"];
      try {
        const result = await rawRequest(tool.subject, payload);
        return jsonResult(result);
      } catch (e) {
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);

      let resolvedPayload: Record<string, unknown>;
      try {
        resolvedPayload = await applyPhotos(params);
      } catch (e) {
        logPhotoFailure(api, "klodi_list_update", e);
        return errorResult(formatPhotoError(e));
      }

      let result: Record<string, unknown>;
      try {
        result = await rawRequest(tool.subject, resolvedPayload);
      } catch (e) {
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);
      const listingId = params["listing_id"] as string;
      try {
        const result = await rawRequest(tool.subject, {
          listing_id: listingId, status: "withdrawn",
        });
        onListingWithdrawn(listingId);
        api.logger.info("sell_file_deleted", { listing_id: listingId });
        return jsonResult(result);
      } catch (e) {
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);
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
        return errorResult(formatError(e));
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
      const err = requireCreds();
      if (err) return errorResult(err);
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
        return errorResult(formatError(e));
      }
    },
  });
}

/**
 * Resolve any local paths in `params.photos` to asset_urls and return
 * the substituted payload. A no-op when `photos` is absent (undefined).
 *
 * Non-array `photos` values (number, string, object) are rejected with
 * `PhotoResolutionError(..., "type")` so the contract matches the
 * Python and Rust helpers — every adapter raises rather than silently
 * passing a malformed payload through to the marketplace.
 *
 * Throws PhotoResolutionError on any validation / mint / PUT failure;
 * callers map that to errorResult via formatPhotoError().
 */
async function applyPhotos(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const photos = params["photos"];
  if (photos === undefined) return params;
  if (!Array.isArray(photos)) {
    throw new PhotoResolutionError(
      `photos must be an array, got ${typeof photos}.`,
      "type",
    );
  }
  const resolved = await resolvePhotos(photos);
  if (resolved === undefined) return params;
  return { ...params, photos: resolved };
}

/**
 * Format a PhotoResolutionError as a canonical JSON envelope:
 *   { "error": "<stage>", "message": "<human>", "path": "<path | null>" }
 *
 * Parity with hermes / nanobot (Python `json.dumps({...})`) and Rust
 * (`McpError::invalid_request(..., data: {error, message, path})`):
 * the agent sees the same structured shape regardless of which adapter
 * served the call. The `path` field is `null` for failures that aren't
 * bound to a specific input element (count cap, non-array photos).
 *
 * Non-PhotoResolutionError errors fall back to formatError() as a flat
 * string — those are unexpected and have no stage tag to surface.
 */
function formatPhotoError(err: unknown): string {
  if (err instanceof PhotoResolutionError) {
    return JSON.stringify({
      error: err.stage,
      message: err.message,
      path: err.path ?? null,
    });
  }
  return formatError(err);
}

/**
 * Emit a structured log line when photo resolution fails. Mint and PUT
 * failures are network-driven and matter to operators (R2 outage, NATS
 * timeout, credential rotation); validation failures (absolute_path,
 * missing, content_type, size) are agent-driven and noise at warn.
 *
 * The agent always sees the structured envelope in `errorResult`; the
 * operator gets visibility on the network-class stages here.
 */
function logPhotoFailure(api: PluginAPI, tool: string, err: unknown): void {
  if (!(err instanceof PhotoResolutionError)) return;
  if (err.stage !== "mint" && err.stage !== "put") return;
  api.logger.warn("klodi_photos_resolution_failed", {
    tool,
    stage: err.stage,
    path: err.path ?? null,
    error: err.message,
  });
}
