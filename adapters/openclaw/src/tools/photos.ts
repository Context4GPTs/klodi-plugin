/**
 * Photo-resolution pipeline shared by klodi_list_create and
 * klodi_list_update.
 *
 * Each element of `params.photos` can be either:
 *   - an http(s) URL passed through verbatim at the same index, or
 *   - an absolute local filesystem path that the adapter validates,
 *     content-sniffs, uploads via the existing `p2p.v1.assets.upload-url`
 *     subject + R2 PUT, and substitutes with the returned `asset_url`.
 *
 * Order is preserved across substitutions. Mint is one NATS call per
 * listing call — if mint fails, no PUTs occur. PUTs run concurrently
 * but the resulting array is reassembled by index, not completion.
 *
 * Atomicity: any validation, sniff, mint, or PUT failure rejects the
 * entire batch with a structured error envelope naming the offending
 * path and the stage. The listing call is never dispatched on partial
 * success. See ADR-0006.
 */

import { promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, sep } from "node:path";
import { homedir } from "node:os";
import { rawRequest } from "../lib/tool-result.js";
import { getKlodiHome } from "../lib/paths.js";

const UPLOAD_URL_SUBJECT = "p2p.v1.assets.upload-url";
const UPLOAD_URL_TIMEOUT_MS = 30_000;

const MAX_PHOTOS_PER_LISTING = 10;
const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;

/**
 * Allowlist per ADR-0006. Magic-number prefixes are checked against the
 * sniffed bytes — extension is advisory and never trusted. The byte
 * tables follow the cross-language parity contract (same table in TS,
 * Python, Rust).
 */
type AllowlistedType = "image/jpeg" | "image/png" | "image/webp";

interface UploadPair {
  upload_url: string;
  asset_url: string;
}

interface MintReply {
  uploads: UploadPair[];
}

interface FileMeta {
  filename: string;
  content_type: AllowlistedType;
  size: number;
}

/**
 * Sensitive directories that must reject regardless of magic-byte sniff.
 * The realpath of any local input must NOT be under any of these
 * prefixes. The klodi credentials dir is added at call-site so it
 * picks up `$KLODI_HOME` overrides.
 */
const STATIC_SENSITIVE_PREFIXES: readonly string[] = [
  "/etc/",
  "/var/run/",
  "/var/log/",
  "/proc/",
  "/sys/",
  "/root/",
];

function sensitivePrefixes(): readonly string[] {
  const dynamic: string[] = [];
  const klodiHome = getKlodiHome();
  if (klodiHome.length > 0) dynamic.push(ensureTrailingSep(klodiHome));
  const home = homedir();
  if (home.length > 0) dynamic.push(`${ensureTrailingSep(home)}.ssh${sep}`);
  return [...STATIC_SENSITIVE_PREFIXES, ...dynamic];
}

function ensureTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep;
}

function isHttpUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

/**
 * Sniff content-type from the first bytes. Returns null if the
 * sequence does not match any allowlisted type — caller surfaces the
 * sniffed signature in the rejection message.
 *
 * Magic numbers per ADR-0006:
 *   - JPEG : FF D8 FF
 *   - PNG  : 89 50 4E 47 0D 0A 1A 0A
 *   - WebP : "RIFF" .... "WEBP" (52 49 46 46 _ _ _ _ 57 45 42 50)
 */
function sniffContentType(bytes: Uint8Array): AllowlistedType | null {
  if (bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50
    && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a
    && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49
    && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45
    && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/**
 * Per-input element. Tracks the original index so that after
 * concurrent PUTs the asset_urls can be reassembled in input order.
 */
interface LocalElement {
  kind: "local";
  index: number;
  rawPath: string;
  realPath: string;
  bytes: Uint8Array;
  contentType: AllowlistedType;
}

interface UrlElement {
  kind: "url";
  index: number;
  url: string;
}

type Element = LocalElement | UrlElement;

/**
 * Resolution error — every rejection surfaces the offending path and a
 * stage tag so the agent can act on the structured envelope. Field
 * shape mirrors the Python and Rust implementations.
 */
export class PhotoResolutionError extends Error {
  readonly path: string | undefined;
  readonly stage: string;
  constructor(message: string, stage: string, path?: string) {
    super(message);
    this.name = "PhotoResolutionError";
    this.stage = stage;
    this.path = path;
  }
}

/**
 * Resolve every local path in `photos` to an asset_url before the
 * listing call is dispatched. Returns the rewritten photos array.
 *
 * Idempotent on URL-only inputs: no NATS call, no PUT, no I/O of any
 * kind beyond the count check. An empty / undefined `photos` returns
 * undefined so the caller can spread the input through to the listing
 * payload unchanged.
 */
export async function resolvePhotos(
  photos: readonly unknown[] | undefined,
): Promise<readonly string[] | undefined> {
  if (photos === undefined) return undefined;
  if (photos.length === 0) return [];

  // Count check FIRST — before any path resolution, sniff, or mint.
  // A 100-photo array with a single rejected element must not waste
  // a filesystem read.
  if (photos.length > MAX_PHOTOS_PER_LISTING) {
    throw new PhotoResolutionError(
      `Too many photos: ${photos.length} entries (max 10 per listing).`,
      "count",
    );
  }

  const elements: Element[] = [];
  for (let i = 0; i < photos.length; i++) {
    const raw = photos[i];
    if (typeof raw !== "string") {
      throw new PhotoResolutionError(
        `photos[${i}] must be a string (URL or absolute path), got ${typeof raw}.`,
        "type",
      );
    }
    if (isHttpUrl(raw)) {
      elements.push({ kind: "url", index: i, url: raw });
      continue;
    }
    const local = await resolveLocal(raw, i);
    elements.push(local);
  }

  const locals = elements.filter((e): e is LocalElement => e.kind === "local");
  if (locals.length === 0) {
    return elements.map((e) => (e.kind === "url" ? e.url : ""));
  }

  // Mint the entire batch in one NATS call. If mint fails, no PUTs
  // have occurred — the atomicity guarantee for cross-element failure
  // upstream of any storage I/O.
  const mintFiles: FileMeta[] = locals.map((local) => ({
    filename: basename(local.realPath),
    content_type: local.contentType,
    size: local.bytes.byteLength,
  }));

  let mintReply: MintReply;
  try {
    mintReply = await rawRequest<MintReply>(
      UPLOAD_URL_SUBJECT,
      { files: mintFiles },
      { timeout: UPLOAD_URL_TIMEOUT_MS },
    );
  } catch (err) {
    throw new PhotoResolutionError(
      `Mint failed for ${locals.length} photo(s): ${formatErr(err)}`,
      "mint",
    );
  }

  if (!Array.isArray(mintReply.uploads)
    || mintReply.uploads.length !== locals.length) {
    throw new PhotoResolutionError(
      `Mint returned ${mintReply.uploads?.length ?? 0} upload pair(s)`
      + ` for ${locals.length} local(s).`,
      "mint",
    );
  }

  // Concurrent PUTs preserving index-to-pair mapping. The original
  // input index lives on the local element; the upload pair lives at
  // the same position in the mint reply. We launch all PUTs in
  // parallel and assemble the final array by index, never by
  // completion order.
  await Promise.all(
    locals.map(async (local, mintIdx) => {
      const pair = mintReply.uploads[mintIdx];
      try {
        const response = await fetch(pair.upload_url, {
          method: "PUT",
          headers: { "Content-Type": local.contentType },
          body: local.bytes,
        });
        if (!response.ok) {
          throw new Error(`PUT failed with status ${response.status}`);
        }
      } catch (err) {
        throw new PhotoResolutionError(
          `PUT failed for ${local.rawPath}: ${formatErr(err)}`,
          "put",
          local.rawPath,
        );
      }
    }),
  );

  // Assemble the final array by index. URL elements pass through; local
  // elements get their matching asset_url from the mint reply.
  const indexToAsset = new Map<number, string>();
  locals.forEach((local, mintIdx) => {
    indexToAsset.set(local.index, mintReply.uploads[mintIdx].asset_url);
  });

  const out: string[] = Array.from({ length: photos.length }, () => "");
  for (const element of elements) {
    if (element.kind === "url") {
      out[element.index] = element.url;
    } else {
      const assetUrl = indexToAsset.get(element.index);
      if (assetUrl === undefined) {
        throw new PhotoResolutionError(
          `Internal: missing asset_url for index ${element.index}.`,
          "internal",
        );
      }
      out[element.index] = assetUrl;
    }
  }
  return out;
}

/**
 * Validate-sniff-load a single local path. Throws PhotoResolutionError
 * with the offending path on any failure (non-absolute, missing,
 * sensitive dir, wrong type, oversize). Reads the entire file into
 * memory — bounded by MAX_BYTES_PER_FILE so the worst case is 10 MB.
 */
async function resolveLocal(raw: string, index: number): Promise<LocalElement> {
  // Absolute-path-only gate. Relative paths and tilde expansion are
  // rejected with no filesystem access, even an `existsSync` would be
  // a security smell here (the adapter would race against a symlink
  // race attacker between the check and a later read).
  if (!isAbsolutePosixOrWindows(raw)) {
    throw new PhotoResolutionError(
      `photos[${index}] must be an absolute path: ${raw}`,
      "absolute_path",
      raw,
    );
  }

  let resolved: string;
  try {
    resolved = await realpath(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PhotoResolutionError(
        `photos[${index}] does not exist or is not readable: ${raw} (ENOENT).`,
        "missing",
        raw,
      );
    }
    throw new PhotoResolutionError(
      `photos[${index}] is not readable: ${raw} (${formatErr(err)}).`,
      "missing",
      raw,
    );
  }

  // Sensitive-dir check on the REAL path, not the input path. A
  // symlink under /tmp/safe.jpg → /etc/passwd resolves to /etc/passwd
  // and gets rejected here.
  for (const prefix of sensitivePrefixes()) {
    if (resolved === prefix.slice(0, -1) || resolved.startsWith(prefix)) {
      throw new PhotoResolutionError(
        `photos[${index}] resolves outside permitted roots: ${raw}`
        + ` → ${resolved} (sensitive directory).`,
        "sensitive_dir",
        raw,
      );
    }
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    throw new PhotoResolutionError(
      `photos[${index}] is not readable: ${raw} (${formatErr(err)}).`,
      "missing",
      raw,
    );
  }

  if (!stat.isFile()) {
    throw new PhotoResolutionError(
      `photos[${index}] is not a regular file: ${raw}.`,
      "missing",
      raw,
    );
  }

  if (stat.size > MAX_BYTES_PER_FILE) {
    throw new PhotoResolutionError(
      `photos[${index}] exceeds the 10 MB ceiling: ${raw}`
      + ` (${stat.size} bytes, 10485760 max).`,
      "size",
      raw,
    );
  }

  // Read the bytes once. The mint payload needs filename + content_type
  // + size; the PUT needs the bytes themselves. One read per file.
  let bytes: Uint8Array;
  try {
    const buffer = await fs.readFile(resolved);
    bytes = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
  } catch (err) {
    throw new PhotoResolutionError(
      `photos[${index}] read failed: ${raw} (${formatErr(err)}).`,
      "missing",
      raw,
    );
  }

  const sniffed = sniffContentType(bytes);
  if (sniffed === null) {
    throw new PhotoResolutionError(
      `photos[${index}] content-type rejected: ${raw} — sniffed bytes`
      + ` do not match the image/jpeg, image/png, or image/webp allowlist.`,
      "content_type",
      raw,
    );
  }

  return {
    kind: "local",
    index,
    rawPath: raw,
    realPath: resolved,
    bytes,
    contentType: sniffed,
  };
}

/**
 * Absolute-path predicate. Accepts POSIX absolute (`/...`) and Windows
 * absolute (`C:\...`, `\\server\share\...`). Rejects relative,
 * tilde-expansion, file:// URLs, and empty strings.
 */
function isAbsolutePosixOrWindows(input: string): boolean {
  if (input.length === 0) return false;
  if (input.startsWith("~")) return false;
  if (input.startsWith("file://")) return false;
  if (input.startsWith("/")) return true;
  // Windows: C:\..., \\server\share\...
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (input.startsWith("\\\\")) return true;
  return false;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
