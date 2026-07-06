/**
 * Enforced catalog↔adapter gate spec for the two wake-relay tools.
 *
 * The bug survived because `scripts/check-adapter-tools.sh` — the one gate that
 * could catch a referenced-but-uncatalogued tool (Invariant 1) — was never
 * ENFORCED. This is the enforcement the bug lacked, mirroring the
 * `match-feedback-additive.test.ts` harness (regen codegen → shell out to the
 * gate). We regenerate `dist/schemas.json` first, exactly as CI would, so the
 * gate reads the live catalog.
 *
 * Four guards:
 *   1. TOOL-SCOPED — the gate reports NO `unknown: klodi_message_user` /
 *      `unknown: klodi_pending_decisions`. This is the exact drift the bug was.
 *      Asserted tool-scoped (not the overall exit code), per the
 *      match-feedback precedent: the tree can carry unrelated gate findings.
 *   2. DENY-LIST COVERAGE (behavioral) — the documented non-tool klodi_* names
 *      (log-event / package / dataclass-attr) are filtered, so a real new
 *      `unknown` stands out instead of drowning in noise.
 *   3. REGRESSION GUARD — removing either entry from the catalog the gate reads
 *      re-produces `unknown: <name>`, proving the catalog is now the ENFORCED
 *      single source of truth and the drift cannot silently recur.
 *   4. DENY-LIST OVER-BROADENING — the deny-list must not swallow a REAL
 *      catalog tool name. Read live from the script, applied adversarially.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these. If the gate reports
 * an unexpected `unknown`, the CATALOG or the adapter is wrong, not this test.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const GATE = join(REPO_ROOT, "scripts", "check-adapter-tools.sh");
const CODEGEN = join(PACKAGE_ROOT, "scripts", "codegen.mjs");
const SCHEMAS_PATH = join(PACKAGE_ROOT, "dist", "schemas.json");

const MESSAGE_USER = "klodi_message_user";
const PENDING = "klodi_pending_decisions";
const WAKE_RELAY_TOOLS = [MESSAGE_USER, PENDING] as const;

/**
 * klodi_* literals that legitimately appear in adapter source but are NOT
 * tools — the deny-list is meant to filter every one of them so the gate is
 * clean on a healthy tree. Pre-fix (old deny-list) these leaked through as
 * `unknown` noise; the bug hid in that noise.
 */
const DOCUMENTED_NON_TOOLS = [
  "klodi_photos_resolution_failed", // log-event name (tools.py / listings.ts)
  "klodi_wake_pump_host", // dataclass attr (bridge.py)
  "klodi_logger", // internal package / crate ident (vendor.py)
  "klodi_rust_host", // internal package / crate ident (vendor.py)
] as const;

interface Schemas {
  tools: Record<string, unknown>;
  local_tools: Record<string, unknown>;
  local_tools_by_host_shape: Record<string, string[]>;
}

function regenCodegen(): void {
  execFileSync(process.execPath, [CODEGEN], { cwd: PACKAGE_ROOT, stdio: "pipe" });
}

/** Run the gate with stderr merged into stdout so findings are always visible. */
function runGate(extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("bash", ["-c", 'bash "$1" 2>&1', "_", GATE], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { code: err.status ?? 1, out };
  }
}

/**
 * Regenerate the schemas artifact, apply `mutate` to the catalog the gate
 * reads, run `fn`, then ALWAYS restore the pristine artifact — even if `fn`
 * throws. dist/schemas.json is a gitignored build output; this never touches
 * tracked source.
 */
function withMutatedSchemas<T>(mutate: (s: Schemas) => void, fn: () => T): T {
  regenCodegen();
  const original = readFileSync(SCHEMAS_PATH, "utf8");
  try {
    const parsed = JSON.parse(original) as Schemas;
    mutate(parsed);
    writeFileSync(SCHEMAS_PATH, JSON.stringify(parsed, null, 2));
    return fn();
  } finally {
    writeFileSync(SCHEMAS_PATH, original);
  }
}

function dropTool(schemas: Schemas, name: string): void {
  delete schemas.local_tools[name];
  for (const shape of Object.keys(schemas.local_tools_by_host_shape)) {
    schemas.local_tools_by_host_shape[shape] = schemas.local_tools_by_host_shape[
      shape
    ].filter((n) => n !== name);
  }
}

describe("wake-relay gate — tool-scoped: the referenced-but-uncatalogued drift is closed", () => {
  it.each(WAKE_RELAY_TOOLS)(
    "the gate reports NO `unknown: %s` (the tool is now in the catalog)",
    (name) => {
      regenCodegen();
      const { out } = runGate();
      expect(
        out.includes(`unknown: ${name}`),
        `check-adapter-tools.sh still reports \`unknown: ${name}\` — the tool is`
          + ` referenced by an adapter but ABSENT from LOCAL_TOOLS. This is the`
          + ` F3 drift. Add the catalog entry; do not weaken this test.\n`
          + `Gate output:\n${out}`,
      ).toBe(false);
    },
  );
});

describe("wake-relay gate — deny-list coverage: documented non-tools are filtered", () => {
  it.each(DOCUMENTED_NON_TOOLS)(
    "the gate reports NO `unknown: %s` (a non-tool klodi_* literal, not a catalog gap)",
    (name) => {
      // If these leak through as `unknown`, a real referenced-but-uncatalogued
      // tool (like the wake-relay bug) drowns in the noise and the gate's
      // signal is worthless. The extended deny-list must cover them.
      regenCodegen();
      const { out } = runGate();
      expect(
        out.includes(`unknown: ${name}`),
        `check-adapter-tools.sh reports \`unknown: ${name}\`, but ${name} is a`
          + ` documented non-tool klodi_* literal. Extend the deny-list to`
          + ` filter it so real catalog gaps stand out.\nGate output:\n${out}`,
      ).toBe(false);
    },
  );
});

describe("wake-relay gate — REGRESSION GUARD: the catalog is the enforced single source of truth", () => {
  it.each(WAKE_RELAY_TOOLS)(
    "removing %s from the catalog (while hermes still references it) re-produces its `unknown` line",
    (name) => {
      // Baseline: with the tool present, no unknown for it.
      regenCodegen();
      const baseline = runGate();
      expect(
        baseline.out.includes(`unknown: ${name}`),
        `precondition failed: ${name} already reported unknown with the tool present`,
      ).toBe(false);

      // Remove ONLY this tool from the gate's catalog input; hermes still
      // references the literal → Invariant 1 must flag it.
      withMutatedSchemas(
        (s) => dropTool(s, name),
        () => {
          const { out } = runGate();
          expect(
            out.includes(`unknown: ${name}`),
            `Removing ${name} from the catalog did NOT re-produce`
              + ` \`unknown: ${name}\`. The gate is not enforcing Invariant 1,`
              + ` so the catalog is not the single source of truth and the drift`
              + ` can silently recur.\nGate output:\n${out}`,
          ).toBe(true);
        },
      );
    },
  );
});

describe("wake-relay gate — deny-list must NOT over-broaden (real tools survive)", () => {
  /** Extract the live `grep -vE '...'` deny patterns from extract_referenced_names. */
  function denyPatterns(): RegExp[] {
    const script = readFileSync(GATE, "utf8");
    const start = script.indexOf("extract_referenced_names()");
    const next = script.indexOf("adapter_references()", start);
    const body = script.slice(start, next === -1 ? undefined : next);
    const pats: RegExp[] = [];
    const re = /grep -vE '([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) pats.push(new RegExp(m[1]));
    return pats;
  }

  function isDenied(name: string, pats: RegExp[]): boolean {
    return pats.some((p) => p.test(name));
  }

  function catalogNames(): string[] {
    regenCodegen();
    const s = JSON.parse(readFileSync(SCHEMAS_PATH, "utf8")) as Schemas;
    return [...Object.keys(s.tools), ...Object.keys(s.local_tools)];
  }

  it("the gate exposes at least the documented deny patterns", () => {
    // Sanity: if this parse finds nothing the gate's structure changed and the
    // over-broadening guard below is meaningless — fail loudly instead.
    expect(denyPatterns().length).toBeGreaterThanOrEqual(2);
  });

  it("NO real catalog tool name is swallowed by the deny-list", () => {
    const pats = denyPatterns();
    const swallowed = catalogNames().filter((n) => isDenied(n, pats));
    expect(
      swallowed,
      `The gate's deny-list over-broadened: it filters these REAL catalog`
        + ` tools, so a typo/stale reference to them would go uncaught:`
        + ` ${JSON.stringify(swallowed)}. Tighten the deny patterns.`,
    ).toEqual([]);
  });

  it("both wake-relay tools survive the deny-list", () => {
    const pats = denyPatterns();
    for (const name of WAKE_RELAY_TOOLS) {
      expect(isDenied(name, pats), `${name} is swallowed by the deny-list`).toBe(false);
    }
  });

  it("the documented non-tool literals ARE denied (the parse is meaningful, not vacuous)", () => {
    const pats = denyPatterns();
    for (const name of DOCUMENTED_NON_TOOLS) {
      expect(
        isDenied(name, pats),
        `${name} is a documented non-tool but the deny-list does not filter it`,
      ).toBe(true);
    }
  });
});

describe("wake-relay gate — cross-adapter scope is documented behavior, not a regression", () => {
  it("under STRICT, openclaw + nanobot are `missing` the wake-relay tools (in_agent gap, EXPECTED)", () => {
    // host_shapes: ["in_agent"] makes all three in-agent hosts required to
    // register the tools; only hermes ships the wake round-trip. This is the
    // ADR-0014 / D4 legitimate cross-adapter gap — WARN by default, RED only
    // under STRICT — NOT a regression this change introduces. Must not be
    // "fixed" by weakening host_shapes to a hermes-only hack.
    regenCodegen();
    const { out } = runGate({ STRICT_ADAPTER_TOOLS: "1" });
    for (const name of WAKE_RELAY_TOOLS) {
      expect(
        out.includes(`missing: ${name}`),
        `Expected STRICT mode to report \`missing: ${name}\` for the hosts that`
          + ` do not yet ship the wake round-trip. Gate output:\n${out}`,
      ).toBe(true);
    }
  });
});
