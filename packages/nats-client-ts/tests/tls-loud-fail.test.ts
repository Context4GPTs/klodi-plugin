/**
 * Loud-fail + per-family well-formed-CA trust (ts) — self-contained.
 *
 * Byte-for-byte port of the
 * Python `test_tls_loud_fail.py` contract.
 *
 * A bad PEM *fails closed at trust-context build* is covered elsewhere. Here
 * the served CA is PEM-valid and the trust
 * context builds, but it cannot anchor the handshake (wrong-signer). The
 * failure must be LOUD, TERMINAL, PROMPT (bounded), and attributable — a
 * structured `CaTrustError`, never a silent hang / bare TLS error.
 *
 * Self-contained: it stands up an in-process Node `tls` server against the
 * local CA fixtures, so it RUNS in plain CI (unlike the gated
 * `tls-ca.integration.test.ts`, which needs an external tls:// NATS). Lives at
 * the top level of `tests/` so it is not gated.
 *
 * Per Open-question #7 (per-stack keyUsage strictness asymmetry) the TS/Node
 * negative anchors on **wrong-signer** only — Node may accept a keyUsage-missing
 * CA and this change does NOT add code to force it to reject (a rejected
 * alternative). The keyUsage-missing negative is proven on the strict stacks
 * (py/rs).
 *
 * QA-owned. NEVER weaken — push failures back to the expert-developer.
 */

import type { Socket } from "node:net";
import { createServer, connect as tlsConnect, type Server } from "node:tls";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { KlodiClient } from "../src/client.js";
import { CaTrustError, persistNatsCa, resolveTlsCa } from "../src/tls.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A wrong-CA connect must reach a terminal error well within this bound; a
 *  hang (retries forever) trips the race → the assertion fails. */
const TERMINAL_BOUND_MS = 8_000;
/** A transient (refused-port) failure must still be retrying inside this short
 *  window (never a terminal CaTrustError). */
const TRANSIENT_WINDOW_MS = 3_000;

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("pnpm-workspace.yaml not found above this test");
}

function fx(name: string): string {
  const path = join(repoRoot(), "test-fixtures", "tls-ca", name);
  if (!existsSync(path)) throw new Error(`missing TLS fixture ${path} (run gen.sh)`);
  return path;
}

/** A plaintext NATS `INFO` line advertising `tls_required` — what a real
 *  `tls://` NATS endpoint (STARTTLS, the klodi transport model) sends BEFORE the
 *  TLS upgrade. Needed so `KlodiClient.connect()` (which speaks STARTTLS via
 *  `@nats-io/transport-node`) reaches the TLS upgrade and surfaces the real
 *  cert-verify failure — an *implicit*-TLS server deadlocks the STARTTLS client
 *  (it waits for INFO; the server waits for a ClientHello), yielding a bare
 *  timeout instead of the CA-trust failure under test. See the In Dev handoff
 *  (dev corrected this server's TLS negotiation to STARTTLS). */
const STARTTLS_INFO =
  'INFO {"server_id":"TEST","version":"2.10.0","proto":1,'
  + '"max_payload":1048576,"tls_required":true,"headers":true}\r\n';

/** In-process localhost TLS server presenting `certPath` (may be a fullchain)
 *  + `keyPath`. Never speaks NATS beyond the handshake prologue. `starttls`
 *  selects the negotiation: `false` (default) = implicit TLS (upgrade on
 *  accept), for a RAW handshake the TEST performs itself (Pillar-A positive
 *  probe); `true` = NATS STARTTLS (send the plaintext `INFO`/`tls_required`
 *  line, THEN upgrade), required to drive `KlodiClient.connect()` (a STARTTLS
 *  client) through the real cert-verify path in the negative tests. */
function startTlsServer(certPath: string, keyPath: string, starttls = false): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (socket) => {
      socket.on("data", () => {});
      socket.on("error", () => {});
    },
  );
  // Track every raw TCP socket so teardown can force-destroy them — a hung,
  // still-retrying client keeps connections open (and its failed handshakes
  // never reach the secureConnection listener), so a plain close() would wait
  // forever.
  server.on("connection", (sock: Socket) => {
    sockets.add(sock);
    // NATS STARTTLS prologue: advertise tls_required on the raw socket BEFORE
    // the TLS upgrade (the `connection` event fires pre-handshake).
    if (starttls) sock.write(STARTTLS_INFO);
    sock.on("close", () => sockets.delete(sock));
  });
  server.on("tlsClientError", () => {});
  server.on("error", () => {});
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      res({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const sock of sockets) sock.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

let home: string | undefined;

afterEach(() => {
  if (home) {
    rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
  delete process.env["KLODI_NATS_CA_FILE"];
});

/** A self-contained ${KLODI_HOME}: placeholder creds (transport reads creds
 *  only when signing the CONNECT — after the TLS handshake), a config, and the
 *  register CA persisted at ${home}/nats-ca.pem (the level-2 auto-trust src). */
function homeFor(natsUrl: string, caPemPath: string): { credsPath: string; configPath: string } {
  home = mkdtempSync(join(tmpdir(), "klodi-tls-loud-"));
  delete process.env["KLODI_NATS_CA_FILE"];
  const credsPath = join(home, "nats.creds");
  writeFileSync(credsPath, "placeholder — not read before the TLS handshake\n");
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      handle: "tlsuser",
      user_id: "00000000-0000-4000-8000-000000000001",
      nkey_public: "UTLSTEST",
      nats_url: natsUrl,
    }),
  );
  persistNatsCa(home, readFileSync(caPemPath, "utf-8"));
  return { credsPath, configPath };
}

type Disposition =
  | { kind: "connected" }
  | { kind: "timeout" }
  | { kind: "error"; err: unknown };

/** Drive connect() under a bounded race. "timeout" = the hang (still retrying
 *  at the bound). The pending connect() promise (if it hangs) is swallowed. */
async function connectDisposition(client: KlodiClient, boundMs: number): Promise<Disposition> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<Disposition>((res) => {
    timer = setTimeout(() => res({ kind: "timeout" }), boundMs);
  });
  const attempt: Promise<Disposition> = client
    .connect()
    .then(() => ({ kind: "connected" as const }))
    .catch((err: unknown) => ({ kind: "error" as const, err }));
  const disposition = await Promise.race([attempt, timeout]);
  clearTimeout(timer!);
  // Don't let a still-pending (hung) connect surface an unhandled rejection.
  void attempt.catch(() => {});
  try {
    await client.close();
  } catch {
    /* best-effort teardown */
  }
  return disposition;
}

function assertAttributable(err: unknown): void {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  const legible = ["ca", "certificate", "cert", "tls", "trust", "verif"].some((t) =>
    text.includes(t),
  );
  expect(legible, `bad-CA error must read as a CA-trust/TLS failure, not opaque: ${String(err)}`)
    .toBe(true);
}

describe("tls loud-fail (ts)", () => {
  // ── Pillar A [integration] GUARD — keyUsage-bearing CA anchors a real
  // handshake (cert + hostname), proven for the TS/Node family. ──────────────
  it("trusts a keyUsage-bearing CA and verifies cert + hostname", async () => {
    home = mkdtempSync(join(tmpdir(), "klodi-tls-pos-"));
    delete process.env["KLODI_NATS_CA_FILE"];
    persistNatsCa(home, readFileSync(fx("ca-good.pem"), "utf-8"));
    const { ca } = resolveTlsCa(home);
    expect(ca, "resolveTlsCa must return the persisted keyUsage CA").toBeTruthy();

    const server = await startTlsServer(fx("leaf-good.pem"), fx("leaf-good.key"));
    try {
      // Cert verifies AND hostname matches the leaf SAN (DNS:localhost).
      const ok = await new Promise<boolean>((res, rej) => {
        const s = tlsConnect(
          { host: "127.0.0.1", port: server.port, servername: "localhost", ca },
          () => {
            const authorized = s.authorized;
            s.end();
            res(authorized);
          },
        );
        s.on("error", rej);
      });
      expect(ok, "the keyUsage-bearing CA must anchor a verified handshake").toBe(true);

      // Hostname verification is genuinely enforced: a name the leaf does not
      // carry must fail (authorized false / handshake error).
      const rejected = await new Promise<boolean>((res) => {
        const s = tlsConnect(
          { host: "127.0.0.1", port: server.port, servername: "not-in-san.example", ca },
          () => {
            const a = s.authorized;
            s.end();
            res(!a);
          },
        );
        s.on("error", () => res(true));
      });
      expect(rejected, "hostname verification must be enforced").toBe(true);
    } finally {
      await server.close();
    }
  });

  // ── Pillar B [integration] RED — wrong-signer served CA. ───────────────────
  it("fails terminally + promptly on a wrong-signer served CA", async () => {
    const server = await startTlsServer(fx("leaf-good.pem"), fx("leaf-good.key"), true);
    try {
      const { credsPath, configPath } = homeFor(`tls://localhost:${server.port}`, fx("ca-wrong.pem"));
      const client = new KlodiClient({ credsPath, configPath });
      const d = await connectDisposition(client, TERMINAL_BOUND_MS);

      expect(
        d.kind,
        `wrong-signer connect HUNG past ${TERMINAL_BOUND_MS}ms (retried forever) — the ` +
          "deterministic CA/TLS-verify failure on the initial connect must be terminal",
      ).not.toBe("timeout");
      expect(
        d.kind === "error" && d.err instanceof CaTrustError,
        `a wrong-signer served CA must surface a structured CaTrustError, not a bare TLS ` +
          `error or a silent non-connection (got ${JSON.stringify(d)})`,
      ).toBe(true);
      if (d.kind === "error") assertAttributable(d.err);
      expect(client.isConnected()).toBe(false);
    } finally {
      await server.close();
    }
  }, 15_000);

  // ── Pillar B [integration] GUARD (classifier pair) — a transient refused
  // port must NOT be classified as a terminal CA failure. ────────────────────
  it("does not classify a refused port (transient) as a terminal CA failure", async () => {
    // Bind then free a port so nothing is listening → connection refused.
    const { createServer: netServer } = await import("node:net");
    const deadPort = await new Promise<number>((res) => {
      const s = netServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        s.close(() => res(port));
      });
    });
    const { credsPath, configPath } = homeFor(`tls://127.0.0.1:${deadPort}`, fx("ca-good.pem"));
    const client = new KlodiClient({ credsPath, configPath });
    const d = await connectDisposition(client, TRANSIENT_WINDOW_MS);

    expect(
      d.kind === "error" && d.err instanceof CaTrustError,
      "a refused-port (transient) failure must NOT be classified as a terminal " +
        "CaTrustError — only the deterministic CA/TLS-verify class fails fast",
    ).toBe(false);
  }, 15_000);
});
