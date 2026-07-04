/**
 * RED — persist the register-response CA to ${KLODI_HOME}/nats-ca.pem (ts).
 *
 * Card: auto-trust-nats-ca-from-register.
 *
 * Two shared helpers land in `nats-client-ts/src/tls.ts`:
 *   - `natsCaPath(klodiHome)`  — the single filename source (nats-ca.pem).
 *   - `persistNatsCa(klodiHome, pem)` — atomic write, mode 0644 (non-secret
 *     cert per ADR-0022, unlike the 0600 nkey creds). A non-PEM-shaped or empty
 *     value is SKIPPED (never written, never throws). Last-write wins → the
 *     re-register CA-rotation path.
 *
 * RED today: neither helper exists.
 * QA-owned. NEVER weaken.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { natsCaPath, persistNatsCa } from "../src/tls.js";

const PEM_A = "-----BEGIN CERTIFICATE-----\nMIICAlphaFixtureBody\n-----END CERTIFICATE-----\n";
const PEM_B = "-----BEGIN CERTIFICATE-----\nMIICBetaRotatedBody\n-----END CERTIFICATE-----\n";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "klodi-nats-ca-persist-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("persistNatsCa + natsCaPath", () => {
  it("natsCaPath resolves to ${KLODI_HOME}/nats-ca.pem", () => {
    expect(natsCaPath(home)).toBe(join(home, "nats-ca.pem"));
  });

  it("writes a PEM-shaped CA verbatim to the well-known path", () => {
    persistNatsCa(home, PEM_A);

    expect(existsSync(natsCaPath(home))).toBe(true);
    expect(readFileSync(natsCaPath(home), "utf-8")).toBe(PEM_A);
  });

  it("persists the CA world-readable 0644 (non-secret cert)", () => {
    persistNatsCa(home, PEM_A);

    const mode = statSync(natsCaPath(home)).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("skips a non-PEM-shaped value without writing or throwing", () => {
    expect(() => persistNatsCa(home, "not a certificate")).not.toThrow();
    expect(existsSync(natsCaPath(home))).toBe(false);
  });

  it("skips an empty value without writing", () => {
    persistNatsCa(home, "");
    expect(existsSync(natsCaPath(home))).toBe(false);
  });

  it("overwrites on rotation (last-write wins)", () => {
    persistNatsCa(home, PEM_A);
    persistNatsCa(home, PEM_B);

    expect(readFileSync(natsCaPath(home), "utf-8")).toBe(PEM_B);
  });
});
