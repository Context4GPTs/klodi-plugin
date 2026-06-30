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
import {
  makeChannelHandler,
  makeNotificationHandler,
} from "../../service/wake-handlers.js";
import type {
  ChannelMessageEvent,
  NotificationEvent,
  NotificationKind,
} from "@klodi/tool-catalog";
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
  errorEvents: Array<{ event: string; ctx: Record<string, unknown> }>;
} {
  const calls: RecordedCall[] = [];
  const warnEvents: Array<{ event: string; ctx: Record<string, unknown> }> = [];
  const infoEvents: Array<{ event: string; ctx: Record<string, unknown> }> = [];
  const errorEvents: Array<{ event: string; ctx: Record<string, unknown> }> = [];

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
      error: (event: string, ctx: Record<string, unknown> = {}) =>
        errorEvents.push({ event, ctx }),
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

  return { api, calls, warnEvents, infoEvents, errorEvents };
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

  // card/audit-all-adapters-for-silent-wake-inject-failure — RED (qa-developer)
  //
  // Seam 4a — openclaw enqueue-failure ERROR alarm (AC 2).
  //
  // An enqueue failure is DETERMINISTIC (a missing sessionKey, a malformed
  // event — re-enqueue re-fails), so ACK stays correct (redelivery is futile),
  // BUT today it logs at WARN and operators demonstrably do not watch WARN
  // (the exact hermes Bug-2 shape). The fix raises it to `api.logger.error`
  // as a distinct, alertable event — keeping the name `wake_failed` with
  // `stage: "enqueue"` — while still ACKing (no rethrow, no heartbeat). These
  // tests assert the ERROR severity; they fail RED while the arm logs at WARN.
  describe("enqueue stage failure (deterministic → ERROR alarm + ACK)", () => {
    it("logs a distinct ERROR alarm (not WARN) and still ACKs (no rethrow)", async () => {
      const { api, calls, errorEvents, warnEvents } = createFakeApi({
        enqueueImpl: async () => {
          throw new Error("queue is full");
        },
      });

      // ACK: a deterministic enqueue failure does not redeliver — resolves.
      await expect(
        wakeAgent(api, "text", "offer.proposed"),
      ).resolves.toBeUndefined();

      expect(calls.map((c) => c.fn)).toEqual(["enqueue"]);
      // The alarm must be operator-visible (ERROR), not buried at WARN.
      const failed = errorEvents.find((e) => e.event === "wake_failed");
      expect(
        failed,
        "enqueue failure must emit a distinct ERROR alarm (operators do not"
          + " watch WARN); got error events: "
          + JSON.stringify(errorEvents),
      ).toBeTruthy();
      expect(failed?.ctx["stage"]).toBe("enqueue");
      expect(failed?.ctx["reason"]).toBe("offer.proposed");
      expect(failed?.ctx["message"]).toBe("queue is full");
      // And it is no longer the WARN it used to be.
      expect(
        warnEvents.find(
          (e) => e.event === "wake_failed" && e.ctx["stage"] === "enqueue",
        ),
      ).toBeUndefined();
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

    // card/openclaw-zeroclaw-per-conversation-wake-keying — OQ-2 (qa-developer RED).
    //
    // OQ-2 RESOLUTION (supersedes the #34 `wake_dead_session` ERROR alarm): under
    // per-conversation keying a conversation's FIRST wake legitimately lands on a
    // not-yet-created session (`entry_exists === false`); the heartbeat runtime
    // creates it on enqueue. The "wrong shared session" failure the alarm
    // surfaced is structurally eliminated by keying, and no single enqueue-time
    // store snapshot can tell a brand-new per-entity session from a reaped one —
    // any surviving gate would only ever false-fire. So the `wake_dead_session`
    // ERROR escalation (wake.ts:99-112) is REMOVED (a clean delete, no shim);
    // `entry_exists`/`store_*` survive only as INFO fields on `wake_enqueued`.
    //
    // This INVERTS the #34 test (which asserted the alarm fires) per the card's
    // confirmed requirement change: the `wake_dead_session` ERROR escalation is
    // removed, so no operator-visible alarm fires on a first-contact session.
    // Distillation updates ADR-0019's openclaw row + the deferred-follow-up note.
    it("does NOT fire a wake_dead_session ERROR on a first-contact no-entry session (OQ-2)", async () => {
      // Canonical wake target `agent:main:main` is ABSENT; the only live session
      // is an explicit TUI one. Under OQ-2 this is legitimate first-contact, NOT
      // a dead session — no operator-visible ERROR must fire.
      writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:explicit:tui-1": {
            sessionId: "uuid-tui",
            updatedAt: Date.now(),
          },
        }),
      );
      const { api, errorEvents, infoEvents, calls } = createFakeApi({
        config: { session: { store: storePath } },
      });

      await wakeAgent(api, "x", "y");

      expect(
        errorEvents.find((e) => e.event === "wake_dead_session"),
        "OQ-2: a first-contact no-entry session must NOT raise wake_dead_session"
          + " — that ERROR escalation is removed; got error events: "
          + JSON.stringify(errorEvents),
      ).toBeUndefined();
      // The wake still proceeds, and entry_exists survives as an INFO diagnostic.
      const ctx = findEnqueued(infoEvents);
      expect(ctx["store_read"]).toBe("ok");
      expect(ctx["entry_exists"]).toBe(false);
      expect(calls.map((c) => c.fn)).toEqual(["enqueue", "heartbeat"]);
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

  // ───────────────────────────────────────────────────────────────────
  // card/add-event-correlator-to-wake-enqueued-log — RED phase.
  //
  // The wake_enqueued log must carry a `kind` discriminator and an
  // `event_id` correlator, additive to the existing reason/sessionKey/
  // store-diagnostic fields. For wire-event wakes both are echoed
  // verbatim from the triggering event; for locally-originated
  // (register-poller) wakes `kind` is the origin string and `event_id`
  // is an explicit `null` (the key is present, never `undefined`).
  //
  // These tests drive the PUBLIC surface — the makeNotificationHandler /
  // makeChannelHandler factories and wakeAgent itself — and assert only
  // observable log output. They mock the SDK boundary already faked by
  // createFakeApi; no logic is stubbed.
  // ───────────────────────────────────────────────────────────────────
  describe("wake_enqueued event correlator (kind + event_id)", () => {
    function findEnqueued(
      events: Array<{ event: string; ctx: Record<string, unknown> }>,
    ): Record<string, unknown> {
      const e = events.find((ev) => ev.event === "wake_enqueued");
      expect(e, "expected a wake_enqueued event").toBeTruthy();
      return e!.ctx;
    }

    function allEnqueued(
      events: Array<{ event: string; ctx: Record<string, unknown> }>,
    ): Array<Record<string, unknown>> {
      return events
        .filter((ev) => ev.event === "wake_enqueued")
        .map((ev) => ev.ctx);
    }

    /**
     * One complete, type-valid NotificationEvent per NotificationKind.
     * Keyed by kind so the contract test can iterate all 16 and assert
     * the line echoes that exact kind + event_id. Each carries a
     * distinct event_id so cross-kind bleed would surface.
     */
    const notificationFixtures: Record<NotificationKind, NotificationEvent> = {
      "listing.created": {
        kind: "listing.created",
        event_id: "evt-listing-created",
        listing_id: "lst-1",
        title: "A widget",
      },
      "listing.relisted": {
        kind: "listing.relisted",
        event_id: "evt-listing-relisted",
        listing_id: "lst-2",
      },
      "listing.withdrawn": {
        kind: "listing.withdrawn",
        event_id: "evt-listing-withdrawn",
        listing_id: "lst-3",
      },
      "listing.sold": {
        kind: "listing.sold",
        event_id: "evt-listing-sold",
        listing_id: "lst-4",
      },
      "listing.expired": {
        kind: "listing.expired",
        event_id: "evt-listing-expired",
        listing_id: "lst-5",
      },
      "listing.status_changed": {
        kind: "listing.status_changed",
        event_id: "evt-listing-status",
        listing_id: "lst-6",
        old_status: "active",
        new_status: "paused",
      },
      "offer.proposed": {
        kind: "offer.proposed",
        event_id: "evt-offer-proposed",
        offer_id: "off-1",
        listing_id: "lst-7",
        buyer_handle: "buyer",
        amount: 1000,
        terms: null,
      },
      "offer.accepted": {
        kind: "offer.accepted",
        event_id: "evt-offer-accepted",
        offer_id: "off-2",
        listing_id: "lst-8",
        seller_handle: "seller",
        amount: 1000,
        transaction_id: "txn-1",
      },
      "offer.rejected": {
        kind: "offer.rejected",
        event_id: "evt-offer-rejected",
        offer_id: "off-3",
        listing_id: "lst-9",
        seller_handle: "seller",
      },
      "transaction.buyer_confirmed": {
        kind: "transaction.buyer_confirmed",
        event_id: "evt-txn-buyer",
        transaction_id: "txn-2",
        listing_id: "lst-10",
        confirmed_by_handle: "buyer",
      },
      "transaction.seller_confirmed": {
        kind: "transaction.seller_confirmed",
        event_id: "evt-txn-seller",
        transaction_id: "txn-3",
        listing_id: "lst-11",
        confirmed_by_handle: "seller",
      },
      "transaction.completed": {
        kind: "transaction.completed",
        event_id: "evt-txn-completed",
        transaction_id: "txn-4",
        listing_id: "lst-12",
      },
      "transaction.cancelled": {
        kind: "transaction.cancelled",
        event_id: "evt-txn-cancelled",
        transaction_id: "txn-5",
        listing_id: "lst-13",
        reason: "buyer backed out",
      },
      "comment.created": {
        kind: "comment.created",
        event_id: "evt-comment",
        listing_id: "lst-14",
        comment_id: "cmt-1",
        handle: "commenter",
        body: "nice listing",
        mentions: [],
        created_at: "2026-06-23T00:00:00Z",
      },
      "search.match": {
        kind: "search.match",
        event_id: "evt-search",
        search_slug: "widgets",
        listing_id: "lst-15",
        listing_summary: {
          title: "Matched widget",
          asking_price: 500,
          currency: "USD",
          fulfillment: [],
          seller_handle: "seller",
          photos: [],
        },
      },
      "channel.opened": {
        kind: "channel.opened",
        event_id: "evt-channel-opened",
        channel_id: "chn-1",
        listing_id: "lst-16",
        buyer_handle: "buyer",
      },
      "channel.closed": {
        kind: "channel.closed",
        event_id: "evt-channel-closed",
        channel_id: "chn-2",
        listing_id: "lst-17",
        closed_by: "seller",
      },
    };

    function channelEvent(
      overrides: Partial<ChannelMessageEvent> = {},
    ): ChannelMessageEvent {
      return {
        kind: "channel.message",
        event_id: "evt-channel-message",
        channel_id: "chn-9",
        message_id: "msg-1",
        sequence: 1,
        sender_user_id: "usr-1",
        sender_handle: "sender",
        content: "hello",
        created_at: "2026-06-23T00:00:00Z",
        ...overrides,
      };
    }

    // (a) every NotificationKind → line carries kind===K and the event's event_id.
    describe("wire NotificationEvent correlator", () => {
      const kinds = Object.keys(notificationFixtures) as NotificationKind[];

      for (const kind of kinds) {
        it(`echoes kind="${kind}" and event_id onto wake_enqueued`, async () => {
          const { api, infoEvents } = createFakeApi();
          const event = notificationFixtures[kind];

          await makeNotificationHandler(api)(event);

          const ctx = findEnqueued(infoEvents);
          expect(ctx["kind"]).toBe(kind);
          expect(ctx["event_id"]).toBe(event.event_id);
        });
      }

      it("covers every NotificationKind in the catalog union (no kind silently dropped)", () => {
        // The catalog `NotificationEvent` union enumerates 17 kinds (the
        // card's "16 fails" is the klodi-stage suite's injected count, a
        // separate thing). The `Record<NotificationKind, …>` fixture map
        // is exhaustive by type, so this guard is the count the emitter
        // must echo a `kind` for — drift in the union breaks it loudly.
        expect(kinds).toHaveLength(17);
      });
    });

    // (b) ChannelMessageEvent → kind==="channel.message" + matching event_id.
    it("channel handler logs kind=channel.message and the event's event_id", async () => {
      const { api, infoEvents } = createFakeApi();
      const event = channelEvent({ event_id: "evt-chan-abc" });

      await makeChannelHandler(api)(event);

      const ctx = findEnqueued(infoEvents);
      expect(ctx["kind"]).toBe("channel.message");
      expect(ctx["event_id"]).toBe("evt-chan-abc");
    });

    // (c) redelivery of the same wire event → same event_id every time.
    it("redelivered notification yields the SAME event_id across lines (stable, not regenerated)", async () => {
      const { api, infoEvents } = createFakeApi();
      const event = notificationFixtures["offer.proposed"];
      const handler = makeNotificationHandler(api);

      // JetStream redelivery under max_deliver: 5 — same event object, twice.
      await handler(event);
      await handler(event);

      const lines = allEnqueued(infoEvents);
      expect(lines).toHaveLength(2);
      expect(lines[0]["event_id"]).toBe(event.event_id);
      expect(lines[1]["event_id"]).toBe(event.event_id);
      expect(lines[0]["event_id"]).toBe(lines[1]["event_id"]);
    });

    // (d) two distinct same-kind notifications → distinguishable by event_id.
    it("two distinct same-kind notifications are distinguishable by event_id", async () => {
      const { api, infoEvents } = createFakeApi();
      const handler = makeNotificationHandler(api);
      const base = notificationFixtures["comment.created"];

      await handler({ ...base, event_id: "evt-comment-A" });
      await handler({ ...base, event_id: "evt-comment-B" });

      const lines = allEnqueued(infoEvents);
      expect(lines).toHaveLength(2);
      // Same kind on both — the gap the docstring names.
      expect(lines[0]["kind"]).toBe("comment.created");
      expect(lines[1]["kind"]).toBe("comment.created");
      // But event_id distinguishes them.
      expect(lines[0]["event_id"]).toBe("evt-comment-A");
      expect(lines[1]["event_id"]).toBe("evt-comment-B");
      expect(lines[0]["event_id"]).not.toBe(lines[1]["event_id"]);
    });

    // (e) local/synthetic wake (register-poller origin) → kind=origin, event_id present and === null.
    describe("locally-originated (register-poller) wake correlator", () => {
      const origins = [
        "klodi-register-timeout",
        "klodi-register-complete",
        "klodi-register-expired",
        "klodi-register-already-claimed",
        "klodi-register-invalid-response",
      ];

      for (const origin of origins) {
        it(`origin "${origin}" → kind=origin and event_id explicitly null (key present)`, async () => {
          const { api, infoEvents } = createFakeApi();

          // The register-poller passes { kind: <origin>, event_id: null }.
          await wakeAgent(api, "synthetic wake", origin, {
            kind: origin,
            event_id: null,
          });

          const ctx = findEnqueued(infoEvents);
          expect(ctx["kind"]).toBe(origin);
          // The key MUST exist with an explicit null — never undefined,
          // which would drop the key and fail the wake_handler contract.
          expect("event_id" in ctx).toBe(true);
          expect(ctx["event_id"]).toBeNull();
          expect(ctx["event_id"]).not.toBeUndefined();
        });
      }
    });

    // (f) non-regression: existing fields still present and unchanged.
    it("keeps reason, sessionKey, and store_* diagnostic fields unchanged (additive only)", async () => {
      const { api, infoEvents } = createFakeApi();
      const event = notificationFixtures["offer.accepted"];

      await makeNotificationHandler(api)(event);

      const ctx = findEnqueued(infoEvents);
      // Pre-existing fields untouched (reason stays the kind). sessionKey is now
      // the per-entity key (Item 1): offer.accepted keys off the LISTING (lst-8),
      // NOT the shared agent:main:main — updated per the card's keying change.
      expect(ctx["reason"]).toBe("offer.accepted");
      expect(ctx["sessionKey"]).toBe("agent:main:klodi:lst-8");
      // Session-store diagnostic block still emitted.
      expect("store_read" in ctx).toBe(true);
      expect("store_entries" in ctx).toBe(true);
      expect("entry_exists" in ctx).toBe(true);
      expect("most_recent_key" in ctx).toBe(true);
      expect("most_recent_matches_resolved" in ctx).toBe(true);
      // And the additive correlator rides alongside, not instead.
      expect(ctx["kind"]).toBe("offer.accepted");
      expect(ctx["event_id"]).toBe(event.event_id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // card/openclaw-zeroclaw-per-conversation-wake-keying — Item 2 (qa-developer).
  //
  // The two deterministic `wake_failed` alarms must carry the in-scope
  // `...correlator` (kind/event_id) so a failed wake is tie-able to its wire
  // event on dashboards — matching the adjacent `wake_enqueued` INFO line and the
  // ADR-0019 cross-adapter alarm contract. Today the enqueue ERROR (wake.ts:84)
  // and the heartbeat WARN (:120) omit it. `null` event_id is fine for a
  // local-origin wake (BR-7). Both alarms spread `...correlator` so a failed
  // wake is tie-able to its wire event.
  // ─────────────────────────────────────────────────────────────────────────
  describe("wake_failed alarm correlator parity (Item 2)", () => {
    it("enqueue-stage ERROR carries the kind+event_id correlator when present", async () => {
      const { api, errorEvents } = createFakeApi({
        enqueueImpl: async () => { throw new Error("queue is full"); },
      });

      await wakeAgent(api, "text", "offer.proposed", {
        kind: "offer.proposed",
        event_id: "evt-42",
      });

      const failed = errorEvents.find(
        (e) => e.event === "wake_failed" && e.ctx["stage"] === "enqueue",
      );
      expect(
        failed,
        "expected an enqueue-stage wake_failed ERROR; got: "
          + JSON.stringify(errorEvents),
      ).toBeTruthy();
      expect(failed?.ctx["kind"]).toBe("offer.proposed");
      expect(failed?.ctx["event_id"]).toBe("evt-42");
      // Existing diagnostic fields stay alongside (additive spread).
      expect(failed?.ctx["sessionKey"]).toBe("agent:main:main");
      expect(failed?.ctx["message"]).toBe("queue is full");
    });

    it("enqueue-stage ERROR is null-safe for a local-origin wake (event_id null)", async () => {
      const { api, errorEvents } = createFakeApi({
        enqueueImpl: async () => { throw new Error("boom"); },
      });

      // register-poller passes { kind: <origin>, event_id: null }.
      await wakeAgent(api, "synthetic", "klodi-register-timeout", {
        kind: "klodi-register-timeout",
        event_id: null,
      });

      const failed = errorEvents.find(
        (e) => e.event === "wake_failed" && e.ctx["stage"] === "enqueue",
      );
      expect(
        failed,
        "the ERROR must still fire for a local-origin wake (BR-7)",
      ).toBeTruthy();
      expect(failed?.ctx["kind"]).toBe("klodi-register-timeout");
      // The key is present with an explicit null — never undefined.
      expect("event_id" in (failed?.ctx ?? {})).toBe(true);
      expect(failed?.ctx["event_id"]).toBeNull();
      expect(failed?.ctx["sessionKey"]).toBe("agent:main:main");
    });

    it("heartbeat-stage WARN carries the kind+event_id correlator when present", async () => {
      const { api, warnEvents } = createFakeApi({
        heartbeatImpl: () => { throw new Error("heartbeat down"); },
      });

      await wakeAgent(api, "text", "transaction.completed", {
        kind: "transaction.completed",
        event_id: "evt-77",
      }).catch(() => undefined);

      const failed = warnEvents.find(
        (e) => e.event === "wake_failed" && e.ctx["stage"] === "heartbeat",
      );
      expect(failed, "expected a heartbeat-stage wake_failed WARN").toBeTruthy();
      expect(failed?.ctx["kind"]).toBe("transaction.completed");
      expect(failed?.ctx["event_id"]).toBe("evt-77");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // card/openclaw-zeroclaw-per-conversation-wake-keying — Item 1 wiring (qa-developer RED).
  //
  // The relay-level proof: makeNotificationHandler/makeChannelHandler must derive
  // the per-entity key from the typed event and pass it into wakeAgent so the
  // wake enqueues — AND heartbeats (invariant #4) — on the CONVERSATION's own key
  // (`agent:<id>:klodi:<entity_id>`), not the shared agent:main:main. Mirrors the
  // hermes relay tests. RED while the handlers still relay to agent:main:main.
  // ─────────────────────────────────────────────────────────────────────────
  describe("per-conversation key wiring through the handlers (Item 1)", () => {
    function sessionKeysOf(
      calls: RecordedCall[],
    ): { enqueue?: string; heartbeat?: string } {
      const enqueue = calls.find((c) => c.fn === "enqueue");
      const heartbeat = calls.find((c) => c.fn === "heartbeat");
      return {
        enqueue: (enqueue?.args[1] as { sessionKey?: string } | undefined)
          ?.sessionKey,
        heartbeat: (heartbeat?.args[0] as { sessionKey?: string } | undefined)
          ?.sessionKey,
      };
    }

    function offerProposed(
      listing_id: string,
      event_id: string,
    ): NotificationEvent {
      return {
        kind: "offer.proposed",
        event_id,
        offer_id: "off-1",
        listing_id,
        buyer_handle: "buyer",
        amount: 1000,
        terms: null,
      };
    }

    it("relays two distinct listings to two distinct per-entity session keys", async () => {
      const a = createFakeApi();
      await makeNotificationHandler(a.api)(offerProposed("lst-7", "e1"));
      const b = createFakeApi();
      await makeNotificationHandler(b.api)(offerProposed("lst-8", "e2"));

      expect(sessionKeysOf(a.calls).enqueue).toBe("agent:main:klodi:lst-7");
      expect(sessionKeysOf(b.calls).enqueue).toBe("agent:main:klodi:lst-8");
      expect(sessionKeysOf(a.calls).enqueue).not.toBe("agent:main:main");
      expect(sessionKeysOf(b.calls).enqueue).not.toBe("agent:main:main");
    });

    it("relays repeat wakes for one listing to one continuous session key", async () => {
      const { api, calls } = createFakeApi();
      const handler = makeNotificationHandler(api);
      await handler(offerProposed("lst-7", "e1"));
      await handler(offerProposed("lst-7", "e2"));

      const enqueues = calls
        .filter((c) => c.fn === "enqueue")
        .map((c) => (c.args[1] as { sessionKey?: string }).sessionKey);
      expect(enqueues).toEqual([
        "agent:main:klodi:lst-7",
        "agent:main:klodi:lst-7",
      ]);
    });

    it("keys offer.accepted off the listing prefix, not the transaction (BR-2)", async () => {
      const { api, calls } = createFakeApi();
      const event: NotificationEvent = {
        kind: "offer.accepted",
        event_id: "evt-acc",
        offer_id: "off-2",
        listing_id: "lst-8",
        seller_handle: "seller",
        amount: 1000,
        transaction_id: "txn-1",
      };
      await makeNotificationHandler(api)(event);
      const key = sessionKeysOf(calls).enqueue;
      expect(key).toBe("agent:main:klodi:lst-8");
      expect(key).not.toContain("txn-1");
    });

    it("relays a channel message to a per-channel session key", async () => {
      const { api, calls } = createFakeApi();
      const event: ChannelMessageEvent = {
        kind: "channel.message",
        event_id: "evt-chan",
        channel_id: "chn-9",
        message_id: "msg-1",
        sequence: 1,
        sender_user_id: "usr-1",
        sender_handle: "sender",
        content: "hello",
        created_at: "2026-06-30T00:00:00Z",
      };
      await makeChannelHandler(api)(event);
      expect(sessionKeysOf(calls).enqueue).toBe("agent:main:klodi:chn-9");
    });

    it("enqueues AND heartbeats on the SAME per-entity key (invariant #4)", async () => {
      const { api, calls } = createFakeApi();
      await makeNotificationHandler(api)(offerProposed("lst-7", "e1"));
      const keys = sessionKeysOf(calls);
      expect(keys.enqueue).toBe("agent:main:klodi:lst-7");
      expect(keys.heartbeat).toBe("agent:main:klodi:lst-7");
      expect(keys.enqueue).toBe(keys.heartbeat);
    });
  });
});

// qa-developer: 0012-gap-fixes-decision-13
// qa-developer: card/add-event-correlator-to-wake-enqueued-log — RED kind/event_id correlator
// qa-developer: card/openclaw-zeroclaw-per-conversation-wake-keying — RED keying + Item 2 correlator + OQ-2
