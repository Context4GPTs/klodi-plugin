/**
 * RED guard for: "Decouple openclaw smoke test from any model pin".
 *
 * The plugin-load smoke gate (scripts/smoke-plugin-load.sh) writes its
 * OpenClaw config from an inline heredoc (the `openclaw.json` body). A
 * plugin-LOAD smoke test must not be tied to any concrete model id — it
 * verifies the plugin loads, not which model is configured. Today the
 * heredoc pins `openai-codex/gpt-5.3-codex` (the `model` / `models`
 * keys), which a downstream ChatGPT account can reject and which is
 * already stale scaffolding the plugin never reads (wake.ts only reads
 * `agents.list`).
 *
 * Acceptance criterion (card → Discovery findings, [unit]):
 *   "Given the openclaw smoke fixture's checked-in config, when its
 *    contents are statically inspected, then it contains no concrete
 *    model identifier ... so a stale pin cannot silently ride back in."
 *
 * The fixture's checked-in form IS the heredoc inside the shell script,
 * so this test extracts that heredoc body and asserts two things the
 * Discovery handoff calls out as hard constraints:
 *   1. it is still valid JSON (the deletion must not break commas —
 *      `agents.defaults` stays well-formed), and
 *   2. it contains no concrete provider/model literal.
 *
 * RED today (the pin is present). GREEN once the expert deletes the two
 * `model` / `models` lines from the `agents.defaults` heredoc.
 *
 * DO NOT weaken this test to match the current fixture. Fix the fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");
const SMOKE_SCRIPT = join(ADAPTER_ROOT, "scripts", "smoke-plugin-load.sh");

/**
 * Extract the body of the heredoc that writes `openclaw.json`, i.e. the
 * lines between `cat >"$STAGE_DIR/openclaw.json" <<'EOF'` and the next
 * bare `EOF` terminator. The heredoc is single-quoted (`<<'EOF'`), so no
 * shell interpolation happens and the body is literal JSON.
 */
function extractOpenClawJsonHeredoc(shell: string): string {
  const lines = shell.split("\n");
  const openIdx = lines.findIndex((line) =>
    /openclaw\.json"?\s*<<'?EOF'?\s*$/.test(line),
  );
  if (openIdx === -1) {
    throw new Error(
      "Could not find the `openclaw.json` heredoc opener in " +
        "smoke-plugin-load.sh — did the fixture move?",
    );
  }
  const closeRel = lines
    .slice(openIdx + 1)
    .findIndex((line) => /^EOF\s*$/.test(line));
  if (closeRel === -1) {
    throw new Error(
      "Could not find the heredoc terminator (`EOF`) after the " +
        "`openclaw.json` opener in smoke-plugin-load.sh.",
    );
  }
  return lines.slice(openIdx + 1, openIdx + 1 + closeRel).join("\n");
}

/**
 * Concrete-model-literal patterns. Each matches the model-id *class*,
 * not just today's `gpt-5.3-codex` value, so the next stale pin can't
 * sneak in under a different family name. Anchored to identifier shapes
 * so they don't false-positive on English prose or docker image refs
 * (e.g. `alpine/openclaw`).
 */
const MODEL_LITERAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "gpt-N (e.g. gpt-5.3-codex)", re: /\bgpt-\d/i },
  { name: "codex", re: /\bcodex\b/i },
  { name: "claude-N", re: /\bclaude-\d/i },
  { name: "anthropic family (sonnet/opus/haiku)", re: /\b(sonnet|opus|haiku)\b/i },
  { name: "gemini-N", re: /\bgemini-\d/i },
  { name: "mistral-*", re: /\bmistral-/i },
  { name: "llama-N", re: /\bllama-\d/i },
  { name: "deepseek", re: /\bdeepseek\b/i },
  { name: "qwen", re: /\bqwen\b/i },
];

describe("openclaw smoke fixture (openclaw.json heredoc) is model-agnostic", () => {
  const shell = readFileSync(SMOKE_SCRIPT, "utf8");
  const body = extractOpenClawJsonHeredoc(shell);

  it("the heredoc body is valid JSON (deletion must not break commas)", () => {
    // Parsing is the well-formedness guard the Discovery handoff demands:
    // removing two middle keys from a hand-written heredoc is comma-error
    // prone. A malformed config would make the host fail to parse before
    // the plugin even loads — a false failure that looks like a host bug.
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("contains no `gpt-5.3-codex` literal (the exact stale pin)", () => {
    // The card names this value explicitly — the account-rejected pin
    // that escaped into the fixture during the multi-host reshape.
    expect(body).not.toMatch(/gpt-5\.3-codex/i);
  });

  it("contains no `gpt-5.x-codex` literal (the codex family at any minor)", () => {
    // Re-pinning to gpt-5.4-codex would relocate the staleness, not fix
    // it. The founder's steer is "no model dependency at all", so the
    // whole gpt-5.*-codex family is forbidden, not just .3.
    expect(body).not.toMatch(/gpt-5\.\d+-codex/i);
  });

  it("contains no concrete provider/model identifier of any class", () => {
    const hits = MODEL_LITERAL_PATTERNS.filter((p) => p.re.test(body)).map(
      (p) => p.name,
    );
    expect(
      hits,
      `smoke fixture still pins concrete model id(s): ${hits.join(", ")}. ` +
        "A plugin-load smoke test must not depend on any model — remove " +
        "the model/models keys from the agents.defaults heredoc.",
    ).toEqual([]);
  });

  it("agents.defaults carries no `model` or `models` key", () => {
    // Structural form of the same constraint: even a model-agnostic
    // placeholder string under these keys would re-introduce the
    // "looks load-bearing" footgun. The chosen approach is bare removal.
    const parsed = JSON.parse(body) as {
      agents?: { defaults?: Record<string, unknown> };
    };
    const defaults = parsed.agents?.defaults ?? {};
    expect(Object.keys(defaults)).not.toContain("model");
    expect(Object.keys(defaults)).not.toContain("models");
  });
});
