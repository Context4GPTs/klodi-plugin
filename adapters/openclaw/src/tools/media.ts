/**
 * Media tools: photo upload (presigned URL).
 *
 * See ADR-0006 — binary never transits klodi-operated compute. The
 * marketplace mints upload + asset URL pairs, the client PUTs to R2
 * directly, and the asset URLs are attached to a listing via
 * klodi_list_create / klodi_list_update.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { klodiTools } from "@klodi/tool-catalog";
import {
  envelopeToolResult,
  jsonResult,
  rawRequest,
  requireCredsEnvelope,
} from "../lib/tool-result.js";

const UPLOAD_URL_TIMEOUT_MS = 30_000;

export function registerMediaTools(api: PluginAPI): void {
  const tool = klodiTools.klodi_assets_upload_url;
  api.registerTool({
    name: "klodi_assets_upload_url",
    label: "Mint Asset Upload URLs",
    description: tool.description,
    parameters: tool.params,
    async execute(_id, params) {
      const guard = requireCredsEnvelope();
      if (guard) return guard;
      try {
        const result = await rawRequest(
          tool.subject,
          { files: params["files"] },
          { timeout: UPLOAD_URL_TIMEOUT_MS },
        );
        return jsonResult(result);
      } catch (e) {
        return envelopeToolResult(e);
      }
    },
  });
}
