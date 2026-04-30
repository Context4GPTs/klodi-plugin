/**
 * Tests for adapters/openclaw/src/lib/setup-state.ts
 *
 * The old src/__tests__/lib/setup-state.test.ts on main exclusively
 * locked down heartbeat-cadence validation; that field was removed in
 * the multi-host refactor (the host now owns wake routing — see plan
 * 0012). The replacement contract under test:
 *
 *   - SetupChecks: credentials_present, config_present, config_valid,
 *     creds_mode_secure, nats_connected, nats_whoami_ok, policy_seeded,
 *     policy_filled, security_policy_present.
 *   - derivePhase decision tree: unregistered → corrupt → degraded →
 *     needs_policy → ready, in that order of precedence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, chmodSync } from "node:fs";
import { createMockPluginApi } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import {
  derivePhase,
  gatherChecks,
  type SetupChecks,
} from "../../lib/setup-state.js";
import {
  getCredsPath,
  getConfigPath,
  getNegotiationStylePath,
  getSecurityPolicyPath,
} from "../../lib/paths.js";
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../../lib/policy-seeding.js";
import {
  mockNatsResponse,
  mockNatsError,
  clearNatsResponses,
  KlodiRequestError,
} from "../helpers/mock-nats.js";

const VALID_CONFIG = {
  handle: "testuser",
  user_id: "uid-123",
  nkey_public: "NKEY",
  nats_url: "nats://localhost:4222",
};

function greenChecks(overrides: Partial<SetupChecks> = {}): SetupChecks {
  const base: SetupChecks = {
    credentials_present: true,
    config_present: true,
    config_valid: true,
    creds_mode_secure: true,
    nats_connected: true,
    nats_whoami_ok: true,
    policy_seeded: true,
    policy_filled: true,
    security_policy_present: true,
  };
  return { ...base, ...overrides };
}

describe("derivePhase precedence", () => {
  it("returns 'unregistered' when neither creds nor config exist", () => {
    expect(
      derivePhase(greenChecks({
        credentials_present: false,
        config_present: false,
        config_valid: false,
      })),
    ).toBe("unregistered");
  });

  it("returns 'corrupt' when only creds exist (no config)", () => {
    expect(
      derivePhase(greenChecks({
        credentials_present: true,
        config_present: false,
        config_valid: false,
      })),
    ).toBe("corrupt");
  });

  it("returns 'corrupt' when only config exists (no creds)", () => {
    expect(
      derivePhase(greenChecks({
        credentials_present: false,
        config_present: true,
        config_valid: false,
      })),
    ).toBe("corrupt");
  });

  it("returns 'corrupt' when both files exist but config is invalid", () => {
    expect(
      derivePhase(greenChecks({ config_valid: false })),
    ).toBe("corrupt");
  });

  it("returns 'degraded' when NATS is disconnected", () => {
    expect(
      derivePhase(greenChecks({
        nats_connected: false,
        nats_whoami_ok: null,
      })),
    ).toBe("degraded");
  });

  it("returns 'degraded' when whoami probe failed", () => {
    expect(
      derivePhase(greenChecks({ nats_whoami_ok: false })),
    ).toBe("degraded");
  });

  it("ignores nats_whoami_ok=null when nats_connected=true (probe skipped)", () => {
    expect(
      derivePhase(greenChecks({ nats_whoami_ok: null })),
    ).toBe("ready");
  });

  it("returns 'needs_policy' when security policy is missing", () => {
    expect(
      derivePhase(greenChecks({ security_policy_present: false })),
    ).toBe("needs_policy");
  });

  it("returns 'needs_policy' when negotiation style not seeded", () => {
    expect(
      derivePhase(greenChecks({ policy_seeded: false })),
    ).toBe("needs_policy");
  });

  it("returns 'needs_policy' when negotiation style not filled", () => {
    expect(
      derivePhase(greenChecks({ policy_filled: false })),
    ).toBe("needs_policy");
  });

  it("returns 'ready' when every check is green", () => {
    expect(derivePhase(greenChecks())).toBe("ready");
  });

  it("'unregistered' wins over 'corrupt' / 'degraded' / 'needs_policy'", () => {
    expect(
      derivePhase(greenChecks({
        credentials_present: false,
        config_present: false,
        config_valid: false,
        nats_connected: false,
        nats_whoami_ok: null,
        security_policy_present: false,
        policy_seeded: false,
        policy_filled: false,
      })),
    ).toBe("unregistered");
  });

  it("'degraded' wins over 'needs_policy' (nats checked first)", () => {
    expect(
      derivePhase(greenChecks({
        nats_connected: false,
        nats_whoami_ok: null,
        security_policy_present: false,
      })),
    ).toBe("degraded");
  });
});

describe("gatherChecks", () => {
  let temp: TempHome;
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(() => {
    temp = createTempHome();
    api = createMockPluginApi();
    clearNatsResponses();
  });

  afterEach(() => temp.cleanup());

  it("reports unregistered state when nothing is on disk", async () => {
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.credentials_present).toBe(false);
    expect(checks.config_present).toBe(false);
    expect(checks.config_valid).toBe(false);
    expect(checks.creds_mode_secure).toBe(false);
    expect(checks.policy_seeded).toBe(false);
    expect(checks.security_policy_present).toBe(false);
  });

  it("flags creds_mode_secure=false on world-readable creds", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    chmodSync(getCredsPath(), 0o644);
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.credentials_present).toBe(true);
    expect(checks.creds_mode_secure).toBe(false);
  });

  it("accepts 0o600 mode as secure", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    chmodSync(getCredsPath(), 0o600);
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.creds_mode_secure).toBe(true);
  });

  it("accepts 0o400 (read-only owner) as secure", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    chmodSync(getCredsPath(), 0o400);
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.creds_mode_secure).toBe(true);
  });

  it("flags config_valid=false when JSON is missing required fields", async () => {
    writeFileSync(getConfigPath(), JSON.stringify({ handle: "x" }));
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.config_present).toBe(true);
    expect(checks.config_valid).toBe(false);
  });

  it("flags config_valid=true with the full canonical shape", async () => {
    writeFileSync(getConfigPath(), JSON.stringify(VALID_CONFIG));
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.config_valid).toBe(true);
  });

  it("policy_seeded reflects the negotiation style file", async () => {
    seedNegotiationStyleIfAbsent();
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.policy_seeded).toBe(true);
  });

  it("security_policy_present reflects the security policy file", async () => {
    seedSecurityPolicyIfAbsent();
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.security_policy_present).toBe(true);
  });

  it("skips the NATS probe when probe=false", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    chmodSync(getCredsPath(), 0o600);
    writeFileSync(getConfigPath(), JSON.stringify(VALID_CONFIG));
    const checks = await gatherChecks(api, { probe: false });
    expect(checks.nats_whoami_ok).toBe(null);
  });
});
