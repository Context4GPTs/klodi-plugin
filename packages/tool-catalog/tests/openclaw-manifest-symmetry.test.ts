/**
 * Manifest↔registered symmetry gate for the openclaw adapter.
 *
 * Card: fix-openclaw-manifest-tool-drift-add-symmetry-gate.
 *
 * The contract (from Discovery — do NOT relitigate in this test):
 *   The "registered-tool set" is the set of static `name:` string literals
 *   inside `api.registerTool({…})` blocks in adapters/openclaw/src/tools/*.ts
 *   (35 today). NOT the @klodi/tool-catalog host_shape slice — that asserts a
 *   different contract (should-be-registered, not is-registered) and rests on a
 *   premise Discovery verified false (there are no dynamically-named tools in
 *   openclaw). The gate set-diffs that registered set against
 *   adapters/openclaw/openclaw.plugin.json `.contracts.tools` in BOTH
 *   directions and names offenders.
 *
 * The gate's in-repo run surface is this vitest test, which shells out to
 *   scripts/check-openclaw-manifest-tools.sh
 * (mirroring how match-feedback-additive.test.ts shells out to
 * check-adapter-tools.sh). There is no .github/, no pre-commit, no runner — the
 * test IS the gate.
 *
 * RED-first: scripts/check-openclaw-manifest-tools.sh does not exist yet, so
 * every case below fails. The correct GREEN is the expert-developer (1) adding
 * the three missing tools to the real manifest (32 → 35) and (2) writing the
 * gate script.
 *
 * CONTRACT THE GATE SCRIPT MUST HONOR (env-var overrides this test drives):
 *   - MANIFEST       — absolute path to the openclaw.plugin.json to read
 *                      `.contracts.tools` from. Defaults to the real manifest.
 *   - TOOLS_SRC_DIR  — absolute path to a directory whose *.ts files the gate
 *                      greps for `name:` literals inside `registerTool({…})`
 *                      blocks. Defaults to adapters/openclaw/src/tools.
 *   The gate exits 0 iff the two sets are equal; on any diff it exits non-zero
 *   and names the offending tool(s) (and direction) to stderr.
 *
 * Per the adversarial-testing skill: NEVER weaken these asserts to make a
 * broken gate pass. If the gate fails a case, the gate (or the manifest) is
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

const GATE = join(REPO_ROOT, "scripts", "check-openclaw-manifest-tools.sh");
const REAL_TOOLS_SRC = join(
  REPO_ROOT,
  "adapters",
  "openclaw",
  "src",
  "tools",
);

/** The three tools missing from the pre-fix manifest (the card's exact drift). */
const MISSING_THREE = [
  "klodi_searches_create",
  "klodi_match_feedback",
  "klodi_setup_reseed_skill",
] as const;

/**
 * The 32 tools the pre-fix manifest declares (verified on this worktree).
 * Reused to build the pre-fix manifest fixture for case 2 — we never mutate the
 * real manifest, we point the gate at a temp copy via MANIFEST.
 */
const PRE_FIX_DECLARED_32: ReadonlyArray<string> = [
  "klodi_channel_close",
  "klodi_channel_create",
  "klodi_channel_history",
  "klodi_channel_message",
  "klodi_channel_mine",
  "klodi_comment",
  "klodi_health",
  "klodi_list_comments",
  "klodi_list_create",
  "klodi_list_get",
  "klodi_list_mine",
  "klodi_list_relist",
  "klodi_list_update",
  "klodi_list_withdraw",
  "klodi_offer_create",
  "klodi_offer_mine",
  "klodi_offer_respond",
  "klodi_ratings",
  "klodi_register",
  "klodi_register_poll",
  "klodi_search",
  "klodi_searches_list",
  "klodi_setup_repair",
  "klodi_setup_reseed_policies",
  "klodi_setup_status",
  "klodi_tx_cancel",
  "klodi_tx_confirm",
  "klodi_tx_rate",
  "klodi_tx_status",
  "klodi_unwatch",
  "klodi_watch",
  "klodi_whoami",
];

/** The full 35-tool registered set (the source ground truth). */
const REGISTERED_35: ReadonlyArray<string> = [
  ...PRE_FIX_DECLARED_32,
  ...MISSING_THREE,
];

interface GateRun {
  code: number;
  out: string;
}

/** Build a manifest fixture file declaring exactly `tools` in `.contracts.tools`. */
function writeManifestFixture(dir: string, tools: ReadonlyArray<string>): string {
  const path = join(dir, "openclaw.plugin.json");
  writeFileSync(
    path,
    JSON.stringify({ id: "klodi", contracts: { tools: [...tools] } }, null, 2),
  );
  return path;
}

/**
 * Run the gate, capturing exit code + combined stdout/stderr. Env overrides
 * (MANIFEST / TOOLS_SRC_DIR) let each case point the gate at fixtures without
 * touching the real manifest or source tree.
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
  tmp = mkdtempSync(join(tmpdir(), "openclaw-manifest-symmetry-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("openclaw manifest↔registered symmetry gate", () => {
  it("[integration] exits 0 against the real (post-fix) tree: manifest declares all 35 registered tools", () => {
    // No env overrides — runs against the real manifest + real src/tools.
    // GREEN requires the expert to have added the three missing tools (32 → 35).
    const { code, out } = runGate();
    expect(
      code,
      "gate should exit 0 when the real manifest declares exactly the 35"
        + " registered tools — non-zero means either the manifest is still at"
        + " 32 (the three not yet declared) or the gate is wrong. Gate output:\n"
        + out,
    ).toBe(0);
  });

  it("[integration] exits non-zero naming exactly the three missing tools against the pre-fix manifest fixture (32 entries)", () => {
    // Point the gate at a temp pre-fix manifest (32 entries) and the REAL
    // source (35 registered). registered − declared must be exactly the three.
    const manifest = writeManifestFixture(tmp, PRE_FIX_DECLARED_32);
    const { code, out } = runGate({
      MANIFEST: manifest,
      TOOLS_SRC_DIR: REAL_TOOLS_SRC,
    });

    expect(
      code,
      "gate must FAIL on the pre-fix manifest (3 registered tools undeclared)."
        + " Gate output:\n" + out,
    ).not.toBe(0);

    // Names exactly the three — no more, no fewer.
    for (const tool of MISSING_THREE) {
      expect(
        out,
        `gate must name the undeclared tool ${tool}. Gate output:\n${out}`,
      ).toContain(tool);
    }

    // No OTHER tool name may appear as an offender — guards against the gate
    // over-reporting (e.g. a stale dedup bug or a wider-than-intended diff).
    // Match on a whole-token word boundary, NOT a substring: `klodi_search` is
    // a proper substring of the genuine offender `klodi_searches_create`, so a
    // naive `.not.toContain("klodi_search")` would fire a false positive the
    // instant the gate correctly names `klodi_searches_create`. `\b…\b` only
    // matches `klodi_search` as a standalone token (the `es` after it blocks the
    // trailing boundary inside `klodi_searches_create`) while still catching a
    // genuine standalone over-report of the tool.
    const otherDeclared = PRE_FIX_DECLARED_32.filter(
      (t) => !(MISSING_THREE as ReadonlyArray<string>).includes(t),
    );
    for (const tool of otherDeclared) {
      expect(
        out,
        `gate must NOT name correctly-declared tool ${tool} as an offender —`
          + ` it is in both sets. Gate over-reported. Gate output:\n${out}`,
      ).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
  });

  it("[integration] exits non-zero naming the offender for a declared-but-unregistered tool (reverse direction)", () => {
    // Manifest declares all 35 registered tools PLUS a phantom tool that no
    // src file registers. The gate must catch the reverse diff (declared −
    // registered), proving symmetry is two-way, not a one-way subset check.
    const phantom = "klodi_phantom_unregistered";
    const manifest = writeManifestFixture(tmp, [...REGISTERED_35, phantom]);
    const { code, out } = runGate({
      MANIFEST: manifest,
      TOOLS_SRC_DIR: REAL_TOOLS_SRC,
    });

    expect(
      code,
      "gate must FAIL when the manifest declares a tool that no src file"
        + " registers (reverse drift) — a one-way subset check would pass here."
        + " Gate output:\n" + out,
    ).not.toBe(0);

    expect(
      out,
      `gate must name the declared-but-unregistered tool ${phantom}.`
        + ` Gate output:\n${out}`,
    ).toContain(phantom);
  });

  it("[integration][adversarial] non-tool klodi_* tokens in src are excluded by construction — no false drift", () => {
    // Build a fixture source dir whose .ts file registers exactly ONE tool but
    // is riddled with non-tool klodi_* tokens that a naive klodi_* scan (or a
    // too-wide `name:`-adjacency window) would falsely pick up:
    //   - a log-event name in api.logger.info("klodi_plugin_loaded", …)
    //   - object-key fields `klodi_home:` / `klodi_home_source:` INSIDE the
    //     registerTool block body (mirrors setup.ts:88-89, the real trap)
    //   - a `name:` field that is NOT inside a registerTool({…}) call
    // The manifest declares exactly the one real registered tool, so a correct
    // gate (extraction scoped to name: inside registerTool({…})) sees the sets
    // as equal and exits 0. If any noise token leaks into the registered set,
    // the gate reports a spurious diff and this case fails.
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
        "      return jsonResult({",
        "        klodi_home: getKlodiHome(),",
        "        klodi_home_source: getKlodiHomeSource(),",
        "      });",
        "    },",
        "  });",
        "  // a stray non-registerTool object also carrying a name: field",
        '  const config = { name: "klodi_not_a_tool", kind: "config" };',
        "  void config;",
        "}",
        "",
      ].join("\n"),
    );

    const manifest = writeManifestFixture(tmp, ["klodi_register"]);
    const { code, out } = runGate({
      MANIFEST: manifest,
      TOOLS_SRC_DIR: toolsDir,
    });

    expect(
      code,
      "gate must exit 0: the only registerTool name is klodi_register, which"
        + " the manifest declares. Non-tool klodi_* tokens (klodi_plugin_loaded,"
        + " klodi_home, klodi_home_source, klodi_not_a_tool) must NOT be"
        + " extracted into the registered set. A non-zero exit means extraction"
        + " is not scoped to name: inside registerTool({…}). Gate output:\n"
        + out,
    ).toBe(0);

    // The noise tokens must never surface as offenders.
    for (const noise of [
      "klodi_plugin_loaded",
      "klodi_home",
      "klodi_home_source",
      "klodi_not_a_tool",
    ]) {
      expect(
        out,
        `non-tool token ${noise} leaked into the gate's registered set —`
          + ` extraction is not scoped to name: inside registerTool({…}).`
          + ` Gate output:\n${out}`,
      ).not.toContain(noise);
    }
  });
});
