/**
 * Catalog-request/reply ↔ registered-by-name symmetry gate (the THIRD axis).
 *
 * The contract (from Discovery — DO NOT relitigate in this test):
 *   Every request/reply catalog key (`Object.keys(klodiTools)` in
 *   packages/tool-catalog/src/index.ts) MUST be registered under that same
 *   name by the in_agent (openclaw) adapter — i.e. it must appear as a static
 *   `name:` string literal inside an `api.registerTool({…})` block in
 *   adapters/openclaw/src/tools/*.ts. Set EQUALITY on the catalog side:
 *   every klodiTools key has a matching openclaw registration; no klodiTools
 *   key is left as a catalog-only ghost.
 *
 *   This is a DISTINCT axis from the two PR #16 closed (ADR-0014):
 *     - check-openclaw-manifest-tools.sh: manifest ↔ registered  (is-declared)
 *     - check-adapter-tools.sh:           referenced ⊆ catalog    (should-be-registered)
 *   Neither reads `klodiTools` to assert a request/reply key is *registered by
 *   its own name on the gateway*. A `klodiTools` entry consumed only as a
 *   `.subject` (never as a `registerTool` name) — exactly the
 *   `klodi_searches_delete` ghost being removed — is invisible to both.
 *   This gate closes that third axis: a future catalog-only ghost fails CI.
 *
 *   The compared set is the CATALOG side, not the registered side. The openclaw
 *   `name:` literals legitimately ALSO include LOCAL-tool names (klodi_unwatch,
 *   klodi_watch, klodi_health, klodi_register, klodi_setup_*, klodi_match_feedback,
 *   klodi_channel_message) that are intentionally NOT 1:1 request/reply catalog
 *   keys. Those must NOT be flagged — the gate intersects on `Object.keys(klodiTools)`,
 *   so a registered local tool that is not a request/reply key is simply ignored.
 *   The only failure is a request/reply catalog key with no registration.
 *
 * The gate's in-repo run surface is this vitest test, which shells out to
 *   scripts/check-catalog-registered.sh
 * (mirroring how openclaw-manifest-symmetry.test.ts shells out to
 * check-openclaw-manifest-tools.sh). There is no .github/, no pre-commit, no
 * runner — the test IS the gate.
 *
 * RED-first: scripts/check-catalog-registered.sh does not exist yet, AND the
 * real catalog still declares the `klodi_searches_delete` ghost. So:
 *   - the real-tree case is RED twice over (no script; and once the script
 *     exists, the still-present ghost keeps it RED) until the DROP lands;
 *   - the fixture/noise cases are RED only because the script is missing.
 * The correct GREEN is the expert-developer (1) dropping `klodi_searches_delete`
 * from `klodiTools` and (2) writing the gate script.
 *
 * CONTRACT THE GATE SCRIPT MUST HONOR (env-var overrides this test drives):
 *   - CATALOG_SRC    — absolute path to the index.ts whose `klodiTools` object
 *                      literal the gate extracts request/reply keys from.
 *                      Defaults to packages/tool-catalog/src/index.ts.
 *   - TOOLS_SRC_DIR  — absolute path to a directory whose *.ts files the gate
 *                      greps for `name:` literals inside `registerTool({…})`
 *                      blocks. Defaults to adapters/openclaw/src/tools.
 *   The gate exits 0 iff every request/reply catalog key is registered under
 *   the same name; on any catalog key with no registration it exits non-zero
 *   and names the offending catalog key to stderr.
 *
 * Per the adversarial-testing skill: NEVER weaken these asserts to make a
 * broken gate pass. If the gate fails a case, the gate (or the catalog) is
 * wrong — fix the implementation, not the test.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const GATE = join(REPO_ROOT, "scripts", "check-catalog-registered.sh");
const REAL_CATALOG_SRC = join(PACKAGE_ROOT, "src", "index.ts");
const REAL_TOOLS_SRC = join(REPO_ROOT, "adapters", "openclaw", "src", "tools");

/**
 * The lone request/reply catalog key with no openclaw registration — the ghost
 * removed here. After the DROP it is gone from `klodiTools`, so the
 * real-tree case below goes GREEN.
 */
const GHOST = "klodi_searches_delete";

/**
 * A few openclaw-registered LOCAL-tool names that are intentionally NOT
 * request/reply catalog keys. The gate must NEVER flag these as offenders —
 * they exist on the registered side by design and are simply not in the
 * compared (catalog) set. Used by the adversarial noise case.
 */
const LOCAL_ONLY_REGISTERED: ReadonlyArray<string> = [
  "klodi_unwatch",
  "klodi_watch",
  "klodi_health",
];

interface GateRun {
  code: number;
  out: string;
}

/**
 * Build a minimal index.ts fixture exporting a `klodiTools` object literal with
 * exactly `keys` as request/reply tool keys. The gate must extract keys from
 * the `klodiTools` object regardless of the per-tool body, so each key gets a
 * trivial body. Noise lines (a non-klodiTools const, a stray `klodi_*:` field
 * deep in a body) probe that extraction is scoped to top-level klodiTools keys.
 */
function writeCatalogFixture(dir: string, keys: ReadonlyArray<string>): string {
  const path = join(dir, "index.ts");
  const entries = keys
    .map(
      (k) =>
        `  ${k}: {\n`
        + `    subject: "p2p.v1.${k}",\n`
        + `    description: "fixture",\n`
        + `    params: Type.Object({}),\n`
        + `    result: Type.Object({ ok: Type.Boolean() }),\n`
        + `  },`,
    )
    .join("\n");
  writeFileSync(
    path,
    [
      'import { Type } from "@sinclair/typebox";',
      "",
      "export const klodiTools = {",
      entries,
      "} as const;",
      "",
      "// noise: a non-klodiTools const that must NOT contribute keys.",
      "export const KLODI_CATALOG_CONSTANTS = {",
      '  klodi_default_api_url: "https://example",',
      "} as const;",
      "",
    ].join("\n"),
  );
  return path;
}

/**
 * Run the gate, capturing exit code + combined stdout/stderr. Env overrides
 * (CATALOG_SRC / TOOLS_SRC_DIR) let each case point the gate at fixtures
 * without touching the real catalog or source tree.
 */
function runGate(env: Record<string, string> = {}): GateRun {
  try {
    const out = execFileSync("bash", [GATE], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    const out =
      (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { code: err.status ?? 1, out };
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "catalog-registered-symmetry-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("catalog-request/reply ↔ registered-by-name symmetry gate", () => {
  it("[integration] exits 0 against the real (post-drop) tree: every request/reply catalog key is registered under its own name by openclaw", () => {
    // No env overrides — runs against the real catalog + real src/tools.
    // GREEN requires the expert to have DROPPED klodi_searches_delete from
    // klodiTools. While the ghost is still declared, the gate must stay RED
    // (it is the lone catalog key with no openclaw registration).
    const { code, out } = runGate();
    expect(
      code,
      "gate should exit 0 when every request/reply klodiTools key has a"
        + " matching openclaw registerTool({name:…}) literal — non-zero means"
        + ` a catalog key (today: ${GHOST}) is a registered-by-name ghost, or`
        + " the gate is wrong. Gate output:\n"
        + out,
    ).toBe(0);
  });

  it("[integration] exits non-zero naming the offending catalog key when a klodiTools key has no openclaw registration (the ghost class)", () => {
    // A catalog fixture declaring a phantom request/reply key that no openclaw
    // src file registers, pointed at the REAL openclaw tools dir. The phantom
    // key has no registration → the gate must FAIL and name it. This is the
    // exact class PR #16's manifest↔registered axis could not see.
    const phantom = "klodi_phantom_unregistered";
    const catalog = writeCatalogFixture(tmp, [
      "klodi_search",
      "klodi_whoami",
      phantom,
    ]);
    const { code, out } = runGate({
      CATALOG_SRC: catalog,
      TOOLS_SRC_DIR: REAL_TOOLS_SRC,
    });

    expect(
      code,
      "gate must FAIL when a request/reply catalog key has no openclaw"
        + ` registration (${phantom}). A gate blind to the catalog axis would`
        + " pass here. Gate output:\n" + out,
    ).not.toBe(0);

    expect(
      out,
      `gate must name the unregistered catalog key ${phantom}.`
        + ` Gate output:\n${out}`,
    ).toContain(phantom);

    // The two genuinely-registered keys must NOT be flagged as offenders.
    for (const ok of ["klodi_search", "klodi_whoami"]) {
      expect(
        out,
        `gate must NOT name correctly-registered catalog key ${ok} as an`
          + ` offender. Gate over-reported. Gate output:\n${out}`,
      ).not.toMatch(new RegExp(`\\b${ok}\\b`));
    }
  });

  it("[integration][adversarial] openclaw local-tool registrations that are NOT request/reply catalog keys do not leak in — no false drift", () => {
    // The real openclaw tools dir registers LOCAL tools (klodi_unwatch,
    // klodi_watch, klodi_health, klodi_register, klodi_setup_*, …) whose names
    // are intentionally NOT request/reply catalog keys. A catalog fixture
    // listing ONLY two real request/reply keys must still pass: the gate
    // compares on the CATALOG side, so the extra registered local-tool names
    // are simply not in scope. If the gate instead compared on the registered
    // side (or set EQUALITY both directions), it would falsely flag every
    // local tool as "registered but not in catalog" and this case would fail.
    const catalog = writeCatalogFixture(tmp, ["klodi_search", "klodi_whoami"]);
    const { code, out } = runGate({
      CATALOG_SRC: catalog,
      TOOLS_SRC_DIR: REAL_TOOLS_SRC,
    });

    expect(
      code,
      "gate must exit 0: both catalog keys (klodi_search, klodi_whoami) are"
        + " registered by openclaw. The many additional openclaw local-tool"
        + " registrations (klodi_unwatch, klodi_watch, …) are NOT request/reply"
        + " catalog keys and must NOT be flagged — the gate compares on the"
        + " catalog side. A non-zero exit means the gate over-reports the"
        + " registered side. Gate output:\n" + out,
    ).toBe(0);

    // No local-only registered name may surface as an offender.
    for (const local of LOCAL_ONLY_REGISTERED) {
      expect(
        out,
        `local-tool registration ${local} leaked into the gate's compared set`
          + ` — it is not a request/reply catalog key and must be ignored.`
          + ` Gate output:\n${out}`,
      ).not.toMatch(new RegExp(`\\b${local}\\b`));
    }
  });

  it("[integration][adversarial] non-tool klodi_* tokens in the openclaw src are excluded by construction — no false drift", () => {
    // A catalog fixture with exactly one request/reply key (klodi_register —
    // which the noisy src DOES register), pointed at a fixture openclaw src dir
    // riddled with non-tool klodi_* tokens that a naive klodi_* scan would
    // falsely pick up. A correct gate (extraction scoped to name: inside
    // registerTool({…}), comparison scoped to the catalog key) sees the one
    // catalog key as registered and exits 0. NOTE: klodi_register is a LOCAL
    // tool in the real catalog, but here it is the fixture's sole request/reply
    // key purely to exercise extraction scoping in isolation.
    const toolsDir = join(tmp, "src-tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(
      join(toolsDir, "noisy.ts"),
      [
        "export function registerNoisy(api) {",
        '  api.logger.info("klodi_plugin_loaded", {',
        "    klodi_home: getKlodiHome(),",
        "    klodi_home_source: getKlodiHomeSource(),",
        "  });",
        "  api.registerTool({",
        '    name: "klodi_register",',
        '    label: "Register",',
        "    async execute() {",
        "      return jsonResult({ klodi_home: getKlodiHome() });",
        "    },",
        "  });",
        "  // a stray non-registerTool object also carrying a name: field",
        '  const config = { name: "klodi_not_a_tool", kind: "config" };',
        "  void config;",
        "}",
        "",
      ].join("\n"),
    );

    const catalog = writeCatalogFixture(tmp, ["klodi_register"]);
    const { code, out } = runGate({
      CATALOG_SRC: catalog,
      TOOLS_SRC_DIR: toolsDir,
    });

    expect(
      code,
      "gate must exit 0: the sole catalog key klodi_register is registered via"
        + " the registerTool block. Non-tool klodi_* tokens (klodi_plugin_loaded,"
        + " klodi_home, klodi_home_source, klodi_not_a_tool) must NOT be treated"
        + " as registrations. A non-zero exit means extraction is not scoped to"
        + " name: inside registerTool({…}). Gate output:\n" + out,
    ).toBe(0);

    for (const noise of [
      "klodi_plugin_loaded",
      "klodi_home",
      "klodi_home_source",
      "klodi_not_a_tool",
    ]) {
      expect(
        out,
        `non-tool token ${noise} surfaced in the gate output — extraction is`
          + ` not scoped to name: inside registerTool({…}). Gate output:\n${out}`,
      ).not.toContain(noise);
    }
  });
});
