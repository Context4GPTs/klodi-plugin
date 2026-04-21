/**
 * Media tools: photo upload.
 */

import type { PluginAPI } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  requireCreds,
  requestAndHandle,
  errorResult,
} from "../lib/tool-result.js";

export function registerMediaTools(
  api: PluginAPI,
): void {
  registerPhotoUpload(api);
}

function registerPhotoUpload(api: PluginAPI): void {
  api.registerTool({
    name: "klodi_photo_upload",
    label: "Get Photo Upload URLs",
    description:
      "Get presigned upload URLs for listing"
      + " photos. Returns upload_url and asset_url."
      + " Max 10, jpeg/png/webp, max 10MB each.",
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          filename: Type.String({
            description: "Photo filename",
          }),
          content_type: Type.String({
            description: "MIME type: image/jpeg,"
              + " image/png, or image/webp",
          }),
          size: Type.Integer({
            description: "File size in bytes",
          }),
        }),
        { description: "Photos to upload (max 10)" },
      ),
    }),
    async execute(_id, params) {
      const err = requireCreds();
      if (err) return errorResult(err);

      return requestAndHandle(
        "p2p.v1.assets.upload-url",
        { files: params["files"] },
        { timeout: 30_000 },
      );
    },
  });
}
