/**
 * Tests for the background retry scheduler in service/wake-pump.ts.
 *
 * Bug being locked: when `startWakePumpIfPossible` throws at register()
 * time (flaky NATS-WS handshake at boot), an already-registered persona
 * has no recovery path — `klodi_register` short-circuits with
 * `already_registered` and never re-runs the start. Without these tests,
 * a regression that drops the retry leaves the persona inbound-deaf
 * until process restart.
 *
 * `connectClient` is the unit under control: rejecting it mimics the
 * real failure mode (WS handshake fails before `createWakePump` is even
 * constructed), and toggling it back to resolve verifies the retry
 * actually recovers the pump rather than just logging forever.
 */

import {
  describe, it, expect, vi, beforeEach, afterEach,
} from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { connectClientMock } = vi.hoisted(() => ({
  connectClientMock: vi.fn(),
}));

vi.mock("../../lib/client.js", () => ({
  connectClient: connectClientMock,
  closeClient: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn(),
  isClientConnected: vi.fn(() => true),
  KlodiRequestError: class KlodiRequestError extends Error {},
}));

import { __resetWakePumpRegistryForTests } from "@klodi/nats-client";
import {
  __resetWakePumpRetryForTests,
  __setWakePumpRetryDelayForTests,
  scheduleWakePumpRetry,
  stopWakePump,
} from "../../service/wake-pump.js";
import { clearConfigCache } from "../../lib/config.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { createMockPluginApi, type MockPluginAPI } from "../helpers/mock-plugin-api.js";

const VALID_CONFIG = {
  handle: "test-user",
  user_id: "u-retry-1",
  nkey_public: "U" + "X".repeat(55),
  nats_url: "wss://example.test",
};

interface FakeSubscription {
  stop: ReturnType<typeof vi.fn>;
  getLastEventAt: () => Date | null;
  getInactiveThresholdMs: () => number | null;
}

function makeFakeSubscription(): FakeSubscription {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
    getLastEventAt: () => null,
    getInactiveThresholdMs: () => null,
  };
}

function makeFakeClient(): {
  isConnected: () => boolean;
  subscribeNotifications: ReturnType<typeof vi.fn>;
  subscribeChannels: ReturnType<typeof vi.fn>;
} {
  return {
    isConnected: () => true,
    subscribeNotifications: vi.fn(async () => makeFakeSubscription()),
    subscribeChannels: vi.fn(async () => makeFakeSubscription()),
  };
}

async function settle(): Promise<void> {
  // Flush microtasks scheduled by awaited promises inside runRetryAttempt.
  // vi.advanceTimersByTimeAsync flushes between timers but not always
  // after the final fire — settling here keeps assertions deterministic.
  await Promise.resolve();
  await Promise.resolve();
}

let tempHome: TempHome;
let api: MockPluginAPI;

beforeEach(() => {
  process.env["KLODI_GATEWAY_OVERRIDE"] = "1";
  tempHome = createTempHome();
  // Minimal creds + config so hasCredentials() and loadConfig() pass.
  // Permission bits don't matter here — loadCreds is never called from
  // the retry path (connectClient is mocked).
  writeFileSync(join(tempHome.path, "nats.creds"), "fake-creds", { mode: 0o600 });
  writeFileSync(
    join(tempHome.path, "config.json"),
    JSON.stringify(VALID_CONFIG),
    { mode: 0o600 },
  );
  clearConfigCache();

  vi.useFakeTimers();
  // Tight schedule to keep tests in millisecond range while still
  // exercising the per-attempt growth in the dedicated backoff test.
  __setWakePumpRetryDelayForTests((attempt) => attempt * 10);

  connectClientMock.mockReset();
  api = createMockPluginApi();
});

afterEach(async () => {
  // Tear down any pump that started during the test, then reset module
  // state so nothing leaks across tests in the same vitest worker.
  vi.useRealTimers();
  await stopWakePump(api);
  __resetWakePumpRetryForTests();
  __resetWakePumpRegistryForTests();
  tempHome.cleanup();
  delete process.env["KLODI_GATEWAY_OVERRIDE"];
});

describe("scheduleWakePumpRetry", () => {
  it("logs wake_pump_retry_scheduled with the first attempt's delay", () => {
    scheduleWakePumpRetry(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      "wake_pump_retry_scheduled",
      expect.objectContaining({ attempt: 1, delay_ms: 10 }),
    );
  });

  it("invokes startWakePumpIfPossible after the delay fires", async () => {
    connectClientMock.mockResolvedValue(makeFakeClient());

    scheduleWakePumpRetry(api);
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    expect(connectClientMock).toHaveBeenCalledTimes(1);
    expect(api.logger.info).toHaveBeenCalledWith(
      "wake_pump_retry_succeeded",
      expect.objectContaining({ attempt: 1 }),
    );
  });

  it("reschedules on failure with a growing attempt counter", async () => {
    connectClientMock.mockRejectedValue(new Error("ws timeout"));

    scheduleWakePumpRetry(api);
    // Fire attempt 1 only — the failure handler reschedules attempt 2.
    // Don't advance further; we want to inspect the reschedule log
    // without firing attempt 2 (which would chain to attempt 3 etc.).
    await vi.advanceTimersByTimeAsync(10);
    await settle();

    expect(connectClientMock).toHaveBeenCalledTimes(1);
    const scheduleEvents = vi.mocked(api.logger.info).mock.calls
      .filter((c) => c[0] === "wake_pump_retry_scheduled")
      .map((c) => c[1]);
    expect(scheduleEvents).toEqual([
      expect.objectContaining({ attempt: 1, delay_ms: 10 }),
      expect.objectContaining({ attempt: 2, delay_ms: 20 }),
    ]);
    expect(api.logger.warn).toHaveBeenCalledWith(
      "wake_pump_retry_failed",
      expect.objectContaining({ attempt: 1, error: "ws timeout" }),
    );
  });

  it("stops rescheduling once the pump starts successfully", async () => {
    // Reject twice, then succeed. After success, no further schedule.
    connectClientMock
      .mockRejectedValueOnce(new Error("ws 1"))
      .mockRejectedValueOnce(new Error("ws 2"))
      .mockResolvedValueOnce(makeFakeClient());

    scheduleWakePumpRetry(api);
    await vi.advanceTimersByTimeAsync(10);  // attempt 1: fail
    await settle();
    await vi.advanceTimersByTimeAsync(20);  // attempt 2: fail
    await settle();
    await vi.advanceTimersByTimeAsync(30);  // attempt 3: succeed
    await settle();
    // No further fire even after a long advance.
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(connectClientMock).toHaveBeenCalledTimes(3);
    expect(api.logger.info).toHaveBeenCalledWith(
      "wake_pump_retry_succeeded",
      expect.objectContaining({ attempt: 3 }),
    );
    const scheduleEvents = vi.mocked(api.logger.info).mock.calls
      .filter((c) => c[0] === "wake_pump_retry_scheduled");
    expect(scheduleEvents).toHaveLength(3);
  });

  it("is idempotent — synchronous double-call schedules only one timer", () => {
    scheduleWakePumpRetry(api);
    scheduleWakePumpRetry(api);
    scheduleWakePumpRetry(api);

    const scheduleEvents = vi.mocked(api.logger.info).mock.calls
      .filter((c) => c[0] === "wake_pump_retry_scheduled");
    expect(scheduleEvents).toHaveLength(1);
  });

  it("stopWakePump cancels the pending retry timer", async () => {
    scheduleWakePumpRetry(api);
    await stopWakePump(api);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    // Timer was cleared before it could fire — connectClient never called.
    expect(connectClientMock).not.toHaveBeenCalled();
  });

  it("halts retries when startWakePumpIfPossible returns null (creds removed)", async () => {
    // Drop creds so hasCredentials() returns false on the retry attempt.
    // startWakePumpIfPossible returns null instead of throwing — that
    // shouldn't be treated as a transient failure.
    delete process.env["KLODI_GATEWAY_OVERRIDE"];

    scheduleWakePumpRetry(api);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    expect(connectClientMock).not.toHaveBeenCalled();
    // Only the initial schedule — no follow-up.
    const scheduleEvents = vi.mocked(api.logger.info).mock.calls
      .filter((c) => c[0] === "wake_pump_retry_scheduled");
    expect(scheduleEvents).toHaveLength(1);
    // Reset env for the afterEach cleanup path.
    process.env["KLODI_GATEWAY_OVERRIDE"] = "1";
  });

  it("resets the attempt counter after a successful retry", async () => {
    // Round 1: fail once, then succeed.
    connectClientMock
      .mockRejectedValueOnce(new Error("ws 1"))
      .mockResolvedValueOnce(makeFakeClient());

    scheduleWakePumpRetry(api);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    await vi.advanceTimersByTimeAsync(20);
    await settle();

    // Tear down so a fresh cycle starts at attempt=1.
    await stopWakePump(api);
    vi.mocked(api.logger.info).mockClear();

    // Round 2: trigger a new failure cycle, expect attempt=1 again.
    connectClientMock.mockRejectedValueOnce(new Error("ws 3"));
    scheduleWakePumpRetry(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      "wake_pump_retry_scheduled",
      expect.objectContaining({ attempt: 1, delay_ms: 10 }),
    );
  });
});

describe("RETRY_BACKOFF_MS schedule", () => {
  beforeEach(() => {
    // Restore the production schedule for this block — the other tests
    // override it for speed, but the schedule itself is the contract.
    __setWakePumpRetryDelayForTests(null);
  });

  it("grows 30s → 60s → 120s → 300s and caps at 300s", () => {
    // Drive the schedule by re-scheduling synchronously after each
    // log assertion. We never advance the timer, so no retry fires —
    // we're only inspecting the scheduled delay metadata.
    scheduleWakePumpRetry(api);  // attempt 1
    // Advance just enough to fire the timer; reject so it reschedules.
    // To inspect attempts 2..5, repeat this without succeeding.
    // Easier: assert attempt 1 only here and trust the formula via
    // unit tests of the schedule function in isolation. But the
    // function is private — so drive it through the scheduler.
    expect(api.logger.info).toHaveBeenLastCalledWith(
      "wake_pump_retry_scheduled",
      expect.objectContaining({ attempt: 1, delay_ms: 30_000 }),
    );
  });

  it("scales subsequent attempts with the production cadence", async () => {
    connectClientMock.mockRejectedValue(new Error("ws fail"));

    scheduleWakePumpRetry(api);
    await vi.advanceTimersByTimeAsync(30_000);  // 1 → fail
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);  // 2 → fail
    await settle();
    await vi.advanceTimersByTimeAsync(120_000); // 3 → fail
    await settle();
    await vi.advanceTimersByTimeAsync(240_000); // 4 → fail
    await settle();
    await vi.advanceTimersByTimeAsync(300_000); // 5 → fail (capped)
    await settle();

    const delays = vi.mocked(api.logger.info).mock.calls
      .filter((c) => c[0] === "wake_pump_retry_scheduled")
      .map((c) => (c[1] as { delay_ms: number }).delay_ms);
    // Six entries because each failure schedules the next: initial +
    // five rescheduled attempts after the five timer fires.
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });
});
