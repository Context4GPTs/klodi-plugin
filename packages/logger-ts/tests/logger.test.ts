/**
 * `@klodi/logger-ts` unit tests — Phase 4A (Cluster IV / D15).
 *
 * Covers the three pillars of the unified-logger contract from
 * `@klodi/tool-catalog/logging`:
 *   1. `levelFromEnv` — env normalisation + catalog default fallback.
 *   2. `redactFields` — recursive walk that replaces redact-name values
 *      with the catalog placeholder.
 *   3. `KlodiLogger` — NDJSON shape, level filtering, redaction-by-level,
 *      error envelope (top frame only), child scope/field inheritance,
 *      and stdout/stderr routing.
 *
 * Tests use an in-memory `LoggerSink` (`captureSink`) so we never write
 * to real stdio; this keeps the suite deterministic and lets us assert
 * routing (info/debug → stdout buffer, warn/error → stderr buffer).
 */

import { describe, expect, it } from "vitest";
import {
  KlodiLogger,
  levelFromEnv,
  redactFields,
  type LoggerSink,
} from "../src/index.js";
import type { KlodiLogLine } from "@klodi/tool-catalog/logging";

interface CaptureSink {
  sink: LoggerSink;
  stdout: string[];
  stderr: string[];
  lines: () => KlodiLogLine[];
}

function captureSink(): CaptureSink {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink: LoggerSink = {
    write: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  };
  const lines = (): KlodiLogLine[] =>
    [...stdout, ...stderr].map((line) => JSON.parse(line) as KlodiLogLine);
  return { sink, stdout, stderr, lines };
}

describe("levelFromEnv", () => {
  it("returns the catalog default (INFO) when env has no LOG_LEVEL", () => {
    expect(levelFromEnv({})).toBe("INFO");
  });

  it("normalises lowercase LOG_LEVEL to uppercase (debug → DEBUG)", () => {
    expect(levelFromEnv({ LOG_LEVEL: "debug" })).toBe("DEBUG");
  });

  it("falls back to catalog default when LOG_LEVEL is unrecognised", () => {
    // 'trace' is not in LOG_LEVELS — expect the catalog default, not 'TRACE'.
    expect(levelFromEnv({ LOG_LEVEL: "trace" })).toBe("INFO");
  });
});

describe("redactFields", () => {
  it("replaces top-level values whose key is in REDACTED_FIELD_NAMES", () => {
    const input = {
      tool_name: "klodi_whoami",
      bio: "x",
      email: "y",
      bearer_token: "z",
    };

    const out = redactFields(input) as Record<string, unknown>;

    expect(out["tool_name"]).toBe("klodi_whoami");
    expect(out["bio"]).toBe("[redacted]");
    expect(out["email"]).toBe("[redacted]");
    expect(out["bearer_token"]).toBe("[redacted]");
  });

  it("walks 2-deep nested objects and redacts inner redact-name keys", () => {
    // `meta` is NOT a redact key, so the walk descends; `email` inside is.
    const input = {
      user_id: "u-1",
      meta: {
        profile: {
          email: "secret@example.com",
          handle: "ada",
        },
      },
    };

    const out = redactFields(input) as Record<string, unknown>;
    const profile = (out["meta"] as Record<string, unknown>)["profile"] as Record<
      string,
      unknown
    >;

    expect(out["user_id"]).toBe("u-1");
    expect(profile["email"]).toBe("[redacted]");
    expect(profile["handle"]).toBe("ada");
  });

  it("walks arrays of objects and redacts redact-name values per entry", () => {
    const input = [
      { content: "first message body", id: "k-1" },
      { content: "second message body", id: "k-2" },
    ];

    const out = redactFields(input) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(2);
    expect(out[0]?.["content"]).toBe("[redacted]");
    expect(out[0]?.["id"]).toBe("k-1");
    expect(out[1]?.["content"]).toBe("[redacted]");
    expect(out[1]?.["id"]).toBe("k-2");
  });

  it("is identity for primitives (string, number, null)", () => {
    expect(redactFields("hello")).toBe("hello");
    expect(redactFields(42)).toBe(42);
    expect(redactFields(null)).toBe(null);
  });
});

describe("KlodiLogger.info NDJSON shape", () => {
  it("emits exactly one line with ts (ISO 8601), level, scope, msg, fields, no error key", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "INFO",
      sink: cap.sink,
    });

    logger.info("wake_handler_invoked", { event_id: "e-1", kind: "offer.proposed" });

    expect(cap.stdout).toHaveLength(1);
    expect(cap.stderr).toHaveLength(0);

    const [line] = cap.lines();
    expect(line).toBeDefined();
    if (!line) throw new Error("no line emitted");
    // ISO 8601 with milliseconds, UTC (toISOString() shape).
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line.level).toBe("INFO");
    expect(line.scope).toBe("klodi-openclaw");
    expect(line.msg).toBe("wake_handler_invoked");
    expect(line.fields).toEqual({ event_id: "e-1", kind: "offer.proposed" });
    // No `error` key when no err is passed.
    expect("error" in line).toBe(false);
  });
});

describe("KlodiLogger redaction-by-level", () => {
  it("at INFO: a top-level redact-name field has its value replaced with '[redacted]'", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "INFO",
      sink: cap.sink,
    });

    logger.info("event_emitted", { payload: { body: "secret" } });

    const [line] = cap.lines();
    if (!line) throw new Error("no line emitted");
    // `payload` is a redact-name → the entire value becomes the placeholder
    // (the walk does NOT descend into a redacted key's value).
    expect(line.fields["payload"]).toBe("[redacted]");
  });

  it("at DEBUG: redaction is bypassed; nested values pass through", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "DEBUG",
      sink: cap.sink,
    });

    logger.debug("event_emitted", { payload: { body: "secret" } });

    const [line] = cap.lines();
    if (!line) throw new Error("no line emitted");
    expect(line.fields["payload"]).toEqual({ body: "secret" });
  });
});

describe("KlodiLogger level filtering", () => {
  it("at WARN: debug/info produce no output; warn/error each produce one line", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "WARN",
      sink: cap.sink,
    });

    logger.debug("debug_event");
    logger.info("info_event");
    logger.warn("warn_event");
    logger.error("error_event");

    // 0 lines on stdout (info/debug are below WARN), 2 lines on stderr.
    expect(cap.stdout).toHaveLength(0);
    expect(cap.stderr).toHaveLength(2);
    expect(cap.lines()).toHaveLength(2);

    const [warnLine, errorLine] = cap.lines();
    expect(warnLine?.level).toBe("WARN");
    expect(warnLine?.msg).toBe("warn_event");
    expect(errorLine?.level).toBe("ERROR");
    expect(errorLine?.msg).toBe("error_event");
  });
});

describe("KlodiLogger.error envelope", () => {
  it("attaches name + message + top_frame; full stack does NOT leak into the line", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "ERROR",
      sink: cap.sink,
    });

    const err = new Error("boom");
    logger.error("op_failed", { op: "publish" }, err);

    expect(cap.stderr).toHaveLength(1);
    const [line] = cap.lines();
    if (!line) throw new Error("no line emitted");
    expect(line.error).toBeDefined();
    expect(line.error?.name).toBe("Error");
    expect(line.error?.message).toBe("boom");
    expect(line.error?.top_frame).toMatch(/^at /);

    // The serialised wire form must not carry the multi-line stack — i.e.
    // no literal `\n` (escaped) characters anywhere in the JSON string.
    // `JSON.stringify` escapes real newlines as `\n` (two chars), so we
    // grep for the escaped form in the raw stderr buffer.
    const raw = cap.stderr[0];
    expect(raw).toBeDefined();
    if (raw == null) throw new Error("no raw line");
    expect(raw.includes("\\n")).toBe(false);
  });
});

describe("KlodiLogger.child", () => {
  it("concatenates scope with '.' and merges baseFields with call-site fields", () => {
    const cap = captureSink();
    const parent = new KlodiLogger("klodi-openclaw", {
      level: "INFO",
      sink: cap.sink,
      baseFields: { user_id: "u-1" },
    });
    const child = parent.child("wake-handler", { kind: "offer.proposed" });

    child.info("invoked", { latency_ms: 12 });

    expect(cap.lines()).toHaveLength(1);
    const [line] = cap.lines();
    if (!line) throw new Error("no line emitted");
    expect(line.scope).toBe("klodi-openclaw.wake-handler");
    expect(line.fields).toEqual({
      user_id: "u-1",
      kind: "offer.proposed",
      latency_ms: 12,
    });
  });
});

describe("KlodiLogger output routing", () => {
  it("info/debug route to sink.write (stdout); warn/error route to sink.writeError (stderr)", () => {
    const cap = captureSink();
    const logger = new KlodiLogger("klodi-openclaw", {
      level: "DEBUG",
      sink: cap.sink,
    });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(cap.stdout).toHaveLength(2);
    expect(cap.stderr).toHaveLength(2);

    const stdoutLines = cap.stdout.map(
      (line) => JSON.parse(line) as KlodiLogLine,
    );
    const stderrLines = cap.stderr.map(
      (line) => JSON.parse(line) as KlodiLogLine,
    );
    expect(stdoutLines.map((l) => l.level).sort()).toEqual(["DEBUG", "INFO"]);
    expect(stderrLines.map((l) => l.level).sort()).toEqual(["ERROR", "WARN"]);
  });
});
