/**
 * INVARIANT GUARD — cert/hostname verification is never disabled (ts).
 *
 * Card: support-tls-nats-transport-with-private-ca-trust — the CORE
 * security invariant. Fails the build if any insecure-TLS toggle appears in
 * the TS TLS connect path / persist code, or if an env flag can turn
 * verification off. `KLODI_NATS_CA_FILE` selects *which* CA to trust, never
 * *whether* to verify, so it is allowed.
 *
 * GREEN today (connectTcp passes `tls: { ca }` and never sets
 * `rejectUnauthorized: false`). This is a RATCHET, not a RED driver — it
 * must stay green as the TLS code evolves; it goes RED the moment
 * `rejectUnauthorized: false`, a `NODE_TLS_REJECT_UNAUTHORIZED` write, or a
 * verification-off env flag appears.
 *
 * The scan strips quotes/whitespace/backticks so `tls.ts`'s docstring (which
 * *names* `rejectUnauthorized` to document it is never false) can't trip the
 * guard, and the forbidden needles are assembled from fragments so this file
 * carries no literal forbidden token.
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

// TLS connect path + persist code across the ts family.
const SCANNED = [
  join(ROOT, "packages/nats-client-ts/src/client.ts"),
  join(ROOT, "packages/nats-client-ts/src/config.ts"),
  join(ROOT, "packages/nats-client-ts/src/tls.ts"),
  join(ROOT, "adapters/openclaw/src/tools/register-poller.ts"),
];

// Assembled from fragments so this file carries no literal forbidden token.
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

/** Strip whitespace, quotes and backticks so prose mentions of a token
 *  can't form the contiguous `token:false` / `token=false` needle. */
function stripped(path: string): string {
  return readFileSync(path, "utf-8").replace(/[\s"'`]/g, "");
}

describe("verification never disabled (ts)", () => {
  it("all scan targets exist", () => {
    const missing = SCANNED.filter((p) => !existsSync(p));
    expect(missing, `scan targets missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("never sets rejectUnauthorized to false", () => {
    for (const path of SCANNED) {
      const code = stripped(path);
      expect(
        code.includes(`${REJECT_UNAUTH}:false`),
        `${path} sets ${REJECT_UNAUTH}:false — forbidden`,
      ).toBe(false);
      expect(
        code.includes(`${REJECT_UNAUTH}=false`),
        `${path} sets ${REJECT_UNAUTH}=false — forbidden`,
      ).toBe(false);
    }
  });

  it("never touches the NODE_TLS_REJECT_UNAUTHORIZED global backdoor", () => {
    for (const path of SCANNED) {
      const raw = readFileSync(path, "utf-8");
      expect(
        raw.includes(NODE_TLS_ENV),
        `${path} references ${NODE_TLS_ENV} — the global verify-off backdoor`,
      ).toBe(false);
    }
  });

  it("exposes no env var that can disable verification", () => {
    for (const path of SCANNED) {
      const raw = readFileSync(path, "utf-8");
      for (const frag of ENV_TOGGLES) {
        expect(
          raw.includes(frag),
          `${path} references a verify-opt-out-shaped token (${frag})`,
        ).toBe(false);
      }
    }
  });
});
