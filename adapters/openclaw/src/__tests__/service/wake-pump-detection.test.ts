/**
 * Detection matrix for `isGatewayRuntime()` in service/wake-pump.ts.
 *
 * Bug being locked (root cause B): the real `openclaw
 * gateway` daemon runs with `process.title === "openclaw"` (argv
 * rewritten, /proc/PID/cmdline empty), but the gate only matched
 * `process.title ∈ {"openclaw-gateway","openclaw-gatewa"}`. So the
 * gateway runtime evaluated to `false`, the pump skipped with no
 * recovery, and klodi was silently inert in production.
 *
 * THE SPEC THIS FILE PINS (the implementation serves it, not the other
 * way round):
 *   - The runtime is the OpenClaw gateway iff a POSITIVE gateway signal
 *     is present: the `gateway` subcommand token appears in process.argv
 *     at the subcommand position (`openclaw gateway [--bind lan]`).
 *     `process.title === "openclaw"` is NOT a positive signal — it is
 *     also the title of every other openclaw invocation whose subcommand
 *     isn't title-rewritten, so matching it would fail the gate OPEN.
 *   - The three genuine CLI contexts — `plugins`, `secrets`, `login` —
 *     carry their OWN subcommand token in argv, never `gateway`, so they
 *     MUST classify as non-gateway (skip).
 *   - `KLODI_GATEWAY_OVERRIDE=1` is the first-checked escape hatch and
 *     wins regardless of argv/title.
 *
 * SEAM (the implementation must provide it): `isGatewayRuntime` is
 * exported, and `__setGatewayRuntimeInputsForTests({ argv, title })`
 * overrides the argv/title the detector reads — so the matrix runs in
 * isolation without mutating the real `process.argv` (which vitest owns)
 * and without docker or NATS. Passing `null` restores the live process
 * values.
 *
 * RED EXPECTATION: with the current `process.title`-only logic (and no
 * export / no seam) this file fails to import — the contract it pins does
 * not exist yet. Once the detection fix lands, the gateway-runtime row
 * flips to `true` and the three CLI rows stay `false`. DO NOT relax any
 * row to make a broken implementation pass — the gateway-runtime row
 * going green is the whole point; a CLI row going green is a
 * fail-OPEN regression and must stay red against such an implementation.
 */

import {
  describe, it, expect, afterEach,
} from "vitest";
import {
  isGatewayRuntime,
  __setGatewayRuntimeInputsForTests,
} from "../../service/wake-pump.js";

/**
 * One row of the detection matrix. `argv` is the process.argv the
 * detector should read (full Node argv shape: [execPath, scriptPath,
 * ...userArgs]); `title` is process.title. `override` toggles
 * KLODI_GATEWAY_OVERRIDE. `expected` is the required isGatewayRuntime()
 * verdict.
 */
interface Row {
  name: string;
  argv: string[];
  title: string;
  override: "1" | undefined;
  expected: boolean;
}

// Real launch shapes. The daemon boots as `openclaw gateway [--bind lan]`
// (smoke-gateway-load.sh:156) and the kernel rewrites process.title to a
// bare "openclaw" for the long-lived daemon. The CLI subcommands carry
// their own token at the subcommand position.
const NODE = "/usr/bin/node";
const ENTRY = "/usr/lib/openclaw/cli.js";

const GATEWAY_ARGV = [NODE, ENTRY, "gateway", "--bind", "lan"];
const PLUGINS_ARGV = [NODE, ENTRY, "plugins", "install", "klodi"];
const SECRETS_ARGV = [NODE, ENTRY, "secrets", "set", "klodi.api_key"];
const LOGIN_ARGV = [NODE, ENTRY, "login", "--handle", "alice"];

const MATRIX: Row[] = [
  // The bug. Real gateway daemon: argv carries `gateway`, title is the
  // bare "openclaw" the kernel rewrote it to, override unset. MUST be
  // true — this row is RED against the current process.title gate and is
  // the row whose flip proves the fix.
  {
    name: "gateway runtime (argv has gateway, title=openclaw, no override)",
    argv: GATEWAY_ARGV,
    title: "openclaw",
    override: undefined,
    expected: true,
  },

  // The three genuine non-gateway CLI contexts. Each loads the plugin
  // only to verify/configure it and must NOT arm a wake subscription.
  // Their argv carries the subcommand token, never `gateway`.
  {
    name: "plugins install CLI (argv has plugins, no override) → skip",
    argv: PLUGINS_ARGV,
    title: "openclaw",
    override: undefined,
    expected: false,
  },
  {
    name: "secrets CLI (argv has secrets, no override) → skip",
    argv: SECRETS_ARGV,
    title: "openclaw",
    override: undefined,
    expected: false,
  },
  {
    name: "login CLI (argv has login, no override) → skip",
    argv: LOGIN_ARGV,
    title: "openclaw",
    override: undefined,
    expected: false,
  },

  // Override is the first-checked escape hatch: it wins even on a CLI
  // argv shape, regardless of title.
  {
    name: "override=1 on a plugins-install argv → arm anyway",
    argv: PLUGINS_ARGV,
    title: "openclaw",
    override: "1",
    expected: true,
  },
  {
    name: "override=1 on a gateway argv → arm",
    argv: GATEWAY_ARGV,
    title: "openclaw",
    override: "1",
    expected: true,
  },

  // Override absent on a gateway argv is the no-override gateway case —
  // detection alone (not the hatch) must carry it. Distinct from the
  // first row only in being asserted as the override-OFF control.
  {
    name: "override unset on gateway argv → detection alone arms",
    argv: GATEWAY_ARGV,
    title: "openclaw",
    override: undefined,
    expected: true,
  },
];

afterEach(() => {
  // Restore the live process argv/title and clear the override so no row
  // leaks into another test in this worker.
  __setGatewayRuntimeInputsForTests(null);
  delete process.env["KLODI_GATEWAY_OVERRIDE"];
});

describe("isGatewayRuntime detection matrix", () => {
  it.each(MATRIX)(
    "$name → $expected",
    ({ argv, title, override, expected }) => {
      if (override === undefined) {
        delete process.env["KLODI_GATEWAY_OVERRIDE"];
      } else {
        process.env["KLODI_GATEWAY_OVERRIDE"] = override;
      }
      __setGatewayRuntimeInputsForTests({ argv, title });

      expect(isGatewayRuntime()).toBe(expected);
    },
  );

  // Adversarial: a fail-OPEN guard. A naive fix that substring-matches
  // "gateway" anywhere in argv would arm during a CLI invocation whose
  // args merely contain the word — e.g. `plugins install gateway-tools`,
  // or a `--note "gateway down"` flag value. The detector must key off
  // the SUBCOMMAND POSITION, not a substring. These rows stay false.
  it("does NOT arm when 'gateway' appears only as a CLI argument value, not the subcommand", () => {
    delete process.env["KLODI_GATEWAY_OVERRIDE"];
    __setGatewayRuntimeInputsForTests({
      argv: [NODE, ENTRY, "plugins", "install", "gateway-helper"],
      title: "openclaw",
    });
    expect(isGatewayRuntime()).toBe(false);
  });

  it("does NOT arm when 'gateway' appears inside a flag value of a non-gateway subcommand", () => {
    delete process.env["KLODI_GATEWAY_OVERRIDE"];
    __setGatewayRuntimeInputsForTests({
      argv: [NODE, ENTRY, "secrets", "set", "--note", "the gateway is flaky"],
      title: "openclaw",
    });
    expect(isGatewayRuntime()).toBe(false);
  });

  // Adversarial: a fail-CLOSED guard against re-introducing a
  // title-based check. The gateway daemon's title is the bare
  // "openclaw"; if a future refactor regated on
  // `title === "openclaw-gateway"` the daemon would skip again — the
  // exact bug. The gateway-runtime row above already pins this, but make
  // the title-independence explicit: gateway argv with ANY title arms.
  it("arms on a gateway argv regardless of process.title (title is not the signal)", () => {
    delete process.env["KLODI_GATEWAY_OVERRIDE"];
    __setGatewayRuntimeInputsForTests({
      argv: GATEWAY_ARGV,
      title: "something-unexpected",
    });
    expect(isGatewayRuntime()).toBe(true);
  });
});
