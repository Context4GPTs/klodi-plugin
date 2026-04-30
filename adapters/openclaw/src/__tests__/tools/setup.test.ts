/**
 * Tests for adapters/openclaw/src/tools/setup.ts
 *
 * Covers klodi_setup_status (phase derivation + issue/next-step
 * surfaces), klodi_setup_repair (delete creds + config, drain pump,
 * clear cache), klodi_setup_reseed_policies, and
 * klodi_setup_reseed_skill.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import {
  writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { registerSetupTools } from "../../tools/setup.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import {
  getCredsPath,
  getConfigPath,
  getKlodiHome,
  getNegotiationStylePath,
  getSecurityPolicyPath,
} from "../../lib/paths.js";
import { writeConfig } from "../../lib/config.js";
import {
  seedNegotiationStyleIfAbsent,
  seedSecurityPolicyIfAbsent,
} from "../../lib/policy-seeding.js";
import {
  mockNatsResponse,
  clearNatsResponses,
  setConnected,
} from "../helpers/mock-nats.js";

let temp: TempHome;
let api: ReturnType<typeof createMockPluginApi>;

function asReady(): void {
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester", user_id: "uid-1",
    nkey_public: "NKEY", nats_url: "wss://example.test:4443",
  });
  seedNegotiationStyleIfAbsent();
  // Replace the template body with a filled version so isNegotiationStyleFilled passes.
  writeFileSync(
    getNegotiationStylePath(),
    [
      "Posture: flexible",
      "Authorization overrides: yes",
      "Always-Ask: bulk",
      "Logistics: USPS",
      "Communication: friendly",
    ].join("\n") + "\n",
  );
  seedSecurityPolicyIfAbsent();
  setConnected(true);
  mockNatsResponse("p2p.v1.users.whoami", { handle: "tester" });
}

beforeEach(() => {
  temp = createTempHome();
  api = createMockPluginApi();
  registerSetupTools(api);
  clearNatsResponses();
});

afterEach(() => temp.cleanup());

describe("klodi_setup_status", () => {
  it("phase=unregistered on a fresh install", async () => {
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("unregistered");
    expect(data.next_step).toContain("klodi_register");
    expect(
      data.issues.some((i: { code: string }) => i.code === "not_registered"),
    ).toBe(true);
  });

  it("phase=corrupt when creds exist but config is missing", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("corrupt");
    expect(data.next_step).toContain("klodi_setup_repair");
  });

  it("phase=corrupt when config.json is invalid (missing required fields)", async () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    writeFileSync(getConfigPath(), JSON.stringify({ handle: "x" }));
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("corrupt");
  });

  it("phase=degraded when NATS is disconnected", async () => {
    asReady();
    setConnected(false);
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("degraded");
  });

  it("phase=needs_policy when security.md is missing", async () => {
    asReady();
    // Wipe security policy.
    unlinkSync(getSecurityPolicyPath());
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("needs_policy");
    expect(
      data.issues.some(
        (i: { code: string }) => i.code === "policy_files_missing",
      ),
    ).toBe(true);
  });

  it("phase=needs_policy when negotiation_style is unfilled", async () => {
    asReady();
    // Re-write the negotiation style file with a placeholder so
    // isNegotiationStyleFilled returns false.
    writeFileSync(
      getNegotiationStylePath(),
      "Posture: <e.g., firm>\n",
    );
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("needs_policy");
    expect(
      data.issues.some((i: { code: string }) => i.code === "policy_unfilled"),
    ).toBe(true);
  });

  it("phase=ready when everything is green", async () => {
    asReady();
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.phase).toBe("ready");
    expect(data.issues).toEqual([]);
    expect(data.next_step).toContain("Setup complete");
  });

  it("includes a creds_perms warning when nats.creds has world bits", async () => {
    asReady();
    chmodSync(getCredsPath(), 0o644);
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(
      data.issues.some((i: { code: string }) => i.code === "creds_perms"),
    ).toBe(true);
  });
});

describe("klodi_setup_status: config_source", () => {
  it("reports klodi_home_source='config' when pluginConfig sets klodi_home", async () => {
    api = createMockPluginApi({
      pluginConfig: { klodi_home: getKlodiHome() },
    });
    registerSetupTools(api);
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.config.klodi_home_source).toBe("config");
  });

  it("reports api_url_source='default' when neither pluginConfig nor env is set", async () => {
    delete process.env["KLODI_API_URL"];
    const tool = getTool(api, "klodi_setup_status");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.config.api_url_source).toBe("default");
  });
});

describe("klodi_setup_repair", () => {
  it("removes nats.creds and config.json when present", async () => {
    asReady();
    expect(existsSync(getCredsPath())).toBe(true);
    expect(existsSync(getConfigPath())).toBe(true);
    const tool = getTool(api, "klodi_setup_repair");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.removed).toEqual(
      expect.arrayContaining([getCredsPath(), getConfigPath()]),
    );
    expect(existsSync(getCredsPath())).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("never touches sell/, buy/, or policies/", async () => {
    asReady();
    writeFileSync(join(temp.sellDir, "x.md"), "sell content");
    writeFileSync(join(temp.buyDir, "y.md"), "buy content");
    const tool = getTool(api, "klodi_setup_repair");
    await tool.execute("call-1", {});
    expect(existsSync(join(temp.sellDir, "x.md"))).toBe(true);
    expect(existsSync(join(temp.buyDir, "y.md"))).toBe(true);
    expect(existsSync(getNegotiationStylePath())).toBe(true);
    expect(existsSync(getSecurityPolicyPath())).toBe(true);
  });

  it("is a no-op when creds/config are already absent", async () => {
    const tool = getTool(api, "klodi_setup_repair");
    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text!);
    expect(data.removed).toEqual([]);
  });
});

describe("klodi_setup_reseed_policies", () => {
  it("seeds both files when absent", async () => {
    const tool = getTool(api, "klodi_setup_reseed_policies");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.negotiation_style_seeded).toBe(true);
    expect(data.security_policy_seeded).toBe(true);
    expect(existsSync(getNegotiationStylePath())).toBe(true);
    expect(existsSync(getSecurityPolicyPath())).toBe(true);
  });

  it("does not overwrite a user-customized negotiation_style.md", async () => {
    seedNegotiationStyleIfAbsent();
    writeFileSync(getNegotiationStylePath(), "user content");
    const tool = getTool(api, "klodi_setup_reseed_policies");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(data.negotiation_style_seeded).toBe(false);
    expect(readFileSync(getNegotiationStylePath(), "utf-8")).toBe(
      "user content",
    );
  });
});

describe("klodi_setup_reseed_skill", () => {
  it("force-copies the bundled skill bundle into ${klodi_home}/skill/", async () => {
    const tool = getTool(api, "klodi_setup_reseed_skill");
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text!);
    expect(Array.isArray(data.reseeded_files)).toBe(true);
    expect(data.reseeded_files.length).toBeGreaterThan(0);
    expect(existsSync(join(getKlodiHome(), "skill"))).toBe(true);
  });
});
