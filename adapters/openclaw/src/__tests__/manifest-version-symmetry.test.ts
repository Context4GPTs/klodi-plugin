/**
 * RED guard for: "Reconcile openclaw package/manifest version drift".
 *
 * Two files each carry a version, but only ONE is the source of truth:
 *   - `adapters/openclaw/package.json` `.version` is the single source of
 *     version truth — npm publishes the package from it.
 *   - `adapters/openclaw/openclaw.plugin.json` `.version` is a SEPARATE
 *     top-level field that OpenClaw / the plugin registry reads as THE
 *     plugin version.
 * These must always be byte-equal. They have drifted: package.json is
 * `0.3.1`, the manifest is `0.3.0`. The registry flagged this as
 * `package-manifest-version-drift` and DISABLED the openclaw target.
 *
 * Root cause (card root-cause section): `adapters/openclaw/scripts/
 * stamp-version.mjs` only rewrites the pinned-tag GitHub URLs in the
 * manifest, never the manifest's own `.version` field. So the bump to
 * 0.3.1 in package.json left the manifest stranded at 0.3.0 — silent drift
 * the registry later rejected.
 *
 * Acceptance criterion ([unit]):
 *   "Given the checked-in adapters/openclaw/package.json and
 *    adapters/openclaw/openclaw.plugin.json, when their `.version` fields
 *    are read, then they are byte-equal and both are a bare X.Y.Z semver —
 *    so the package the world installs and the plugin version the registry
 *    enables can never disagree."
 *
 * This is a PURE STATIC READ of the two checked-in JSON files — no docker,
 * no publish stage, no network. It runs in the default fast
 * `pnpm -C adapters/openclaw test` loop, so the drift is caught at test
 * time, long before publish.
 *
 * RED EXPECTATION (against the current committed state): the manifest is
 * `0.3.0` and package.json is `0.3.1`, so the equality assertion is RED
 * right now ("0.3.0" !== "0.3.1"). The fix (expert-developer's job, NOT
 * this test's) extends stamp-version.mjs to stamp the manifest `.version`
 * field from package.json and bumps both to 0.3.2 — which turns this GREEN.
 *
 * DO NOT weaken this test to make the drift pass. A failure here is fixed by
 * running `pnpm -C adapters/openclaw stamp-version` (which DERIVES the
 * manifest version from package.json, the source of truth) and committing
 * the regenerated manifest — NEVER by hand-editing openclaw.plugin.json to
 * match. Hand-editing the manifest re-creates the exact class of drift this
 * card exists to kill: it makes the two agree once, by luck, while leaving
 * the generator that should keep them in lockstep still broken.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → src → adapters/openclaw
const ADAPTER_ROOT = join(HERE, "..", "..");
const PACKAGE_JSON_PATH = join(ADAPTER_ROOT, "package.json");
const MANIFEST_PATH = join(ADAPTER_ROOT, "openclaw.plugin.json");

/** A bare X.Y.Z semver — no pre-release, no build metadata, no `v` prefix. */
const BARE_SEMVER = /^\d+\.\d+\.\d+$/;

interface Versioned {
  version?: unknown;
}

function readVersion(path: string): unknown {
  return (JSON.parse(readFileSync(path, "utf8")) as Versioned).version;
}

describe("openclaw package/manifest version symmetry (no publish-blocking drift)", () => {
  it("package.json#version is a bare X.Y.Z semver string (the source of truth is well-formed)", () => {
    // Sanity: package.json `.version` is what npm publishes from and what
    // the manifest derives FROM. If it were missing, non-string, or a
    // non-semver, the equality assertion below could pass vacuously
    // (e.g. undefined === undefined) while the published version is garbage.
    // Pin the source of truth before pinning the relationship to it.
    const pkgVersion = readVersion(PACKAGE_JSON_PATH);
    expect(
      typeof pkgVersion,
      "adapters/openclaw/package.json `.version` must be a string — it is " +
        "the single source of version truth that npm publishes from.",
    ).toBe("string");
    expect(
      BARE_SEMVER.test(pkgVersion as string),
      "adapters/openclaw/package.json .version is " +
        `"${String(pkgVersion)}", which is not a bare X.Y.Z semver. The ` +
        "published version (and the manifest version derived from it) must " +
        "be a clean X.Y.Z.",
    ).toBe(true);
  });

  it("openclaw.plugin.json#version === package.json#version (manifest tracks the source of truth)", () => {
    // THE CORE SYMMETRY ASSERTION. package.json is the source of truth;
    // the manifest version must equal it exactly. Drift here is what the
    // registry rejects as `package-manifest-version-drift` — it disabled
    // the openclaw target over precisely this mismatch.
    const pkgVersion = readVersion(PACKAGE_JSON_PATH);
    const manifestVersion = readVersion(MANIFEST_PATH);
    expect(
      manifestVersion,
      "openclaw.plugin.json .version " +
        `("${String(manifestVersion)}") must equal package.json .version ` +
        `("${String(pkgVersion)}"). package.json is the SOURCE OF TRUTH ` +
        "(npm publishes from it); the manifest version the registry reads " +
        "must be derived from it. They have drifted — the registry flagged " +
        "`package-manifest-version-drift` and disabled the openclaw target. " +
        "Fix by running `pnpm -C adapters/openclaw stamp-version` (which " +
        "stamps the manifest version FROM package.json) and committing the " +
        "regenerated manifest — NEVER by hand-editing the manifest to match.",
    ).toBe(pkgVersion);
  });
});
