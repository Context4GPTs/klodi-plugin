/**
 * Additive-contract gate for the `klodi_match_feedback` flywheel-emit tool
 * (card: emit-standing-search-accept-dismiss-feedback, SC8).
 *
 * The card's hardest constraint: this change is PURELY ADDITIVE. The only
 * mutation to any adapter's tool surface is one new `LOCAL_TOOLS` key with
 * `host_shapes: ["in_agent"]`. No existing tool's name/params/result moves;
 * the daemon (Rust trio) allowlist stays empty so moltis/ironclaw/zeroclaw
 * gain nothing and stay byte-identical.
 *
 * RED-first: `klodi_match_feedback` is not in `LOCAL_TOOLS` yet.
 *
 * Two layers:
 *   1. Catalog-source assertions (fast, deterministic, no build) — the
 *      PRIMARY RED signal. Pins the pre-existing local-tool surface as a
 *      frozen snapshot of (name, kind, host_shapes, param keys, result
 *      keys) so ANY edit to an existing entry trips the test, and asserts
 *      the in_agent set grows by EXACTLY `klodi_match_feedback`.
 *   2. The static symmetry gate `scripts/check-adapter-tools.sh` run under
 *      STRICT_ADAPTER_TOOLS=1 (the card's explicit ask). It is the backstop
 *      for the intermediate state — once the catalog entry exists but a host
 *      forgot to register the literal, strict mode fails RED rather than
 *      warning. Generates dist/schemas.json first, exactly as CI does.
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts, and never
 * add the new tool to `PRE_EXISTING_*` to make layer 1 pass — that would
 * defeat the additive proof. The correct GREEN is the expert adding the
 * catalog entry + all three in-agent registrations together.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOCAL_TOOLS, localToolsForHostShape } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const NEW_TOOL = "klodi_match_feedback";

interface LocalEntry {
  name: string;
  kind: string;
  host_shapes: readonly string[];
  params: unknown;
  result: unknown;
}

function entries(): Record<string, LocalEntry> {
  return LOCAL_TOOLS as unknown as Record<string, LocalEntry>;
}

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

function schemaKeys(schema: unknown): { props: string[]; required: string[] } {
  const round = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  return {
    props: Object.keys(round.properties ?? {}).sort(),
    required: [...(round.required ?? [])].sort(),
  };
}

/**
 * Frozen snapshot of the established local tools — the surface `klodi_match_feedback`
 * is additive to. The map keys are the tool names; the values pin the surface
 * that MUST NOT move.
 *
 * `klodi_match_feedback` is deliberately ABSENT — it is the one permitted
 * addition this card proves. If a future edit changes any listed entry, the
 * byte-identity test below fails for the right reason.
 *
 * NOTE (card: wake-relay-tools-absent-from-tool-catalog): `klodi_message_user`
 * and `klodi_pending_decisions` were added to `LOCAL_TOOLS` by a LATER card
 * (finding F3) and are therefore part of the established surface here — their
 * own registration + fidelity spec lives in `wake-relay-tools-catalog.test.ts`.
 * They are pinned below so this test's byte-identity guard covers them too.
 */
const PRE_EXISTING_LOCAL_TOOLS: ReadonlyArray<string> = [
  "klodi_register",
  "klodi_register_poll",
  "klodi_health",
  "klodi_watch",
  "klodi_unwatch",
  "klodi_setup_status",
  "klodi_setup_repair",
  "klodi_setup_reseed_policies",
  "klodi_setup_reseed_skill",
  "klodi_channel_message",
  "klodi_message_user",
  "klodi_pending_decisions",
];

/** Per-tool frozen surface: kind, host_shapes, sorted param + result keys. */
const PRE_EXISTING_SURFACE: Record<
  string,
  { kind: string; host_shapes: string[]; params: string[]; result: string[] }
> = {
  klodi_register: { kind: "local", host_shapes: ["in_agent"], params: [], result: ["auth_url", "poll_after_seconds", "session_id"] },
  klodi_register_poll: { kind: "local", host_shapes: ["in_agent"], params: ["session_id"], result: ["handle", "message", "status", "user_id"] },
  klodi_health: { kind: "local", host_shapes: ["in_agent"], params: [], result: ["connected", "handle", "issue", "latency_ms", "ok", "user_id"] },
  klodi_watch: { kind: "local", host_shapes: ["in_agent"], params: ["currency", "max_price", "query", "slug"], result: ["buy_file_path", "search_id", "slug"] },
  klodi_unwatch: { kind: "local", host_shapes: ["in_agent"], params: ["slug"], result: ["buy_file_removed", "removed", "slug"] },
  klodi_setup_status: { kind: "local", host_shapes: ["in_agent", "cli_only"], params: [], result: ["handle", "issues", "klodi_home", "phase", "user_id"] },
  klodi_setup_repair: { kind: "local", host_shapes: ["in_agent"], params: [], result: ["preserved_files", "seeded_files"] },
  klodi_setup_reseed_policies: { kind: "local", host_shapes: ["in_agent"], params: [], result: ["reseeded_files", "timestamp"] },
  klodi_setup_reseed_skill: { kind: "local", host_shapes: ["in_agent"], params: [], result: ["reseeded_files", "timestamp"] },
  klodi_channel_message: { kind: "publish", host_shapes: ["in_agent"], params: ["channel_id", "content"], result: ["created_at", "event_id", "message_id", "sequence"] },
  // Added by card wake-relay-tools-absent-from-tool-catalog (F3). result of
  // klodi_pending_decisions is a top-level ARRAY, so it has no top-level
  // `properties` — schemaKeys() reports [] here by design (its item-shape is
  // pinned in wake-relay-tools-catalog.test.ts).
  klodi_message_user: { kind: "local", host_shapes: ["in_agent"], params: ["text"], result: ["chat_id", "delivered", "entity_id", "pending_status", "platform"] },
  klodi_pending_decisions: { kind: "local", host_shapes: ["in_agent"], params: [], result: [] },
};

describe("klodi_match_feedback — additive: existing local tools are byte-unchanged", () => {
  it("every pre-existing local tool is still present", () => {
    const live = new Set(Object.keys(entries()));
    for (const name of PRE_EXISTING_LOCAL_TOOLS) {
      expect(live, `breaking change: local tool ${name} disappeared`).toContain(name);
    }
  });

  it.each(PRE_EXISTING_LOCAL_TOOLS)(
    "%s keeps its exact kind, host_shapes, params, and result surface",
    (name) => {
      const entry = entries()[name];
      expect(entry, `local tool ${name} missing`).toBeDefined();
      const frozen = PRE_EXISTING_SURFACE[name];
      expect(entry.kind).toBe(frozen.kind);
      expect([...entry.host_shapes].sort()).toEqual([...frozen.host_shapes].sort());
      const params = schemaKeys(entry.params);
      const result = schemaKeys(entry.result);
      expect(params.props).toEqual(frozen.params);
      expect(result.props).toEqual(frozen.result);
    },
  );
});

describe("klodi_match_feedback — additive: the in_agent set grows by EXACTLY one tool", () => {
  it("the in_agent local-tool set is the pre-existing set plus only klodi_match_feedback", () => {
    const live = new Set(localToolsForHostShape("in_agent"));
    const preExistingInAgent = PRE_EXISTING_LOCAL_TOOLS.filter(
      (n) => PRE_EXISTING_SURFACE[n].host_shapes.includes("in_agent"),
    );
    const expected = new Set([...preExistingInAgent, NEW_TOOL]);
    expect(live).toEqual(expected);
  });

  it("the ONLY addition vs the pre-existing local-tool set is klodi_match_feedback", () => {
    const live = new Set(Object.keys(entries()));
    const additions = [...live].filter(
      (n) => !PRE_EXISTING_LOCAL_TOOLS.includes(n),
    );
    expect(additions).toEqual([NEW_TOOL]);
  });

  it("daemon local-tool allowlist stays empty (Rust trio gains nothing)", () => {
    expect([...localToolsForHostShape("daemon")]).toEqual([]);
  });
});

describe("klodi_match_feedback — catalog↔adapter symmetry gate (STRICT_ADAPTER_TOOLS=1)", () => {
  // The card's explicit ask: run scripts/check-adapter-tools.sh strict and
  // assert the ONLY addition is klodi_match_feedback (in_agent), daemon stays
  // empty. The gate's invariant 2 requires every in_agent local tool to
  // appear as a literal in all three in-agent adapter sources (openclaw,
  // hermes, nanobot); under strict mode a "missing" literal fails RED.
  //
  // SCOPING NOTE (important — read before "fixing" this test): on this
  // worktree the gate ALSO emits pre-existing `unknown` findings unrelated to
  // this card — `klodi_photos_resolution_failed` (a log-event name),
  // `klodi_logger` / `klodi_rust_host` (package names) — which its name-
  // extraction deny-list does not cover. Those make the gate exit non-zero on
  // the BASE tree, before this card touches anything. So we do NOT assert the
  // gate's overall exit code (that would demand the expert fix unrelated
  // breakage to go GREEN). Instead we assert the CARD-SCOPED signal: the gate
  // reports no `missing: klodi_match_feedback` under strict mode, i.e. all
  // three in-agent adapters carry the literal. (The pre-existing `unknown`
  // noise is flagged to the expert in the card's In-Dev test-notes, not gated
  // here.)
  //
  // We regenerate dist/schemas.json first (the gate reads it), exactly as CI
  // does, so the gate sees the live catalog rather than a stale artifact.
  const GATE = join(REPO_ROOT, "scripts", "check-adapter-tools.sh");
  const CODEGEN = join(PACKAGE_ROOT, "scripts", "codegen.mjs");

  function runGateStrict(): { code: number; out: string } {
    // Refresh the codegen artifact the gate consumes.
    execFileSync(process.execPath, [CODEGEN], { cwd: PACKAGE_ROOT, stdio: "pipe" });
    try {
      const out = execFileSync("bash", [GATE], {
        cwd: REPO_ROOT,
        env: { ...process.env, STRICT_ADAPTER_TOOLS: "1" },
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

  it("reports NO `missing: klodi_match_feedback` under strict mode (all 3 in-agent hosts register it)", () => {
    const { out } = runGateStrict();
    // The gate prints `  - missing: <name>` for every required local tool a
    // host fails to reference. Pre-entry, the tool isn't required (no line);
    // entry-added-but-unregistered, the line appears (RED); fully registered,
    // it's gone (GREEN). We assert the literal NEVER shows as missing.
    expect(
      out.includes(`missing: ${NEW_TOOL}`),
      "check-adapter-tools.sh --strict reports klodi_match_feedback as a"
      + " MISSING local-tool literal — at least one of openclaw/hermes/nanobot"
      + " has not registered it. Land all three registrations together. Gate"
      + " output:\n" + out,
    ).toBe(false);
  });

  it("daemon allowlist is empty in the codegen artifact the gate consumes", () => {
    // Cross-checks layer 1 against the actual generated schemas.json (the
    // gate's input), closing the gap between src and the propagated artifact.
    execFileSync(process.execPath, [CODEGEN], { cwd: PACKAGE_ROOT, stdio: "pipe" });
    const schemasPath = join(PACKAGE_ROOT, "dist", "schemas.json");
    const schemas = JSON.parse(
      execFileSync("cat", [schemasPath], { encoding: "utf8" }),
    ) as { local_tools_by_host_shape?: Record<string, string[]> };
    const byShape = schemas.local_tools_by_host_shape ?? {};
    expect(byShape["daemon"] ?? []).toEqual([]);
    expect(byShape["in_agent"] ?? []).toContain(NEW_TOOL);
  });
});
