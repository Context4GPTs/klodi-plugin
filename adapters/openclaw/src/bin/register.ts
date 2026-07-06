#!/usr/bin/env node
/**
 * `klodi-openclaw-register` — the headless, agent-free registration entry.
 *
 * The TS analogue of rust `run_register` (packages/klodi-rust-host/src/
 * register.rs): a blocking mint → print authorize URL → poll → persist → exit
 * flow, driven by `KLODI_API_URL` / `KLODI_HOME`. It composes the PluginAPI-free
 * core (lib/register-core.ts) and NEVER dials NATS, arms the wake pump, or
 * touches PluginAPI — a short-lived boot process must not arm a JetStream
 * consumer (ADR-0015). Registration *provisions* creds/config/CA to disk; the
 * plugin, loaded later in the host, *connects*.
 *
 * Contracts (see docs/specs/hosts + ADR-0022):
 *   - STDOUT is the machine contract: the exact `${api_url}/authorize?session=`
 *     `<S>` (api_url trailing-slash-trimmed) is the ONLY thing written there, on
 *     its own line, undecorated — so a boot script can grep it while diagnostics
 *     stream. Every notice / completion / error / transient goes to STDERR.
 *   - Exit code is a boot-orchestration contract: 0 ⟺ usable creds are on disk
 *     (fresh completion OR idempotent short-circuit); non-zero ⟺ nothing usable
 *     was provisioned this run. A boot script gates plugin-load on it.
 *   - Idempotent short-circuit: valid creds + no `--force` ⟹ reuse notice
 *     (STDERR), exit 0, ZERO network — container restarts must not churn the
 *     marketplace `sessions` row.
 *   - `--force` is the operator-side repair primitive (rust's `--force-register`
 *     analogue): the plugin's in-agent `klodi_setup_repair` can't run headlessly.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REGISTER_POLL_CEILING_SECONDS,
  REGISTER_POLL_INTERVAL_SECONDS,
} from "@klodi/tool-catalog";

import {
  claimRegisterSession,
  type CoreClaimResult,
  type CoreLogger,
} from "../lib/register-core.js";
import { loadConfig } from "../lib/config.js";
import { getApiUrl, getCredsPath } from "../lib/paths.js";

const POLL_INTERVAL_MS = REGISTER_POLL_INTERVAL_SECONDS * 1_000;
const POLL_MAX_MS = REGISTER_POLL_CEILING_SECONDS * 1_000;

const EXIT_OK = 0;
const EXIT_FAILED = 1;

/** Every diagnostic goes to STDERR — STDOUT is reserved for the authorize URL. */
function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Structured-log seam handed to the core: keeps its diagnostics on STDERR. */
const STDERR_LOGGER: CoreLogger = {
  info: (event, fields) => note(formatLog(event, fields)),
  warn: (event, fields) => note(formatLog(event, fields)),
};

function formatLog(event: string, fields?: Record<string, unknown>): string {
  const suffix =
    fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  return `${event}${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The handle of an already-registered install, or `null`. Mirrors rust
 * `existing_creds_handle`: non-empty `nats.creds` AND a `config.json` that
 * parses with populated `handle` + `user_id`. A malformed / partial config
 * reads as "not registered" so a broken prior run doesn't wedge the short
 * circuit.
 */
function existingHandle(): string | null {
  const credsPath = getCredsPath();
  if (!existsSync(credsPath) || statSync(credsPath).size === 0) return null;
  try {
    const config = loadConfig();
    if (config.handle.length > 0 && config.user_id.length > 0) {
      return config.handle;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Run the headless registration flow. `argv` is the flag list (`process.argv`
 * minus node + script). Returns the process exit code. Exported as the testable
 * seam — importing this module must NOT execute the flow (see the entry guard).
 */
export async function runRegisterCli(argv: string[]): Promise<number> {
  const force = argv.includes("--force");
  if (!force) {
    const handle = existingHandle();
    if (handle !== null) {
      note(
        `Reusing existing klodi credentials (@${handle}).`
        + " Pass --force to re-register.",
      );
      return EXIT_OK;
    }
  }

  const apiUrl = getApiUrl().replace(/\/+$/, "");
  const sessionId = crypto.randomUUID();
  // The ONE stdout line: the machine-greppable authorize URL, undecorated.
  process.stdout.write(`${apiUrl}/authorize?session=${sessionId}\n`);
  note(
    `Polling for registration completion (every ${REGISTER_POLL_INTERVAL_SECONDS}s,`
    + ` up to ${POLL_MAX_MS / 60_000} min)…`,
  );

  return pollToCompletion(sessionId);
}

async function pollToCompletion(sessionId: string): Promise<number> {
  let timedOut = false;
  // A fake-timer-safe deadline: a flag flipped by a real setTimeout, so the
  // loop terminates whether or not the test harness fakes Date.
  const deadline = setTimeout(() => {
    timedOut = true;
  }, POLL_MAX_MS);
  try {
    while (!timedOut) {
      const result = await claimRegisterSession(sessionId, STDERR_LOGGER);
      const exit = terminalExit(result);
      if (exit !== null) return exit;
      await sleep(POLL_INTERVAL_MS);
    }
    note(
      "Registration timed out — re-run klodi-openclaw-register to start a"
      + " new session.",
    );
    return EXIT_FAILED;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Map a claim result to an exit code, emitting the human-facing line to STDERR.
 * Returns `null` for the non-terminal kinds (`pending` / `http_error` /
 * `transport_error`) so the caller keeps polling — matching how the plugin
 * poller treats a transient poll.
 */
function terminalExit(result: CoreClaimResult): number | null {
  switch (result.kind) {
    case "registered":
      note(`Registration complete — welcome, @${result.handle}.`);
      return EXIT_OK;
    case "expired":
      note(
        "Registration link expired before you completed it — re-run"
        + " klodi-openclaw-register.",
      );
      return EXIT_FAILED;
    case "already_claimed":
      note(
        "Registration session was already claimed on another device — re-run"
        + " klodi-openclaw-register.",
      );
      return EXIT_FAILED;
    case "invalid_response":
      note(`Registration failed: ${result.message}`);
      return EXIT_FAILED;
    case "pending":
      return null;
    case "http_error":
      note(`Transient poll error: HTTP ${result.status} ${result.statusText}.`);
      return null;
    case "transport_error":
      note(`Transient poll error: ${result.message}.`);
      return null;
  }
}

/**
 * True only when this module is the process entry point (invoked as the bin),
 * NOT when imported. `realpathSync` resolves the `node_modules/.bin` symlink to
 * the real file so invocation via the linked name still matches.
 */
function invokedAsBinary(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsBinary()) {
  runRegisterCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      note(`klodi-openclaw-register: ${String(err)}`);
      process.exit(EXIT_FAILED);
    },
  );
}
