/**
 * Tests for the photo-resolution behaviour folded into klodi_list_create
 * and klodi_list_update.
 *
 * The card "fold-uploads-into-listing-tools" replaces the standalone
 * klodi_assets_upload_url tool with adapter-internal handling: each
 * element of `params.photos` can be either an `http(s)://` URL (passed
 * through verbatim) or an absolute local filesystem path (validated,
 * content-sniffed, uploaded to R2, substituted with the returned
 * asset_url before listings.create / listings.update is dispatched).
 *
 * Tests are behavioural — they exercise the public tool API, never the
 * private helper. The developer chooses where the helper lives
 * (lib/photos.ts vs tools/listings.ts internals); tests don't care.
 *
 * Mocks (boundaries only):
 *   - lib/client.js  → mock-nats.ts          (NATS subjects)
 *   - globalThis.fetch                       (R2 PUT)
 *   - temp-home + temp files                 (filesystem)
 *
 * This file currently RED across the board — the production tool calls
 * `rawRequest(tool.subject, params)` with `params.photos` verbatim and
 * never validates or resolves a local path. The developer's job is to
 * green these by adding the resolution pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/client.js", () =>
  import("../helpers/mock-nats.js"),
);

import { registerListingTools } from "../../tools/listings.js";
import { createMockPluginApi, getTool } from "../helpers/mock-plugin-api.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.js";
import { getCredsPath } from "../../lib/paths.js";
import {
  clearNatsResponses,
  mockNatsResponse,
} from "../helpers/mock-nats.js";

// ── Fixture helpers ────────────────────────────────────────────────────

/** Minimal but valid magic-number byte sequences. */
const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_MAGIC = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const WEBP_MAGIC = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // size placeholder
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);
const PDF_MAGIC = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);

const LISTING_ID = "550e8400-e29b-41d4-a716-446655440000";

let temp: TempHome;
let fixtures: string;
let api: ReturnType<typeof createMockPluginApi>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Write a fixture file with the given bytes and return its absolute path. */
function writeFixture(name: string, bytes: Uint8Array): string {
  const path = join(fixtures, name);
  writeFileSync(path, bytes);
  return path;
}

/** Default fake — every PUT succeeds with 200/OK. */
function defaultFetchFake(): typeof globalThis.fetch {
  return vi.fn(async () => {
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(async () => {
  temp = createTempHome();
  fixtures = mkdtempSync(join(tmpdir(), "klodi-fixtures-"));
  writeFileSync(getCredsPath(), "creds-bytes");
  chmodSync(getCredsPath(), 0o600);
  writeConfig({
    handle: "tester",
    user_id: "uid-1",
    nkey_public: "NKEY",
    nats_url: "wss://example.test:4443",
  });
  api = createMockPluginApi();
  registerListingTools(api);
  clearNatsResponses();
  // The shared mock client in mock-nats.ts is a module-singleton —
  // clearNatsResponses() resets the registered responses but does NOT
  // reset mock call history. Without this, "toHaveBeenCalledTimes(N)"
  // assertions accumulate across tests in this file.
  const { getClient } = await import("../helpers/mock-nats.js");
  getClient().request.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    defaultFetchFake(),
  );
});

afterEach(() => {
  rmSync(fixtures, { recursive: true, force: true });
  temp.cleanup();
  vi.restoreAllMocks();
});

// ── URL pass-through — regression guard ────────────────────────────────

describe("klodi_list_create — URL pass-through (no upload occurs)", () => {
  it("forwards http(s) URLs verbatim and never mints / never PUTs", async () => {
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Existing URL listing",
      photos: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
    });
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-1", {
      title: "Existing URL listing",
      description: "two hosted URLs",
      category: "home",
      asking_price: 100_00,
      fulfillment: [{ method: "pickup" }],
      photos: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
    });

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).not.toHaveBeenCalled();

    const client = (await import("../helpers/mock-nats.js")).getClient();
    // Exactly one NATS call (listings.create); no upload-url mint occurred.
    expect(client.request).toHaveBeenCalledTimes(1);
    const [subject, payload] = client.request.mock.calls[0];
    expect(subject).toBe("p2p.v1.listings.create");
    expect((payload as { photos: string[] }).photos).toEqual([
      "https://cdn.example/a.jpg",
      "https://cdn.example/b.jpg",
    ]);
  });

  it("is a no-op when photos is undefined", async () => {
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "No-photos listing",
    });
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-2", {
      title: "No-photos listing",
      description: "digital",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "digital" }],
    });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).not.toHaveBeenCalled();
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toBe("p2p.v1.listings.create");
  });

  it("is a no-op when photos is the empty array", async () => {
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Empty array",
    });
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-3", {
      title: "Empty array",
      description: "digital",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "digital" }],
      photos: [],
    });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Error path — non-absolute / unreadable paths ───────────────────────

describe("klodi_list_create — local-path validation (unit)", () => {
  it("rejects a non-absolute path with a clear 'absolute path required' error", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-relpath", {
      title: "Bad relative path",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: ["./img.jpg"],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body.toLowerCase()).toContain("absolute path");
    expect(body).toContain("./img.jpg");
    // No NATS request, no fetch — we rejected before any I/O.
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a tilde-expansion path before any filesystem access", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-tilde", {
      title: "Bad tilde path",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: ["~/img.jpg"],
    });
    expect(result.isError).toBe(true);
    expect((result.content[0].text ?? "").toLowerCase()).toContain(
      "absolute path",
    );
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects a missing-file path with an error naming the path", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-missing", {
      title: "Missing file",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: ["/tmp/this-file-does-not-exist-987654.jpg"],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain("/tmp/this-file-does-not-exist-987654.jpg");
    expect(body.toLowerCase()).toMatch(/not.{0,12}read|not.{0,12}exist|missing|enoent/);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Error path — invalid content type ──────────────────────────────────

describe("klodi_list_create — content-type sniff (unit)", () => {
  it("rejects a PDF file (not on the allowlist)", async () => {
    const path = writeFixture("doc.pdf", PDF_MAGIC);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-pdf", {
      title: "Has PDF",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain(path);
    // Error mentions the rejected content type so the agent can act.
    expect(body.toLowerCase()).toMatch(
      /content.?type|application\/pdf|image\/jpeg|allow.?list/,
    );
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects on sniffed content type, not extension (PDF bytes in .jpg)", async () => {
    // ADR-0006 format-confusion gap: extension lies, bytes win.
    const path = writeFixture("sneaky.jpg", PDF_MAGIC);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-sneaky", {
      title: "Sneaky",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain(path);
    // The error must mention the sniffed type / mismatch — not just say
    // "rejected" — so the agent learns the actual cause.
    expect(body.toLowerCase()).toMatch(/sniff|magic|bytes|content.?type/);
  });
});

// ── Error path — oversize / over-count ─────────────────────────────────

describe("klodi_list_create — size + count limits (unit)", () => {
  it("rejects a file larger than 10 MB before any mint", async () => {
    // Build a >10MB JPEG (header + 10MB+ padding). Cheap allocation:
    // a single Buffer with the JPEG magic prefix.
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG_MAGIC, 0);
    const path = writeFixture("huge.jpg", big);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-big", {
      title: "Oversized",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain(path);
    // Names the ceiling explicitly so the agent knows the rule.
    expect(body).toMatch(/10\s?MB|10485760|ten.?megabyte/i);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a photos array of 11 entries before any I/O", async () => {
    // 11 URLs — count check must run before any path resolution / mint.
    const photos = Array.from(
      { length: 11 },
      (_, i) => `https://cdn.example/${i}.jpg`,
    );
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-overcount", {
      title: "Too many",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos,
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    // Names the per-listing ceiling so the agent knows the rule.
    expect(body).toMatch(/10\b|ten/i);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Path-traversal / symlink defence ───────────────────────────────────

describe("klodi_list_create — symlink + sensitive-dir defence (unit)", () => {
  it("rejects a symlink that resolves outside permitted roots", async () => {
    const target = "/etc/passwd"; // real file on every POSIX host
    const linkPath = join(fixtures, "safe.jpg");
    try {
      symlinkSync(target, linkPath);
    } catch (err) {
      // /etc/passwd not readable in this env — skip.
      // We don't `it.skip` because we want the test to fail-loud if the
      // helper isn't implemented yet, and pass in any env where the
      // symlink can be created.
      if ((err as NodeJS.ErrnoException).code === "EACCES") {
        return;
      }
      throw err;
    }

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-symlink", {
      title: "Symlinked",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [linkPath],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    // Either the realpath rejects the symlink target (sensitive-dir
    // check) or the sniff against /etc/passwd's text fails the
    // allowlist. Both are acceptable closures; both must name a clear
    // reason.
    expect(body.toLowerCase()).toMatch(
      /symlink|sensitive|outside.{0,12}permitt|content.?type|escape/,
    );
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a path under /etc/ with a 'permitted roots' style error", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-etc", {
      title: "Etc path",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: ["/etc/passwd"],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body.toLowerCase()).toMatch(
      /permitt|sensitive|outside|content.?type|allow.?list|escape/,
    );
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
