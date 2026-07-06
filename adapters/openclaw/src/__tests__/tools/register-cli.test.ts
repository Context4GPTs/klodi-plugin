/**
 * RED — the headless register CLI (src/bin/register.ts → dist/bin/register.js).
 *
 * The TS analogue of rust `run_register`: a blocking mint → print URL → poll →
 * persist → exit entry, agent-free, driven by KLODI_API_URL / KLODI_HOME. It
 * composes the PluginAPI-free core (register-core.ts) — it NEVER dials NATS,
 * arms the wake pump, or touches PluginAPI (this file deliberately does NOT
 * mock lib/client.js or service/wake-pump.js; if the bin reaches into either,
 * the test surfaces it rather than hiding it).
 *
 * TESTABLE SEAM (this is the spec): the module exports
 *   `runRegisterCli(argv: string[]): Promise<number>`
 * where `argv` is the flag list (e.g. `[]` or `["--force"]`) and the return
 * value is the process exit code. The module's entry guard runs
 * `process.exit(await runRegisterCli(process.argv.slice(2)))` ONLY when
 * invoked directly — importing the module must NOT execute the flow (else it
 * would call process.exit and kill the test worker).
 *
 * Contracts asserted:
 *   - Idempotent short-circuit: existing valid creds + no --force ⟹ prints a
 *     reuse notice to STDERR, exits 0, and makes ZERO network calls.
 *   - --force runs the full mint → poll → persist flow (network happens).
 *   - stdout/stderr split (product hard contract): the EXACT
 *     `${api_url}/authorize?session=<S>` (api_url trailing-slash-trimmed) is
 *     the ONLY thing on stdout, on its own line, undecorated. Every diagnostic
 *     / notice / completion / error line goes to stderr.
 *   - Exit-code boot contract: registered / short-circuit ⟹ 0;
 *     expired / already_claimed / invalid_response / timeout ⟹ non-zero.
 *   - invalid_response (non-tls nats_url) writes NO creds.
 *   - transient http_error is non-terminal: the loop keeps polling.
 *
 * QA-owned (adversarial-testing). NEVER weaken. Do NOT collapse the
 * stdout/stderr split, and do NOT turn a failed provision into exit 0 — the
 * exit code is what a boot script gates plugin-load on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, chmodSync } from "node:fs";

import {
  REGISTER_POLL_INTERVAL_SECONDS,
  REGISTER_POLL_CEILING_SECONDS,
} from "@klodi/tool-catalog";
import { runRegisterCli } from "../../bin/register.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { getCredsPath } from "../../lib/paths.js";
import { writeConfig } from "../../lib/config.js";

const API_URL = "https://klodi.test";
const AUTHORIZE_RE = /^https:\/\/klodi\.test\/authorize\?session=[0-9a-f-]{36}$/;
const COMPLETED_PAYLOAD = {
  status: "completed",
  nats_creds: "creds-bytes",
  handle: "newuser",
  user_id: "uid-new",
  nkey_public: "NKEY",
  nats_url: "tls://hayabusa.proxy.rlwy.net:32770",
};

let temp: TempHome;
let stdoutChunks: string[];
let stderrChunks: string[];
let savedApiUrl: string | undefined;

function stdout(): string {
  return stdoutChunks.join("");
}
function stderr(): string {
  return stderrChunks.join("");
}

function captureStd(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function withCreds(): void {
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester",
    user_id: "uid-1",
    nkey_public: "NKEY",
    nats_url: "tls://hayabusa.proxy.rlwy.net:32770",
  });
}

beforeEach(() => {
  temp = createTempHome();
  stdoutChunks = [];
  stderrChunks = [];
  savedApiUrl = process.env["KLODI_API_URL"];
  process.env["KLODI_API_URL"] = API_URL;
  captureStd();
});

afterEach(() => {
  temp.cleanup();
  if (savedApiUrl === undefined) delete process.env["KLODI_API_URL"];
  else process.env["KLODI_API_URL"] = savedApiUrl;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("register CLI — idempotent short-circuit", () => {
  it("existing creds + no --force ⟹ reuse notice on STDERR, exit 0, ZERO network", async () => {
    withCreds();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const code = await runRegisterCli([]);

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Reuse notice is a diagnostic → stderr, never stdout.
    expect(stderr()).toMatch(/reusing/i);
    expect(stdout()).not.toMatch(/authorize/);
    expect(stdout().trim()).toBe("");
  });
});

describe("register CLI — --force full flow + stdout/stderr split", () => {
  it("--force mints, prints ONLY the authorize URL to stdout, completes with exit 0", async () => {
    withCreds(); // creds exist, but --force ignores the short-circuit
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, COMPLETED_PAYLOAD),
    );

    const code = await runRegisterCli(["--force"]);

    expect(code).toBe(0);

    // stdout: exactly ONE line, the undecorated authorize URL, nothing else.
    const outLines = stdout().trim().split("\n");
    expect(outLines).toHaveLength(1);
    expect(outLines[0]).toMatch(AUTHORIZE_RE);

    // The completion line is a diagnostic → stderr, not stdout.
    expect(stdout()).not.toMatch(/welcome|complete/i);
    expect(stderr()).toMatch(/welcome|complete/i);
    expect(stderr()).toMatch(/newuser/);
  });

  it("trims a trailing slash on api_url so the URL has exactly one slash", async () => {
    process.env["KLODI_API_URL"] = "https://klodi.test/"; // trailing slash
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, COMPLETED_PAYLOAD),
    );

    const code = await runRegisterCli(["--force"]);

    expect(code).toBe(0);
    const line = stdout().trim();
    expect(line).toMatch(AUTHORIZE_RE); // https://klodi.test/authorize?... — single slash
    expect(line).not.toContain("test//authorize");
  });
});

describe("register CLI — terminal exit codes", () => {
  it("expired ⟹ non-zero exit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, { status: "expired" }),
    );
    expect(await runRegisterCli(["--force"])).not.toBe(0);
  });

  it("already_claimed ⟹ non-zero exit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(409, { error: "CREDENTIALS_ALREADY_CLAIMED" }),
    );
    expect(await runRegisterCli(["--force"])).not.toBe(0);
  });

  it("invalid_response (non-tls nats_url) ⟹ non-zero exit, NO creds written", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, {
        ...COMPLETED_PAYLOAD,
        nats_url: "ws://attacker.example.com:4222",
      }),
    );
    const code = await runRegisterCli(["--force"]);
    expect(code).not.toBe(0);
    expect(existsSync(getCredsPath())).toBe(false);
  });

  it("times out with a non-zero exit when the session never completes", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fakeResponse(200, { status: "pending" }),
    );

    const pending = runRegisterCli(["--force"]);
    await vi.advanceTimersByTimeAsync(
      (REGISTER_POLL_CEILING_SECONDS + REGISTER_POLL_INTERVAL_SECONDS + 1) * 1000,
    );
    const code = await pending;

    expect(code).not.toBe(0);
  });
});

describe("register CLI — transient errors are non-terminal", () => {
  it("keeps polling past a 500, then completes with exit 0", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(fakeResponse(500, { error: "internal" }))
      .mockResolvedValueOnce(fakeResponse(200, COMPLETED_PAYLOAD));

    const pending = runRegisterCli(["--force"]);
    await vi.advanceTimersByTimeAsync(
      (REGISTER_POLL_INTERVAL_SECONDS * 2 + 1) * 1000,
    );
    const code = await pending;

    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(getCredsPath())).toBe(true);
  });
});
