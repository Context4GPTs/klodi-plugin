/**
 * Tag-hygiene guard for the gateway-load smoke gate.
 *
 * Card: openclaw-wake-pump-never-arms-in-real-gateway — founder review on
 * PR #19. The wake-pump DETECTION fix (argv[2] === "gateway") is accepted
 * and not in question. What is wrong is VERSION PINNING: the gateway smoke
 * gate hard-pinned `alpine/openclaw:2026.5.27`, and the latest published
 * openclaw is 2026.6.9. Founder policy: we always align with the LATEST
 * openclaw image — no fixed image pins on the gateway gate.
 *
 * The bug already reproduces on 2026.6.9 (card Symptom/Repro), so the
 * argv-subcommand detection still holds on latest — this is a pin /
 * version-hygiene rework, not a logic change.
 *
 * THE SPEC THIS FILE PINS (the script + narrative serve it, not the other
 * way round):
 *   1. [integration-default] `smoke-gateway-load.sh` with no `OPENCLAW_TAG`
 *      resolves its image tag to the FLOATING `latest` tag — NOT a frozen
 *      `2026.x.y`. `OPENCLAW_TAG` stays the override seam (a one-off
 *      specific tag can still be passed), but the DEFAULT must track
 *      latest so the gate always boots the newest published openclaw.
 *      (This is the fast, docker-free proxy for the [integration] AC; the
 *      real boot rides on smoke-gateway-load.integration.test.ts, which now
 *      boots `latest` too.)
 *   2. [unit] No `2026.5.27` literal survives anywhere in this PR's changed
 *      files — as a gate, a default, an assertion, OR a narrative pin. The
 *      founder names dropping 2026.5.27 specifically; any genuine dated
 *      empirical datapoint is re-confirmed on 2026.6.9 and labelled as an
 *      illustrative observation, never a value the code keys on. A stale
 *      `2026.5.27` left in the diff is by definition a frozen pin, not a
 *      fresh datapoint — so the named literal must be gone entirely.
 *
 * EXPLICITLY OUT OF SCOPE — these are floors/contracts, NOT version pins,
 * and this guard must not flag them:
 *   - `smoke-plugin-load.sh` (`OPENCLAW_TAG:-2026.4.15`): a DELIBERATE floor
 *     test that boots the OLDEST supported host to prove load-on-floor. The
 *     opposite intent from the gateway gate — correct as-is.
 *   - the `>=` semantic floors in package.json#openclaw (minGatewayVersion /
 *     pluginApi / minHostVersion): minimum-supported-host contracts tied to
 *     the ADR-0008/0009 `--ignore-scripts` security guarantee.
 *   So this guard sweeps ONLY the PR-diff file set and keys ONLY off the
 *   specific `2026.5.27` literal — it never touches the floor scripts or
 *   the semantic `>=` floors.
 *
 * RED EXPECTATION (against the current pushed state of PR #19):
 *   - Contract 1 is RED: `smoke-gateway-load.sh:86` reads
 *     `OPENCLAW_TAG:-2026.5.27`, so the resolved default is the frozen
 *     `2026.5.27`, not `latest`.
 *   - Contract 2 is RED: `2026.5.27` appears in smoke-gateway-load.sh,
 *     smoke-gateway-load.integration.test.ts, wake-pump.ts, and
 *     0015-gateway-runtime-load-vs-armed-axis.md.
 *
 * DO NOT weaken these assertions to make a stale pin pass. The fix is to
 * float the gateway-gate default to `latest` and reframe the narrative to
 * "the latest openclaw gateway image" (re-confirming any genuine empirical
 * datapoint on 2026.6.9, labelled as such). That is the whole point of the
 * founder bounce.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → src → adapters/openclaw
const ADAPTER_ROOT = join(HERE, "..", "..");
// adapters/openclaw → adapters → repo root
const REPO_ROOT = join(ADAPTER_ROOT, "..", "..");

const GATEWAY_SMOKE_SCRIPT = join(
  ADAPTER_ROOT,
  "scripts",
  "smoke-gateway-load.sh",
);

/**
 * The PR #19 changed-file set (`git diff --stat origin/dev...HEAD`). The
 * `2026.5.27`-de-hardcode contract applies to exactly these files — the
 * ones this PR introduced or edited. Deliberately enumerated (not a live
 * `git diff` shell-out) so the guard is a static, deterministic, docker-
 * free unit test that runs in the default `pnpm test` loop. Pre-existing
 * 2026.5.27 references OUTSIDE this PR (ADR-0014, check-openclaw-manifest-
 * tools.sh, manifest-activation.test.ts) are out of scope — they belong to
 * other cards and are not this PR's to rewrite.
 */
const PR_DIFF_FILES: string[] = [
  "adapters/openclaw/scripts/smoke-gateway-load.sh",
  "adapters/openclaw/src/__tests__/service/wake-pump-detection.test.ts",
  "adapters/openclaw/src/__tests__/service/wake-pump-retry.test.ts",
  "adapters/openclaw/src/__tests__/smoke-gateway-load.integration.test.ts",
  "adapters/openclaw/src/service/wake-pump.ts",
  "docs/decisions/0015-gateway-runtime-load-vs-armed-axis.md",
  "docs/decisions/INDEX.md",
];

/** The frozen pin the founder names for removal. */
const FROZEN_PIN = "2026.5.27";

/**
 * Extract the resolved DEFAULT of `OPENCLAW_TAG` from the script — the
 * value the gate boots when `OPENCLAW_TAG` is unset. Matches the
 * `readonly TAG="${OPENCLAW_TAG:-<default>}"` shell-default form without
 * running bash, so the contract is asserted statically. Returns null if
 * the assignment shape isn't found (which is itself a failure the caller
 * surfaces).
 */
function resolveDefaultTag(scriptBody: string): string | null {
  // Match: TAG="${OPENCLAW_TAG:-<default>}"  (readonly optional, ws-tolerant)
  const m = scriptBody.match(
    /TAG="\$\{OPENCLAW_TAG:-([^}"]+)\}"/,
  );
  return m ? m[1].trim() : null;
}

describe("gateway-load smoke gate tracks the latest openclaw image (no frozen pin)", () => {
  it("the gateway smoke script exists (sanity: the guard is not vacuous)", () => {
    expect(
      existsSync(GATEWAY_SMOKE_SCRIPT),
      `${GATEWAY_SMOKE_SCRIPT} does not exist — the gateway smoke gate this ` +
        "guard pins is missing.",
    ).toBe(true);
  });

  it("smoke-gateway-load.sh defaults OPENCLAW_TAG to the floating `latest` tag, not a frozen 2026.x.y", () => {
    const body = readFileSync(GATEWAY_SMOKE_SCRIPT, "utf8");
    const def = resolveDefaultTag(body);

    expect(
      def,
      "Could not find the `readonly TAG=\"${OPENCLAW_TAG:-<default>}\"` " +
        "default-resolution line in smoke-gateway-load.sh. The gate must " +
        "resolve its image tag from OPENCLAW_TAG with a default — keep that " +
        "shape and make the default `latest`.",
    ).not.toBeNull();

    // The default must be the floating `latest`, not a frozen calendar tag.
    // Founder policy: the gateway gate always boots the NEWEST published
    // openclaw; OPENCLAW_TAG stays the override seam for a one-off run.
    expect(
      def,
      `smoke-gateway-load.sh defaults OPENCLAW_TAG to "${def}". The gateway ` +
        "gate must default to the floating `latest` tag so it always boots " +
        "the newest published openclaw (the bug reproduces on the current " +
        "latest, 2026.6.9, so detection still holds). OPENCLAW_TAG remains " +
        "the override seam for a one-off specific tag.",
    ).toBe("latest");

    // Belt-and-braces: the default must not be a frozen calendar tag of any
    // 2026.x.y shape — catches a re-pin to 2026.6.9 or any other dated value
    // slipping back into the DEFAULT position.
    expect(
      /^\d{4}\.\d+\.\d+$/.test(def ?? ""),
      `smoke-gateway-load.sh defaults OPENCLAW_TAG to the frozen calendar ` +
        `tag "${def}". A frozen pin in the default position is exactly the ` +
        "founder bounce — float it to `latest`.",
    ).toBe(false);
  });
});

describe("no 2026.5.27 literal survives in the PR-diff files (drop the fixed pin)", () => {
  it.each(PR_DIFF_FILES.map((rel) => [rel]))(
    "%s carries no 2026.5.27 literal",
    (rel) => {
      const abs = join(REPO_ROOT, rel);
      // The file must exist — a path regression that voided the sweep would
      // otherwise let a stale pin survive undetected.
      expect(
        existsSync(abs),
        `${rel} (a PR #19 changed file) is missing — the de-hardcode sweep ` +
          "would silently skip it. Fix the path; do not drop the file from " +
          "the guard.",
      ).toBe(true);

      const body = readFileSync(abs, "utf8");
      const lines = body.split("\n");
      const offending = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes(FROZEN_PIN));

      expect(
        offending,
        `${rel} still contains the frozen pin ${FROZEN_PIN} on line(s) ` +
          `${offending.map((o) => o.n).join(", ")}:\n` +
          offending.map((o) => `  ${o.n}: ${o.line.trim()}`).join("\n") +
          "\nFounder policy: drop the 2026.5.27 pin entirely. Where the " +
          "reference is a gate/default/assertion, float it to `latest`. " +
          "Where it is a genuine dated empirical datapoint, re-confirm it on " +
          "2026.6.9 and label it as an illustrative observation " +
          "(`observed on 2026.6.9 (latest at time of writing)`) — never a " +
          "value the code keys on.",
      ).toEqual([]);
    },
  );
});
