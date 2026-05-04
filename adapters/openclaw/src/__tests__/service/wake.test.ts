/**
 * Decision 13 — D.2.b3-throw: wake retry on heartbeat error.
 *
 * Adversarial unit test for klodi-plugin/adapters/openclaw/src/service/wake.ts.
 *
 * Locks down the B.3 contract:
 *   - enqueue stage failure  → log "wake_failed" with stage=enqueue, RETURN
 *     (never invoke heartbeat, never rethrow).
 *   - heartbeat stage failure → log "wake_failed" with stage=heartbeat, then
 *     RETHROW so the consumer's catch can nak. JetStream redelivers per
 *     max_deliver: 5; agent-side event_id dedup absorbs the double-enqueue.
 *   - happy path → enqueue first, then heartbeat (order is the headline
 *     invariant — heartbeat flushes the queue and a flush before enqueue is
 *     the bug this helper exists to prevent).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeAgent } from "../../service/wake.js";
import type { PluginAPI } from "openclaw/plugin-sdk";

interface RecordedCall {
  fn: "enqueue" | "heartbeat";
  args: unknown[];
}

interface FakeApiOptions {
  enqueueImpl?: (text: string, opts?: unknown) => Promise<void>;
  heartbeatImpl?: (opts?: unknown) => void;
  config?: unknown;
}

function createFakeApi(opts: FakeApiOptions = {}): {
  api: PluginAPI;
  calls: RecordedCall[];
  warnEvents: Array<{ event: string; ctx: Record<string, unknown> }>;
  infoEvents: Array<{ event: string; ctx: Record<string, unknown> }>;
} {
  const calls: RecordedCall[] = [];
  const warnEvents: Array<{ event: string; ctx: Record<string, unknown> }> = [];
  const infoEvents: Array<{ event: string; ctx: Record<string, unknown> }> = [];

  const enqueueImpl =
    opts.enqueueImpl ?? (async () => { /* default: succeed */ });
  const heartbeatImpl =
    opts.heartbeatImpl ?? (() => { /* default: succeed */ });

  // Resolve to the canonical "agent:main:main" key when no config provided.
  const config = opts.config ?? {};

  const api = {
    config,
    logger: {
      info: (event: string, ctx: Record<string, unknown> = {}) =>
        infoEvents.push({ event, ctx }),
      warn: (event: string, ctx: Record<string, unknown> = {}) =>
        warnEvents.push({ event, ctx }),
      error: () => undefined,
      debug: () => undefined,
    },
    runtime: {
      system: {
        async enqueueSystemEvent(text: string, options?: unknown): Promise<void> {
          calls.push({ fn: "enqueue", args: [text, options] });
          await enqueueImpl(text, options);
        },
        requestHeartbeatNow(options?: unknown): void {
          calls.push({ fn: "heartbeat", args: [options] });
          heartbeatImpl(options);
        },
      },
    },
  } as unknown as PluginAPI;

  return { api, calls, warnEvents, infoEvents };
}

describe("wakeAgent (Decision 13 — D.2.b3-throw)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("happy path", () => {
    it("invokes enqueueSystemEvent THEN requestHeartbeatNow in order", async () => {
      const { api, calls, infoEvents } = createFakeApi();

      await wakeAgent(api, "incoming offer", "offer.proposed");

      expect(calls.map((c) => c.fn)).toEqual(["enqueue", "heartbeat"]);
      // Order matters because heartbeat flushes the queue. If we ever
      // reorder or merge these into one call, this test must fail.
      expect(infoEvents.find((e) => e.event === "wake_enqueued")).toBeTruthy();
    });

    it("passes the same sessionKey to both enqueue and heartbeat", async () => {
      const { api, calls } = createFakeApi();

      await wakeAgent(api, "msg", "channel.message");

      const enqueueOpts = calls[0].args[1] as { sessionKey?: string };
      const heartbeatOpts = calls[1].args[0] as { sessionKey?: string };
      expect(enqueueOpts.sessionKey).toBe("agent:main:main");
      expect(heartbeatOpts.sessionKey).toBe("agent:main:main");
    });

    it("namespaces the heartbeat reason as hook:klodi:<reason>", async () => {
      const { api, calls } = createFakeApi();

      await wakeAgent(api, "msg", "offer.accepted");

      const heartbeatOpts = calls[1].args[0] as { reason?: string };
      // Required for OpenClaw's resolveHeartbeatReasonKind to classify
      // this as kind=hook (otherwise it falls into kind=other and the
      // queued event never feeds into the turn).
      expect(heartbeatOpts.reason).toBe("hook:klodi:offer.accepted");
    });

    it("does not throw on success", async () => {
      const { api } = createFakeApi();
      await expect(
        wakeAgent(api, "msg", "x"),
      ).resolves.toBeUndefined();
    });
  });

  describe("enqueue stage failure", () => {
    it("returns early without calling heartbeat and does NOT rethrow", async () => {
      const { api, calls, warnEvents } = createFakeApi({
        enqueueImpl: async () => {
          throw new Error("queue is full");
        },
      });

      await expect(
        wakeAgent(api, "text", "offer.proposed"),
      ).resolves.toBeUndefined();

      expect(calls.map((c) => c.fn)).toEqual(["enqueue"]);
      const failed = warnEvents.find((e) => e.event === "wake_failed");
      expect(failed).toBeTruthy();
      expect(failed?.ctx["stage"]).toBe("enqueue");
      expect(failed?.ctx["reason"]).toBe("offer.proposed");
      expect(failed?.ctx["message"]).toBe("queue is full");
    });

    it("never sends a heartbeat when enqueue fails (would flush an empty queue)", async () => {
      const { api, calls } = createFakeApi({
        enqueueImpl: async () => { throw new Error("fail"); },
      });

      await wakeAgent(api, "x", "y");

      expect(calls.find((c) => c.fn === "heartbeat")).toBeUndefined();
    });
  });

  describe("heartbeat stage failure (D.2.b3-throw)", () => {
    it("RETHROWS the heartbeat error so the consumer can nak", async () => {
      const heartbeatErr = new Error("heartbeat sdk down");
      const { api } = createFakeApi({
        heartbeatImpl: () => {
          throw heartbeatErr;
        },
      });

      await expect(
        wakeAgent(api, "text", "offer.proposed"),
      ).rejects.toBe(heartbeatErr);
    });

    it("logs wake_failed with stage=heartbeat BEFORE rethrowing", async () => {
      const { api, warnEvents } = createFakeApi({
        heartbeatImpl: () => { throw new Error("nope"); },
      });

      await wakeAgent(api, "text", "transaction.confirmed").catch(
        () => undefined,
      );

      const failed = warnEvents.find((e) => e.event === "wake_failed");
      expect(failed).toBeTruthy();
      expect(failed?.ctx["stage"]).toBe("heartbeat");
      expect(failed?.ctx["reason"]).toBe("transaction.confirmed");
      expect(failed?.ctx["sessionKey"]).toBe("agent:main:main");
      // Heartbeat-thrown Error gets describeError unpacking.
      expect(failed?.ctx["message"]).toBe("nope");
    });

    it("still records an enqueue (proves the order: enqueue committed before throw)", async () => {
      const { api, calls } = createFakeApi({
        heartbeatImpl: () => { throw new Error("x"); },
      });

      await wakeAgent(api, "t", "r").catch(() => undefined);

      expect(calls.map((c) => c.fn)).toEqual(["enqueue", "heartbeat"]);
    });

    it("rethrows non-Error throws untouched (raw value preserved)", async () => {
      // SDK can throw plain objects; describeError must not collapse the
      // diagnostic — and the rethrow must preserve the original value.
      const rawThrow = { code: 42, info: "weird" };
      const { api, warnEvents } = createFakeApi({
        heartbeatImpl: () => { throw rawThrow; },
      });

      await expect(wakeAgent(api, "t", "r")).rejects.toBe(rawThrow);

      const failed = warnEvents.find((e) => e.event === "wake_failed");
      expect(failed?.ctx["raw"]).toBe(JSON.stringify(rawThrow));
    });
  });

  describe("session-store diagnostic on wake_enqueued", () => {
    // The plugin reads sessions.json on every wake to surface the void-session
    // symptom: a wake that lands on `agent:<id>:main` while the user's only
    // live session is `agent:<id>:explicit:<sid>` from a TUI run. The
    // heartbeat-runner accepts the forced key, runs in an empty fresh
    // transcript with no skill context, and the user (still in their explicit
    // session) sees nothing happen. The diagnostic doesn't change behavior —
    // it just makes that symptom visible in production logs.
    let tempDir: string;
    let storePath: string;
    let originalStateDir: string | undefined;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "klodi-wake-store-"));
      storePath = join(tempDir, "sessions.json");
      // Isolate from any real ~/.openclaw on the dev machine when the test
      // exercises the env-default code path (no cfg.session.store).
      originalStateDir = process.env["OPENCLAW_STATE_DIR"];
      process.env["OPENCLAW_STATE_DIR"] = tempDir;
    });

    afterEach(() => {
      if (originalStateDir === undefined) {
        delete process.env["OPENCLAW_STATE_DIR"];
      } else {
        process.env["OPENCLAW_STATE_DIR"] = originalStateDir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    function findEnqueued(
      events: Array<{ event: string; ctx: Record<string, unknown> }>,
    ): Record<string, unknown> {
      const e = events.find((ev) => ev.event === "wake_enqueued");
      expect(e, "expected a wake_enqueued event").toBeTruthy();
      return e!.ctx;
    }

    it("entry_exists=true and most_recent_matches_resolved=true when canonical key is populated", async () => {
      writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "uuid-main", updatedAt: Date.now() },
        }),
      );
      const { api, infoEvents } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_read"]).toBe("ok");
      expect(ctx["store_entries"]).toBe(1);
      expect(ctx["entry_exists"]).toBe(true);
      expect(ctx["most_recent_key"]).toBe("agent:main:main");
      expect(ctx["most_recent_matches_resolved"]).toBe(true);
    });

    it("flags the smoking-gun: entry_exists=false while most_recent_key points to an explicit session", async () => {
      // The exact scenario the diagnostic exists to catch: the canonical
      // wake target has no entry, and the user's only session is explicit
      // (TUI / `openclaw command run`). Operators reading this log should
      // immediately see entry_exists=false, most_recent_matches_resolved=false,
      // most_recent_key=agent:main:explicit:* and know the wake landed in a
      // void.
      writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:explicit:tui-1": {
            sessionId: "uuid-tui",
            updatedAt: Date.now(),
          },
        }),
      );
      const { api, infoEvents } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_read"]).toBe("ok");
      expect(ctx["entry_exists"]).toBe(false);
      expect(ctx["most_recent_key"]).toBe("agent:main:explicit:tui-1");
      expect(ctx["most_recent_matches_resolved"]).toBe(false);
    });

    it("excludes :subagent: and :heartbeat keys from most_recent_key even when they have higher updatedAt", async () => {
      // Heartbeat-runner refuses forced wakes onto subagent (redirects to main)
      // and :heartbeat (its own isolated lane) keys, so reporting either as the
      // most-recent legitimate target would be misleading. Both must be skipped
      // even if their updatedAt is the highest in the store.
      const now = Date.now();
      writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "u-main", updatedAt: now - 1_000 },
          "agent:main:explicit:abc:subagent:child": {
            sessionId: "u-sub",
            updatedAt: now - 500,
          },
          "agent:main:explicit:def:heartbeat": {
            sessionId: "u-hb",
            updatedAt: now - 100,
          },
        }),
      );
      const { api, infoEvents } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_entries"]).toBe(3);
      expect(ctx["most_recent_key"]).toBe("agent:main:main");
    });

    it("reports store_read='missing' when sessions.json doesn't exist", async () => {
      // No file written. The cfg points at a path that doesn't exist; the
      // diagnostic must degrade gracefully — wake still proceeds.
      const { api, infoEvents, calls } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_read"]).toBe("missing");
      expect(ctx["store_entries"]).toBe(0);
      expect(ctx["entry_exists"]).toBe(false);
      expect(ctx["most_recent_key"]).toBeNull();
      // Behavior unaffected — enqueue + heartbeat still fired.
      expect(calls.map((c) => c.fn)).toEqual(["enqueue", "heartbeat"]);
    });

    it("reports store_read='error' when sessions.json contains malformed JSON", async () => {
      writeFileSync(storePath, "{not-json");
      const { api, infoEvents } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_read"]).toBe("error");
      expect(ctx["store_entries"]).toBe(0);
      expect(ctx["entry_exists"]).toBe(false);
    });

    it("interpolates {agentId} in cfg.session.store template", async () => {
      // Mirrors openclaw's resolveStorePath behavior: when the configured
      // store template embeds {agentId}, expand it before reading. Lets the
      // diagnostic find the right file when a user runs a non-default agent.
      writeFileSync(
        storePath,
        JSON.stringify({
          "agent:custom:main": {
            sessionId: "u-custom",
            updatedAt: Date.now(),
          },
        }),
      );
      const templated = join(tempDir, "{agentId}-sessions.json");
      // Move file to match the template expansion target.
      const expanded = join(tempDir, "custom-sessions.json");
      writeFileSync(
        expanded,
        JSON.stringify({
          "agent:custom:main": {
            sessionId: "u-custom",
            updatedAt: Date.now(),
          },
        }),
      );
      const { api, infoEvents } = createFakeApi({
        config: {
          session: { store: templated },
          agents: { list: [{ id: "custom", default: true }] },
        },
      });

      await wakeAgent(api, "x", "y");

      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_path"]).toBe(expanded);
      expect(ctx["store_read"]).toBe("ok");
      expect(ctx["entry_exists"]).toBe(true);
    });
  });

  describe("sessionKey resolution from api.config", () => {
    it("uses default-marked agent id when present", async () => {
      const { api, calls } = createFakeApi({
        config: {
          agents: {
            list: [
              { id: "secondary" },
              { id: "primary", default: true },
            ],
          },
          session: { mainKey: "main" },
        },
      });

      await wakeAgent(api, "x", "y");

      const enqueueOpts = calls[0].args[1] as { sessionKey?: string };
      expect(enqueueOpts.sessionKey).toBe("agent:primary:main");
    });

    it("falls back to first agent with id when no default is marked", async () => {
      const { api, calls } = createFakeApi({
        config: {
          agents: { list: [{ id: "first" }, { id: "second" }] },
        },
      });

      await wakeAgent(api, "x", "y");

      const enqueueOpts = calls[0].args[1] as { sessionKey?: string };
      expect(enqueueOpts.sessionKey).toBe("agent:first:main");
    });
  });
});

// qa-developer: 0012-gap-fixes-decision-13
