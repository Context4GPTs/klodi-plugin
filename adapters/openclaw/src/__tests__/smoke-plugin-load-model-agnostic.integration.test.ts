/**
 * Integration proof for: "Decouple openclaw smoke test from any model
 * pin".
 *
 * Acceptance criterion (card → Discovery findings, [integration]):
 *   "Given the openclaw plugin-load smoke fixture with the concrete
 *    model pin removed/abstracted, when scripts/smoke-plugin-load.sh runs
 *    and installs the freshly-packed tarball into the OpenClaw image,
 *    then the install subprocess exits cleanly and the
 *    `klodi_plugin_loaded` marker fires — i.e. the plugin still LOADS
 *    without depending on `openai-codex/gpt-5.3-codex` (or any concrete
 *    model id)."
 *
 * This is the run that settles the PRIMARY risk in Discovery: does the
 * OpenClaw host require an `agents.defaults.model` block to install/load
 * a plugin at all? The unit guards prove the literal is gone from the
 * fixture; only this docker run proves the de-pinned fixture still LOADS.
 *
 * The assertion is the conjunction that flips on the expert's edit:
 *   1. the fixture the script ships carries no model literal, AND
 *   2. running the script exits 0 — which the script defines as
 *      "install + load succeeded AND the install subprocess exited
 *      cleanly AND wake_pump_skip_non_gateway fired" (see the script's
 *      header + its internal asserts; klodi_plugin_loaded is among them).
 *
 * Today (1) is FALSE — the heredoc still pins gpt-5.3-codex — so this is
 * RED. After the expert removes the model block it becomes the live
 * proof that the model-less fixture loads.
 *
 * Requirements: docker (daemon reachable), pnpm, bash, AND opt-in via
 * `KLODI_SMOKE_INTEGRATION=1`. The opt-in keeps a ~1-minute docker build
 * out of the default `pnpm test` inner loop — the repo runs the smoke
 * gate as a deliberate shell step (`prepublish`, Makefiles), never inside
 * vitest, so this test mirrors that: it is the same gate, expressed as a
 * vitest assertion, runnable on demand. When the opt-in is unset or any
 * tool is missing it SKIPS LOUDLY (console.warn) — never passes silently,
 * because an environment limitation must not delete coverage.
 *
 * Run it explicitly:
 *   KLODI_SMOKE_INTEGRATION=1 pnpm vitest run \
 *     src/__tests__/smoke-plugin-load-model-agnostic.integration.test.ts
 * CI sets KLODI_SMOKE_INTEGRATION=1 to exercise it for real.
 *
 * DO NOT weaken this test to make it pass against the pinned fixture.
 * Remove the model block; that is the whole point of the card.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");
const SMOKE_SCRIPT = join(ADAPTER_ROOT, "scripts", "smoke-plugin-load.sh");

// The script does build + vendor + npm pack + docker run; the default
// vitest 10s timeout is nowhere near enough.
const SMOKE_TIMEOUT_MS = 8 * 60 * 1000;

const MODEL_LITERAL_PATTERNS: RegExp[] = [
  /\bgpt-\d/i,
  /\bcodex\b/i,
  /\bclaude-\d/i,
  /\b(sonnet|opus|haiku)\b/i,
  /\bgemini-\d/i,
  /\bmistral-/i,
  /\bllama-\d/i,
  /\bdeepseek\b/i,
  /\bqwen\b/i,
];

function have(cmd: string): boolean {
  // No `shell: true` (it triggers DEP0190 and is a needless injection
  // surface): resolve the binary on PATH directly with `which`.
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function dockerDaemonUp(): boolean {
  if (!have("docker")) return false;
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function extractOpenClawJsonHeredoc(shell: string): string {
  const lines = shell.split("\n");
  const openIdx = lines.findIndex((line) =>
    /openclaw\.json"?\s*<<'?EOF'?\s*$/.test(line),
  );
  const closeRel = lines
    .slice(openIdx + 1)
    .findIndex((line) => /^EOF\s*$/.test(line));
  return lines.slice(openIdx + 1, openIdx + 1 + closeRel).join("\n");
}

const optedIn = process.env.KLODI_SMOKE_INTEGRATION === "1";
const toolsPresent = dockerDaemonUp() && have("pnpm") && have("bash");
const runnable = optedIn && toolsPresent;

// `it` runs the test; `it.skip` skips it but keeps it visible in the
// report. We never silently no-op: when un-runnable we warn and skip.
const maybeIt = runnable ? it : it.skip;
if (!runnable) {
  const reason = !optedIn
    ? "KLODI_SMOKE_INTEGRATION is not set to 1 (opt-in keeps the docker " +
      "build out of the default test loop)"
    : "docker (daemon up), pnpm, or bash is unavailable";
  // eslint-disable-next-line no-console
  console.warn(
    `[smoke-plugin-load.integration] SKIPPED: ${reason}. This is not a ` +
      "pass — set KLODI_SMOKE_INTEGRATION=1 with docker available to run " +
      "scripts/smoke-plugin-load.sh for real (CI does this).",
  );
}

describe("smoke-plugin-load.sh loads the plugin from a model-agnostic fixture", () => {
  maybeIt(
    "ships a model-less fixture AND the plugin loads (exit 0)",
    () => {
      // (1) The fixture the script will ship must carry no model literal.
      //     RED until the expert removes the model/models keys.
      const fixture = extractOpenClawJsonHeredoc(
        readFileSync(SMOKE_SCRIPT, "utf8"),
      );
      const literalHits = MODEL_LITERAL_PATTERNS.filter((re) =>
        re.test(fixture),
      ).map((re) => re.source);
      expect(
        literalHits,
        "smoke fixture still pins a model id: " +
          `${literalHits.join(", ")}. The plugin-load smoke test must not ` +
          "depend on any model — remove the model/models keys.",
      ).toEqual([]);

      // (2) Running the script must exit 0. The script's header defines
      //     0 == install + load succeeded AND the install subprocess
      //     exited cleanly AND wake_pump_skip_non_gateway fired (the
      //     klodi_plugin_loaded marker is asserted internally). Any
      //     non-zero is a real failure — packaging, install, hang, or a
      //     host that rejects the model-less config (the PRIMARY risk).
      const result = spawnSync("bash", [SMOKE_SCRIPT], {
        cwd: ADAPTER_ROOT,
        encoding: "utf8",
        timeout: SMOKE_TIMEOUT_MS,
      });
      const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(
        result.status,
        "smoke-plugin-load.sh did not exit cleanly. Output:\n" + log,
      ).toBe(0);
      // Belt-and-braces on the load marker the criterion names directly,
      // in case the script's success contract ever changes shape.
      expect(log).toContain("klodi_plugin_loaded");
    },
    SMOKE_TIMEOUT_MS,
  );
});
