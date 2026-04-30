/**
 * Single wake path for the plugin.
 *
 * Every place that would otherwise inline enqueueSystemEvent +
 * requestHeartbeatNow must route through here. Four invariants:
 *
 *   1. Order: enqueue BEFORE heartbeat. requestHeartbeatNow flushes the
 *      queue — flushing a queue that hasn't received the event yet is
 *      the bug this helper locks down.
 *   2. Stage separation: each call has its own try/catch so `wake_failed`
 *      carries a `stage` field. Enqueue failure → return early (no
 *      heartbeat, nothing queued). Heartbeat failure → rethrow so the
 *      consumer naks and JetStream redelivers per `max_deliver: 5` /
 *      `ack_wait: 30s`. Each redelivery re-runs both calls; agent-side
 *      `event_id` dedup absorbs the resulting double-enqueue.
 *   3. Error detail: `describeError` unpacks Error instances into
 *      name/message/stack and JSON.stringify's plain-object throws.
 *      The SDK can throw non-Error values; `String(err)` would collapse
 *      those to "[object Object]" and destroy the diagnostic signal.
 *   4. sessionKey: the SDK's `enqueueSystemEvent` throws
 *      `"system events require a sessionKey"` when the key is missing,
 *      which routes the event to LOST. We resolve the default agent's
 *      main-session key from `api.config` (canonical
 *      `agent:<agentId>:<mainKey>` pattern, matching what the cron
 *      runtime does) and pass it to both enqueue and heartbeat so the
 *      wake targets the same session that will drain the queue.
 *   5. Heartbeat reason namespace: OpenClaw's
 *      `resolveHeartbeatReasonKind` classifies reasons by prefix.
 *      Anything outside `wake`/`hook:`/`acp:spawn:`/`cron:`/
 *      `exec-event`/`manual`/`interval`/`retry` falls into kind=`other`,
 *      which flips `isWakeReason` off — the preflight then gates on
 *      HEARTBEAT.md, and without one the run short-circuits with
 *      `skipReason: "empty-heartbeat-file"` and no queued events are
 *      inspected. We pass `hook:klodi:<reason>` so kind=`hook`,
 *      `shouldBypassFileGates` and `shouldInspectPendingEvents` both
 *      become true, and the queued event feeds into the turn's prompt.
 */

import type { PluginAPILike } from "../lib/plugin-api-types.js";

export async function wakeAgent(
  api: PluginAPILike,
  text: string,
  reason: string,
): Promise<void> {
  const sessionKey = resolveAgentSessionKey(api);
  try {
    await api.runtime.system.enqueueSystemEvent(text, { sessionKey });
  } catch (err) {
    api.logger.warn("wake_failed", {
      reason,
      stage: "enqueue",
      sessionKey,
      ...describeError(err),
    });
    return;
  }
  api.logger.info("wake_enqueued", { reason, sessionKey });
  const heartbeatReason = `hook:klodi:${reason}`;
  try {
    api.runtime.system.requestHeartbeatNow({
      reason: heartbeatReason,
      sessionKey,
    });
  } catch (err) {
    api.logger.warn("wake_failed", {
      reason,
      stage: "heartbeat",
      sessionKey,
      ...describeError(err),
    });
    throw err;
  }
}

type RuntimeConfigShape = {
  agents?: {
    list?: ReadonlyArray<
      { id?: unknown; default?: unknown } | null | undefined
    >;
  };
  session?: { mainKey?: unknown };
};

/**
 * Build the canonical `agent:<agentId>:<mainKey>` key for the default
 * agent's main session. Mirrors OpenClaw's `resolveAgentMainSessionKey`
 * (bundled in `main-session-BBC2g05K.js`) without importing it — the
 * plugin-sdk runtime isn't resolvable from an external plugin's
 * node_modules, so we walk `api.config` directly. Falls back to
 * `"main"` for both halves when the config is empty (single-agent
 * defaults), which matches OpenClaw's `FALLBACK_DEFAULT_AGENT_ID`.
 */
export function resolveAgentSessionKey(api: PluginAPILike): string {
  const cfg = api.config as RuntimeConfigShape | undefined;
  const agents = cfg?.agents?.list ?? [];
  const defaultAgent = agents.find(isDefaultAgent);
  const firstWithId = agents.find(hasAgentId);
  const agentId = asTrimmed(defaultAgent?.id)
    ?? asTrimmed(firstWithId?.id)
    ?? "main";
  const mainKey = asTrimmed(cfg?.session?.mainKey) ?? "main";
  return `agent:${agentId}:${mainKey}`;
}

function isDefaultAgent(
  value: { id?: unknown; default?: unknown } | null | undefined,
): boolean {
  return value?.default === true && typeof asTrimmed(value?.id) === "string";
}

function hasAgentId(
  value: { id?: unknown; default?: unknown } | null | undefined,
): boolean {
  return typeof asTrimmed(value?.id) === "string";
}

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Per **D § D15** (P3-13 closure): only the top stack frame is logged.
 * Full `err.stack` leaks dist paths and `${KLODI_HOME}` location, so
 * the catalog redact list (`stack_full`) explicitly hides it. Top frame
 * is enough for triage; anyone debugging locally can flip
 * `LOG_LEVEL=DEBUG` and rerun.
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const stack = typeof err.stack === "string" ? err.stack : "";
    const topFrame = stack
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("at ")) ?? "";
    return { name: err.name, message: err.message, top_frame: topFrame };
  }
  return {
    raw: typeof err === "object" && err !== null
      ? JSON.stringify(err)
      : String(err),
  };
}
