/**
 * CA-source precedence has ONE encoding — the resolver (ts).
 *
 * Card: consolidate-ca-source-precedence-into-the-resolver.
 *
 * `resolveTlsCa` returns the CA text AND the label naming *which* source it
 * selected (env → persisted → bundled). The connect-failure attribution
 * consumes that label instead of re-deriving the order; the parallel
 * `describeCaSource` helper is deleted, so there is no second encoding to drift.
 *
 * This pin asserts, per precedence level:
 *   (a) `resolveTlsCa(home).source` reports the exact expected label, and
 *   (b) the loud-fail `CaTrustError` the client raises on a CA-verify failure
 *       names *exactly* that same label — proving the client consumes the
 *       resolver's selection, never an independent re-walk.
 *
 * The CA-verify failure is injected by rejecting the mocked TCP transport with
 * a cert-verify-shaped error (no live NATS). QA-owned. NEVER weaken.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tcpMock } = vi.hoisted(() => ({
  // Reject with a cert-verify-shaped error so the client classifies it as a
  // terminal CA-trust failure (isCaVerifyError matches /cert|verif|tls|ca/).
  tcpMock: vi.fn().mockRejectedValue(new Error("certificate verify failed")),
}));

vi.mock("@nats-io/nats-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@nats-io/nats-core")>();
  return { ...orig, credsAuthenticator: vi.fn(() => vi.fn()) };
});
vi.mock("@nats-io/transport-node", () => ({ connect: tcpMock }));

const { KlodiClient } = await import("../src/client.js");
const { CaTrustError, resolveTlsCa } = await import("../src/tls.js");

const CA_FILE_ENV = "KLODI_NATS_CA_FILE";
const TLS_URL = "tls://kodama.proxy.rlwy.net:37360";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nPARITYFIXTUREBODY\n-----END CERTIFICATE-----\n";

let home: string;
let prevEnv: string | undefined;

function persistedPath(h: string): string {
  return join(h, "nats-ca.pem");
}

function makeClient(natsUrl: string): InstanceType<typeof KlodiClient> {
  const configPath = join(home, "config.json");
  const credsPath = join(home, "nats.creds");
  writeFileSync(
    configPath,
    JSON.stringify({ handle: "alice", user_id: "u-1", nkey_public: "UAAA", nats_url: natsUrl }),
  );
  writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nfake\n", { mode: 0o600 });
  return new KlodiClient({ credsPath, configPath });
}

/** The `<source>` the client interpolates into the loud-fail message. */
async function attributedSource(): Promise<string> {
  const client = makeClient(TLS_URL);
  try {
    await client.connect();
  } catch (err) {
    expect(err, "a CA-verify failure must surface a CaTrustError").toBeInstanceOf(CaTrustError);
    return (err as Error).message;
  }
  throw new Error("connect() should have rejected with a CaTrustError");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "klodi-ca-parity-"));
  prevEnv = process.env[CA_FILE_ENV];
  delete process.env[CA_FILE_ENV];
  vi.clearAllMocks();
  tcpMock.mockRejectedValue(new Error("certificate verify failed"));
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[CA_FILE_ENV];
  else process.env[CA_FILE_ENV] = prevEnv;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe("CA-source parity — resolver-selected source == attributed source", () => {
  it("[unit] env level: resolver label and loud-fail attribution agree", async () => {
    const envFile = join(home, "env-ca.pem");
    writeFileSync(envFile, CA_PEM);
    process.env[CA_FILE_ENV] = envFile;

    const { source } = resolveTlsCa(home);
    expect(source).toBe(`${CA_FILE_ENV}=${envFile}`);
    expect(await attributedSource()).toContain(`served NATS CA (${source})`);
  });

  it("[unit] persisted level: resolver label and loud-fail attribution agree", async () => {
    writeFileSync(persistedPath(home), CA_PEM);

    const { source } = resolveTlsCa(home);
    expect(source).toBe(`persisted register CA at ${persistedPath(home)}`);
    expect(await attributedSource()).toContain(`served NATS CA (${source})`);
  });

  it("[unit] bundled level: resolver label and loud-fail attribution agree", async () => {
    // No env, no persisted → the bundled/system-store fallthrough. The label
    // is populated even when the bundle is empty (ca undefined).
    const { source } = resolveTlsCa(home);
    expect(source).toBe("bundled KLODI_NATS_CA_PEM");
    expect(await attributedSource()).toContain(`served NATS CA (${source})`);
  });

  it("[unit] the source label set is exhaustive over the precedence levels", () => {
    const bundled = resolveTlsCa(home).source;
    writeFileSync(persistedPath(home), CA_PEM);
    const persisted = resolveTlsCa(home).source;
    const envFile = join(home, "env-ca.pem");
    writeFileSync(envFile, CA_PEM);
    process.env[CA_FILE_ENV] = envFile;
    const env = resolveTlsCa(home).source;

    const labels = new Set([env, persisted, bundled]);
    expect(labels.size, "each level must yield a distinct, populated label").toBe(3);
    expect([...labels].every((l) => l.length > 0)).toBe(true);
  });
});
