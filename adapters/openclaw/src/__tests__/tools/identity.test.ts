/**
 * Tests for adapters/openclaw/src/tools/identity.ts
 *
 * Covers the synchronous tool registrations:
 *   - klodi_register (HTTP-only entry, returns auth_url; not the polling)
 *   - klodi_register_poll (manual fallback claim)
 *   - klodi_whoami
 *   - klodi_health (preflight + lazy connect + whoami probe + notif loop check)
 *   - klodi_ratings
 *
 * Background register polling lives in register-poller.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerIdentityTools } from "../../tools/identity.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { writeFileSync, chmodSync } from "node:fs";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  setNotificationsLastEventAt,
  setNotificationsInactiveThresholdMs,
  setConnected,
  KlodiRequestError,
} from "../helpers/mock-nats.js";
import { stopRegisterPoll } from "../../tools/register-poller.js";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

function withCreds(): void {
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester", user_id: "uid-1",
    nkey_public: "NKEY", nats_url: "wss://example.test:4443",
  });
}

beforeEach(() => {
  temp = createTempHome();
  api = createMockPluginApi();
  registerIdentityTools(api);
  clearNatsResponses();
});

afterEach(() => {
  stopRegisterPoll("test-cleanup");
  temp.cleanup();
});

describe("klodi_register", () => {
  it("returns already_registered when both creds + config exist", async () => {
    withCreds();
    const tool = getTool(api, "klodi_register");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("already_registered");
    expect(data.handle).toBe("tester");
  });

  it("returns auth_url + session_id and starts background poll when uncredentialed", async () => {
    const tool = getTool(api, "klodi_register");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("awaiting_browser");
    expect(typeof data.session_id).toBe("string");
    expect(data.auth_url).toContain(`session=${data.session_id}`);
    expect(data.poll_url).toContain(data.session_id);
    // Cleanup the timer so afterEach is sufficient.
    stopRegisterPoll("test-end");
  });
});

describe("klodi_register_poll", () => {
  it("rejects a non-UUID session_id with the invalid_request envelope", async () => {
    const tool = getTool(api, "klodi_register_poll");
    const result = await tool.execute("call-1", { session_id: "not-a-uuid" });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("invalid_request");
    expect(env.details.field).toBe("session_id");
    expect(env.message).toContain("UUID");
  });
});

describe("klodi_whoami", () => {
  it("forwards an empty payload to p2p.v1.users.whoami", async () => {
    withCreds();
    mockNatsResponse("p2p.v1.users.whoami", { handle: "tester" });
    const tool = getTool(api, "klodi_whoami");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text!)).toEqual({ handle: "tester" });
  });

  it("returns the not_registered envelope when credentials are missing", async () => {
    const tool = getTool(api, "klodi_whoami");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("not_registered");
    expect(env.recovery_hint.kind).toBe("cli");
  });
});

describe("klodi_health", () => {
  it("reports unhealthy with creds_missing when nats.creds is absent", async () => {
    const tool = getTool(api, "klodi_health");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("unhealthy");
    expect(
      data.issues.some((i: { code: string }) => i.code === "creds_missing"),
    ).toBe(true);
  });

  it("reports healthy when files exist, NATS is connected, and whoami succeeds", async () => {
    withCreds();
    mockNatsResponse("p2p.v1.users.whoami", { handle: "tester" });
    setConnected(true);
    const tool = getTool(api, "klodi_health");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("healthy");
    expect(data.handle).toBe("tester");
    expect(data.nats_connected).toBe(true);
    expect(data.whoami_ok).toBe(true);
    expect(data.issues).toEqual([]);
  });

  it("returns whoami_failed when the round-trip errors", async () => {
    withCreds();
    mockNatsError(
      "p2p.v1.users.whoami",
      new KlodiRequestError({ error: "INTERNAL", message: "server down" }),
    );
    setConnected(true);
    const tool = getTool(api, "klodi_health");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("unhealthy");
    expect(data.whoami_ok).toBe(false);
    expect(
      data.issues.some((i: { code: string }) => i.code === "whoami_failed"),
    ).toBe(true);
  });

  it("flags notifications_loop_suspect when consumer is silent past threshold", async () => {
    withCreds();
    mockNatsResponse("p2p.v1.users.whoami", { handle: "tester" });
    setConnected(true);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    setNotificationsLastEventAt(twoDaysAgo);
    setNotificationsInactiveThresholdMs(7 * 24 * 60 * 60 * 1_000);
    const tool = getTool(api, "klodi_health");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.status).toBe("degraded");
    expect(
      data.issues.some(
        (i: { code: string }) => i.code === "notifications_loop_suspect",
      ),
    ).toBe(true);
  });
});

describe("klodi_ratings", () => {
  it("forwards handle to p2p.v1.ratings.query", async () => {
    withCreds();
    mockNatsResponse("p2p.v1.ratings.query", {
      handle: "alice",
      seller: { avg: 4.8, count: 10 },
      buyer: { avg: 4.5, count: 7 },
    });
    const tool = getTool(api, "klodi_ratings");
    const result = await tool.execute("call-1", { handle: "alice" });
    const data = JSON.parse(result.content[0].text!);
    expect(data.handle).toBe("alice");
  });

  it("returns the not_registered envelope without creds", async () => {
    const tool = getTool(api, "klodi_ratings");
    const result = await tool.execute("call-1", { handle: "alice" });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("not_registered");
  });

  it("surfaces NATS errors as envelope tool-results", async () => {
    withCreds();
    mockNatsError(
      "p2p.v1.ratings.query",
      new KlodiRequestError({ error: "NOT_FOUND", message: "not found" }),
    );
    const tool = getTool(api, "klodi_ratings");
    const result = await tool.execute("call-1", { handle: "missing" });
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text!);
    expect(env.error).toBe("NOT_FOUND");
  });
});
