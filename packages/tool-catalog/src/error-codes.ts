/**
 * Canonical error-code vocabulary for cross-adapter envelope parity.
 *
 * Every `error` value an agent receives is drawn from this closed set
 * (R2). Adapters that catch an unrecognised marketplace code fall back
 * to `marketplace_error` and preserve the original code in
 * `details.marketplace_error_code` (also enumerated below).
 *
 * The set is append-only without renames — agents in flight may
 * pattern-match on these literals, and the catalog stability gate at
 * `tests/error-codes-stability.test.ts` (when added) snapshots the keys
 * to catch accidental deletions.
 *
 * Cross-language parity:
 *   - Rust embeds the equivalent table at compile time via
 *     `packages/klodi-rust-host/src/mcp/envelope.rs` mapping.
 *   - Python re-exports from `klodi_nats_client` (consumed by hermes +
 *     nanobot).
 *   - The openclaw TS adapter imports this module directly.
 *
 * See ADR-0011 (`docs/decisions/0011-adapter-exception-envelope.md`)
 * and the bundled skill at `skill/references/error_envelopes.md`.
 */

/** Recovery target the agent should follow when the code surfaces. */
export type RecoveryKind = "cli" | "tool" | "shell" | "dialog" | "none";

export interface ErrorCodeEntry {
  /** Human-readable description shown to operators / agents. */
  readonly description: string;
  /** Canonical recovery vocabulary — matches `recovery_hint.kind`. */
  readonly recovery_kind: RecoveryKind;
  /** When non-null, the specific tool/CLI/shell command the
   * `recovery_hint` resolves to for this code. Adapters substitute the
   * per-host CLI name for `cli`-kind hints; the `tool`-kind hints are
   * already host-portable. */
  readonly recovery_target?: string;
}

/**
 * The frozen canonical map. Renames break agents; deletions break the
 * stability gate. Add new codes by amending ADR-0011 and appending here.
 */
export const errorCodes: Readonly<Record<string, ErrorCodeEntry>> = Object.freeze({
  not_registered: {
    description:
      "Credentials missing under ${KLODI_HOME} (one or both of " +
      "nats.creds, config.json absent). The agent surfaces the per-host " +
      "register CLI as the recovery action.",
    recovery_kind: "cli",
    // The exact CLI name is host-specific; per-adapter the dispatcher
    // substitutes e.g. `klodi-zeroclaw-register`. Catalog default is
    // the host-agnostic placeholder.
    recovery_target: "klodi-<host>-register",
  },
  klodi_home_missing: {
    description:
      "${KLODI_HOME} directory absent or unwritable for tools with " +
      "on-disk side effects (klodi_list_create, klodi_list_update, " +
      "klodi_list_withdraw, klodi_list_relist, klodi_searches_create, " +
      "klodi_watch, klodi_unwatch).",
    recovery_kind: "tool",
    recovery_target: "klodi_setup_status",
  },
  connection_not_ready: {
    description:
      "The persistent NATS-WS connection has not been established " +
      "(transport down, no responders, or connect failed).",
    recovery_kind: "tool",
    recovery_target: "klodi_setup_status",
  },
  consumer_missing: {
    description:
      "A server-managed durable consumer is absent at subscribe time. " +
      "details.consumer is 'notifications' or 'channels'.",
    recovery_kind: "tool",
    recovery_target: "klodi_setup_status",
  },
  invalid_request: {
    description:
      "Args failed adapter-side schema validation before NATS dispatch. " +
      "details carries {field, problem} where problem is one of " +
      "missing | wrong_type | empty.",
    recovery_kind: "none",
  },
  unauthorized: {
    description:
      "Marketplace rejected the request because the calling user does " +
      "not own the target resource. details.marketplace_error_code " +
      "carries the server's original code.",
    recovery_kind: "none",
  },
  not_found: {
    description:
      "Marketplace rejected the request because the target id does not " +
      "exist. details carries {resource, resource_id}.",
    recovery_kind: "none",
  },
  conflict: {
    description:
      "Marketplace rejected the state transition because the resource " +
      "is already in a non-retriable state (tx confirmed, listing sold, " +
      "offer accepted, channel closed). details.current_state names " +
      "the current state.",
    recovery_kind: "tool",
    // resource-specific; adapter substitutes klodi_tx_status /
    // klodi_list_status / etc. when the dispatcher knows the resource.
    recovery_target: "klodi_<resource>_status",
  },
  validation_failed: {
    description:
      "Marketplace rejected the request shape (server-side schema). " +
      "details.field names the bad field; agent re-calls with corrected " +
      "args.",
    recovery_kind: "none",
  },
  rate_limited: {
    description:
      "Marketplace throttled the request. details.retry_after_seconds " +
      "(when present) carries the wait period.",
    recovery_kind: "none",
  },
  marketplace_error: {
    description:
      "Marketplace returned an error not in the more-specific subset. " +
      "details.marketplace_error_code preserves the original code; " +
      "details.marketplace_message preserves the server's message.",
    recovery_kind: "none",
  },
  upload_failed: {
    description:
      "Photo upload step failed during klodi_list_create / " +
      "klodi_list_update. details.path names the failing file.",
    recovery_kind: "none",
  },
  internal_error: {
    description:
      "Adapter-internal exception (JSON decode, panic, unexpected " +
      "transport error). details.exception_class or details.trace_id " +
      "carries what the adapter knows. The agent retries once or " +
      "surfaces to the operator.",
    recovery_kind: "none",
  },
});

export type ErrorCode = keyof typeof errorCodes;
