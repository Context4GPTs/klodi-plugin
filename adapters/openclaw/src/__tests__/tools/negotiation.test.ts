/**
 * Tests for adapters/openclaw/src/tools/negotiation.ts
 *
 * Covers klodi_channel_create / _mine / _message / _history / _close.
 * klodi_channel_message uses publishChannelMessage on the client (direct
 * JetStream publish), not the request/reply path — the mock-nats helper
 * has a dedicated mock entry for that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerNegotiationTools } from "../../tools/negotiation.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeFileSync, chmodSync } from "node:fs";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  mockChannelPublishResponse,
  mockChannelPublishError,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";
const LISTING_ID = "550e8400-e29b-41d4-a716-446655440000";

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
  registerNegotiationTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_channel_create", () => {
  it("forwards listing_id to p2p.v1.channels.create", async () => {
    mockNatsResponse("p2p.v1.channels.create", {
      channel_id: CHANNEL_ID, listing_id: LISTING_ID,
    });
    const tool = getTool(api, "klodi_channel_create");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.channel_id).toBe(CHANNEL_ID);
  });

  it("returns 'Not registered' without creds", async () => {
    temp.cleanup();
    temp = createTempHome();
    api = createMockPluginApi();
    registerNegotiationTools(api);
    const tool = getTool(api, "klodi_channel_create");
    const result = await tool.execute("call-1", { listing_id: LISTING_ID });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_channel_mine", () => {
  it("forwards an empty payload when status is omitted", async () => {
    mockNatsResponse("p2p.v1.channels.mine", { channels: [] });
    const tool = getTool(api, "klodi_channel_mine");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
  });

  it("forwards status when provided", async () => {
    mockNatsResponse("p2p.v1.channels.mine", { channels: [] });
    const tool = getTool(api, "klodi_channel_mine");
    const result = await tool.execute("call-1", { status: "active" });
    expect(result.isError).toBeFalsy();
  });
});

describe("klodi_channel_message", () => {
  it("publishes via JetStream and returns the sequence as confirmation", async () => {
    mockChannelPublishResponse(CHANNEL_ID, { sequence: 42 });
    const tool = getTool(api, "klodi_channel_message");
    const result = await tool.execute("call-1", {
      channel_id: CHANNEL_ID, content: "Hi there",
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.sequence).toBe(42);
    expect(data.content).toBe("Hi there");
    expect(data.channel_id).toBe(CHANNEL_ID);
    expect(typeof data.sent_at).toBe("string");
  });

  it("formats publish errors as tool errors", async () => {
    mockChannelPublishError(
      CHANNEL_ID, new Error("stream closed"),
    );
    const tool = getTool(api, "klodi_channel_message");
    const result = await tool.execute("call-1", {
      channel_id: CHANNEL_ID, content: "hi",
    });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_channel_history", () => {
  it("reverses the server's desc-ordered messages so the agent reads chronologically", async () => {
    mockNatsResponse("p2p.v1.channels.history", {
      messages: [
        { message_id: "m3", content: "third" },
        { message_id: "m2", content: "second" },
        { message_id: "m1", content: "first" },
      ],
    });
    const tool = getTool(api, "klodi_channel_history");
    const result = await tool.execute("call-1", {
      channel_id: CHANNEL_ID, limit: 50,
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.messages.map((m: { message_id: string }) => m.message_id))
      .toEqual(["m1", "m2", "m3"]);
  });

  it("propagates NATS errors", async () => {
    mockNatsError(
      "p2p.v1.channels.history",
      new KlodiRequestError("not found", "NOT_FOUND"),
    );
    const tool = getTool(api, "klodi_channel_history");
    const result = await tool.execute("call-1", { channel_id: CHANNEL_ID });
    expect(result.isError).toBe(true);
  });
});

describe("klodi_channel_close", () => {
  it("forwards channel_id and reason to p2p.v1.channels.close", async () => {
    mockNatsResponse("p2p.v1.channels.close", {
      channel_id: CHANNEL_ID, status: "closed",
      closed_at: "2026-04-30T00:00:00Z",
    });
    const tool = getTool(api, "klodi_channel_close");
    const result = await tool.execute("call-1", {
      channel_id: CHANNEL_ID, reason: "buyer abandoned",
    });
    expect(result.isError).toBeFalsy();
  });
});
