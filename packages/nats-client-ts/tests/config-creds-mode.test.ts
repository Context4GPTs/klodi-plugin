/**
 * Unit tests for the lenient creds-mode rule (D2 / P1-6).
 *
 * `loadCreds` warns when group or world bits are set on the creds
 * file but never refuses to load — surfacing a permissions decision
 * is the host plugin's call. Both `0o600` (documented baseline) and
 * `0o400` (stricter; read-only owner) pass without warning.
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadCreds } from "../src/config.js";

let tmp: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "klodi-creds-mode-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function writeCredsAt(mode: number): string {
  const path = join(tmp, "nats.creds");
  writeFileSync(path, "-----BEGIN NATS USER JWT-----\nfoo\n", "utf-8");
  chmodSync(path, mode);
  return path;
}

describe("loadCreds permission check", () => {
  it("loads silently at the documented 0o600 baseline", () => {
    const path = writeCredsAt(0o600);
    const bytes = loadCreds(path);
    expect(bytes.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads silently at stricter 0o400 (no warning)", () => {
    const path = writeCredsAt(0o400);
    const bytes = loadCreds(path);
    expect(bytes.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when group bits are set (0o640)", () => {
    const path = writeCredsAt(0o640);
    loadCreds(path);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(path);
  });

  it("warns when world bits are set (0o604)", () => {
    const path = writeCredsAt(0o604);
    loadCreds(path);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns when permissions are wide open (0o644)", () => {
    const path = writeCredsAt(0o644);
    loadCreds(path);
    expect(warn).toHaveBeenCalledOnce();
  });
});
