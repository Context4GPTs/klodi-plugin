/**
 * Guard: the openclaw ClawHub publish scripts must never pass --owner.
 * The package is org-scoped (@4gpts/klodi, owned by 4gpts), so an explicit
 * --owner injects a conflicting ownerHandle into packages:publishRelease and
 * crashes it with a bare [CONVEX A(packages:publishRelease)] Server Error.
 * This fails while the flag is present (RED) and passes once it is deleted.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = join(HERE, "..", "..");

const pkg = JSON.parse(
  readFileSync(join(ADAPTER_ROOT, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

describe("openclaw clawhub publish scripts never pass --owner", () => {
  it("publish:clawhub does not contain --owner", () => {
    expect(pkg.scripts["publish:clawhub"]).not.toContain("--owner");
  });

  it("publish:clawhub:dry does not contain --owner", () => {
    expect(pkg.scripts["publish:clawhub:dry"]).not.toContain("--owner");
  });
});
