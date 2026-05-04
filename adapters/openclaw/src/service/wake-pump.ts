/**
 * OpenClaw adapter wiring for the shared `WakePump`.
 *
 * Per `docs/plans/2026-04-28-host-agnostic-wake-pump.md`: the previous
 * lifecycle-hook gate (`gateway:startup` → subscribe) is unreliable
 * across host SDK versions. The pump replaces it with eager subscription
 * the moment credentials are present — at `register()` time when the
 * adapter loads against an already-registered persona, the `klodi_register`
 * success path on first-run, or a backoff retry from this module when
 * the register-time start fails (e.g., flaky NATS-WS handshake at boot —
 * without the retry an already-registered persona would stay inbound-deaf
 * until process restart, since `klodi_register` short-circuits with
 * `already_registered` and never re-runs the start path).
 */

import {
  createWakePump,
  type WakePump,
} from "@klodi/nats-client";
import type { PluginAPILike } from "../lib/plugin-api-types.js";
import { hasCredentials, loadConfig } from "../lib/config.js";
import { connectClient } from "../lib/client.js";
import {
  makeChannelHandler,
  makeNotificationHandler,
} from "./wake-handlers.js";

let pump: WakePump | null = null;

export function getWakePump(): WakePump | null {
  return pump;
}

/**
 * True when this process is the OpenClaw gateway runtime (the only
 * context where wake delivery is meaningful).
 *
 * OpenClaw sets `process.title = "openclaw-${subcommand}"` per CLI
 * invocation (see `program-COALA5eN.js` in the bundled SDK). So:
 *
 *   - `openclaw gateway`         → `openclaw-gateway`
 *   - `openclaw plugins install` → `openclaw-plugins`  ← install verify
 *   - `openclaw secrets ...`     → `openclaw-secrets`
 *   - `openclaw login ...`       → `openclaw-login`
 *
 * Linux's TASK_COMM_LEN (15 chars) truncates `openclaw-gateway` to
 * `openclaw-gatewa`, so we match both forms. macOS does not truncate.
 *
 * `OPENCLAW_CLI=1` is set unconditionally on every openclaw invocation
 * (`openclaw-exec-env-*.js::ensureOpenClawExecMarkerOnProcess`), so
 * it's useless as a discriminator. Don't gate on it.
 *
 * `KLODI_GATEWAY_OVERRIDE=1` is a test escape hatch — lets unit tests
 * and ad-hoc shell harnesses force the pump on without spoofing
 * `process.title`. Production never sets it.
 */
function isGatewayRuntime(): boolean {
  if (process.env["KLODI_GATEWAY_OVERRIDE"] === "1") return true;
  const t = process.title;
  return t === "openclaw-gateway" || t === "openclaw-gatewa";
}

/**
 * Boot the wake pump if we're in a gateway runtime AND credentials are
 * present. Returns `null` in either skip case.
 *
 * Idempotent: re-calling while a pump is already running is a no-op
 * (the singleton in `@klodi/nats-client`'s registry de-dupes too).
 */
export async function startWakePumpIfPossible(
  api: PluginAPILike,
): Promise<WakePump | null> {
  if (!isGatewayRuntime()) {
    // Info-level: operators verifying a smoke / install run want to
    // see this signal in the standard log stream. The skip is the
    // primary contract between this module and every non-gateway
    // openclaw context (install verify, secrets audit, login, etc.).
    api.logger.info("wake_pump_skip_non_gateway", {
      message:
        "Process is not the openclaw gateway (process.title check) —"
        + " skipping pump start. Wakes only deliver in the gateway"
        + " runtime; CLI subcommands like `openclaw plugins install`"
        + " load the plugin to verify it but never receive wakes.",
      process_title: process.title,
    });
    return null;
  }
  if (!hasCredentials()) {
    api.logger.debug("wake_pump_skip_no_creds", {
      message:
        "Credentials missing — wake pump deferred until klodi_register"
        + " success. Outbound tools still work via lazy connect.",
    });
    return null;
  }
  return startWakePump(api);
}

/**
 * Boot the wake pump unconditionally — caller has already verified
 * credentials. Used by `klodi_register`'s success path so the pump
 * lights up immediately on first-run registration.
 */
export async function startWakePump(api: PluginAPILike): Promise<WakePump> {
  if (pump !== null) {
    api.logger.debug("wake_pump_already_running", {
      message: "wake pump already running for this user — reusing.",
    });
    return pump;
  }
  const client = await connectClient(api);
  const config = loadConfig();
  const onNotification = makeNotificationHandler(api);
  const onChannelEvent = makeChannelHandler(api);
  const next = createWakePump(client, config.user_id, {
    onNotification,
    onChannelEvent,
  });
  try {
    await next.start();
  } catch (err) {
    api.logger.error("wake_pump_start_failed", {
      user_id: config.user_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  pump = next;
  api.logger.info("wake_pump_started", {
    user_id: config.user_id,
    handle: config.handle,
  });
  return pump;
}

/**
 * Stop the wake pump and clear the local reference. Idempotent — safe
 * to call when no pump is running. Used by `klodi_setup_repair` (creds
 * cleared → pump must drain) and on process-exit signals.
 *
 * Cancels any pending start-retry timer. Without this, a long-backoff
 * retry could fire after the process has begun draining and resurrect
 * the pump mid-shutdown.
 */
export async function stopWakePump(api: PluginAPILike): Promise<void> {
  cancelRetry();
  if (pump === null) return;
  const current = pump;
  pump = null;
  try {
    await current.stop();
    api.logger.info("wake_pump_stopped", {});
  } catch (err) {
    api.logger.warn("wake_pump_stop_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Outer backoff schedule for `scheduleWakePumpRetry`. Slower than
 * `attachWithRetry`'s inner ~75s loop so a wedged subscribe doesn't
 * burn the full outer schedule in the first minute. 30s → 60s → 120s
 * → 240s → 300s → 300s ...; no attempt cap (a permanently-down NATS
 * will log one warning per ~5min, which is the signal operators want).
 */
const RETRY_BACKOFF_MS = (attempt: number): number => {
  const exp = Math.min(attempt - 1, 4);
  return Math.min(30_000 * 2 ** exp, 300_000);
};

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let retryDelayOverride: ((attempt: number) => number) | null = null;

/**
 * Schedule a background start retry after `wake_pump_register_start_failed`.
 *
 * Independent of `klodi_register`'s success path so already-registered
 * personas (which never re-enter `klodi_register`) recover without a
 * process restart. Idempotent — re-arming while a timer is queued or
 * the pump is already running is a no-op.
 *
 * The timer is `unref`'d so it never pins the event loop on its own;
 * shutdown paths still cancel it explicitly via `stopWakePump`.
 */
export function scheduleWakePumpRetry(api: PluginAPILike): void {
  if (retryTimer !== null) return;
  if (pump !== null) return;
  retryAttempt += 1;
  const schedule = retryDelayOverride ?? RETRY_BACKOFF_MS;
  const delay = schedule(retryAttempt);
  api.logger.info("wake_pump_retry_scheduled", {
    attempt: retryAttempt,
    delay_ms: delay,
  });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runRetryAttempt(api);
  }, delay);
  retryTimer.unref?.();
}

async function runRetryAttempt(api: PluginAPILike): Promise<void> {
  try {
    const result = await startWakePumpIfPossible(api);
    if (result === null) {
      // Skipped (non-gateway runtime or creds removed). Stop retrying —
      // re-entry happens via klodi_register on first-run or the next
      // process boot.
      retryAttempt = 0;
      return;
    }
    api.logger.info("wake_pump_retry_succeeded", { attempt: retryAttempt });
    retryAttempt = 0;
  } catch (err) {
    api.logger.warn("wake_pump_retry_failed", {
      attempt: retryAttempt,
      error: err instanceof Error ? err.message : String(err),
    });
    scheduleWakePumpRetry(api);
  }
}

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryAttempt = 0;
}

/** Test escape hatches. Not exported from the package barrel. */
export function __resetWakePumpRetryForTests(): void {
  cancelRetry();
  retryDelayOverride = null;
}

export function __setWakePumpRetryDelayForTests(
  fn: ((attempt: number) => number) | null,
): void {
  retryDelayOverride = fn;
}

/**
 * Health snapshot for `klodi_setup_status`. Reports `running: false`
 * when no pump exists for this process.
 */
export function wakePumpHealth(): {
  running: boolean;
  user_id: string | null;
  notifications_last_event_at: Date | null;
  channels_last_event_at: Date | null;
} {
  if (pump === null) {
    return {
      running: false,
      user_id: null,
      notifications_last_event_at: null,
      channels_last_event_at: null,
    };
  }
  const h = pump.health();
  return {
    running: h.running,
    user_id: h.user_id,
    notifications_last_event_at: h.notifications_last_event_at,
    channels_last_event_at: h.channels_last_event_at,
  };
}
