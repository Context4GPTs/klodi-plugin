# TLS-CA test fixtures — `gate-auto-trust-on-well-formed-ca-loud-fail`

Locally-generated X.509 fixtures for the cross-family TLS-trust tests
(`nats-client-{py,ts,rs}`). They let the unit/integration tiers prove the
auto-trust loud-fail contract **without** blocking on the marketplace
`regenerate-nats-ca-with-keyusage-for-all-adapters` card (that card is only
required for *prod* correctness — the real served CA carrying keyUsage).

Regenerate with `./gen.sh <outdir>` (needs `openssl`). Certs are valid 3650
days. These are **throwaway test keys** — no marketplace value.

## What each fixture is

| File | Role |
|---|---|
| `ca-good.pem` / `.key` | **Pillar A** anchor: a well-formed, **keyUsage-bearing** CA (`basicConstraints=CA:TRUE`, `keyUsage=keyCertSign,cRLSign`). A TLS stack accepts it as a trust anchor. |
| `leaf-good.pem` / `.key` | Server leaf signed **directly** by `ca-good`, `SAN=DNS:localhost,IP:127.0.0.1`, `EKU=serverAuth`. The server cert for the Pillar-A positive path and the wrong-signer negative. |
| `ca-wrong.pem` / `.key` | **Pillar B (universal)**: a well-formed keyUsage-bearing CA that signed **nothing the server presents**. A client that trusts *this* while the server presents `leaf-good` is rejected by **every** stack (issuer not trusted). This is the cross-family anchor. |
| `int-nokeyusage.pem` / `.key` | **Pillar B (strict-stack)**: the "keyUsage-missing CA" — an intermediate signed by `ca-good` but whose `keyUsage` **omits `keyCertSign`** (`CA:TRUE` + `keyUsage=digitalSignature`). PEM-valid; a trust context builds; but strict stacks (OpenSSL/rustls) refuse it as a signer. |
| `leaf-viachain.pem` / `.key` | Server leaf signed by `int-nokeyusage`. |
| `chain-nokeyusage.pem` | `leaf-viachain` + `int-nokeyusage` concatenated — the chain the server presents for the keyUsage-missing case. Client trusts `ca-good` (the root); path-building refuses the defective intermediate. |

## Empirically-verified trust outcomes (Python OpenSSL 3.x)

- trust `ca-good`, present `leaf-good` → **verifies** (cert + hostname). *(Pillar A)*
- trust `ca-wrong`, present `leaf-good` → **reject**, `unable to get local issuer certificate` (verify code 20). *(Pillar B universal — every stack)*
- trust `ca-good`, present `chain-nokeyusage` → **reject**, `invalid CA certificate` (verify code 79). *(Pillar B strict — py/rs)*

Per Open-question #7 (per-stack keyUsage strictness asymmetry), the
**wrong-signer** case is the guaranteed cross-family negative; the
**keyUsage-missing** case is the strict-stack (Python/Rust) instance. TS/Node
is not asked to reject a keyUsage-defect (a rejected alternative) — its negative
uses wrong-signer.
