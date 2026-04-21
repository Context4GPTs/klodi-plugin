/**
 * Tests for src/service/wake.ts.
 *
 * Contract:
 *   wakeAgent(api, text, reason)
 *     1. Resolves the canonical session key via resolveAgentSessionKey(api).
 *     2. Awaits enqueueSystemEvent(text, { sessionKey }) — populates queue.
 *     3. Calls requestHeartbeatNow({ reason, sessionKey }) — flushes queue.
 *
 *   Ordering is load-bearing: flushing a not-yet-populated queue is the bug
 *   documented in OpenClaw SDK #29215/#34338/#14191.
 *
 *   sessionKey is mandatory. The SDK's `enqueueSystemEvent` throws
 *   "system events require a sessionKey" when the key is missing —
 *   the event would be LOST. Both enqueue AND heartbeat must carry
 *   the same sessionKey so they target the session that actually
 *   drains the queue.
 *
 *   Each stage has its own try/catch so the `wake_failed` log distinguishes
 *   a LOST event (enqueue failed → agent never wakes) from a QUEUED event
 *   (heartbeat failed → event fires at next heartbeat.every tick ≤ 1min):
 *     - enqueue throws → log { stage: "enqueue", ... }, return, do NOT
 *       call requestHeartbeatNow.
 *     - heartbeat throws → log { stage: "heartbeat", ... }, resolve.
 *
 *   describeError(err) unpacks Error instances into { name, message, stack }
 *   and falls back to { raw } for non-Error throws (plain objects become
 *   JSON.stringify'd, primitives/null become String(err)). Previously the
 *   helper stringified everything, turning non-Error throws into
 *   "[object Object]" and destroying diagnostic info.
 *
 * resolveAgentSessionKey contract:
 *   Build the canonical `agent:<agentId>:<mainKey>` key by walking
 *   `api.config`. Falls back to "main" for both halves when the config
 *   is empty — matching OpenClaw's FALLBACK_DEFAULT_AGENT_ID semantics.
 *   Agent selection: prefer `agents.list[*].default === true`, else the
 *   first entry with a non-blank string id. Blank/non-string ids are
 *   rejected so the SDK never sees an invalid key like
 *   `agent::main` or `agent:undefined:main`.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  createMockPluginApi,
  type MockPluginAPI,
} from "../helpers/mock-plugin-api.js";
import { wakeAgent, resolveAgentSessionKey } from "../../service/wake.js";

// ── Helpers ────────────────────────────────────────────────────────────────

let api: MockPluginAPI;

// Default mock config is {} which makes resolveAgentSessionKey return
// "agent:main:main" — matches the observed production runtime when no
// agents are explicitly configured.
const DEFAULT_SESSION_KEY = "agent:main:main";

beforeEach(() => {
  vi.clearAllMocks();
  api = createMockPluginApi();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("wakeAgent", () => {
  describe("happy path", () => {
    it("awaits enqueueSystemEvent with (text, { sessionKey })", async () => {
      // Arrange
      const text = "offer.proposed: lst-1 buyer=alice amount=$15.00";

      // Act
      await wakeAgent(api, text, "klodi-notification");

      // Assert — the SDK signature is positional: (text, options). The
      // sessionKey option is mandatory; missing it is the bug being fixed.
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
        text,
        { sessionKey: DEFAULT_SESSION_KEY },
      );
    });

    it("calls requestHeartbeatNow with { reason, sessionKey }", async () => {
      // Arrange
      const reason = "klodi-poller-tick";

      // Act
      await wakeAgent(api, "any text", reason);

      // Assert — heartbeat must target the SAME session that will drain
      // the queue; otherwise the enqueue goes to one session and the
      // flush pokes another. The reason is prefixed with "hook:klodi:"
      // so OpenClaw's resolveHeartbeatReasonKind classifier flips
      // isWakeReason=true and the preflight bypasses HEARTBEAT.md gating
      // (see wake.ts invariant #5).
      expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledTimes(1);
      expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
        reason: `hook:klodi:${reason}`,
        sessionKey: DEFAULT_SESSION_KEY,
      });
    });

    it(
      "emits wake_enqueued info log after successful enqueue with " +
        "{ reason, sessionKey }",
      async () => {
        // Arrange — success breadcrumb proves the enqueue settled before
        // the heartbeat fires. Without it, an enqueue/heartbeat pairing
        // gone wrong is indistinguishable in prod logs from a never-ran
        // wake.
        const reason = "klodi-notification";

        // Act
        await wakeAgent(api, "text", reason);

        // Assert
        expect(api.logger.info).toHaveBeenCalledWith("wake_enqueued", {
          reason,
          sessionKey: DEFAULT_SESSION_KEY,
        });
      },
    );

    it(
      "enqueues BEFORE requesting heartbeat (invariant — flushing a " +
        "not-yet-populated queue is the bug we are fixing)",
      async () => {
        // Arrange — capture observed call order across both mocks.
        const callOrder: string[] = [];
        (api.runtime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockImplementation(async () => {
            callOrder.push("enqueue");
          });
        (api.runtime.system.requestHeartbeatNow as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockImplementation(() => {
            callOrder.push("heartbeat");
          });

        // Act
        await wakeAgent(api, "text", "reason");

        // Assert
        expect(callOrder).toEqual(["enqueue", "heartbeat"]);
      },
    );

    it("emits no wake_failed log when both calls succeed", async () => {
      // Arrange — default mocks: enqueue resolves undefined, heartbeat no-op.

      // Act
      await wakeAgent(api, "text", "klodi-notification");

      // Assert
      expect(api.logger.warn).not.toHaveBeenCalledWith(
        "wake_failed",
        expect.anything(),
      );
    });

    it(
      "propagates the resolved sessionKey to both calls when agents.list " +
        "carries a default agent (session key varies per user config)",
      async () => {
        // Arrange — seed a realistic production config where the user
        // has configured a named default agent.
        const namedApi = createMockPluginApi({
          config: {
            agents: { list: [{ id: "klodi", default: true }] },
            session: { mainKey: "primary" },
          },
        });

        // Act
        await wakeAgent(namedApi, "text", "klodi-notification");

        // Assert — both SDK calls carry the SAME resolved key
        // "agent:klodi:primary" (not DEFAULT_SESSION_KEY). The heartbeat
        // reason is prefixed with "hook:klodi:" per invariant #5 in
        // wake.ts so OpenClaw treats it as a wake trigger.
        expect(namedApi.runtime.system.enqueueSystemEvent)
          .toHaveBeenCalledWith("text", { sessionKey: "agent:klodi:primary" });
        expect(namedApi.runtime.system.requestHeartbeatNow)
          .toHaveBeenCalledWith({
            reason: "hook:klodi:klodi-notification",
            sessionKey: "agent:klodi:primary",
          });
      },
    );

    it(
      "prefixes the heartbeat reason with 'hook:klodi:' so OpenClaw's " +
        "reason classifier flips isWakeReason=true and the preflight " +
        "skips the HEARTBEAT.md gate (without this the turn never " +
        "fires for queued events)",
      async () => {
        // Act
        await wakeAgent(api, "text", "klodi-notification");

        // Assert — matches the bundled heartbeat-wake-BZyHxxu5.js
        // classifier: any reason starting with "hook:" maps to
        // kind="hook", which sets shouldBypassFileGates=true and
        // shouldInspectPendingEvents=true. Without the prefix, the
        // classifier falls into kind="other", isWakeReason flips to
        // false, and the run short-circuits with
        // skipReason="empty-heartbeat-file".
        expect(api.runtime.system.requestHeartbeatNow).toHaveBeenCalledWith({
          reason: "hook:klodi:klodi-notification",
          sessionKey: "agent:main:main",
        });
      },
    );

    it(
      "keeps the plain reason in wake_enqueued log (prefix is for the " +
        "heartbeat only)",
      async () => {
        // Act
        await wakeAgent(api, "text", "klodi-notification");

        // Assert — operator-facing plugin logs stay in their own
        // namespace ("klodi-notification"); only the outbound
        // heartbeat call carries the "hook:klodi:" namespace required
        // by OpenClaw's classifier. Mixing the two would make the
        // log noisy for humans and regressing this split would hide
        // which wake reason fired at the plugin level.
        expect(api.logger.info).toHaveBeenCalledWith("wake_enqueued", {
          reason: "klodi-notification",
          sessionKey: "agent:main:main",
        });
      },
    );
  });

  describe("error handling — enqueue stage (event is LOST)", () => {
    it(
      "on enqueueSystemEvent rejection with Error: resolves, logs " +
        "wake_failed with stage='enqueue' + name/message/stack, and does " +
        "NOT call requestHeartbeatNow (flushing an empty queue would be " +
        "the bug)",
      async () => {
        // Arrange
        const reason = "klodi-notification";
        const boom = new Error("enqueue exploded");
        (api.runtime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockRejectedValue(boom);

        // Act — MUST NOT throw; callers rely on swallow semantics.
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled();
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "enqueue",
          sessionKey: DEFAULT_SESSION_KEY,
          name: boom.name,
          message: boom.message,
          stack: boom.stack,
        });
        // Enqueue rejected → the success breadcrumb MUST NOT fire.
        // Emitting wake_enqueued here would tell prod "event landed"
        // when it was actually LOST.
        expect(api.logger.info).not.toHaveBeenCalledWith(
          "wake_enqueued",
          expect.anything(),
        );
      },
    );

    it(
      "on enqueueSystemEvent rejection with a plain object (SDK may throw " +
        "non-Error): log carries raw=JSON.stringify(obj) so the object's " +
        "fields are preserved instead of becoming '[object Object]'",
      async () => {
        // Arrange
        const reason = "klodi-notification";
        const thrown = { code: "E_FOO", detail: "bar" };
        (api.runtime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockRejectedValue(thrown);

        // Act
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled();
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "enqueue",
          sessionKey: DEFAULT_SESSION_KEY,
          raw: JSON.stringify(thrown),
        });
      },
    );

    it(
      "on enqueueSystemEvent rejection with undefined: log carries " +
        "raw='undefined' so the diagnostic signal is preserved",
      async () => {
        // Arrange — an SDK that `reject(undefined)`s is malformed but
        // documented in OpenClaw #14191. The log must not collapse
        // this to "[object Object]".
        const reason = "klodi-notification";
        (api.runtime.system.enqueueSystemEvent as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockRejectedValue(undefined);

        // Act
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.requestHeartbeatNow).not.toHaveBeenCalled();
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "enqueue",
          sessionKey: DEFAULT_SESSION_KEY,
          raw: "undefined",
        });
      },
    );
  });

  describe("error handling — heartbeat stage (event is QUEUED)", () => {
    it(
      "on synchronous requestHeartbeatNow throw with Error (OpenClaw " +
        "#34338 channel-session skip semantics): resolves, logs " +
        "wake_failed with stage='heartbeat' + name/message/stack, enqueue " +
        "was still called exactly once",
      async () => {
        // Arrange
        const reason = "klodi-poller-tick";
        const boom = new Error("heartbeat skipped: no active channel");
        (api.runtime.system.requestHeartbeatNow as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockImplementation(() => {
            throw boom;
          });

        // Act
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
        expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(
          "text",
          { sessionKey: DEFAULT_SESSION_KEY },
        );
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "heartbeat",
          sessionKey: DEFAULT_SESSION_KEY,
          name: boom.name,
          message: boom.message,
          stack: boom.stack,
        });
        // Enqueue succeeded BEFORE heartbeat threw — the success
        // breadcrumb MUST have fired. This is what distinguishes a
        // LOST event (no wake_enqueued) from a QUEUED one
        // (wake_enqueued present, heartbeat.every tick will drain
        // the queue within ≤ 1min). Asserted here on the
        // representative Error-throw test; sibling tests re-check
        // since they exercise different throw shapes.
        expect(api.logger.info).toHaveBeenCalledWith("wake_enqueued", {
          reason,
          sessionKey: DEFAULT_SESSION_KEY,
        });
      },
    );

    it(
      "on heartbeat throw of null: log carries raw='null' (not " +
        "'[object Object]') so the cause is diagnosable",
      async () => {
        // Arrange
        const reason = "klodi-poller-tick";
        (api.runtime.system.requestHeartbeatNow as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockImplementation(() => {
            throw null;
          });

        // Act
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "heartbeat",
          sessionKey: DEFAULT_SESSION_KEY,
          raw: "null",
        });
        expect(api.logger.info).toHaveBeenCalledWith("wake_enqueued", {
          reason,
          sessionKey: DEFAULT_SESSION_KEY,
        });
      },
    );

    it(
      "on heartbeat throw of a string: log carries raw=<string> verbatim " +
        "so the thrown message is preserved",
      async () => {
        // Arrange
        const reason = "klodi-poller-tick";
        (api.runtime.system.requestHeartbeatNow as ReturnType<typeof vi.fn>)
          .mockReset()
          .mockImplementation(() => {
            throw "runtime not ready";
          });

        // Act
        await expect(wakeAgent(api, "text", reason)).resolves.toBeUndefined();

        // Assert
        expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledTimes(1);
        expect(api.logger.warn).toHaveBeenCalledWith("wake_failed", {
          reason,
          stage: "heartbeat",
          sessionKey: DEFAULT_SESSION_KEY,
          raw: "runtime not ready",
        });
        expect(api.logger.info).toHaveBeenCalledWith("wake_enqueued", {
          reason,
          sessionKey: DEFAULT_SESSION_KEY,
        });
      },
    );
  });
});

// ── resolveAgentSessionKey ─────────────────────────────────────────────────

describe("resolveAgentSessionKey", () => {
  it(
    "returns 'agent:main:main' when config is empty (FALLBACK_DEFAULT_" +
      "AGENT_ID semantics — single-agent default runtime)",
    () => {
      // Arrange
      const emptyApi = createMockPluginApi({ config: {} });

      // Act
      const key = resolveAgentSessionKey(emptyApi);

      // Assert — this is the key OpenClaw's cron runtime uses when
      // the user has not configured any agents. Production observed
      // the bug was: the SDK threw because `sessionKey` was missing
      // entirely, not because this default is wrong.
      expect(key).toBe("agent:main:main");
    },
  );

  it("returns 'agent:main:main' when api.config is undefined", () => {
    // Arrange — the SDK can hand back undefined if it never injects config.
    const noConfigApi = createMockPluginApi();
    (noConfigApi as { config: unknown }).config = undefined;

    // Act
    const key = resolveAgentSessionKey(noConfigApi);

    // Assert — undefined config must not NPE; fall through to defaults.
    expect(key).toBe("agent:main:main");
  });

  it(
    "uses the id of the entry flagged `default: true` over any other " +
      "entries in agents.list",
    () => {
      // Arrange — two agents, the second is flagged default. The order
      // must not trump the `default` flag, otherwise the wake would go
      // to the wrong session.
      const multiApi = createMockPluginApi({
        config: {
          agents: {
            list: [
              { id: "secondary", default: false },
              { id: "primary", default: true },
            ],
          },
        },
      });

      // Act
      const key = resolveAgentSessionKey(multiApi);

      // Assert
      expect(key).toBe("agent:primary:main");
    },
  );

  it(
    "falls back to the FIRST entry with a valid id when no entry is " +
      "flagged default (order-dependent, matches OpenClaw resolver)",
    () => {
      // Arrange — no default flag anywhere. The SDK's resolver picks
      // the first entry with a valid id; we must match that behavior.
      const apiNoDefault = createMockPluginApi({
        config: {
          agents: {
            list: [
              { id: "alpha" },
              { id: "bravo" },
            ],
          },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiNoDefault);

      // Assert
      expect(key).toBe("agent:alpha:main");
    },
  );

  it(
    "skips entries with blank string ids and uses the first entry whose " +
      "id is a non-blank string",
    () => {
      // Arrange — a blank or whitespace-only id would produce an
      // invalid key like "agent: :main", which the SDK rejects.
      const apiBlank = createMockPluginApi({
        config: {
          agents: {
            list: [
              { id: "" },
              { id: "   " },
              { id: "real-agent" },
            ],
          },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiBlank);

      // Assert
      expect(key).toBe("agent:real-agent:main");
    },
  );

  it(
    "skips entries whose id is a non-string value (number/object/null)",
    () => {
      // Arrange — malformed user config; treat any non-string id as
      // absent rather than stringifying it into the session key.
      const apiBadTypes = createMockPluginApi({
        config: {
          agents: {
            list: [
              { id: 123 },
              { id: { nested: "thing" } },
              { id: null },
              { id: "recoverable" },
            ],
          },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiBadTypes);

      // Assert
      expect(key).toBe("agent:recoverable:main");
    },
  );

  it(
    "tolerates null/undefined entries inside agents.list (malformed " +
      "config must not throw)",
    () => {
      // Arrange — a null entry can appear if user config was
      // deserialized from a sparse array.
      const apiSparse = createMockPluginApi({
        config: {
          agents: {
            list: [null, undefined, { id: "resilient" }],
          },
        },
      });

      // Act + Assert
      expect(() => resolveAgentSessionKey(apiSparse)).not.toThrow();
      expect(resolveAgentSessionKey(apiSparse)).toBe(
        "agent:resilient:main",
      );
    },
  );

  it(
    "uses session.mainKey override in the second half of the key " +
      "(agent:<id>:<mainKey>)",
    () => {
      // Arrange
      const apiMainKey = createMockPluginApi({
        config: {
          agents: { list: [{ id: "klodi", default: true }] },
          session: { mainKey: "cli" },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiMainKey);

      // Assert
      expect(key).toBe("agent:klodi:cli");
    },
  );

  it(
    "falls back to mainKey='main' when session.mainKey is a blank string",
    () => {
      // Arrange — trimmed-to-empty must not produce "agent:x:" which
      // would be an invalid key.
      const apiBlankKey = createMockPluginApi({
        config: {
          agents: { list: [{ id: "klodi", default: true }] },
          session: { mainKey: "   " },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiBlankKey);

      // Assert
      expect(key).toBe("agent:klodi:main");
    },
  );

  it(
    "falls back to mainKey='main' when session.mainKey is a non-string " +
      "(malformed user config)",
    () => {
      // Arrange
      const apiBadKey = createMockPluginApi({
        config: {
          agents: { list: [{ id: "klodi", default: true }] },
          session: { mainKey: 42 },
        },
      });

      // Act
      const key = resolveAgentSessionKey(apiBadKey);

      // Assert
      expect(key).toBe("agent:klodi:main");
    },
  );

  it(
    "returns 'agent:main:main' when agents.list is empty (no agents " +
      "configured) — matches the single-agent runtime default",
    () => {
      // Arrange
      const apiEmpty = createMockPluginApi({
        config: { agents: { list: [] } },
      });

      // Act
      const key = resolveAgentSessionKey(apiEmpty);

      // Assert
      expect(key).toBe("agent:main:main");
    },
  );
});
