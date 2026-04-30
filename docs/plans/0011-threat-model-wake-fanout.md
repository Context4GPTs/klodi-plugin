# PLAN-0011 — Threat model: wake-fanout (Rows D, E)

- **Status:** Landing with the Week-1 multi-host deliverable
- **Type:** Threat enumeration + mitigation record
- **Source:** [0010 § Threat-model deltas](./0010-multi-host-build-plan.md)

## Scope

0010 introduces two new assets:

1. A **server-side wake-fanout** service that subscribes to
   `p2p.v1.notifications.>` and POSTs signed envelopes to each user's
   registered host webhook.
2. A **per-user webhook channel** `(webhook_url, hmac_secret)` stored in
   Postgres, rotated by reregistration.

Every other threat the prior cloud-pivot draft proposed (aggregated
credential store, multi-tenant MCP isolation, MCP session tokens, fake
MCP endpoint, OAuth token lifecycle) **does not apply** to the Tier-A
architecture shipped in Week 1. Those rows stay out of the threat model
until Tier-B partnerships force a hosted MCP.

## Rows to add

### Row D — Wake-fanout abuse

*Compromise of the fanout service or the wake_channels lookup table
enables (a) spurious wakes (spam/DoS against the user's agent),
(b) suppressed wakes (user misses a live deal), or (c) metadata
exfiltration via crafted payloads.*

**Scope:** cloud — the fanout runs on klodi infrastructure.

**Mitigations implemented in Week 1:**

- **Content-free envelope.** The outbound POST carries only
  `{user_id, kind, timestamp}`. All marketplace content (offers,
  listings, channel messages, comments) stays on the backend and is
  pulled by the agent via `klodi_pending`. A fanout compromise cannot
  exfiltrate marketplace content it never sees.
- **HMAC-SHA256 signed envelopes.** Every outbound POST carries
  `X-Klodi-Signature: sha256=<hex>` computed over the exact bytes of
  the body using the per-user secret. Adapter webhook handlers verify
  the signature and reject any unsigned or mis-signed payload
  (see Row E, and `klodi-plugin/packages/klodi-mcp/src/lib/webhook-verify.ts`).
  A fanout operator cannot forge wakes that pass adapter verification
  without also compromising the wake_channels row for that user.
- **Per-user rate limits.** Token-bucket limiter in
  `services/wake-fanout/src/rate-limit.ts` enforces `burst` +
  `sustained/window` caps per user. A compromised publisher cannot
  hammer a user's webhook faster than the configured rate. Default:
  10 burst, 30 per 60s — tuned from 0010's "contain dispatch loops"
  requirement.
- **Bounded retry with exponential backoff.** Default 3 attempts,
  500ms → 5s delay cap. A single stuck POST cannot tie up the
  fanout; a user's dead webhook channel fails fast.
- **Event-content-free logs.** The fanout logs user_id,
  host_slug, webhook host (not full URL), and HTTP status.
  Adapter-side bodies are never logged.
- **Secret rotation via reregistration.** `klodi_wake_register` issues
  a fresh HMAC secret on every call; the old secret is discarded
  atomically in the upsert. Users rotate by re-running
  `klodi_wake_register` from any host.

**Residual risk:** The wake_channels table in Postgres contains the
plaintext HMAC secret for each user. A read of this table by a
compromised DB user would let an attacker sign valid payloads to the
adapter's webhook, producing spurious wakes. Mitigation path:
application-layer encryption of `hmac_secret` with a KMS-held key,
deferred until multi-instance fanout forces key-management discipline.

### Row E — Webhook-endpoint forgery

*A network-level attacker sends a forged POST directly to the adapter's
webhook endpoint, attempting to trigger spurious agent wakes.*

**Scope:** host — the adapter's webhook handler is the defensive layer.

**Mitigations implemented in Week 1:**

- **HMAC verification on every inbound POST** before the adapter pokes
  the host's wake primitive. Implementation lives in
  `klodi-plugin/packages/klodi-mcp/src/lib/webhook-verify.ts` and is reusable by
  any adapter regardless of host language (TypeScript adapters import
  directly; other runtimes reimplement the ~30 lines).
- **Constant-time comparison** via `node:crypto.timingSafeEqual`.
  Rejects unsigned payloads, wrong-algorithm signatures, and length
  mismatches without touching the user's agent.
- **HMAC secret stored client-side at 0600.** Same posture as the NKey
  (`${klodi_home}/nats.creds`). Overwritten by reregistration;
  survives host restart.
- **Envelope shape validation** after signature verification.
  `parseEnvelope` throws on missing user_id/kind/timestamp fields so
  a signature-valid but shape-invalid payload (from a future fanout
  version the adapter doesn't yet understand) cannot reach the wake
  primitive.

**Residual risk:** An attacker with read access to
`${klodi_home}/wake.hmac` on the user's machine could forge valid
wake POSTs. This reduces to the existing workstation-owner trust
anchor already documented in `docs/plans/README.md` § Out of scope —
the attacker would also have access to `nats.creds` and thus the
entire NKey-scoped backend surface, not just wake.

## Rows explicitly NOT added

The prior cloud-pivot draft proposed Rows A/B/C/F/G covering a hosted
MCP service. The Tier-A architecture (stdio MCP + server fanout)
eliminates each of them by construction:

| Proposed row | Why N/A under Week-1 architecture |
|---|---|
| A — Aggregated credential store | No aggregated NATS credentials server-side; NKey stays on the user's disk. |
| B — Cross-tenant MCP session leakage | No hosted MCP sessions — tool calls originate from the user's subprocess. |
| C — MCP session-token theft | No MCP session tokens. |
| F — Fake MCP endpoint | No public MCP endpoint to spoof — every adapter spawns `klodi-mcp` locally. |
| G — OAuth token lifecycle weakness | No OAuth tokens on the Tier-A path; NKey-based authentication only. |

Reinstate when Tier-B partnerships force a hosted MCP for a partner
whose host cannot spawn a local subprocess — scoped to that partner's
integration, not a Tier-A default.

## Definition of done

- [x] Row D and Row E added to this plan with mitigations explicitly
  mapped to source files.
- [x] Wake fanout service enforces the Row D mitigations in code:
  content-free envelope, HMAC signing, rate limits, bounded retry,
  sanitized logs.
- [x] `webhook-verify.ts` helper exports HMAC verification for every
  future adapter.
- [x] Database migration creates `wake_channels` with `hmac_secret`
  column sized to hold a 64-char hex-encoded secret.
- [ ] When Tier-B partnerships close: reinstate Rows A/B/C/F/G scoped
  to the partner's hosted-MCP integration. (Tracked on 0010 § Open
  questions; not a Tier-A blocker.)
