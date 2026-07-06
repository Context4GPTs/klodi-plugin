/**
 * Tests for adapters/openclaw/src/tools/register-poller.ts — the PLUGIN
 * runtime that survives the register-core extraction.
 *
 * The claim + persist mapping (every branch of `claimRegisterSession`, the
 * tls:// fail-fast guard, the optional-`nats_ca` contract) now lives in the
 * PluginAPI-free core and is covered by `../lib/register-core.test.ts`. The
 * plugin wrapper `claimAndBringUp` (persist + wake-pump refresh, AC4) is
 * covered by `./register-poller-bringup.test.ts`.
 *
 * This file keeps ONLY what stays owned by register-poller.ts: the
 * setInterval-driven `startRegisterPoll` / `stopRegisterPoll` lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () => import("../helpers/mock-nats.js"));

import {
  startRegisterPoll,
  stopRegisterPoll,
} from "../../tools/register-poller.js";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { __resetWakePumpRegistryForTests } from "@klodi/nats-client";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

beforeEach(() => {
  temp = createTempHome();
  api = createMockPluginApi();
  __resetWakePumpRegistryForTests();
});

afterEach(() => {
  stopRegisterPoll("test-cleanup");
  __resetWakePumpRegistryForTests();
  temp.cleanup();
  vi.restoreAllMocks();
});

describe("startRegisterPoll lifecycle", () => {
  it("starts and stops cleanly", () => {
    startRegisterPoll(api, SESSION_ID);
    // No throw on the second start (replaces the active session).
    startRegisterPoll(api, "22222222-3333-4444-8555-666666666666");
    stopRegisterPoll("test-end");
  });

  it("stopRegisterPoll is idempotent when no poll is active", () => {
    stopRegisterPoll("noop-1");
    stopRegisterPoll("noop-2");
  });
});
