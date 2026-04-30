/**
 * Klodi unified-logger contract.
 *
 * Single source of truth for the cross-language `KlodiLogger` packages
 * (`@klodi/logger-ts`, `klodi_logger` Py, `klodi_logger` Rust). Codegens
 * into:
 *   - `dist/schemas.json#logging` — Python consumer
 *   - `dist/rust-types.rs#logging` — Rust consumer
 *
 * Per **D § D15** in
 * `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`.
 *
 * The contract pins three things every implementation must honor:
 *   1. The four log levels (`DEBUG` < `INFO` < `WARN` < `ERROR`).
 *   2. The redact list — field names whose values are replaced with
 *      `"[redacted]"` at INFO/WARN/ERROR. DEBUG bypasses redaction so
 *      developers can see actual payloads.
 *   3. The required-field map per call-site type — enforced by the
 *      `tests/integration/log-contract.test.ts` integration test, not
 *      by the loggers themselves (they emit whatever the caller passes).
 */

/** Ordered log levels. Lower index = noisier. */
export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Field names whose values are replaced with `"[redacted]"` at
 * INFO/WARN/ERROR levels. Bypassed at `LOG_LEVEL=DEBUG` so developers
 * can see actual payloads during local work.
 *
 * Adding a name here lights it up in TS, Py, and Rust loggers in one
 * step (codegen ratchets the constant downstream).
 */
export const REDACTED_FIELD_NAMES = [
  // Credentials / keys / bearer tokens.
  "creds",
  "nkey_seed",
  "nkey_private",
  "authorization",
  "bearer_token",
  // Floor values — defense in depth (ADR-0005 says they never leave the
  // client; redact regardless so a regression is not silently logged).
  "min_acceptable_price",
  "auto_reject_below",
  // PII.
  "email",
  "bio",
  "avatar_url",
  "phone",
  // Notification / message payload bodies. Redacted at INFO; visible
  // at DEBUG. The `P2P_EVENTS` audit/eval pipeline (D11) reads payloads
  // directly from JetStream — operator logs do NOT carry them.
  "payload",
  "body",
  "content",
  "description",
  "terms",
  // Stack / paths. Top frame is OK (`error.top_frame`); full stack is
  // redacted because it leaks dist paths and `${KLODI_HOME}` location.
  "stack_full",
] as const satisfies readonly string[];

export type RedactedFieldName = (typeof REDACTED_FIELD_NAMES)[number];

/**
 * Required fields per call-site type. The contract test
 * (`tests/integration/log-contract.test.ts`) asserts these are present
 * at INFO. Loggers do NOT reject calls missing required fields — the
 * test fails CI instead.
 */
export const REQUIRED_FIELDS_BY_SITE = {
  wake_handler: ["event_id", "kind"],
  tool_call_success: ["tool_name", "user_id", "latency_ms"],
  outbox_publish: ["event_id", "recipient_count", "attempt"],
  side_consumer_reject: ["user_id", "channel_id", "count_in_window"],
} as const satisfies Record<string, readonly string[]>;

export type CallSiteType = keyof typeof REQUIRED_FIELDS_BY_SITE;

/**
 * Redaction sentinel emitted in place of redacted-field values at
 * INFO/WARN/ERROR. Centralised so log-aggregation queries can grep for
 * one canonical string regardless of source language.
 */
export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Default log level when `LOG_LEVEL` is unset or invalid. Production
 * deploys land at `INFO`; dev workflows set `LOG_LEVEL=DEBUG` to see
 * full payloads. There is no separate `KLODI_LOG_PAYLOADS` flag — the
 * level is the only knob.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = "INFO";

/**
 * The newline-delimited JSON line shape every logger produces. Operator
 * log aggregation (Datadog, Loki, CloudWatch) parses one shape across
 * TS, Python, and Rust sources.
 */
export interface KlodiLogLine {
  /** ISO 8601 with milliseconds, UTC. */
  ts: string;
  level: LogLevel;
  /** Logger scope, e.g. `"klodi-openclaw"` or `"marketplace.handlers.offers"`. */
  scope: string;
  /** Short event name, e.g. `"wake_handler_invoked"`. */
  msg: string;
  /** Caller-supplied structured fields. Redacted at non-DEBUG levels. */
  fields: Record<string, unknown>;
  /** Optional error envelope. `top_frame` only — full stack is redacted. */
  error?: {
    name: string;
    message: string;
    top_frame: string;
  };
}

/**
 * Map of catalog-level logging constants the codegen emits into Py
 * (`schemas.json#logging`) and Rust (`rust-types.rs` consts + arrays).
 */
export const KLODI_LOGGING_CONSTANTS = {
  LOG_LEVELS,
  REDACTED_FIELD_NAMES,
  REQUIRED_FIELDS_BY_SITE,
  REDACTION_PLACEHOLDER,
  DEFAULT_LOG_LEVEL,
} as const;
