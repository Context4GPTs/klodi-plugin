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

// ── Happy path — local file → mint → PUT → substitute ───────────────────

describe("klodi_list_create — local-path upload pipeline (integration)", () => {
  /**
   * Drive the mint+PUT sequence end-to-end. Pinned contract:
   *   1. Adapter mints presigned URLs via NATS subject
   *      `p2p.v1.assets.upload-url` with one `files[]` entry per local
   *      path (filename + sniffed content_type + size).
   *   2. Adapter PUTs each local file's bytes to its `upload_url`,
   *      with `Content-Type` header matching the sniffed type.
   *   3. Adapter dispatches `p2p.v1.listings.create` with the photos
   *      array rewritten so each local path is replaced by its
   *      `asset_url`. Order is preserved positionally.
   *   4. The agent sees the listing.create reply unchanged (and the
   *      existing sell_file side effect still fires).
   */
  it("uploads one local JPEG and substitutes the asset_url before listings.create", async () => {
    const path = writeFixture("img1.jpg", JPEG_MAGIC);
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/up1?sig=abc",
          asset_url: "https://cdn.example/asset1.jpg",
        },
      ],
    });
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Local JPEG",
      photos: ["https://cdn.example/asset1.jpg"],
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-1jpg", {
      title: "Local JPEG",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });

    expect(result.isError).toBeFalsy();

    // Mint happened with the right file metadata.
    const client = (await import("../helpers/mock-nats.js")).getClient();
    const subjects = client.request.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subjects).toEqual([
      "p2p.v1.assets.upload-url",
      "p2p.v1.listings.create",
    ]);
    const mintCall = client.request.mock.calls[0];
    const mintPayload = mintCall[1] as {
      files: { filename: string; content_type: string; size: number }[];
    };
    expect(mintPayload.files).toHaveLength(1);
    expect(mintPayload.files[0].content_type).toBe("image/jpeg");
    expect(mintPayload.files[0].size).toBe(JPEG_MAGIC.byteLength);
    expect(mintPayload.files[0].filename).toContain("img1.jpg");

    // R2 PUT happened with the bytes + correct content type.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [putUrl, putInit] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(putUrl).toBe("https://r2.example/up1?sig=abc");
    expect(putInit?.method).toBe("PUT");
    expect(
      (putInit?.headers as Record<string, string>)?.["Content-Type"]
        ?? (putInit?.headers as Record<string, string>)?.["content-type"],
    ).toBe("image/jpeg");

    // listings.create dispatched with the substituted asset_url.
    const createPayload = client.request.mock.calls[1][1] as {
      photos: string[];
    };
    expect(createPayload.photos).toEqual([
      "https://cdn.example/asset1.jpg",
    ]);
  });

  it("preserves index order when mixing URLs and local paths", async () => {
    const localPath = writeFixture("middle.png", PNG_MAGIC);
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/up-middle?sig=mid",
          asset_url: "https://cdn.example/asset-middle.png",
        },
      ],
    });
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Mixed",
      photos: [
        "https://cdn.example/keep.jpg",
        "https://cdn.example/asset-middle.png",
        "https://cdn.example/keep2.webp",
      ],
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-mixed", {
      title: "Mixed",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [
        "https://cdn.example/keep.jpg",
        localPath,
        "https://cdn.example/keep2.webp",
      ],
    });

    expect(result.isError).toBeFalsy();

    const client = (await import("../helpers/mock-nats.js")).getClient();
    // Exactly one mint — only the local needs a presigned URL.
    const mintCall = client.request.mock.calls[0];
    const mintPayload = mintCall[1] as { files: unknown[] };
    expect(mintCall[0]).toBe("p2p.v1.assets.upload-url");
    expect(mintPayload.files).toHaveLength(1);

    // listings.create receives the URLs verbatim and the asset_url at
    // index 1.
    const createPayload = client.request.mock.calls[1][1] as {
      photos: string[];
    };
    expect(createPayload.photos).toEqual([
      "https://cdn.example/keep.jpg",
      "https://cdn.example/asset-middle.png",
      "https://cdn.example/keep2.webp",
    ]);

    // Exactly one PUT happened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves index-to-pair mapping for three locals (concurrent PUTs)", async () => {
    // The criterion: indexes 0/1/2 must positionally correspond to
    // a.jpg/b.jpg/c.jpg even if PUTs are issued concurrently. The mint
    // reply order pairs (a,b,c) ↔ (asset_a,asset_b,asset_c); the adapter
    // must hold that mapping when launching PUTs and assemble the final
    // photos array by index, not by completion order.
    const pathA = writeFixture("a.jpg", JPEG_MAGIC);
    const pathB = writeFixture("b.png", PNG_MAGIC);
    const pathC = writeFixture("c.webp", WEBP_MAGIC);

    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/upA",
          asset_url: "https://cdn.example/asset-a.jpg",
        },
        {
          upload_url: "https://r2.example/upB",
          asset_url: "https://cdn.example/asset-b.png",
        },
        {
          upload_url: "https://r2.example/upC",
          asset_url: "https://cdn.example/asset-c.webp",
        },
      ],
    });
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "Three",
    });

    // Force PUTs to resolve in reverse order so completion-order ≠
    // index-order. The adapter must still substitute by index.
    const completionOrder: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      const delay = u.endsWith("upA") ? 30 : u.endsWith("upB") ? 15 : 0;
      await new Promise((r) => setTimeout(r, delay));
      completionOrder.push(u);
      return new Response(null, { status: 200 });
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-three", {
      title: "Three",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [pathA, pathB, pathC],
    });

    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // PUTs completed in non-index order (proves concurrency, not
    // serial-by-index).
    expect(completionOrder.at(-1)).toContain("upA");

    const client = (await import("../helpers/mock-nats.js")).getClient();
    const createPayload = client.request.mock.calls[1][1] as {
      photos: string[];
    };
    expect(createPayload.photos).toEqual([
      "https://cdn.example/asset-a.jpg",
      "https://cdn.example/asset-b.png",
      "https://cdn.example/asset-c.webp",
    ]);
  });

  it("preserves the sell_file side effect from listings.test.ts", async () => {
    // Regression guard — adding photos upload mustn't break the
    // create-time sell-file side effect.
    const path = writeFixture("photo.jpg", JPEG_MAGIC);
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/up",
          asset_url: "https://cdn.example/asset.jpg",
        },
      ],
    });
    mockNatsResponse("p2p.v1.listings.create", {
      listing_id: LISTING_ID,
      title: "With sell file",
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-sf", {
      title: "Vintage Lamp",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text ?? "{}");
    expect(data.sell_file).toBeDefined();
    expect(data.sell_file.slug).toContain("vintage-lamp");
  });
});

// ── Happy path — klodi_list_update mirrors the same pipeline ────────────

describe("klodi_list_update — local-path upload pipeline (integration)", () => {
  it("uploads a local PNG and substitutes the asset_url before listings.update", async () => {
    const path = writeFixture("replacement.png", PNG_MAGIC);
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/up-upd",
          asset_url: "https://cdn.example/replacement.png",
        },
      ],
    });
    mockNatsResponse("p2p.v1.listings.update", {
      listing_id: LISTING_ID,
      photos: ["https://cdn.example/replacement.png"],
    });

    const tool = getTool(api, "klodi_list_update");
    const result = await tool.execute("call-upd", {
      listing_id: LISTING_ID,
      photos: [path],
    });

    expect(result.isError).toBeFalsy();
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "p2p.v1.assets.upload-url",
      "p2p.v1.listings.update",
    ]);
    const updatePayload = client.request.mock.calls[1][1] as {
      photos: string[];
    };
    expect(updatePayload.photos).toEqual([
      "https://cdn.example/replacement.png",
    ]);
    // Sniffed as PNG, not from extension.
    const mintPayload = client.request.mock.calls[0][1] as {
      files: { content_type: string }[];
    };
    expect(mintPayload.files[0].content_type).toBe("image/png");
  });
});

// ── Error path — atomic failure across mixed array ──────────────────────

describe("klodi_list_create — atomic failure (integration)", () => {
  it("fails the entire call when one file in a multi-photo array is oversize", async () => {
    const ok = writeFixture("ok.jpg", JPEG_MAGIC);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG_MAGIC, 0);
    const oversize = writeFixture("oversized.jpg", big);

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-mix-fail", {
      title: "Mixed",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [ok, oversize],
    });

    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain(oversize);
    // listings.create MUST NOT have been called — partial success forbidden.
    const client = (await import("../helpers/mock-nats.js")).getClient();
    const subjects = client.request.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subjects).not.toContain("p2p.v1.listings.create");
  });

  it("fails the entire call when one file in a multi-photo array is the wrong type", async () => {
    const ok = writeFixture("ok.jpg", JPEG_MAGIC);
    const pdf = writeFixture("doc.pdf", PDF_MAGIC);

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-pdf-mix", {
      title: "Mixed",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [ok, pdf],
    });

    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    expect(body).toContain(pdf);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    const subjects = client.request.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subjects).not.toContain("p2p.v1.listings.create");
  });

  it("fails the call when the mint NATS request errors (no PUT, no create)", async () => {
    const path = writeFixture("ok.jpg", JPEG_MAGIC);
    const { mockNatsError, KlodiRequestError } = await import(
      "../helpers/mock-nats.js"
    );
    mockNatsError(
      "p2p.v1.assets.upload-url",
      new KlodiRequestError("rate limited", "RATE_LIMITED"),
    );

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-mint-fail", {
      title: "x",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });

    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    // Marketplace error code surfaces so the agent can branch on it.
    expect(body).toMatch(/RATE_LIMITED|rate.?limit/);

    // No R2 PUT — bytes never moved because no presigned URL was minted.
    expect(fetchSpy).not.toHaveBeenCalled();

    // listings.create must not have been dispatched.
    const client = (await import("../helpers/mock-nats.js")).getClient();
    const subjects = client.request.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subjects).toEqual(["p2p.v1.assets.upload-url"]);
  });

  it("fails the call when one R2 PUT errors (no listing dispatched)", async () => {
    // Two locals: first PUT succeeds, second returns 500. The criterion
    // forbids partial success — the entire listings.create call must
    // be skipped.
    const a = writeFixture("a.jpg", JPEG_MAGIC);
    const b = writeFixture("b.png", PNG_MAGIC);

    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/upA",
          asset_url: "https://cdn.example/asset-a.jpg",
        },
        {
          upload_url: "https://r2.example/upB",
          asset_url: "https://cdn.example/asset-b.png",
        },
      ],
    });

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("upB")) {
        return new Response("storage error", { status: 500 });
      }
      return new Response(null, { status: 200 });
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-put-fail", {
      title: "x",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [a, b],
    });

    expect(result.isError).toBe(true);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    const subjects = client.request.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    // Mint happened (it's the first step). Create must not have fired.
    expect(subjects).toEqual(["p2p.v1.assets.upload-url"]);
  });
});

// ── URL pass-through for klodi_list_update (regression) ─────────────────

describe("klodi_list_update — URL pass-through (regression)", () => {
  it("forwards URLs verbatim and never mints", async () => {
    mockNatsResponse("p2p.v1.listings.update", {
      listing_id: LISTING_ID,
      photos: [
        "https://cdn.example/x.jpg",
        "https://cdn.example/y.png",
      ],
    });
    const tool = getTool(api, "klodi_list_update");
    const result = await tool.execute("call-upd-url", {
      listing_id: LISTING_ID,
      photos: [
        "https://cdn.example/x.jpg",
        "https://cdn.example/y.png",
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).not.toHaveBeenCalled();
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "p2p.v1.listings.update",
    ]);
  });
});

// ── Type-level rejection — non-array `photos` value (P2.4) ──────────────
//
// Python and Rust raise `PhotoResolutionError(..., "type")` on a non-list /
// non-array input. openclaw's old `applyPhotos` early-returned `params`
// unchanged when `Array.isArray(photos)` was false, which:
//   - bypassed the validator
//   - sent the bad payload to `p2p.v1.listings.create` so the marketplace
//     had to be the type checker
//   - silently diverged from the Python/Rust adapters
//
// Per CQG round-1 P2.4, openclaw must reject the non-array value before
// any NATS dispatch — matching the other two language stacks.

describe("klodi_list_create — non-array photos rejection (P2.4)", () => {
  it("rejects a numeric photos value before any NATS dispatch", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-num-photos", {
      title: "Bad type",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      // photos is a number, not an array — openclaw must reject.
      photos: 42 as unknown as string[],
    });
    expect(result.isError).toBe(true);
    const body = result.content[0].text ?? "";
    // Error must mention the wrong type and use a `type` stage tag so
    // the structured envelope is consistent with hermes / nanobot /
    // Rust.
    expect(body.toLowerCase()).toMatch(/type|array|list/);
    // No NATS dispatch — the photos validation must run before the
    // listings.create request.
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a string photos value before any NATS dispatch", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-str-photos", {
      title: "Bad type 2",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      // `photos` is a string (e.g. a single URL) — must reject.
      photos: "https://cdn.example/single.jpg" as unknown as string[],
    });
    expect(result.isError).toBe(true);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an object photos value before any NATS dispatch", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-obj-photos", {
      title: "Bad type 3",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: { "0": "/tmp/x.jpg" } as unknown as string[],
    });
    expect(result.isError).toBe(true);
    const client = (await import("../helpers/mock-nats.js")).getClient();
    expect(client.request).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Error envelope parity (P2.1 + P2.2) ─────────────────────────────────
//
// All three language stacks must emit the same structured envelope shape
// when photo resolution fails. CQG round 1 found:
//   - openclaw returned a plain string `"<stage>: <message>"` — and the
//     ternary `err.path ? '<a>' : '<b>'` was dead because both branches
//     were identical (P2.1).
//   - hermes / nanobot returned `json.dumps({"error", "message", "path"})`.
//   - klodi-rust-host wrapped the same JSON in `McpError::invalid_request`.
//
// Canonical shape: a JSON object with `error` (stage tag),
// `message` (human explanation, including the path), and `path` (the
// offending raw input, or null when there is no specific path — e.g.
// the count cap). Pinning this shape in openclaw closes the
// cross-language drift the architect flagged in Discovery.
//
// The test parses `result.content[0].text` as JSON for every photo
// failure path, asserts the three fields, and asserts the path field
// carries the raw input verbatim (so the dead ternary cannot be
// reintroduced — both branches must use `err.path`).

describe("klodi_list_create — structured error envelope (P2.1 + P2.2)", () => {
  function parseEnvelope(text: string): {
    error?: string;
    message?: string;
    path?: string | null;
  } {
    return JSON.parse(text);
  }

  it("absolute-path failure: emits {error: 'absolute_path', message, path}", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-relpath", {
      title: "Bad relative path",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: ["./img.jpg"],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("absolute_path");
    expect(env.path).toBe("./img.jpg");
    expect(env.message).toBeDefined();
    expect(env.message!.toLowerCase()).toContain("absolute");
    expect(env.message).toContain("./img.jpg");
  });

  it("missing-file failure: emits {error: 'missing', message, path}", async () => {
    const tool = getTool(api, "klodi_list_create");
    const missingPath = "/tmp/never-exists-987654321.jpg";
    const result = await tool.execute("call-env-missing", {
      title: "Missing",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [missingPath],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("missing");
    expect(env.path).toBe(missingPath);
    expect(env.message).toBeDefined();
    expect(env.message).toContain(missingPath);
  });

  it("content-type failure: emits {error: 'content_type', message, path}", async () => {
    const path = writeFixture("doc.pdf", PDF_MAGIC);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-ct", {
      title: "PDF",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("content_type");
    expect(env.path).toBe(path);
    expect(env.message).toBeDefined();
    expect(env.message).toContain(path);
  });

  it("oversize failure: emits {error: 'size', message, path}", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG_MAGIC, 0);
    const path = writeFixture("huge.jpg", big);
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-size", {
      title: "Big",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("size");
    expect(env.path).toBe(path);
    expect(env.message).toContain(path);
  });

  it("count failure: emits {error: 'count', message, path: null}", async () => {
    const photos = Array.from(
      { length: 11 },
      (_, i) => `https://cdn.example/${i}.jpg`,
    );
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-count", {
      title: "Too many",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos,
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("count");
    // count is not bound to any single path — path field exists but is
    // null / undefined. Matches the Python `None` and Rust `Option::None`.
    expect(env.path == null).toBe(true);
    expect(env.message).toBeDefined();
  });

  it("non-array failure: emits {error: 'type', message, path: null}", async () => {
    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-type", {
      title: "Bad type",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: 42 as unknown as string[],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("type");
    // type failures (whole-input shape, not a specific element) carry a
    // null path — matches Python / Rust.
    expect(env.path == null).toBe(true);
    expect(env.message).toBeDefined();
  });

  it("PUT failure: emits {error: 'put', message, path}", async () => {
    const path = writeFixture("ok.jpg", JPEG_MAGIC);
    mockNatsResponse("p2p.v1.assets.upload-url", {
      uploads: [
        {
          upload_url: "https://r2.example/up-fail",
          asset_url: "https://cdn.example/asset.jpg",
        },
      ],
    });
    fetchSpy.mockImplementation(async () => {
      return new Response("storage error", { status: 500 });
    });

    const tool = getTool(api, "klodi_list_create");
    const result = await tool.execute("call-env-put", {
      title: "PUT fail",
      description: "x",
      category: "home",
      asking_price: 100,
      fulfillment: [{ method: "pickup" }],
      photos: [path],
    });
    expect(result.isError).toBe(true);
    const env = parseEnvelope(result.content[0].text ?? "");
    expect(env.error).toBe("put");
    expect(env.path).toBe(path);
    expect(env.message).toContain(path);
  });
});
