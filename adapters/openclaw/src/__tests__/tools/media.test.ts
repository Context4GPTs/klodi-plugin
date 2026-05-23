/**
 * Tests for adapters/openclaw/src/tools/media.ts (klodi_assets_upload_url).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerMediaTools } from "../../tools/media.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeFileSync, chmodSync } from "node:fs";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

beforeEach(() => {
  temp = createTempHome();
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester", user_id: "uid-1",
    nkey_public: "NKEY", nats_url: "wss://example.test:4443",
  });
  api = createMockPluginApi();
  registerMediaTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_assets_upload_url", () => {
  it("forwards files array to p2p.v1.assets.upload-url", async () => {
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [{
        upload_url: "https://upload",
        asset_url: "https://asset",
      }],
    });
    const tool = getTool(api, "klodi_assets_upload_url");
    const result = await tool.execute("call-1", {
      files: [{ filename: "a.jpg", content_type: "image/jpeg", size: 1234 }],
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.uploads[0].upload_url).toBe("https://upload");
  });

  it("surfaces KlodiRequestError as the canonical envelope", async () => {
    // Round 2 P2.1 — marketplace codes collapse to the R2 catch-all.
    mockNatsError(
      "p2p.v1.assets.upload-url",
      new KlodiRequestError({ error: "FILE_TOO_LARGE", message: "file too large" }),
    );
    const tool = getTool(api, "klodi_assets_upload_url");
    const result = await tool.execute("call-1", {
      files: [{ filename: "huge.jpg", content_type: "image/jpeg", size: 99 }],
    });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("marketplace_error");
    expect(env.details.marketplace_error_code).toBe("FILE_TOO_LARGE");
    expect(env.recovery_hint).toBeNull();
  });

  it("returns the not_registered envelope when credentials are missing", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerMediaTools(api);
    const tool = getTool(api, "klodi_assets_upload_url");
    const result = await tool.execute("call-1", { files: [] });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("not_registered");
  });
});
