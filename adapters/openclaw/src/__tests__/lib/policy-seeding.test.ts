/**
 * Tests for adapters/openclaw/src/lib/policy-seeding.ts
 *
 * Covers the non-destructive seed contract for negotiation_style.md
 * and security.md, plus the placeholder-detection predicate that the
 * setup-status flow uses to decide whether the user has filled the
 * negotiation style template.
 *
 * The bundled templates live at the monorepo's `skill/` (see
 * getBundledSkillDir() in paths.ts → adapters/openclaw/skill/ when
 * compiled via dist/, but resolves to repo-root skill/ in source).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  isNegotiationStyleFilled,
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../../lib/policy-seeding.js";
import {
  getNegotiationStylePath,
  getSecurityPolicyPath,
} from "../../lib/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
});

describe("seedNegotiationStyleIfAbsent", () => {
  it("creates the file with the bundled template when absent", () => {
    expect(existsSync(getNegotiationStylePath())).toBe(false);
    const seeded = seedNegotiationStyleIfAbsent();
    expect(seeded).toBe(true);
    expect(existsSync(getNegotiationStylePath())).toBe(true);
  });

  it("returns false and leaves the file untouched on the second call", () => {
    expect(seedNegotiationStyleIfAbsent()).toBe(true);
    writeFileSync(getNegotiationStylePath(), "user-edited content");
    expect(seedNegotiationStyleIfAbsent()).toBe(false);
    expect(readFileSync(getNegotiationStylePath(), "utf-8")).toBe(
      "user-edited content",
    );
  });

  it("creates the policies dir if missing", () => {
    // createTempHome already makes policies/, but the seed function
    // also has to be safe when run on a freshly-created klodi home.
    expect(seedNegotiationStyleIfAbsent()).toBe(true);
    expect(existsSync(getNegotiationStylePath())).toBe(true);
  });
});

describe("seedSecurityPolicyIfAbsent", () => {
  it("creates the file with the bundled security policy when absent", () => {
    expect(existsSync(getSecurityPolicyPath())).toBe(false);
    const seeded = seedSecurityPolicyIfAbsent();
    expect(seeded).toBe(true);
    expect(existsSync(getSecurityPolicyPath())).toBe(true);
  });

  it("returns false and leaves the file untouched on the second call", () => {
    expect(seedSecurityPolicyIfAbsent()).toBe(true);
    writeFileSync(getSecurityPolicyPath(), "edited policy");
    expect(seedSecurityPolicyIfAbsent()).toBe(false);
    expect(readFileSync(getSecurityPolicyPath(), "utf-8")).toBe(
      "edited policy",
    );
  });
});

describe("isNegotiationStyleFilled", () => {
  it("returns false when the file is absent", () => {
    expect(isNegotiationStyleFilled()).toBe(false);
  });

  it("returns false on the freshly-seeded template", () => {
    seedNegotiationStyleIfAbsent();
    expect(isNegotiationStyleFilled()).toBe(false);
  });

  it("returns false while any '<e.g., ...>' placeholder remains", () => {
    writeFileSync(
      getNegotiationStylePath(),
      "Posture: firm\n\nLogistics: <e.g., USPS>\n",
    );
    expect(isNegotiationStyleFilled()).toBe(false);
  });

  it("returns false while the literal posture sentinel survives", () => {
    writeFileSync(
      getNegotiationStylePath(),
      "Posture:\nfirm | flexible | aggressive\n\nLogistics: USPS\n",
    );
    expect(isNegotiationStyleFilled()).toBe(false);
  });

  it("returns true when every placeholder has been replaced", () => {
    writeFileSync(
      getNegotiationStylePath(),
      [
        "Posture: flexible",
        "",
        "Authorization overrides: yes for buyers",
        "",
        "Always-Ask: bulk discounts",
        "",
        "Logistics: USPS, pickup near 94110",
        "",
        "Communication: friendly tone, 1-day SLA",
      ].join("\n") + "\n",
    );
    expect(isNegotiationStyleFilled()).toBe(true);
  });
});
