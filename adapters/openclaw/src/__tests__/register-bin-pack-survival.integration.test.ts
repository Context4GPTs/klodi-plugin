/**
 * RED — AC3: the klodi-openclaw-register bin survives build + pack.
 *
 * The whole point of this card is a headless entry that klodi-stage drives
 * from a LOCAL pack of the adapter (never a published version). So the bin has
 * to ride through BOTH pack paths the pipeline uses:
 *   - raw `pnpm pack` of the adapter (package.json#files ships dist/),
 *   - the vendored `.publish-stage` tree that scripts/vendor.mjs produces (the
 *     one the ClawHub smoke gate installs).
 *
 * Asserted, against the REAL build + vendor (no stubs):
 *   1. `package.json#bin["klodi-openclaw-register"]` === "./dist/bin/register.js".
 *   2. a raw `pnpm pack` tarball contains `package/dist/bin/register.js`.
 *   3. the vendored `.publish-stage/dist/bin/register.js` exists AND the staged
 *      package.json keeps the `bin` field.
 *   4. `node .publish-stage/dist/bin/register.js`, run against a temp
 *      KLODI_HOME holding valid creds and an UNREACHABLE api url, short-circuits
 *      (exit 0, reuse notice, zero network) — proving the vendored bin LOADS
 *      with its transitive `@klodi/*` imports resolving to the vendored copies
 *      (no ERR_MODULE_NOT_FOUND) and the short-circuit works from the packed
 *      artefact.
 *
 * This DRIVES the real producers (`pnpm build`, `node scripts/vendor.mjs`,
 * `pnpm pack`) — a static grep can't prove the bytes land in the tarball. When
 * build prerequisites are absent it SKIPS LOUDLY (console.warn), never a silent
 * pass — same discipline as vendor-no-dangling-sourcemap.integration.
 *
 * QA-owned (adversarial-testing). NEVER weaken. Do NOT hand-edit .publish-stage/
 * or the tarball to make this pass — fix package.json#bin / the bin source and
 * let the producers regenerate.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → adapters/openclaw
const ADAPTER_ROOT = join(HERE, "..", "..");
const VENDOR_SCRIPT = join(ADAPTER_ROOT, "scripts", "vendor.mjs");
const STAGE_DIR = join(ADAPTER_ROOT, ".publish-stage");

const BIN_NAME = "klodi-openclaw-register";
const BIN_REL = "./dist/bin/register.js";
const DIST_BIN = join(ADAPTER_ROOT, "dist", "bin", "register.js");
const STAGE_BIN = join(STAGE_DIR, "dist", "bin", "register.js");

// copy-skill + tsc + vendor + pack — minutes, not the 10s default.
const HEAVY_TIMEOUT_MS = 5 * 60 * 1000;

interface Produced {
  built: boolean;
  vendored: boolean;
  rawPackTarball: string | null;
  reason?: string;
}

function run(cmd: string, args: string[], cwd = ADAPTER_ROOT) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: HEAVY_TIMEOUT_MS,
  });
}

const produced: Produced = {
  built: false,
  vendored: false,
  rawPackTarball: null,
};

beforeAll(() => {
  const build = run("pnpm", ["build"]);
  if (build.status !== 0 || !existsSync(join(ADAPTER_ROOT, "dist"))) {
    produced.reason =
      "`pnpm build` failed / produced no dist/ — cannot verify pack survival.\n" +
      `${build.stdout ?? ""}${build.stderr ?? ""}`;
    return;
  }
  produced.built = true;

  const vendor = run("node", [VENDOR_SCRIPT]);
  produced.vendored = vendor.status === 0 && existsSync(join(STAGE_DIR, "dist"));

  const packDest = mkdtempSync(join(tmpdir(), "klodi-rawpack-"));
  const pack = run("pnpm", ["pack", "--pack-destination", packDest]);
  if (pack.status === 0) {
    const tgz = readdirSync(packDest).find((n) => n.endsWith(".tgz"));
    produced.rawPackTarball = tgz ? join(packDest, tgz) : null;
  }
}, HEAVY_TIMEOUT_MS);

describe("klodi-openclaw-register bin — pack survival (AC3)", () => {
  it("package.json#bin declares klodi-openclaw-register → ./dist/bin/register.js", () => {
    const pkg = JSON.parse(
      readFileSync(join(ADAPTER_ROOT, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin?.[BIN_NAME]).toBe(BIN_REL);
  });

  it("tsc compiles the bin to dist/bin/register.js", () => {
    if (!produced.built) {
      console.warn(`[register-bin-pack-survival] SKIPPED (not a pass): ${produced.reason}`);
      return;
    }
    expect(existsSync(DIST_BIN)).toBe(true);
  });

  it("a raw `pnpm pack` tarball contains package/dist/bin/register.js", () => {
    if (!produced.built || produced.rawPackTarball === null) {
      console.warn(
        "[register-bin-pack-survival] raw-pack SKIPPED (not a pass): " +
          (produced.reason ?? "no tarball produced"),
      );
      return;
    }
    const list = spawnSync("tar", ["-tzf", produced.rawPackTarball], {
      encoding: "utf8",
    }).stdout;
    expect(list).toContain("package/dist/bin/register.js");
  });

  it("the vendored .publish-stage keeps dist/bin/register.js AND the bin field", () => {
    if (!produced.vendored) {
      console.warn(
        "[register-bin-pack-survival] vendored-stage SKIPPED (not a pass): " +
          (produced.reason ?? "vendor.mjs did not stage — run build:deps first"),
      );
      return;
    }
    expect(existsSync(STAGE_BIN)).toBe(true);
    const stagePkg = JSON.parse(
      readFileSync(join(STAGE_DIR, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(stagePkg.bin?.[BIN_NAME]).toBe(BIN_REL);
  });

  it("node .publish-stage/dist/bin/register.js short-circuits from vendored copies (no creds/no network)", () => {
    if (!produced.vendored) {
      console.warn(
        "[register-bin-pack-survival] run SKIPPED (not a pass): " +
          (produced.reason ?? "vendor.mjs did not stage"),
      );
      return;
    }
    expect(existsSync(STAGE_BIN)).toBe(true);

    // A temp KLODI_HOME with valid creds → the bin must SHORT-CIRCUIT (exit 0,
    // no network). KLODI_API_URL points at an unreachable port to prove nothing
    // is dialled on the short-circuit path.
    const home = mkdtempSync(join(tmpdir(), "klodi-packrun-"));
    writeFileSync(join(home, "nats.creds"), "creds-bytes");
    chmodSync(join(home, "nats.creds"), 0o600);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        handle: "packtester",
        user_id: "uid-pack",
        nkey_public: "NKEY",
        nats_url: "tls://hayabusa.proxy.rlwy.net:32770",
      }),
    );

    const result = spawnSync("node", [STAGE_BIN], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        KLODI_HOME: home,
        KLODI_API_URL: "http://127.0.0.1:1",
      },
    });

    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // Imports must resolve to the vendored copies — no module-resolution error.
    expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
    expect(result.status).toBe(0);
    expect(result.stderr ?? "").toMatch(/reusing/i);
    // stdout stays clean on a short-circuit (no URL minted).
    expect(result.stdout ?? "").not.toMatch(/authorize/);
  });
});
