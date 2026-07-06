/**
 * RED — CA resolution consults the persisted register-response CA (ts).
 *
 * `resolveTlsCa(klodiHome)` gains a NEW level-2 step between the env override
 * and the bundled constant, byte-for-byte with py/rs:
 *   1. KLODI_NATS_CA_FILE env — explicit override; short-circuits (persisted
 *      file not even read when set).
 *   2. ${KLODI_HOME}/nats-ca.pem — persisted register CA. NEW.
 *   3. bundled KLODI_NATS_CA_PEM — static fallback.
 *   4. system trust store (undefined) — verify-ON final fallback.
 *
 * These are unit tests at the resolver's string boundary — `resolveTlsCa`
 * returns the PEM *text* to hand Node's verifying `tls.connect({ tls: { ca } })`
 * (it never validates the bytes; a malformed CA fails closed at connect, which
 * the gated integration proves). We assert *which source* wins and that a bad
 * persisted CA reaches the verifying layer rather than being silently dropped.
 *
 * RED drivers: env-unset→persisted-consulted, malformed-returned-verbatim,
 * present-but-unreadable→CaTrustError. Guards (must stay green): env-wins,
 * short-circuit-no-read, no-source→undefined, manual-host-unchanged.
 *
 * QA-owned. NEVER weaken — push failures back to the expert-developer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CaTrustError, resolveTlsCa } from "../src/tls.js";

const CA_FILE_ENV = "KLODI_NATS_CA_FILE";

// PEM-*shaped* fixtures — distinct content is all the string-level resolver
// needs (it does not parse the bytes).
const ENV_CA = "-----BEGIN CERTIFICATE-----\nENVCAFIXTUREBODY\n-----END CERTIFICATE-----\n";
const REG_CA = "-----BEGIN CERTIFICATE-----\nREGCAFIXTUREBODY\n-----END CERTIFICATE-----\n";
const MALFORMED = "-----BEGIN CERTIFICATE-----\nnot-valid-base64-garbage\n-----END CERTIFICATE-----\n";

let home: string;
let prevEnv: string | undefined;

/** The well-known persisted-CA location the resolver must consult. */
function persistedPath(h: string): string {
  return join(h, "nats-ca.pem");
}

function writePersisted(content: string): void {
  writeFileSync(persistedPath(home), content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "klodi-nats-ca-resolve-"));
  prevEnv = process.env[CA_FILE_ENV];
  delete process.env[CA_FILE_ENV];
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[CA_FILE_ENV];
  else process.env[CA_FILE_ENV] = prevEnv;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTlsCa — persisted register CA (level 2)", () => {
  // ── Scenario 2 — explicit operator config wins ──────────────────────────
  it("[guard] env override wins over a persisted register CA", () => {
    const envFile = join(home, "env-ca.pem");
    writeFileSync(envFile, ENV_CA);
    writePersisted(REG_CA);
    process.env[CA_FILE_ENV] = envFile;

    expect(resolveTlsCa(home).ca).toBe(ENV_CA);
  });

  it("[guard] env override short-circuits — the persisted file is not even read", () => {
    const envFile = join(home, "env-ca.pem");
    writeFileSync(envFile, ENV_CA);
    // A directory at the persisted path would throw EISDIR *if read*.
    mkdirSync(persistedPath(home));
    process.env[CA_FILE_ENV] = envFile;

    // Must not throw and must return the env CA — proves no read/diff of the
    // persisted file (strict precedence, no divergence I/O). Open questions #3.
    expect(resolveTlsCa(home).ca).toBe(ENV_CA);
  });

  // ── Scenario 1 — auto-trust the persisted register CA ───────────────────
  it("[RED] returns the persisted register CA when no env override is set", () => {
    writePersisted(REG_CA);

    expect(resolveTlsCa(home).ca).toBe(REG_CA);
  });

  // ── Scenario 3 — no regression ──────────────────────────────────────────
  it("[guard] no env + no persisted + empty bundle → undefined (system store)", () => {
    expect(resolveTlsCa(home).ca).toBeUndefined();
  });

  it("[guard] manual-CA host with a response that omits nats_ca is unchanged", () => {
    const envFile = join(home, "env-ca.pem");
    writeFileSync(envFile, ENV_CA);
    process.env[CA_FILE_ENV] = envFile; // manual override, nothing persisted

    expect(resolveTlsCa(home).ca).toBe(ENV_CA);
  });

  // ── Boundary / error paths ──────────────────────────────────────────────
  it("[RED] a malformed persisted CA is returned verbatim (reaches the verifying layer)", () => {
    // resolveTlsCa never falls back to undefined/system-store on a bad
    // persisted CA — it hands the bytes to Node's verifying context so the
    // handshake fails CLOSED. Never loosens verification to compensate.
    writePersisted(MALFORMED);

    expect(resolveTlsCa(home).ca).toBe(MALFORMED);
  });

  it("[RED] a present-but-unreadable persisted CA fails closed (CaTrustError)", () => {
    // A directory at the path forces a read failure. It must fail CLOSED, not
    // fall through to the bundled/system store.
    mkdirSync(persistedPath(home));

    expect(() => resolveTlsCa(home)).toThrow(CaTrustError);
  });
});
