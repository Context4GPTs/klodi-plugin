/**
 * Cross-adapter regression guard for: "Decouple openclaw smoke test from
 * any model pin".
 *
 * No adapter's smoke script may hardcode a concrete provider/model
 * literal. A plugin-load / registration smoke test verifies the plugin
 * loads — it must not embed a model id a host account could reject, and
 * must not carry a value that goes stale the moment a provider renames a
 * model.
 *
 * Acceptance criterion (card → Discovery findings, [unit]):
 *   "Given every adapter's smoke fixture/script (adapters/*\/scripts/
 *    smoke*.sh), when all are statically swept for model-id literals,
 *    then none hardcodes a concrete codex (or other provider) model that
 *    a host account would reject."
 *
 * Today exactly one adapter (openclaw) embeds a model block; the other
 * five (hermes, nanobot, moltis, ironclaw, zeroclaw) assert
 * registration/load with no model config. So this guard is RED now
 * (openclaw carries the pin), goes GREEN after the expert removes it,
 * and then *stays* a regression guard keeping all six clean.
 *
 * The match net is deliberately the model *class*, not just today's
 * `gpt-5.3-codex` value — otherwise it would fail to catch the next
 * stale pin under a different family name.
 *
 * DO NOT add an allowlist to make a failing adapter pass. A hit means a
 * smoke script pins a model — fix the script.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → adapters/openclaw → adapters/
const ADAPTERS_DIR = join(HERE, "..", "..", "..");

/**
 * Concrete-model-literal patterns. Anchored to model-id identifier
 * shapes so they catch the *class* (gpt-N, codex, claude-N, the
 * Anthropic family, gemini-N, mistral-, llama-N, deepseek, qwen) without
 * false-positiving on docker image refs (`alpine/openclaw`), file paths,
 * or English prose. The bare `provider/model` slash shape is
 * intentionally NOT a standalone trigger: it is indistinguishable from a
 * docker image ref by regex, and every real model literal already names
 * one of the family patterns below.
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

/** Glob `adapters/*\/scripts/smoke*.sh` without a shell or extra deps. */
function findAdapterSmokeScripts(adaptersDir: string): string[] {
  const scripts: string[] = [];
  for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scriptsDir = join(adaptersDir, entry.name, "scripts");
    if (!existsSync(scriptsDir)) continue;
    for (const file of readdirSync(scriptsDir)) {
      if (/^smoke.*\.sh$/.test(file)) {
        scripts.push(join(scriptsDir, file));
      }
    }
  }
  return scripts.sort();
}

function modelLiteralHits(body: string): string[] {
  return MODEL_LITERAL_PATTERNS.filter((p) => p.re.test(body)).map(
    (p) => p.name,
  );
}

describe("no adapter smoke script hardcodes a concrete provider/model literal", () => {
  const scripts = findAdapterSmokeScripts(ADAPTERS_DIR);

  it("finds the adapter smoke scripts to sweep (sanity: the glob works)", () => {
    // If this is empty the sweep below would vacuously pass — assert the
    // corpus is non-empty so a path regression can't silently void the
    // guard.
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts.map((path) => [path]))(
    "%s carries no model-id literal",
    (path) => {
      const body = readFileSync(path, "utf8");
      const hits = modelLiteralHits(body);
      expect(
        hits,
        `${path} hardcodes model literal(s): ${hits.join(", ")}. A smoke ` +
          "test must not depend on any model — remove the pin.",
      ).toEqual([]);
    },
  );
});
