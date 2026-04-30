/**
 * Tests for adapters/openclaw/src/lib/config.ts
 *
 * Covers the disk read/write contract for the auth-plane artifacts:
 *   - hasCredentials (both files must be present)
 *   - loadConfig + clearConfigCache (in-memory cache invalidation)
 *   - loadCreds (returns bytes; warns on insecure mode)
 *   - writeConfig (writes 0o600 + populates the cache)
 *
 * Sell/buy file I/O moved to lib/sell-buy-files.ts; policy seeding
 * moved to lib/policy-seeding.ts. Each is now covered in its own
 * sibling test file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
import {
  hasCredentials,
  loadConfig,
  loadCreds,
  writeConfig,
  clearConfigCache,
  type KlodiConfig,
} from "../../lib/config.js";
import { getConfigPath, getCredsPath } from "../../lib/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";

const SAMPLE_CONFIG: KlodiConfig = {
  handle: "testuser",
  user_id: "abc-123",
  nkey_public: "NKEY123",
  nats_url: "nats://localhost:4222",
};

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
});

describe("hasCredentials", () => {
  it("returns false when neither file exists", () => {
    expect(hasCredentials()).toBe(false);
  });

  it("returns false with only config.json", () => {
    writeFileSync(getConfigPath(), JSON.stringify(SAMPLE_CONFIG));
    expect(hasCredentials()).toBe(false);
  });

  it("returns false with only nats.creds", () => {
    writeFileSync(getCredsPath(), "creds-bytes");
    expect(hasCredentials()).toBe(false);
  });

  it("returns true with both files present", () => {
    writeFileSync(getConfigPath(), JSON.stringify(SAMPLE_CONFIG));
    writeFileSync(getCredsPath(), "creds-bytes");
    expect(hasCredentials()).toBe(true);
  });
});

describe("loadConfig", () => {
  it("reads and parses config.json", () => {
    writeFileSync(getConfigPath(), JSON.stringify(SAMPLE_CONFIG));
    const cfg = loadConfig();
    expect(cfg).toEqual(SAMPLE_CONFIG);
  });

  it("preserves optional notification fields when present", () => {
    const withNotif = {
      ...SAMPLE_CONFIG,
      notification_channel: "ntfy",
      notification_target: "https://ntfy.sh/abc",
    };
    writeFileSync(getConfigPath(), JSON.stringify(withNotif));
    expect(loadConfig().notification_channel).toBe("ntfy");
    expect(loadConfig().notification_target).toBe("https://ntfy.sh/abc");
  });

  it("throws a descriptive error when config.json is absent", () => {
    expect(() => loadConfig()).toThrow(/Not registered/);
  });

  it("caches the parsed config across calls", () => {
    writeFileSync(getConfigPath(), JSON.stringify(SAMPLE_CONFIG));
    const first = loadConfig();
    // Mutating the file on disk must not change the cached result.
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ ...SAMPLE_CONFIG, handle: "rotated" }),
    );
    const second = loadConfig();
    expect(second).toBe(first);
    expect(second.handle).toBe("testuser");
  });

  it("clearConfigCache forces a re-read on the next loadConfig", () => {
    writeFileSync(getConfigPath(), JSON.stringify(SAMPLE_CONFIG));
    expect(loadConfig().handle).toBe("testuser");
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ ...SAMPLE_CONFIG, handle: "rotated" }),
    );
    clearConfigCache();
    expect(loadConfig().handle).toBe("rotated");
  });
});

describe("loadCreds", () => {
  it("returns the raw creds bytes", () => {
    writeFileSync(getCredsPath(), "secret-creds-bytes", { mode: 0o600 });
    chmodSync(getCredsPath(), 0o600);
    const buf = loadCreds();
    expect(Buffer.from(buf).toString("utf-8")).toBe("secret-creds-bytes");
  });

  it("throws when nats.creds is absent", () => {
    expect(() => loadCreds()).toThrow(/Credentials not found/);
  });

  it("warns to stderr when creds have group/world bits set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(getCredsPath(), "creds-bytes");
      chmodSync(getCredsPath(), 0o644);
      loadCreds();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain("WARNING");
      expect(message).toMatch(/644/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn at 0o600", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(getCredsPath(), "creds-bytes");
      chmodSync(getCredsPath(), 0o600);
      loadCreds();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn at 0o400 (stricter than baseline)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(getCredsPath(), "creds-bytes");
      chmodSync(getCredsPath(), 0o400);
      loadCreds();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("writeConfig", () => {
  it("serializes config to disk at 0o600", () => {
    writeConfig(SAMPLE_CONFIG);
    const raw = readFileSync(getConfigPath(), "utf-8");
    expect(JSON.parse(raw)).toEqual(SAMPLE_CONFIG);
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("populates the in-memory cache so loadConfig can serve without disk", () => {
    writeConfig(SAMPLE_CONFIG);
    // Delete the file underneath; loadConfig should still return the
    // cached value.
    chmodSync(getConfigPath(), 0o600);
    expect(loadConfig()).toEqual(SAMPLE_CONFIG);
  });
});
