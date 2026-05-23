/**
 * Pre-call guard contract for openclaw.
 *
 * Three guards run in fixed order before any NATS request:
 *
 *   1. `guardCreds` — `${KLODI_HOME}/{nats.creds, config.json}` both
 *      exist. Failure → `not_registered` envelope + `NextAction(Cli)`
 *      with the host-specific register CLI name (R8).
 *   2. `guardConnection` — the singleton `KlodiClient` is connected.
 *      Lives next to the dispatcher because it depends on the async
 *      client lifecycle; tests for it live in the tools tests
 *      (mocked client).
 *   3. `guardArgs` — schema check on adapter-side required fields.
 *      Failure → `invalid_request` + `details: {field, problem}`; no
 *      recovery_hint (agent re-calls with corrected args).
 *
 * Guards fail FAST — no NATS request, no filesystem write, no
 * marketplace round-trip. First failure short-circuits; later guards
 * do NOT execute (R4).
 *
 * Mirrors the Rust contract in
 * `packages/klodi-rust-host/src/mcp/guards.rs` and the Python contract
 * in `packages/nats-client-py/src/klodi_nats_client/guards.py`. See
 * ADR-0011.
 */

import { existsSync } from "node:fs";

import { hasCredentials } from "./config.js";
import { makeEnvelope, type ToolEnvelope } from "./envelope.js";
import { getConfigPath, getCredsPath } from "./paths.js";

export type ArgKind = "uuid" | "string" | "integer" | "bool" | "non_empty_string";

export interface ArgRule {
  field: string;
  kind: ArgKind;
}

export interface GuardOptions {
  /** Per-host register CLI name. The `not_registered` envelope's
   * `recovery_hint` carries this verbatim so the agent surfaces the
   * literal command the operator runs (R8). */
  registerCli?: string;
}

const DEFAULT_REGISTER_CLI = "klodi-openclaw-register";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `creds_present` guard. Returns `null` when both `${KLODI_HOME}/nats.creds`
 * and `${KLODI_HOME}/config.json` exist; otherwise an envelope.
 *
 * Note: this is the only public guard that does I/O — it stat()s two
 * files. No connection is opened, no other side-effects.
 */
export function guardCreds(opts: GuardOptions = {}): ToolEnvelope | null {
  // `hasCredentials` checks creds via the canonical path resolver; the
  // raw `existsSync` calls below cover the config-half-missing case the
  // test harness exercises (creds present, config absent).
  if (hasCredentials() && existsSync(getConfigPath())) {
    return null;
  }
  const registerCli = opts.registerCli ?? DEFAULT_REGISTER_CLI;
  return notRegistered(registerCli);
}

/**
 * `args_well_formed` guard. Walks `required` in order and returns the
 * FIRST envelope describing a missing / wrong-type / empty field. R4
 * short-circuit: the agent fixes one problem per round-trip.
 */
export function guardArgs(
  args: Record<string, unknown>,
  required: ReadonlyArray<ArgRule>,
): ToolEnvelope | null {
  for (const { field, kind } of required) {
    const value = args[field];
    if (value === undefined || value === null) {
      return invalidRequest(field, "missing");
    }
    const problem = checkValue(value, kind);
    if (problem !== null) {
      return invalidRequest(field, problem);
    }
  }
  return null;
}

/**
 * Synchronous pre-call guard composition: creds → args. The async
 * `guardConnection` lives in the dispatcher because it depends on the
 * singleton client; tests for it live in the tools tests.
 */
export function runPreCallGuards(
  args: Record<string, unknown>,
  required: ReadonlyArray<ArgRule>,
  opts: GuardOptions = {},
): ToolEnvelope | null {
  const credsEnv = guardCreds(opts);
  if (credsEnv !== null) return credsEnv;
  return guardArgs(args, required);
}

/**
 * Convenience builder for the `connection_not_ready` envelope.
 * The dispatcher calls this once the singleton check returns false.
 */
export function connectionNotReadyEnvelope(): ToolEnvelope {
  return makeEnvelope({
    error: "connection_not_ready",
    message:
      "klodi NATS connection is not ready. " +
      "Call klodi_setup_status to diagnose, then retry.",
    details: null,
    recovery_hint: {
      kind: "tool",
      tool: "klodi_setup_status",
      message: "Inspect setup state — connection is not ready.",
    },
  });
}

function notRegistered(registerCli: string): ToolEnvelope {
  return makeEnvelope({
    error: "not_registered",
    message:
      `klodi is not registered on this host. Run ${registerCli} from a shell to ` +
      "mint nats.creds and config.json under ${KLODI_HOME}.",
    details: null,
    recovery_hint: {
      kind: "cli",
      command: registerCli,
      message:
        `Run ${registerCli} — opens a browser link, polls for completion, ` +
        "writes nats.creds + config.json.",
    },
  });
}

function invalidRequest(field: string, problem: string): ToolEnvelope {
  return makeEnvelope({
    error: "invalid_request",
    message: `argument \`${field}\` is ${problem}; re-call with a corrected value`,
    details: { field, problem },
    recovery_hint: null,
  });
}

function checkValue(value: unknown, kind: ArgKind): string | null {
  switch (kind) {
    case "uuid":
      if (typeof value !== "string") return "wrong_type";
      if (value === "") return "empty";
      if (!UUID_V4_RE.test(value)) return "wrong_type";
      return null;
    case "string":
      if (typeof value !== "string") return "wrong_type";
      return null;
    case "non_empty_string":
      if (typeof value !== "string") return "wrong_type";
      if (value === "") return "empty";
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return "wrong_type";
      }
      return null;
    case "bool":
      if (typeof value !== "boolean") return "wrong_type";
      return null;
  }
}
