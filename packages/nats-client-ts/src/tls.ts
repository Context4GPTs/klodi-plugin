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
 *      self-signed test CA; emergency rotation without a release).
 *   2. The bundled `KLODI_NATS_CA_PEM` catalog constant — the shipped
 *      private CA. Empty until the epic mints the real CA; empty means
 *      "fall through".
 *   3. Neither present → `undefined`: the system trust store applies and
 *      a private-CA cert fails closed (correct).
 */

import { readFileSync } from "node:fs";
import { KLODI_NATS_CA_PEM } from "@klodi/tool-catalog";

/** Env var naming a PEM bundle path. Selects *which* CA to trust. */
const CA_FILE_ENV = "KLODI_NATS_CA_FILE";

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
 * `undefined` to use the system trust store. Throws {@link CaTrustError}
 * when `KLODI_NATS_CA_FILE` is set but unreadable — verification is never
 * disabled to work around a broken override.
 */
export function resolveTlsCa(): string | undefined {
  const override = process.env[CA_FILE_ENV];
  if (override !== undefined && override !== "") {
    try {
      return readFileSync(override, "utf-8");
    } catch (err) {
      throw new CaTrustError(
        `${CA_FILE_ENV}=${override} could not be read: ${String(err)}. `
        + "Point it at a readable PEM bundle or unset it to use the "
        + "bundled / system trust store — verification is never disabled "
        + "to work around this.",
      );
    }
  }
  return KLODI_NATS_CA_PEM.length > 0 ? KLODI_NATS_CA_PEM : undefined;
}
