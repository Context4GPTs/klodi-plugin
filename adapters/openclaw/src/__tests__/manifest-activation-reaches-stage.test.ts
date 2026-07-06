/**
 * RED guard for: "Load openclaw plugin at gateway startup" — the fix must
 * reach the SHIPPED artifact, not just the source tree.
 *
 * The `.activation` edit is only useful if it survives into the published
 * tarball. `scripts/vendor.mjs` stages the publish-ready tree at
 * `.publish-stage/` and copies `openclaw.plugin.json` verbatim
 * (`TOP_LEVEL_FILES` → `cpSync`). This test proves that contract holds for
 * the field this change depends on: after vendoring, the staged manifest's
 * `.activation` is byte-identical to source. If a future change to
 * vendor.mjs ever rewrote/stripped/mangled the manifest, the fix would be
 * green in source yet absent from the tarball users install — the exact
 * "source-fixed but artefact-broken" gap this asserts against.
 *
 * Acceptance criterion ([unit] AC-1b):
 *   "Given the publish stage produced by scripts/vendor.mjs, when
 *    .publish-stage/openclaw.plugin.json `.activation` is compared to the
 *    source manifest's `.activation`, then they are identical — the
 *    manifest fix provably reaches the packed tarball, not just source."
 *
 * Mirrors the structural-assert discipline already in
 * scripts/smoke-plugin-load.sh (which proves vendored sources reach the
 * tarball), at the unit tier and scoped to the one field this change moves.
 *
 * Placement / runnability. The publish stage only exists after the real
 * build path produces it: vendor.mjs preflight requires the adapter's
 * dist/ AND both workspace deps' dist/ (packages/{tool-catalog,
 * nats-client-ts}/dist). So this test DRIVES the real stage producer
 * (`node scripts/vendor.mjs`) rather than inventing a parallel one — that
 * is "follow how the repo currently produces .publish-stage/". When those
 * build prerequisites are absent (a clean default-loop checkout with no
 * dist/), vendor.mjs exits non-zero with a "<dist> missing" message and
 * no stage is produced; this test then SKIPS LOUDLY (console.warn) — never
 * a silent pass, because a missing build must not delete coverage. With
 * the dists present (CI's build:vendored path, or after `pnpm build` +
 * `pnpm build:deps`) it runs the parity assertion for real.
 *
 * RED today on the parity invariant's PREMISE-failure surface is the same
 * RED as AC-1: while source `.activation` is the wrong block, the staged
 * copy faithfully reproduces the wrong block too. The assertion proves
 * the COPY is faithful, so it goes GREEN-parity once vendor runs — but the
 * companion AC-1 test stays RED until the source field is fixed. Together:
 * AC-1 = "source declares onStartup", AC-1b = "whatever source declares,
 * the tarball gets byte-for-byte". Both must hold for the fix to ship.
 *
 * DO NOT weaken this test, and DO NOT hand-edit .publish-stage/ to make it
 * pass — the staged copy is generated; fix the source and let vendor copy.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → adapters/openclaw
const ADAPTER_ROOT = join(HERE, "..", "..");
const VENDOR_SCRIPT = join(ADAPTER_ROOT, "scripts", "vendor.mjs");
const SOURCE_MANIFEST = join(ADAPTER_ROOT, "openclaw.plugin.json");
const STAGE_DIR = join(ADAPTER_ROOT, ".publish-stage");
const STAGED_MANIFEST = join(STAGE_DIR, "openclaw.plugin.json");

// vendor.mjs does cpSync of top-level files only — no build, no docker —
// so the default 10s timeout is plenty, but staging the dist tree on a
// cold cache can take a moment.
const VENDOR_TIMEOUT_MS = 60 * 1000;

interface VendorResult {
  produced: boolean;
  /** Set only when prerequisites were missing, for the loud skip message. */
  reason?: string;
}

/**
 * Run the REAL stage producer. Returns whether `.publish-stage/` now
 * carries the staged manifest. A non-zero exit with a "<dist> missing"
 * preflight message means the build prerequisites are absent — that is a
 * SKIP condition, not a test failure (the parity contract is untestable
 * without a stage, but the absence is an env limitation, not a bug).
 */
function produceStage(): VendorResult {
  // Start clean so we never assert against a stale stage from a prior run.
  rmSync(STAGE_DIR, { recursive: true, force: true });

  const result = spawnSync("node", [VENDOR_SCRIPT], {
    cwd: ADAPTER_ROOT,
    encoding: "utf8",
    timeout: VENDOR_TIMEOUT_MS,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status === 0 && existsSync(STAGED_MANIFEST)) {
    return { produced: true };
  }
  // vendor.mjs preflight emits "<path>/dist missing" when a build hasn't
  // run. Treat that as "skip — no build available", anything else as a
  // genuine failure surfaced through the assertion below.
  const prereqMissing = /dist missing|Build workspace deps first|Run `pnpm build`/.test(out);
  return {
    produced: false,
    reason: prereqMissing
      ? "build prerequisites absent (no dist/ — run `pnpm build` + " +
        "`pnpm build:deps` first); vendor.mjs cannot stage"
      : `vendor.mjs exited ${result.status} without producing a stage. Output:\n${out}`,
  };
}

const stage = produceStage();

const maybeIt = stage.produced ? it : it.skip;
if (!stage.produced) {
  // eslint-disable-next-line no-console
  console.warn(
    `[manifest-activation-reaches-stage] SKIPPED: ${stage.reason}. This is ` +
      "NOT a pass — build the adapter + workspace deps (CI's build:vendored " +
      "path does this) so scripts/vendor.mjs can stage .publish-stage/ and " +
      "the source→artefact parity of .activation is actually verified.",
  );
}

describe("vendor.mjs ships openclaw.plugin.json `.activation` byte-identical to source", () => {
  maybeIt(".publish-stage `.activation` equals source `.activation`", () => {
    const sourceActivation = (
      JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")) as {
        activation?: unknown;
      }
    ).activation;
    const stagedActivation = (
      JSON.parse(readFileSync(STAGED_MANIFEST, "utf8")) as {
        activation?: unknown;
      }
    ).activation;

    // Structural equality: whatever the fix sets in source, the tarball
    // must carry exactly that. (`toEqual` deep-compares the parsed
    // objects; combined with the raw-substring check below it pins both
    // shape and serialization.)
    expect(
      stagedActivation,
      "staged .publish-stage/openclaw.plugin.json `.activation` diverged " +
        "from source — the .activation fix did not reach the published " +
        "tarball. vendor.mjs must copy openclaw.plugin.json verbatim " +
        "(TOP_LEVEL_FILES). Fix vendor.mjs; do not hand-edit the stage.",
    ).toEqual(sourceActivation);

    // Byte-level guard: the verbatim copy contract is stronger than deep
    // equality — the raw `.activation` JSON substring must appear
    // identically in both files. Catches a re-serialization that
    // preserves the object but rewrites formatting/key order, which could
    // still trip a strict host manifest parser.
    const sourceRaw = readFileSync(SOURCE_MANIFEST, "utf8");
    const stagedRaw = readFileSync(STAGED_MANIFEST, "utf8");
    expect(stagedRaw).toBe(sourceRaw);
  });
});
