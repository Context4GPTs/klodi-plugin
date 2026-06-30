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
 *   6. Diagnostic snapshot: `wake_enqueued` carries a session-store
 *      readout (`store_*`, `entry_exists`, `most_recent_*`). Purely
 *      diagnostic — does not change which session we target. Lets us
 *      confirm in production whether a failing wake landed on a key
 *      with no entry (e.g., the canonical `agent:<id>:main` while the
 *      user's only session is `agent:<id>:explicit:<sid>` from a TUI
 *      run). All fields are best-effort: any read failure falls
 *      through to `store_read: "missing" | "error"` and the wake
 *      proceeds unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginAPILike } from "../lib/plugin-api-types.js";

/**
 * Correlator that ties a `wake_enqueued` log line back to the wire event
 * that caused the wake. `kind` is a first-class discriminator (distinct
 * from the overloaded `reason`); `event_id` is the per-wire-event id
 * echoed verbatim from the triggering event — `null` for locally-
 * originated wakes (register-poller) that point at no wire event. The
 * `wake_handler` call-site contract (`tool-catalog logging.ts:74`)
 * requires both keys present, hence `event_id` is nullable, never
 * optional/`undefined` — `null` keeps the key in the emitted line.
 */
export interface WakeCorrelator {
  kind: string;
  event_id: string | null;
}

export async function wakeAgent(
  api: PluginAPILike,
  text: string,
  reason: string,
  correlator?: WakeCorrelator,
): Promise<void> {
  const sessionKey = resolveAgentSessionKey(api);
  try {
    await api.runtime.system.enqueueSystemEvent(text, { sessionKey });
  } catch (err) {
    // An enqueue failure is DETERMINISTIC (a missing sessionKey, a malformed
    // event — re-enqueue re-fails), so ACK stays correct: we return without
    // rethrowing and never fire the heartbeat (it would flush an empty queue).
    // But the failure is raised to ERROR, not WARN — operators demonstrably
    // do not watch WARN (the hermes Bug-2 shape). The alarm, not redelivery,
    // is the surface. Mirrors hermes's wake_inject_deterministic_failure.
    api.logger.error("wake_failed", {
      reason,
      stage: "enqueue",
      sessionKey,
      ...describeError(err),
    });
    return;
  }
  const snapshot = inspectSessionStore(api, sessionKey);
  api.logger.info("wake_enqueued", {
    reason,
    sessionKey,
    ...correlator,
    ...snapshot,
  });
  // Bug 3 (silent-success): the enqueue SUCCEEDED, but the resolved session
  // has no entry in the store — the wake lands on a dead session the user
  // never reads (e.g. canonical `agent:<id>:main` while the only live session
  // is an explicit TUI one). That is not buried as an INFO field: a confirmed
  // dead target raises a distinct operator-visible ERROR alarm. Gated on
  // `store_read === "ok"` so a missing/unreadable store (best-effort snapshot,
  // genuinely unknown) does not page a false alarm — see the snapshot docstring.
  if (snapshot.store_read === "ok" && snapshot.entry_exists === false) {
    api.logger.error("wake_dead_session", {
      reason,
      sessionKey,
      ...snapshot,
    });
  }
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
 * Best-effort snapshot of OpenClaw's `sessions.json` at wake-enqueue
 * time. Pure diagnostic: never throws, never mutates, never affects
 * which session we target.
 *
 * Purpose: surface the smoking-gun symptom where a wake lands on a
 * sessionKey that has no entry — typically the canonical
 * `agent:<id>:main` while the user's only live session is
 * `agent:<id>:explicit:<sessionId>` from a TUI / `command run`
 * invocation. The heartbeat-runner accepts the forced key but creates
 * a fresh empty transcript with no skill context, and the user (still
 * in their explicit session) sees nothing happen.
 *
 * Path resolution mirrors openclaw's
 * `resolveStorePath(cfg.session?.store, { agentId })` and
 * `resolveStateDir`/`resolveDefaultSessionStorePath`. Replicated rather
 * than imported because the plugin-sdk runtime isn't reachable from an
 * external plugin's node_modules. If openclaw rewires either, this
 * snapshot degrades to `store_read: "missing" | "error"` and stops
 * being useful — that's the failure mode we accept for a diagnostic.
 *
 * `most_recent_key` excludes `:subagent:` and trailing `:heartbeat`
 * keys: the heartbeat runner refuses to route forced wakes onto those
 * (subagents redirect back to main; `:heartbeat` is the runner's own
 * isolated lane), so they're never useful targets.
 */
type SessionStoreEntry = { updatedAt?: unknown };
type SessionStore = Record<string, SessionStoreEntry | null | undefined>;

interface SessionStoreDiagnostic {
  store_path: string;
  store_read: "ok" | "missing" | "error";
  store_entries: number;
  entry_exists: boolean;
  most_recent_key: string | null;
  most_recent_age_ms: number | null;
  most_recent_matches_resolved: boolean | null;
}

function inspectSessionStore(
  api: PluginAPILike,
  sessionKey: string,
): SessionStoreDiagnostic {
  try {
    const agentId = resolveAgentIdForStore(api);
    const storePath = resolveSessionStorePath(api, agentId);
    return readStoreSnapshot(storePath, sessionKey);
  } catch {
    return {
      store_path: "",
      store_read: "error",
      store_entries: 0,
      entry_exists: false,
      most_recent_key: null,
      most_recent_age_ms: null,
      most_recent_matches_resolved: null,
    };
  }
}

function resolveAgentIdForStore(api: PluginAPILike): string {
  const cfg = api.config as RuntimeConfigShape | undefined;
  const agents = cfg?.agents?.list ?? [];
  return asTrimmed(agents.find(isDefaultAgent)?.id)
    ?? asTrimmed(agents.find(hasAgentId)?.id)
    ?? "main";
}

function resolveSessionStorePath(
  api: PluginAPILike,
  agentId: string,
): string {
  const cfg = api.config as { session?: { store?: unknown } } | undefined;
  const tpl = asTrimmed(cfg?.session?.store);
  if (tpl !== undefined) {
    const expanded = tpl.replaceAll("{agentId}", agentId);
    return expandHomePrefix(expanded);
  }
  // Default OpenClaw layout. OPENCLAW_STATE_DIR overrides the home-relative
  // root; otherwise we land at ~/.openclaw. The legacy `.clawdbot` fallback
  // openclaw still recognizes is intentionally NOT mirrored here — if a
  // user is on that path, the diagnostic reports `store_read: "missing"`
  // and the operator knows to inspect the real location.
  const stateOverride = asTrimmed(process.env["OPENCLAW_STATE_DIR"]);
  const stateDir = stateOverride !== undefined
    ? expandHomePrefix(stateOverride)
    : join(homedir(), ".openclaw");
  return join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

function expandHomePrefix(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function readStoreSnapshot(
  storePath: string,
  sessionKey: string,
): SessionStoreDiagnostic {
  if (!existsSync(storePath)) {
    return {
      store_path: storePath,
      store_read: "missing",
      store_entries: 0,
      entry_exists: false,
      most_recent_key: null,
      most_recent_age_ms: null,
      most_recent_matches_resolved: null,
    };
  }
  let store: SessionStore;
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        store_path: storePath,
        store_read: "error",
        store_entries: 0,
        entry_exists: false,
        most_recent_key: null,
        most_recent_age_ms: null,
        most_recent_matches_resolved: null,
      };
    }
    store = parsed as SessionStore;
  } catch {
    return {
      store_path: storePath,
      store_read: "error",
      store_entries: 0,
      entry_exists: false,
      most_recent_key: null,
      most_recent_age_ms: null,
      most_recent_matches_resolved: null,
    };
  }

  const entries = Object.entries(store);
  const targetEntry = store[sessionKey];
  const entryExists = targetEntry !== undefined && targetEntry !== null;

  let mostRecentKey: string | null = null;
  let mostRecentUpdatedAt = -1;
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (key.includes(":subagent:")) continue;
    if (key.endsWith(":heartbeat")) continue;
    const updatedAt = (entry as SessionStoreEntry).updatedAt;
    if (typeof updatedAt === "number" && updatedAt > mostRecentUpdatedAt) {
      mostRecentUpdatedAt = updatedAt;
      mostRecentKey = key;
    }
  }

  return {
    store_path: storePath,
    store_read: "ok",
    store_entries: entries.length,
    entry_exists: entryExists,
    most_recent_key: mostRecentKey,
    most_recent_age_ms:
      mostRecentKey !== null ? Date.now() - mostRecentUpdatedAt : null,
    most_recent_matches_resolved:
      mostRecentKey !== null ? mostRecentKey === sessionKey : null,
  };
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
