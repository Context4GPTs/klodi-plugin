/**
 * `@klodi/logger-ts` — TypeScript implementation of the unified
 * `KlodiLogger` contract from `@klodi/tool-catalog/logging` (D15).
 *
 * One contract per language (TS / Py / Rust). Three implementations.
 * Operator log aggregation parses one NDJSON shape regardless of source.
 *
 * Public surface:
 *   - `class KlodiLogger` — `error/warn/info/debug` + `child`.
 *   - `levelFromEnv()` — reads `LOG_LEVEL` (default per catalog).
 *   - `redactFields()` — exposed for tests + side-consumer threshold path.
 *   - `createLogger({ service })` — service-scoped facade matching the
 *     legacy call sites in marketplace / web / infra-nats.
 *
 * The redaction walk is recursive — nested objects are walked and any
 * key in `REDACTED_FIELD_NAMES` has its value replaced with the catalog
 * placeholder (`[redacted]`) at INFO/WARN/ERROR. DEBUG bypasses redaction
 * so developers see full payloads locally.
 *
 * The `error()` method takes an optional `err` and emits the top stack
 * frame only (P3-13's mechanical fix becomes free for every caller).
 */

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  REDACTED_FIELD_NAMES,
  REDACTION_PLACEHOLDER,
  type KlodiLogLine,
  type LogLevel,
} from "@klodi/tool-catalog/logging";

export type { KlodiLogLine, LogLevel } from "@klodi/tool-catalog/logging";

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const REDACT_SET: ReadonlySet<string> = new Set(REDACTED_FIELD_NAMES);

export interface LoggerSink {
  write(line: string): void;
  writeError(line: string): void;
}

// Use `console.log` / `console.error` rather than `process.stdout.write`
// for two reasons: (1) Next.js / vitest test stubs commonly replace
// `console.*` (the existing marketplace + web tests do exactly this);
// (2) the platform handles flushing on process exit, so we don't lose
// trailing lines when a panicking handler exits before stdout drains.
// Outcome is identical NDJSON either way — `console.log` appends a
// newline and routes to the same fd as `process.stdout`.
const DEFAULT_SINK: LoggerSink = {
  write: (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  },
  writeError: (line) => {
    // eslint-disable-next-line no-console
    console.error(line);
  },
};

export interface KlodiLoggerOptions {
  /** Override the level. Defaults to env-derived (`LOG_LEVEL`). */
  level?: LogLevel;
  /** Override the sink (tests use an in-memory buffer). */
  sink?: LoggerSink;
  /** Initial fields merged into every emitted line. */
  baseFields?: Record<string, unknown>;
}

/** Returns the level derived from `LOG_LEVEL` env, or the catalog default. */
export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env["LOG_LEVEL"];
  if (raw == null) return DEFAULT_LOG_LEVEL;
  const upper = raw.toUpperCase();
  if ((LOG_LEVELS as readonly string[]).includes(upper)) {
    return upper as LogLevel;
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * Walk an arbitrary value and replace redacted-field values with the
 * placeholder. Pure function — never mutates the input.
 */
export function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactFields(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_SET.has(key) ? REDACTION_PLACEHOLDER : redactFields(val);
    }
    return out;
  }
  return value;
}

function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((line) => line.trim());
  // Skip the leading "ErrorName: msg" line.
  return lines.find((line) => line.startsWith("at ")) ?? "";
}

function describeError(err: unknown): KlodiLogLine["error"] | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: err.message,
      top_frame: topFrame(err.stack),
    };
  }
  return {
    name: "NonErrorThrown",
    message: typeof err === "string" ? err : JSON.stringify(err),
    top_frame: "",
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `KlodiLogger` — emit NDJSON lines that match the `KlodiLogLine` shape
 * from `@klodi/tool-catalog/logging`.
 *
 * Construct one per scope (e.g. `"klodi-openclaw"` or
 * `"marketplace.handlers.offers"`). Use `child(extraScope, baseFields)`
 * to derive a sub-scope that inherits + extends the parent's base fields.
 */
export class KlodiLogger {
  private readonly scope: string;
  private readonly level: LogLevel;
  private readonly sink: LoggerSink;
  private readonly baseFields: Record<string, unknown>;

  constructor(scope: string, options: KlodiLoggerOptions = {}) {
    this.scope = scope;
    this.level = options.level ?? levelFromEnv();
    this.sink = options.sink ?? DEFAULT_SINK;
    this.baseFields = options.baseFields ?? {};
  }

  /** Read-only access to the scope. The service-scoped `createLogger`
   * facade uses this to derive a sibling logger that inherits base
   * fields but keeps the same scope (the legacy `Logger.child(ctx)` API). */
  get scopeName(): string {
    return this.scope;
  }

  error(msg: string, fields?: Record<string, unknown>, err?: unknown): void {
    this.emit("ERROR", msg, fields, err);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("WARN", msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("INFO", msg, fields);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("DEBUG", msg, fields);
  }

  child(extraScope: string, baseFields: Record<string, unknown> = {}): KlodiLogger {
    return new KlodiLogger(`${this.scope}.${extraScope}`, {
      level: this.level,
      sink: this.sink,
      baseFields: { ...this.baseFields, ...baseFields },
    });
  }

  private emit(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
    err?: unknown,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const merged: Record<string, unknown> = fields
      ? { ...this.baseFields, ...fields }
      : { ...this.baseFields };
    const emittedFields = level === "DEBUG" ? merged : (redactFields(merged) as Record<string, unknown>);
    const line: KlodiLogLine = {
      ts: nowIso(),
      level,
      scope: this.scope,
      msg,
      fields: emittedFields,
    };
    const errorEnvelope = describeError(err);
    if (errorEnvelope) line.error = errorEnvelope;
    const serialised = JSON.stringify(line);
    if (level === "ERROR" || level === "WARN") {
      this.sink.writeError(serialised);
    } else {
      this.sink.write(serialised);
    }
  }
}

// ---------------------------------------------------------------------------
// Service-scoped facade (createLogger)
//
// Marketplace, web, and infra-nats consume the logger through a thin
// `createLogger({ service })` shape that pre-dates D15. Keeping the facade
// here (rather than in a separate `@klodi/logger` re-export package) is
// the rule-compliant path: NO RE-EXPORTS per CLAUDE.md / coding-rules.md.
// One package, one contract, one set of tests.
// ---------------------------------------------------------------------------

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(event: string, ctx?: LogContext): void;
  info(event: string, ctx?: LogContext): void;
  warn(event: string, ctx?: LogContext): void;
  error(event: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

export interface LoggerOptions {
  service: string;
  /** Optional explicit level override; otherwise reads `LOG_LEVEL`. */
  level?: LogLevel;
}

function wrap(klodi: KlodiLogger): Logger {
  return {
    debug: (event, ctx) => klodi.debug(event, ctx),
    info: (event, ctx) => klodi.info(event, ctx),
    warn: (event, ctx) => klodi.warn(event, ctx),
    error: (event, ctx) => klodi.error(event, ctx),
    // Inherit base fields without mutating the scope. Calling
    // `KlodiLogger.child("", ctx)` would yield a trailing `.` in the
    // scope; instead build a sibling logger with the same scope and
    // merged base fields.
    child: (ctx) => wrap(buildChild(klodi, ctx)),
  };
}

function buildChild(parent: KlodiLogger, baseFields: LogContext): KlodiLogger {
  // `KlodiLogger.child(extraScope, baseFields)` requires a non-empty
  // extra scope segment. The legacy `Logger.child(ctx)` API extends
  // base fields without scoping, so derive a sibling logger with the
  // same scope (read via the `scopeName` getter) and merged base fields.
  return new KlodiLogger(parent.scopeName, { baseFields });
}

export function createLogger(options: LoggerOptions): Logger {
  const klodi = new KlodiLogger(options.service, { level: options.level });
  return wrap(klodi);
}
