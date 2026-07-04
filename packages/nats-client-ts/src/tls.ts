/**
 * TLS trust for the raw `tls://` NATS transport (private-CA proxy).
 * See ADR-0022 (`docs/decisions/0022-tls-nats-transport-private-ca-trust.md`).
 *
 * The Railway L4 TCP proxy terminates TLS at the NATS server with a
 * **private** CA (epic `nats-ws-ingress-flap-2026-06`). For a `tls://`
 * URL the client trusts that CA via `@nats-io/transport-node`'s
 * `connect({ tls: { ca } })`, keeping certificate + hostname
 * verification ON.
 *
 * Invariant (the card's core security control): verification is **never**
 * disabled. `rejectUnauthorized` is never set to `false` anywhere;
 * `KLODI_NATS_CA_FILE` selects *which* CA to trust, never *whether* to
 * verify — a missing / wrong CA fails **closed** (the handshake rejects).
 *
 * Providing `ca` makes Node's TLS stack trust **only** that CA: Node's
 * `tls.createSecureContext` *replaces* the default Mozilla bundle when
 * `ca` is set (`@nats-io/transport-node` forwards it straight to
 * `tls.connect`), so this is private-CA-**only** — matching the Python
 * (`ssl` `cadata=`) and Rust (`add_root_certificates`) clients. A
 * private-CA cert verifies; any other cert (including a public chain)
 * fails closed.
 *
 * CA resolution order (highest priority first):
 *   1. `KLODI_NATS_CA_FILE` env var — a path to a PEM bundle (local /
 *      self-signed test CA; emergency rotation without a release). When set
 *      it **short-circuits** — the persisted register CA is not even read.
 *   2. `${KLODI_HOME}/nats-ca.pem` — the register-response CA persisted at
 *      registration (see `persistNatsCa`). Server-authoritative,
 *      endpoint-matched to the served `nats_url`, rotatable without a client
 *      release (card `auto-trust-nats-ca-from-register`). Present-but-
 *      unreadable fails closed; absent falls through.
 *   3. The bundled `KLODI_NATS_CA_PEM` catalog constant — the shipped
 *      private CA. Empty until the epic mints the real CA; empty means
 *      "fall through".
 *   4. None present → `undefined`: the system trust store applies and
 *      a private-CA cert fails closed (correct).
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { KLODI_NATS_CA_PEM } from "@klodi/tool-catalog";

/** Env var naming a PEM bundle path. Selects *which* CA to trust. */
const CA_FILE_ENV = "KLODI_NATS_CA_FILE";

/** Cheap PEM-shape sniff at the persist boundary — a full X.509 parse
 *  would make the adapter persist sites expensive and asymmetric; a
 *  PEM-shaped-but-deep-invalid cert instead fails closed at connect. */
const PEM_MARKER = "-----BEGIN CERTIFICATE-----";

/** Non-secret cert (ADR-0022 §Security) — world-readable, unlike the 0600
 *  nkey creds of ADR-0002. */
const CA_FILE_MODE = 0o644;

/**
 * The persisted register-CA location `${klodiHome}/nats-ca.pem`. Single
 * filename source shared by {@link persistNatsCa} (register-time write) and
 * {@link resolveTlsCa} (connect-time level-2 read) so the two can never
 * disagree on location.
 */
export function natsCaPath(klodiHome: string): string {
  return join(klodiHome, "nats-ca.pem");
}

/**
 * Persist the register-response CA to `${klodiHome}/nats-ca.pem`. Atomic
 * write (temp + rename) at mode 0644 — a non-secret CA certificate
 * (ADR-0022 §Security), unlike the 0600 nkey creds. **Skips** — writing
 * nothing, throwing nothing — when `pem` is empty or not PEM-shaped, so an
 * absent / garbage `nats_ca` can never fail registration. Last-write-wins:
 * a fresh value overwrites, making re-register the CA-rotation path.
 * Returns the written path, or `undefined` when the value was skipped.
 */
export function persistNatsCa(
  klodiHome: string,
  pem: string,
): string | undefined {
  if (pem.length === 0 || !pem.includes(PEM_MARKER)) return undefined;
  const target = natsCaPath(klodiHome);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, pem, { encoding: "utf-8", mode: CA_FILE_MODE });
  // Defensive against a umask that widened the create mode.
  chmodSync(tmp, CA_FILE_MODE);
  renameSync(tmp, target);
  return target;
}

/**
 * Raised when a configured CA source cannot be read. Fail-closed signal:
 * a `KLODI_NATS_CA_FILE` pointing at a missing / unreadable PEM aborts
 * the connect rather than silently downgrading to an unverified
 * transport.
 */
export class CaTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaTrustError";
  }
}

/**
 * Resolve the CA PEM text to trust for a `tls://` connection, or
 * `undefined` to use the system trust store. Applies the documented order:
 * env override (short-circuits) → persisted `${klodiHome}/nats-ca.pem` →
 * bundled constant → system store. Throws {@link CaTrustError} when a
 * configured source (the env override, or a present persisted file) is
 * unreadable — verification is never disabled to work around a broken CA.
 *
 * `klodiHome` locates the persisted register CA (level 2); the caller
 * derives it from the creds-path parent so this lower-layer package never
 * re-resolves `KLODI_HOME` upward.
 */
export function resolveTlsCa(klodiHome?: string): string | undefined {
  const override = process.env[CA_FILE_ENV];
  if (override !== undefined && override !== "") {
    try {
      return readFileSync(override, "utf-8");
    } catch (err) {
      throw new CaTrustError(
        `${CA_FILE_ENV}=${override} could not be read: ${String(err)}. `
        + "Point it at a readable PEM bundle or unset it to use the "
        + "persisted / bundled / system trust store — verification is never "
        + "disabled to work around this.",
      );
    }
  }
  // Level 2 — the register-response CA persisted at registration. Only
  // reached when the env override is unset (strict precedence, no CA union,
  // no divergence read). Present-but-unreadable fails closed; absent falls
  // through to the bundled constant.
  if (klodiHome !== undefined) {
    const persisted = natsCaPath(klodiHome);
    if (existsSync(persisted)) {
      try {
        return readFileSync(persisted, "utf-8");
      } catch (err) {
        throw new CaTrustError(
          `persisted register CA at ${persisted} could not be read: `
          + `${String(err)}. Re-register to repersist it, or set `
          + `${CA_FILE_ENV} to an explicit PEM — verification is never `
          + "disabled to work around this.",
        );
      }
    }
  }
  return KLODI_NATS_CA_PEM.length > 0 ? KLODI_NATS_CA_PEM : undefined;
}
