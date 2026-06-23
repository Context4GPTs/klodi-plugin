/**
 * Integration proof for: "Load openclaw plugin at gateway startup".
 *
 * Acceptance criteria (card → Discovery findings, [integration] AC-2/3/4/6):
 *   AC-2 — "Given a stock latest alpine/openclaw gateway with the
 *           freshly-packed klodi tarball installed, when the gateway
 *           boots, then `openclaw gateway health --json` returns
 *           { ok: true, plugins: { loaded: [...] } } with `klodi` present
 *           in plugins.loaded (the 9th plugin)."
 *   AC-4 — "...the static install/health signals and the runtime load
 *           state are consistent, closing the 'three green lights, zero
 *           function' gap."
 *   AC-6 — "...a manifest-load smoke gate runs it against the latest
 *           openclaw image, asserts `klodi` appears
 *           in `gateway health --json` plugins.loaded (the runtime axis),
 *           failing loud and naming the absence — rather than asserting
 *           only the klodi_plugin_loaded log marker or relying on
 *           `plugins doctor` (the static axes)."
 *
 * This is the run that settles the bug: the latest openclaw host treats
 * `.activation` as an authoritative load gate, so the current manifest
 * (`onCapabilities: ["tool"]`, no startup trigger) never activates klodi
 * at gateway boot. Only a real gateway boot on the ENFORCING image, read
 * via `gateway health --json` plugins.loaded, proves the fix loads the
 * plugin. (AC-3 — tools + wake-pump register as a consequence of load —
 * rides on the same boot; the load assertion is its precondition and the
 * authoritative user-observable signal the card names.)
 *
 * The assertion is the conjunction that flips on the expert's edit:
 *   1. the gateway-load script exists, AND
 *   2. running it exits 0 — which the script defines (devops spec) as
 *      "the gateway booted on the latest openclaw image AND `klodi` ∈
 *      gateway health --json plugins.loaded".
 *
 * Today BOTH are FALSE — there is no scripts/smoke-gateway-load.sh yet
 * (devops-engineer writes it), AND the current manifest does not load on
 * the latest openclaw — so this is RED. That conjunction is the point: it
 * goes GREEN only when the `.activation` fix lands AND the script exists,
 * the same shape as the sibling's "model-less fixture AND it loads".
 *
 * HARD CONSTRAINTS (card Intent + product-owner notes — do not relax):
 *   - The sole authoritative load signal is `openclaw gateway health
 *     --json` → plugins.loaded. NOT `/v1/models` (serves Control UI HTML
 *     on the latest openclaw regardless of load — false green). NOT the
 *     `klodi_plugin_loaded` log marker (can fire on a lazy/capability
 *     path while klodi is still absent from the startup plugins.loaded
 *     set — the exact gap this card closes). NOT `plugins doctor` (a
 *     static manifest lint that passed clean while the plugin failed to
 *     load). So this wrapper keys its assertion off the script's
 *     plugins.loaded report — never a model endpoint, never a log marker.
 *
 * Requirements: docker (daemon reachable), pnpm, bash, AND opt-in via
 * `KLODI_SMOKE_INTEGRATION=1`. The opt-in keeps a multi-minute docker
 * boot out of the default `pnpm test` inner loop — the repo runs smoke
 * gates as deliberate shell steps (prepublish), never inside vitest, so
 * this test mirrors that: the same gate, expressed as a vitest assertion,
 * runnable on demand. When the opt-in is unset or any tool is missing it
 * SKIPS LOUDLY (console.warn) — never passes silently, because an
 * environment limitation must not delete coverage.
 *
 * Run it explicitly:
 *   KLODI_SMOKE_INTEGRATION=1 pnpm vitest run \
 *     src/__tests__/smoke-gateway-load.integration.test.ts
 * CI sets KLODI_SMOKE_INTEGRATION=1 to exercise it for real.
 *
 * DO NOT weaken this test to make it pass while the plugin doesn't load.
 * Fix `.activation` so the plugin actually loads at gateway startup; that
 * is the whole point of the card.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");
const SMOKE_SCRIPT = join(ADAPTER_ROOT, "scripts", "smoke-gateway-load.sh");

// The script does build + vendor + npm pack + docker run of a real
// gateway + bounded health poll; the default 10s vitest timeout is
// nowhere near enough.
const SMOKE_TIMEOUT_MS = 8 * 60 * 1000;

function have(cmd: string): boolean {
  // No `shell: true` (it triggers DEP0190 and is a needless injection
  // surface): resolve the binary on PATH directly with `which`.
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function dockerDaemonUp(): boolean {
  if (!have("docker")) return false;
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
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
      "gateway boot out of the default test loop)"
    : "docker (daemon up), pnpm, or bash is unavailable";
  // eslint-disable-next-line no-console
  console.warn(
    `[smoke-gateway-load.integration] SKIPPED: ${reason}. This is not a ` +
      "pass — set KLODI_SMOKE_INTEGRATION=1 with docker available to run " +
      "scripts/smoke-gateway-load.sh for real (CI does this).",
  );
}

describe("smoke-gateway-load.sh loads klodi at gateway startup on the latest openclaw image", () => {
  maybeIt(
    "boots the gateway AND klodi appears in gateway health --json plugins.loaded (exit 0)",
    () => {
      // (1) The gateway-load script must exist. devops-engineer writes
      //     scripts/smoke-gateway-load.sh (boots a real gateway on the
      //     latest openclaw image, polls `gateway health --json`, asserts
      //     `klodi` ∈ plugins.loaded). RED until that script lands. We
      //     assert presence explicitly so the failure NAMES the missing
      //     deliverable rather than surfacing as an opaque spawn error.
      expect(
        existsSync(SMOKE_SCRIPT),
        "scripts/smoke-gateway-load.sh does not exist yet. devops-engineer " +
          "owns it: it must boot a real openclaw gateway on the latest " +
          "openclaw image, poll `openclaw gateway health --json`, and " +
          "assert `klodi` ∈ plugins.loaded (exit 0 pass / 1 plugin-not-loaded " +
          "/ 2 infra). Do NOT stub this assertion away.",
      ).toBe(true);

      // (2) Running the script must exit 0. The script's contract
      //     (devops spec) defines 0 == the gateway booted on the latest
      //     openclaw image
      //     AND `klodi` ∈ `gateway health --json` plugins.loaded. exit 1
      //     == klodi absent from plugins.loaded (THE BUG — manifest's
      //     .activation never fired at startup); exit 2 == infra/boot
      //     failure. Any non-zero is a real failure surfaced with the
      //     script's own loaded-set / docker-logs dump.
      const result = spawnSync("bash", [SMOKE_SCRIPT], {
        cwd: ADAPTER_ROOT,
        encoding: "utf8",
        timeout: SMOKE_TIMEOUT_MS,
      });
      const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(
        result.status,
        "smoke-gateway-load.sh did not exit cleanly. A non-zero exit means " +
          "klodi is absent from `gateway health --json` plugins.loaded " +
          "(exit 1, the bug) or the gateway failed to boot (exit 2). " +
          "Output:\n" + log,
      ).toBe(0);

      // (3) Authoritative load assertion, keyed off plugins.loaded ONLY.
      //     The script emits the loaded set; the plugin's id MUST appear
      //     in it. We deliberately do NOT accept the klodi_plugin_loaded
      //     log marker or a /v1/models response as proof — they are
      //     forbidden by the card (a marker can fire on a lazy path while
      //     klodi is absent from the startup plugins.loaded set; /v1/models
      //     is Control-UI HTML on the latest openclaw). Belt-and-braces on the
      //     plugin id the criterion names directly, in case the script's
      //     exit-code contract ever changes shape.
      expect(
        log,
        "smoke-gateway-load.sh exited 0 but its output does not report " +
          "`klodi` in the gateway's plugins.loaded set. The authoritative " +
          "load signal is `gateway health --json` plugins.loaded — the " +
          "script must emit it and `klodi` must be present.",
      ).toContain("klodi");
      expect(log).toContain("plugins.loaded");

      // (4) Axis-4 arm assertion (this card — wake-pump-never-arms). Loaded
      //     is necessary but not sufficient: root cause B is a loaded plugin
      //     that misclassifies the gateway runtime and stays inert. The
      //     script asserts the gateway DAEMON phase of the boot log carries
      //     no `wake_pump_skip_non_gateway` (creds-independent proof the
      //     gateway-runtime gate flipped) and emits an arm-proof line on
      //     exit 0. We belt-and-braces on that line so a future change to
      //     the script's exit-code shape cannot silently drop axis 4. exit 3
      //     == loaded-but-not-armed (the arm bug); already failed at (2).
      expect(
        log,
        "smoke-gateway-load.sh exited 0 but its output does not report the " +
          "wake-pump gate armed. The script must confirm " +
          "`wake_pump_skip_non_gateway` is ABSENT from the gateway-daemon " +
          "phase (the gateway-runtime gate flipped on) and emit that proof.",
      ).toContain("wake-pump gate armed");
    },
    SMOKE_TIMEOUT_MS,
  );
});
