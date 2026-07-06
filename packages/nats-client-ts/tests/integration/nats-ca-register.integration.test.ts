/**
 * GATED e2e — register-supplied CA, no env override, connects tls:// (ts).
 *
 * Criteria:
 *   - [e2e] private-CA NATS over tls:// + a register response supplying that CA
 *     as nats_ca → a host that persists it then connects using ONLY the
 *     register-supplied CA (no KLODI_NATS_CA_FILE) succeeds end-to-end.
 *   - [integration] a persisted register CA that does not match the proxy chain
 *     → connect fails CLOSED, never a plaintext / verify-off fallback.
 *
 * GATE (dev-pair local TLS harness — NOT the Railway proxy): SKIPS unless
 * KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL (tls://…), KLODI_NATS_CA_FILE
 * (the CA that signs the test nats cert), KLODI_TLS_CREDS_PATH.
 *
 * The client derives ${KLODI_HOME} from the creds-path parent, so we copy the
 * harness creds into a fresh temp home, persist the CA there via persistNatsCa,
 * and connect with the env override UNSET.
 *
 * Authored to spec; UNVALIDATED in CI until the harness exists. QA-owned.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KlodiClient } from "../../src/client.js";
import { CaTrustError, persistNatsCa } from "../../src/tls.js";

/** A bad persisted CA must reach a terminal error within this bound; a hang
 *  trips the race → the assertion fails. */
const TERMINAL_BOUND_MS = 12_000;

const ON = process.env["KLODI_TLS_INTEGRATION"] === "1";
const NATS_URL = process.env["KLODI_TLS_NATS_URL"] ?? "";
const CA_FILE = process.env["KLODI_NATS_CA_FILE"] ?? "";
const CREDS = process.env["KLODI_TLS_CREDS_PATH"] ?? "";
const SHOULD_RUN = ON && NATS_URL !== "" && CA_FILE !== "" && CREDS !== "";

// A valid but WRONG self-signed CA (does not sign the test nats cert).
const WRONG_CA = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUOYd0yLhlGK5jH6xxwvE3S5v0cakwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSa2xvZGktdGVzdC1jYS1iZXRhMB4XDTI2MDcwNDEyMjEw
MFoXDTM2MDcwMTEyMjEwMFowHTEbMBkGA1UEAwwSa2xvZGktdGVzdC1jYS1iZXRh
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtaUcJW6DMvTuV3j4LlBz
vRKm4B7Y4Yh/6D2mk3PpIZu0qVQXlzSr5B0Y/AXCooJxmW3p7/O21Vxf44kzDG4n
sbsgnq5UKmVnISzloymUhDF181e+tb7QHMye227SfM7liK4DdQ4lZzTx7tbDU9wI
Too/810UlL6+nlW67r4RIm3rGNCmrG6YQ8OW9Xpfub/IaDtJl+1xmXOpeASYuEEb
dw//FgdR+9BsiSDwn44ZJEDNAk6ddgX6BxK2vkoM5nsXOz+yT9BQGvSo7IIxM5DZ
fpq43DGiBnl6n1TKHkUodoWxpZ7/r2wAtO0PkCqHGYtlmcWm9Dq8uK3v0NJBgAV8
1wIDAQABo1MwUTAdBgNVHQ4EFgQU740IbcLfYe9+daxQ7v/pAE2EVxkwHwYDVR0j
BBgwFoAU740IbcLfYe9+daxQ7v/pAE2EVxkwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAC7gCQ/KxNgGRitStItsoScBqrE9oK0Dim4gA//+YrQjm
v3Mvns5LkKOh77gQ0Jjtke4WlaUgVfxLbaAAN2DxBltr2WFwLA03JZ3+q3CZZ8M/
6m1tbwlcVu+ImOlQZ9/ObWNlKD5510Z8qGmbrkw8Qo0c8hV/4X3hiBji3pRoTIaJ
uh6C6QqErvGUW6HfVZ/8oPxe5C/iVqJzYLX8jYQP+vzIT+rCRCIXvLLpKun74Oc/
DWKR7pY4DKpPbFfu3K7xwH+704ZTR7Zd3Mlcqq1sp87nBLOG9biVePFvKUzwr0U3
mb2pW8e2eH2dGBHieO2EWxmsoTfQIiKcJua4dibV+Q==
-----END CERTIFICATE-----
`;

let home: string;

function homeWithCreds(): { credsPath: string; configPath: string } {
  home = mkdtempSync(join(tmpdir(), "klodi-nats-ca-e2e-"));
  const credsPath = join(home, "nats.creds");
  copyFileSync(CREDS, credsPath);
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      handle: "tlsuser",
      user_id: "00000000-0000-4000-8000-000000000001",
      nkey_public: "UTLSTEST",
      nats_url: NATS_URL,
    }),
  );
  return { credsPath, configPath };
}

beforeEach(() => {
  delete process.env["KLODI_NATS_CA_FILE"];
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!SHOULD_RUN)("tls:// with register-supplied CA", () => {
  it("connects using only the persisted register CA (no env override)", async () => {
    const { credsPath, configPath } = homeWithCreds();
    persistNatsCa(home, readFileSync(CA_FILE, "utf-8"));
    const client = new KlodiClient({ credsPath, configPath });
    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      const resp = await client.request("p2p.v1.users.whoami", {});
      expect(typeof resp).toBe("object");
    } finally {
      await client.close();
    }
  });

  it("fails closed (terminal, bounded, structured) when the persisted CA does not match", async () => {
    // TIGHTENED from a bare
    // `.rejects.toThrow()`: the wrong-signer persisted register CA must fail
    // loud + terminal + prompt with a structured `CaTrustError`, not merely
    // "not connected". A hang trips the race → this fails. QA-owned.
    const { credsPath, configPath } = homeWithCreds();
    persistNatsCa(home, WRONG_CA);
    const client = new KlodiClient({ credsPath, configPath });
    let timer: NodeJS.Timeout;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), TERMINAL_BOUND_MS);
    });
    const attempt = client
      .connect()
      .then(() => "connected" as const)
      .catch((err: unknown) => err);
    const outcome = await Promise.race([attempt, timeout]);
    clearTimeout(timer!);
    void attempt.catch(() => {});
    expect(outcome, `wrong persisted CA connect HUNG past ${TERMINAL_BOUND_MS}ms`).not.toBe(
      "timeout",
    );
    expect(
      outcome instanceof CaTrustError,
      `wrong persisted CA must surface a structured CaTrustError (got ${String(outcome)})`,
    ).toBe(true);
    expect(client.isConnected()).toBe(false);
    await client.close();
  });
});
