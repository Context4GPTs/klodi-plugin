/**
 * RED guard for: "Load openclaw plugin at gateway startup".
 *
 * Root-cause assertion (static). On `alpine/openclaw:2026.5.27` the host
 * treats `openclaw.plugin.json` `.activation` as an authoritative LOAD
 * GATE: a plugin whose activation contract carries no startup trigger is
 * not activated when the gateway boots, so klodi's `register()` never
 * runs and klodi is absent from `gateway health --json` `plugins.loaded`.
 * Today `.activation` is `{ "onCapabilities": ["tool"] }` — a
 * capability-demand trigger that never fires at gateway boot — so klodi
 * does not load. (See the card root-cause section + ADR-0014's
 * "2026.4.15 tolerant / 2026.5.27 enforcing" version-gate class.)
 *
 * Acceptance criterion (card → Discovery findings, [unit] AC-1):
 *   "Given adapters/openclaw/openclaw.plugin.json, when its `.activation`
 *    block is read, then it declares a startup-firing trigger
 *    (`onStartup: true`) such that a tool-providing plugin is activated
 *    at gateway boot — and does NOT retain `onCapabilities: ["tool"]` as
 *    the sole trigger that never fires at startup on 2026.5.27."
 *
 * The fix (expert-developer's job, NOT this test's): replace the block
 * with `{ "onStartup": true }`, dropping `onCapabilities`.
 *
 * This is a pure static read of the checked-in manifest — no docker, no
 * publish stage, no network. It runs in the default fast
 * `pnpm -C adapters/openclaw test` loop.
 *
 * RED today (the manifest carries only `onCapabilities`). GREEN once the
 * expert flips `.activation` to a startup-firing trigger.
 *
 * DO NOT weaken this test to match the current manifest. Fix the
 * manifest — making the plugin actually load at gateway startup is the
 * whole point of the card.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → adapters/openclaw
const ADAPTER_ROOT = join(HERE, "..", "..");
const MANIFEST_PATH = join(ADAPTER_ROOT, "openclaw.plugin.json");

interface Manifest {
  activation?: {
    onStartup?: unknown;
    onCapabilities?: unknown;
    [key: string]: unknown;
  };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

describe("openclaw.plugin.json declares startup activation (loads at gateway boot)", () => {
  it("has an `.activation` block at all", () => {
    // Sanity: a missing block would make the assertions below vacuously
    // pass against `undefined`. The block must exist and be an object so
    // the host has a load contract to honour.
    const { activation } = readManifest();
    expect(activation, "openclaw.plugin.json must declare an `.activation` block").toBeDefined();
    expect(typeof activation).toBe("object");
  });

  it("`.activation.onStartup` is exactly `true` (the startup-firing trigger)", () => {
    // The single-variable proof in the signal log: overlaying
    // `activation: { onStartup: true }` onto the staged manifest makes
    // klodi load as the 9th plugin on 2026.5.27. This is the load gate
    // the user-visible contract depends on.
    const { activation } = readManifest();
    expect(
      activation?.onStartup,
      "`.activation.onStartup` must be `true` so a tool-providing plugin " +
        "is activated at gateway boot. On 2026.5.27 the host treats " +
        "`.activation` as an authoritative load gate; with no startup " +
        "trigger klodi never activates and is absent from " +
        "`gateway health --json` plugins.loaded.",
    ).toBe(true);
  });

  it("does NOT retain `onCapabilities` as the sole/leftover trigger", () => {
    // `onCapabilities: ["tool"]` is a capability-demand trigger that
    // never fires at gateway boot on 2026.5.27 — it is the exact bug.
    // The chosen fix drops it (a single unambiguous startup trigger
    // removes the double-activation surface; see card Risks: `register()`
    // is not idempotent against `api.registerTool`). Keeping it alongside
    // `onStartup` is ruled out unless the expert proves the live host
    // needs it AND adds a register-once guard — which would be a
    // deliberate, separately-justified change, not the default. This
    // test asserts the default chosen approach: `onCapabilities` is gone.
    const { activation } = readManifest();
    expect(
      activation && Object.prototype.hasOwnProperty.call(activation, "onCapabilities"),
      "`.activation.onCapabilities` must be dropped. It is a " +
        "capability-demand trigger that never fires at gateway boot on " +
        "2026.5.27 (the bug), and re-running `register()` on a second " +
        "activation would double-register every unguarded klodi_* tool. " +
        "Ship a single startup trigger.",
    ).toBe(false);
  });

  it("does not fall back to `onCapabilities` as the only trigger when onStartup is absent", () => {
    // Defends the precise failure mode the card names: a manifest whose
    // ONLY activation key is `onCapabilities` reads, to the 2026.5.27
    // host, as "activate me only when a tool capability is demanded" —
    // and at gateway boot nothing demands it. This assertion fails fast
    // and loud for that exact shape, independent of the two above, so a
    // partial edit (e.g. someone adds a different lazy trigger but
    // forgets onStartup) is still caught.
    const { activation } = readManifest();
    const keys = activation ? Object.keys(activation) : [];
    const hasStartupTrigger = activation?.onStartup === true;
    const onlyCapabilities = keys.length > 0 && keys.every((k) => k === "onCapabilities");
    expect(
      hasStartupTrigger && !onlyCapabilities,
      "`.activation` must carry a startup-firing trigger and must not " +
        `reduce to only capability-demand activation. Got keys: [${keys.join(", ")}].`,
    ).toBe(true);
  });
});
