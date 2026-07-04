/**
 * RED/ratchet — the nats_ca path adds a CA SOURCE, never a verify toggle (ts).
 *
 * Card: auto-trust-nats-ca-from-register — cross-cutting invariant.
 *
 * Extends the verify-off ratchet to the NEW nats_ca surface (tls.ts persist +
 * level-2 resolve, its index.ts export, and the openclaw persist site) so the
 * register-CA path can introduce no `rejectUnauthorized:false`, no
 * `NODE_TLS_REJECT_UNAUTHORIZED` write, and no env var **or wire field** that
 * toggles verification off.
 *
 * Two clauses:
 *   - verify-off scan (GREEN ratchet) — the new files carry no disabling token.
 *   - persist-site symmetry (RED driver) — the openclaw persist site wires the
 *     shared `persistNatsCa` helper (TS half of the six-adapter symmetry).
 *
 * Needles assembled from fragments; quotes/whitespace/backticks stripped so a
 * docstring that *names* a token can't form the contiguous needle.
 *
 * QA-owned. NEVER weaken.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("pnpm-workspace.yaml not found above this test");
}

const ROOT = repoRoot();

// NEW / touched nats_ca code paths in the ts family.
const NATS_CA_FILES = [
  join(ROOT, "packages/nats-client-ts/src/tls.ts"),
  join(ROOT, "packages/nats-client-ts/src/index.ts"),
  join(ROOT, "adapters/openclaw/src/tools/register-poller.ts"),
];

const REJECT_UNAUTH = "reject" + "Unauthorized";
const NODE_TLS_ENV = "NODE_TLS_" + "REJECT_UNAUTHORIZED";
const ENV_TOGGLES = [
  "INSEC" + "URE",
  "NO_" + "VERIFY",
  "SKIP_" + "VERIFY",
  "DISABLE_" + "TLS",
  "ALLOW_" + "PLAINTEXT",
  "NO_" + "TLS",
];

function stripped(path: string): string {
  return readFileSync(path, "utf-8").replace(/[\s"'`]/g, "");
}

describe("nats_ca path — no verify-off toggle (ts)", () => {
  it("all scan targets exist", () => {
    const missing = NATS_CA_FILES.filter((p) => !existsSync(p));
    expect(missing, `scan targets missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("never sets rejectUnauthorized to false in the nats_ca path", () => {
    for (const path of NATS_CA_FILES) {
      const code = stripped(path);
      expect(code.includes(`${REJECT_UNAUTH}:false`), path).toBe(false);
      expect(code.includes(`${REJECT_UNAUTH}=false`), path).toBe(false);
    }
  });

  it("never touches the NODE_TLS_REJECT_UNAUTHORIZED backdoor", () => {
    for (const path of NATS_CA_FILES) {
      expect(readFileSync(path, "utf-8").includes(NODE_TLS_ENV), path).toBe(false);
    }
  });

  it("exposes no env var / wire field that can disable verification", () => {
    for (const path of NATS_CA_FILES) {
      const raw = readFileSync(path, "utf-8");
      for (const frag of ENV_TOGGLES) {
        expect(raw.includes(frag), `${path} references ${frag}`).toBe(false);
      }
    }
  });

  it("[symmetry] the openclaw persist site wires the shared persistNatsCa helper", () => {
    const site = join(ROOT, "adapters/openclaw/src/tools/register-poller.ts");
    expect(
      readFileSync(site, "utf-8").includes("persistNatsCa("),
      "register-poller.ts must wire persistNatsCa — else openclaw never auto-trusts",
    ).toBe(true);
  });
});
