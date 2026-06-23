/**
 * Discovery tools: search, watch (one-shot or persistent), unwatch,
 * standing-search list, comment.
 *
 * `klodi_watch(persist=true)` registers a server-side standing search
 * (`p2p.v1.searches.create`) AND writes a `buy/<slug>.md` policy file.
 * `klodi_watch(persist=false)` is a one-shot search via `klodi_search`.
 * `klodi_unwatch` deletes both. No cron, no client-side dedup —
 * matches arrive as `search.match` notifications with full payloads.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  Cents,
  Category,
  DeliveryFilter,
  LOCAL_TOOLS,
  Uuid,
  klodiTools,
  type DeliveryFilter as DeliveryFilterShape,
} from "@klodi/tool-catalog";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
} from "../lib/tool-result.js";
import { getClient } from "../lib/client.js";
import { runPreCallGuardsResult } from "../lib/guards.js";
import { getBuyFilePath } from "../lib/paths.js";
import { slugify, type ActionOnMatch } from "../lib/sell-buy-files.js";
import {
  onBuySearchCreated,
  onBuySearchRemoved,
} from "../service/state.js";

// Per-host register CLI surfaced in `not_registered` recovery hints (R8).
const OPENCLAW_REGISTER_CLI = "klodi-openclaw-register";

const BUY_FILE_HINT =
  "Write evaluation criteria and logistics constraints into this"
  + " file's body. Never create a separate per-search file.";

export function registerDiscoveryTools(api: PluginAPI): void {
  registerSearch(api);
  registerSearchesCreate(api);
  registerWatch(api);
  registerUnwatch(api);
  registerSearchesList(api);
  registerComment(api);
  registerMatchFeedback(api);
}

function registerSearch(api: PluginAPI): void {
  const tool = klodiTools.klodi_search;
  api.registerTool({
    name: "klodi_search",
    label: "Search Marketplace",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      // See ADR-0012 SC-parity.1 — the catalog defines the wire shape;
      // openclaw forwards catalog-shaped params raw. The previous
      // `compactPayload(params)` step dropped `null` / `""` / `undefined`
      // and stripped adapter-internal flags, which silently diverged from
      // every other stack (hermes, nanobot, klodi-rust-host) and from
      // the marketplace's matcher contract (empty-string ≠ omitted).
      // `compactPayload` lives on inside `runOneShotSearch` (the
      // `klodi_watch` composite) where the strip-fields `persist` /
      // `action_on_match` / `target_price` ARE legitimately adapter-
      // internal — those are composite params, not catalog params.
      try {
        const result = await rawRequest(tool.subject, params);
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerSearchesCreate(api: PluginAPI): void {
  // See ADR-0012 SC-parity.2 — `klodi_searches_create` is a canonical
  // catalog tool; agents must be able to register a standing search
  // directly (with their own slug) without going through the
  // `klodi_watch` composite. hermes / nanobot / klodi-rust-host all
  // expose it via their catalog passthrough; openclaw was the outlier.
  // Pure pass-through (mirrors `registerSearchesList`) — the marketplace
  // handler is the contract, the tool layer forwards unchanged.
  const tool = klodiTools.klodi_searches_create;
  api.registerTool({
    name: "klodi_searches_create",
    label: "Register Standing Search",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(
        params,
        [{ field: "slug", kind: "non_empty_string" }],
        { registerCli: OPENCLAW_REGISTER_CLI },
      );
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

function registerWatch(api: PluginAPI): void {
  // Composite tool — local-only param shape, dispatches to either
  // `searches.create` (persist) or `listings.search` (one-shot).
  api.registerTool({
    name: "klodi_watch",
    label: "Standing Search",
    description:
      "Create a standing (persistent) search OR a one-shot search."
      + " persist=true registers the search server-side; matches arrive"
      + " as `search.match` notification wakes carrying the listing"
      + " summary. persist=false is a one-shot equivalent of klodi_search."
      + " `delivery` is a discriminated union — pickup, ship, digital, or"
      + " any (default).",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Text search" })),
      category: Type.Optional(Category),
      max_price: Type.Optional(Cents),
      delivery: Type.Optional(DeliveryFilter),
      limit: Type.Optional(Type.Integer({
        description: "Result cap for one-shot mode (default 20)",
      })),
      persist: Type.Optional(Type.Boolean({
        description: "true = register server-side; false = one-shot",
      })),
      target_price: Type.Optional(Cents),
      action_on_match: Type.Optional(Type.Union(
        [Type.Literal("notify"), Type.Literal("negotiate")],
        { description: "What to do on match (default notify)" },
      )),
    }),
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      const persist = params["persist"] === true;
      return persist
        ? createPersistentSearch(api, params)
        : runOneShotSearch(params);
    },
  });
}

async function runOneShotSearch(
  params: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof jsonResult>>> {
  const tool = klodiTools.klodi_search;
  try {
    const result = await rawRequest(tool.subject, compactPayload(params));
    return jsonResult(result);
  } catch (e) {
    return envelopeToolResult(e);
  }
}

async function createPersistentSearch(
  api: PluginAPI,
  params: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof jsonResult>>> {
  const tool = klodiTools.klodi_searches_create;
  const queryRaw = (params["query"] as string | undefined) ?? "";
  const slug = slugify(queryRaw || "watch", crypto.randomUUID());
  const delivery = (params["delivery"] as DeliveryFilterShape | undefined)
    ?? { method: "any" };
  const payload: Record<string, unknown> = { slug, delivery };
  if (queryRaw) payload["query"] = queryRaw;
  if (params["category"]) payload["category"] = params["category"];
  if (params["max_price"] !== undefined) {
    payload["max_price"] = params["max_price"];
  }

  let result: Record<string, unknown>;
  try {
    result = await rawRequest(tool.subject, payload);
  } catch (e) {
    return envelopeToolResult(e);
  }

  onBuySearchCreated(slug, {
    query: queryRaw,
    max_price: (params["max_price"] as number) ?? null,
    target_price: (params["target_price"] as number) ?? null,
    delivery,
    action_on_match:
      (params["action_on_match"] as ActionOnMatch | undefined) ?? "notify",
    body: "",
  });
  api.logger.info("buy_file_created", { slug });
  return jsonResult({
    ...result,
    buy_file: { slug, path: getBuyFilePath(slug), hint: BUY_FILE_HINT },
  });
}

function registerUnwatch(api: PluginAPI): void {
  // Bare subject literal — the standalone server-delete catalog tool was
  // dropped (it was a ghost: declared but never registered under that name on
  // the gateway). The delete capability stays live here under the
  // `klodi_unwatch` composite. See ADR-0014 (catalog ↔ registered-by-name axis).
  const deleteSubject = "p2p.v1.searches.delete";
  api.registerTool({
    name: "klodi_unwatch",
    label: "Stop Standing Search",
    description:
      "Close out a standing search: deletes the server-side"
      + " registration AND the buy/<slug>.md file. Irreversible —"
      + " call klodi_watch persist=true to recreate.",
    parameters: Type.Object({
      buy_slug: Type.String({
        description:
          "Slug of the buy file to remove (e.g. gaming-laptop-abc123).",
      }),
    }),
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(
        params,
        [{ field: "buy_slug", kind: "non_empty_string" }],
        { registerCli: OPENCLAW_REGISTER_CLI },
      );
      if (guard) return guard;
      const slug = params["buy_slug"] as string;
      try {
        await rawRequest(deleteSubject, { slug });
      } catch (e) {
        return envelopeToolResult(e);
      }
      onBuySearchRemoved(slug);
      api.logger.info("buy_file_removed", { slug });
      return jsonResult({ removed: true, slug });
    },
  });
}

function registerSearchesList(api: PluginAPI): void {
  const tool = klodiTools.klodi_searches_list;
  api.registerTool({
    name: "klodi_searches_list",
    label: "List Standing Searches",
    description: tool.description,
    parameters: tool.params,
    async execute() {
      const guard = runPreCallGuardsResult({}, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      try {
        const result = await rawRequest(tool.subject, {});
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerComment(api: PluginAPI): void {
  const tool = klodiTools.klodi_comment;
  api.registerTool({
    name: "klodi_comment",
    label: "Comment on Listing",
    description: tool.description,
    parameters: Type.Object({
      listing_id: Uuid,
      body: Type.String({
        description: "Comment text (max 1000 chars)",
        minLength: 1,
        maxLength: 1000,
      }),
    }),
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(params, [], { registerCli: OPENCLAW_REGISTER_CLI });
      if (guard) return guard;
      try {
        const result = await rawRequest(tool.subject, {
          listing_id: params["listing_id"],
          body: params["body"],
        });
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function registerMatchFeedback(api: PluginAPI): void {
  // Local publish tool (SC8 flywheel emit) — no NATS request/reply. Reports
  // the agent's pursue/dismiss verdict on a standing-search match via
  // getClient().publishMatchFeedback. The catalog entry is the single source
  // of the param schema. NOTE: listing_id / search_slug are guarded as
  // non_empty_string, NOT uuid — they ride in the body, not a subject path,
  // and the marketplace accepts a non-UUID listing id (the deliberate
  // divergence from klodi_channel_message). See the catalog entry.
  const tool = LOCAL_TOOLS.klodi_match_feedback;
  api.registerTool({
    name: "klodi_match_feedback",
    label: "Report Match Verdict",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = runPreCallGuardsResult(
        params,
        [
          { field: "search_slug", kind: "non_empty_string" },
          { field: "listing_id", kind: "non_empty_string" },
          { field: "outcome", kind: "non_empty_string" },
        ],
        { registerCli: OPENCLAW_REGISTER_CLI },
      );
      if (guard) return guard;
      const searchSlug = params["search_slug"] as string;
      const listingId = params["listing_id"] as string;
      const outcome = params["outcome"] as "pursued" | "dismissed";
      const actionOnMatch = params["action_on_match"] as string | undefined;
      try {
        const ack = await getClient().publishMatchFeedback({
          searchSlug,
          listingId,
          outcome,
          actionOnMatch,
        });
        api.logger.info("match_feedback_published", {
          search_slug: searchSlug,
          listing_id: listingId,
          outcome,
          event_id: ack.event_id,
          sequence: ack.sequence,
        });
        return jsonResult({
          search_slug: searchSlug,
          listing_id: listingId,
          outcome,
          event_id: ack.event_id,
          sequence: ack.sequence,
        });
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}

function compactPayload(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  // Drop adapter-internal flags before sending to the marketplace.
  delete out["persist"];
  delete out["action_on_match"];
  delete out["target_price"];
  return out;
}
