# 0010 — Multi-host build plan

**Status:** shipping — week 1 merged (PR #35); weeks 2–4 delivered in feat/multi-host-adapters
**Source:** follow-up to [0009](./0009-multi-host-marketplace-strategy.md) — strategy picked the hosts; this plan picks the shipping architecture.
**Scope:** implementation-level architecture for porting klodi from OpenClaw-only to the Tier-A hosts we actually intend to win (OpenClaw, Hermes, Moltis, ZeroClaw, IronClaw, nanobot) and the Tier-B partnership path (Claude Cowork, Nebula, Arahi, Vellum) where client-side code isn't an option.

## Guiding principle

> **klodi's tool logic runs on the user's machine; the only new server-side component is a dumb NATS-to-webhook fanout that turns backend events into signed POSTs to each host's inbound webhook.** Each adapter per host is a thin bundle — skill + setup flow + a pointer at a shared stdio MCP binary. No hosted MCP server, no aggregated credential store, no per-user multi-tenant session state on our infra.

This preserves the privacy posture of today's OpenClaw plugin — NKey stays on disk, strategy files stay on disk, the only data transiting our backend is the marketplace data that always had to — while unlocking every Tier-A host that exposes MCP stdio for tools and an inbound HTTP webhook for wake.

The architecture collapses from "run a hosted multi-tenant MCP service + OAuth resource server + dispatcher + local wake-relay" to "ship one compiled stdio MCP binary + a dumb NATS-to-webhook fanout next to the existing backend." Most of today's client code is reused as-is; most of the new server work goes away.

## Out of scope for this pivot

- **Coding-first hosts** — Cursor, Claude Code (the CLI), Goose, OpenCode, Letta, Emdash, Amp, Kiro, OpenHands, Workshop, fast-agent. klodi is tangential to their primary workflow; we accept any free distribution that happens because they read `agentskills.io` or the Anthropic plugins ecosystem, but we do not build adapters for them in v1. Revisit if usage data later justifies it.
- **Any host that cannot accept a signed inbound HTTP webhook.** If a host has no network-reachable wake channel, it ships at session-start-polling tier or it does not ship. We do not ship a local wake-relay binary to close the gap — the complexity cost exceeded the reach benefit.
- **A hosted MCP server.** Deferred to Tier-B when the first partnership (Cowork / Nebula / Arahi / Vellum) makes it unavoidable. Building it later is strictly additive; we do not pay the cost twice.

## Two planes

| Plane | Default (every host, including OpenClaw) | How it works |
|---|---|---|
| **Data** (agent ↔ klodi tool calls) | Stdio MCP | The host spawns `klodi-mcp` as a subprocess. It exposes the full `klodi_*` tool surface, reads the user's NKey from `${klodi_home}/nats.creds` (`0600`, same as today), and talks to the klodi backend over NATS request-reply. |
| **Wake** (backend event → idle agent) | HostWebhook | Our NATS-to-webhook fanout POSTs a signed envelope to the user's registered host webhook. The adapter's webhook handler verifies the HMAC, then pokes the host's native wake primitive (OpenClaw's `enqueueSystemEvent + requestHeartbeatNow`, Hermes's scheduler, Moltis's persistent-agent API, etc.). The agent wakes, the skill tells it to call `klodi_pending`, and the queue drains through the stdio MCP tools. |

One architecture across every host. Today's OpenClaw-specific code (in-process NATS subscription, in-process wake) gets extracted or retired as part of the migration — see **Stdio MCP binary** § *Extraction from today's OpenClaw plugin* for the source-mapping.

Both planes reuse code we already have. The stdio MCP binary is `src/tools/*.ts` + `src/lib/*.ts` wrapped in a JSON-RPC loop. The fanout subscribes to the same `p2p.v1.notifications.<userId>` stream the existing plugin already subscribes to — we're moving the subscription from the user's machine to our server, not inventing a new event path.

## Server-side wake fanout

One new service, sitting next to the existing klodi API. Responsibilities in full:

1. Subscribe to `p2p.v1.notifications.>` on the existing NATS cluster — the same stream today's plugin subscribes to per-user.
2. On each event, look up the user's registered wake channel: `{webhook_url, hmac_secret}` keyed by `user_id`.
3. POST a minimal signed envelope to `webhook_url`. Payload: `{"user_id": ..., "kind": "klodi-pending", "timestamp": ...}` — **no event content, no listing/offer data**. The adapter calls `klodi_pending` to pull the actual events. Signature: `X-Klodi-Signature: sha256=<hmac>`.
4. Rate-limit per user (burst + sustained) to contain dispatch loops.
5. Retry with bounded exponential backoff on 5xx; drop after N failures and log.

Per-user state held server-side — **one record per user, last-write-wins**:
- `wake_channel_url` — the host's inbound webhook.
- `wake_channel_hmac_secret` — generated at registration, delivered to the adapter once.
- Optionally, a fallback tier (e.g., email) — omitted in v1.

When the same user runs `klodi_register` on a second host, the new registration overwrites the previous one. Only the most recently registered host receives push wakes; earlier hosts drain events through `klodi_pending` on next session activity. No events are lost — only wake latency shifts for the quieted host. See **Identity and authorization** § *Wake channel: last-write-wins* for the rationale.

That is the entire service. No user access tokens, no OAuth resource server, no tool routing, no per-session NATS scoping, no multi-tenant MCP plumbing. One engineer owns it end-to-end; roughly a week of work plus ongoing dispatch-quality monitoring.

Crucially, the klodi backend itself is unchanged. The fanout sits *beside* it, not *in front of* it. Tool calls from every host still reach the backend the way they always have — through authenticated NATS request-reply with the user's own NKey. The backend never sees traffic from a "hosted MCP" layer because there isn't one.

## Package layout per host

A klodi-for-host-X package contains:

```
@4gpts/klodi-<host>/
├─ manifest                  host's native format (openclaw.plugin.json,
│                            plugin.yaml, Cargo.toml, etc.) — declares
│                            `command: klodi-mcp` (or the host's equivalent
│                            stdio-MCP slot); host wires the subprocess on install
├─ skill/                    identical across every host — the playbook the agent reads
│  ├─ SKILL.md
│  ├─ SETUP.md
│  ├─ policies/security.md
│  └─ templates/negotiation_style.template.md
├─ <host-specific entry>     for Hermes: __init__.py exposing register(ctx) that
│                            wires klodi_* tools via ctx.register_tool(...) with
│                            handlers that proxy to a persistent klodi-mcp subprocess.
│                            For OpenClaw: src/index.ts plugin entry. For Rust hosts:
│                            src/bin/webhook.rs + src/bin/setup.rs.
├─ setup.{ts,py,rs,sh}       first-run: seeds policy files on disk, kicks off the
│                            existing klodi_register OAuth flow (browser → backend →
│                            NKey at ${klodi_home}/nats.creds), registers the host's
│                            inbound webhook URL + HMAC secret with the backend
└─ README.md
```

**Hermes adapter shape specifically** — matches real Hermes plugin convention
verified from `hermes-cloudflare-plugin`: flat directory with `plugin.yaml` +
`__init__.py` at root (NOT a pip package with a `src/klodi_hermes/` subpackage).
`plugin.yaml` declares `provides_tools` + `requires_env`; `__init__.py` calls
`ctx.register_tool(name, toolset, schema, handler, check_fn, requires_env,
is_async, description, emoji)` per the Hermes 0.3.0+ SDK. Hermes clones the
repo into `~/.hermes/plugins/<name>/` and loads `__init__.py` on
`hermes plugins enable`. Non-Hermes adapters pick the idiomatic layout for
their ecosystem — setuptools `py-modules` for Python, `[[bin]]` for Rust,
`openclaw.plugin.json` for OpenClaw.

What's **not** in the package:
- Tool implementations — live in the shared `klodi-mcp` binary.
- A hosted endpoint pointer — there is no hosted endpoint.
- A wake-relay binary — there isn't one.
- A local always-on daemon separate from the host — there isn't one.

What **is** shared across every adapter:
- The entire `skill/` directory — one canonical SKILL.md, byte-for-byte.
- The `klodi-mcp` binary target — one compiled artifact that every adapter points at.
- The setup-flow logic (seed policies + OAuth + register webhook) — parameterized by host.

Result: each adapter is a few hundred lines of host-specific glue around shared artifacts. Authoring a new adapter is closer to "write a manifest, a 30-line setup script, and a webhook handler that verifies HMAC and forwards to the host's wake primitive" than "port a codebase."

## Repository and release topology

**One monorepo, multiple per-host package outputs.** All adapters, the shared skill bundle, and the stdio MCP binary source live in `github.com/Context4GPTs/klodi-plugin` under an `adapters/` tree. Each adapter is published to its host's native package registry from the monorepo via CI.

```
klodi-plugin/                         (this repo)
├─ packages/
│  └─ klodi-mcp/                      stdio MCP server — wraps today's src/tools/* + src/lib/*
│                                     in a JSON-RPC loop; single artifact every adapter consumes
├─ skill/                             canonical skill bundle (@4gpts/klodi-skill)
├─ adapters/
│  ├─ openclaw/                       OpenClaw manifest + webhook handler + skill copy
│  │                                  (migrated from today's src/ — see extraction table)
│  ├─ hermes/                         Python setup + manifest + webhook handler
│  ├─ moltis/                         Rust setup + manifest + webhook handler
│  ├─ zeroclaw/ironclaw/nanobot/      per-host adapters, same shape
│  └─ common/                         shared adapter helpers
└─ registry/listings.yaml             source of truth for per-host listing metadata
```

Host registries (Hermes Atlas, Moltis plugin list, etc.) receive listings that link to `klodi-plugin/tree/main/adapters/<host>` — not to separate storefront repos. We accept that per-host star counts and per-host issue trackers blend into the monorepo's; the simplicity of one source of truth, one CI pipeline, and atomic skill-bundle rollouts across all adapters is worth more than native-looking per-host repos.

**Shared skill bundle — build-time copy, not symlink.** Each adapter's directory at publish time must be self-contained, because several host registries copy the plugin to a local cache and block path traversal outside the plugin root. Rather than relying on symlinks to survive those caches, per-adapter CI runs a `copy-skill-bundle` step that materializes `skill/` into `adapters/<host>/skills/klodi/` before publishing. The authoritative source remains the monorepo's root `skill/` directory — adapter-local copies are build artifacts, never edited by hand.

**Adapter directories match their host's plugin format natively.** The OpenClaw adapter's directory *is* an OpenClaw plugin. The Hermes adapter's directory *is* a Hermes plugin. Zero transformation between source and publish.

## Wake dispatch — verified per host

Every Tier-A host, including OpenClaw, uses the same `HostWebhook` strategy. The adapter's only job on the wake side is to (a) stand up an HMAC-verifying handler at the host's webhook endpoint and (b) register `{webhook_url, hmac_secret}` with our backend during setup.

### The unified shape: inbound webhooks

The 2026 personal-agent ecosystem converged on a common pattern. Every Tier-A host we target runs as a persistent server and exposes an **inbound HTTP webhook endpoint** that third parties can POST to — typically for "receive GitHub/Stripe/messenger events," equally usable for our wake signal.

### Strategy table, verified

| Strategy | Hosts | Mechanism | Evidence |
|---|---|---|---|
| `HostWebhook` | **OpenClaw** | Fanout POSTs to an HTTP endpoint the plugin's service registers; handler verifies HMAC then calls `enqueueSystemEvent + requestHeartbeatNow` on the OpenClaw SDK. Built + tested as `adapters/openclaw/src/service/webhook.ts`; NOT yet wired into `src/index.ts` — the in-process NATS consumer remains active as the documented fallback until OpenClaw's webhook primitive is verified (§ Open questions). Flipping is a one-import-line change. | OpenClaw plugin service + existing wake code |
| `HostWebhook` | **Hermes** | Fanout POSTs to the Hermes gateway's `platforms.webhook.extra.routes.klodi` route; Hermes validates the HMAC-SHA256 signature using the `secret` field the klodi adapter wrote into `~/.hermes/config.yaml`, then dispatches a prompt to the agent. A standalone `klodi-hermes-webhook` daemon (at `adapters/hermes/webhook.py`) is available for deployments without the Hermes gateway exposed. | [Hermes webhooks docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks) |
| `HostWebhook` | **Moltis** | Fanout POSTs to the klodi-moltis-webhook binary which HMAC-verifies and then forwards to Moltis's persistent-agent API via hyper-util HTTP client. Real forward is gated behind `MOLTIS_WAKE_URL + MOLTIS_AGENT_TOKEN`; missing both without `--allow-observe-only` refuses to start. | [Moltis.org](https://moltis.org/) |
| `HostWebhook` | **ZeroClaw** | Fanout POSTs directly to ZeroClaw's native `POST /hooks/wake` endpoint in the canonical deployment. Optional defense-in-depth passthrough via `klodi-zeroclaw-webhook` for operators who want an independent HMAC verification hop. | [ZeroClaw gateway docs](https://deepwiki.com/zeroclaw-labs/zeroclaw/10-gateway-and-webhook-server) |
| `HostWebhook` | **IronClaw** | Fanout POSTs to `klodi-ironclaw-webhook`; HMAC-verified envelopes forward to IronClaw's event-trigger endpoint via hyper-util. | [IronClaw HTTP webhooks](https://deepwiki.com/nearai/ironclaw/4.3-http-webhooks) |
| `HostWebhook` | **nanobot** | Fanout POSTs to `klodi-nanobot-webhook`; on valid POST the daemon publishes a `klodi.pending` event on the configured nanobot event-bus channel (default `klodi`). The agent subscribes to that channel and wakes to call `klodi_pending`. | nanobot release notes |
| `PartnerNotification` (Tier-B, future) | **Claude Cowork**, Nebula, Arahi, Vellum | Partnership-driven inbound integration endpoints. Each has its own catalog webhook. Timing depends on BD. | partnership-driven |

### Degraded floor

Even if a host's webhook is temporarily unreachable, the user can say "anything new on klodi?" and the agent calls `klodi_pending`. Wake is an optimization over manual drain; it is not load-bearing for correctness.

### What each adapter owes the fanout

Per host, during setup the adapter registers with our backend:

1. **Webhook URL** — where the fanout should POST.
2. **HMAC secret** — generated by the backend, returned to the adapter once; adapter persists it for verification.

That registration happens once, piggybacking on the existing `klodi_register` OAuth flow. The adapter does not run any wake code beyond the initial registration and the webhook-verifying handler it ships with the host.

## Stdio MCP binary: the one shared client artifact

A single compiled `klodi-mcp` exposes the full `klodi_*` surface over JSON-RPC on stdin/stdout. Consumed by every adapter, including OpenClaw. What it is:

1. A thin JSON-RPC loop (`initialize`, `tools/list`, `tools/call`) wrapping the existing `src/tools/*.ts`.
2. The existing NATS request-reply client (`src/lib/nats-client.ts`) for tool dispatch to the backend, authenticated by the user's NKey on disk.
3. **No NATS subscription.** No always-on listener. The binary is invoked by the host as a subprocess when tools are called; its lifecycle is the host's lifecycle. Wake comes from the server-side fanout → host webhook, not from an in-process listener.

What it is **not**:
- Not a daemon. Not a system service. Lives and dies with the host session that spawned it.
- Not OS-specific in interesting ways — compiled via Bun to single-file binaries for macOS/Linux/Windows.
- Not shipping cross-host wake logic; that's the server's job.

**Distribution:**
- Primary: each adapter declares the MCP command in its host's native manifest (`command: klodi-mcp`) and bundles the binary at publish time via CI — same pattern as the skill-bundle copy step.
- npm package `@4gpts/klodi-mcp` as a secondary path for Node-enabled hosts that prefer `npx`.
- Signed GitHub Releases, reusing the publish-provenance discipline from [0004](./0004-npm-publish-provenance.md).

### Extraction from today's OpenClaw plugin

The week-1 deliverable (see Rollout). Source-mapping from the current repo:

| Today (OpenClaw in-process plugin) | After extraction |
|---|---|
| `src/tools/*.ts` | `klodi-plugin/packages/klodi-mcp/src/tools/*.ts` — reused wholesale |
| `src/lib/*.ts` (NATS request-reply client, schemas, config, duration, markdown helpers) | `klodi-plugin/packages/klodi-mcp/src/lib/*.ts` — reused wholesale |
| `src/service/nats.ts` (long-lived NATS subscription + durable JetStream consumer) | **Retired.** The server-side fanout owns the subscription; every client path is request-reply only. |
| `src/service/wake.ts` (`enqueueSystemEvent + requestHeartbeatNow`) | **Moved into the OpenClaw adapter's webhook handler.** Same SDK calls, now invoked after verifying an inbound HMAC-signed POST from the fanout instead of an in-process NATS message. Stays OpenClaw-specific because the SDK pair is OpenClaw-specific. |
| `src/service/notifications.ts` (event parsing, agent-facing formatting, below-floor auto-reject) | **Split.** Event parsing moves to the fanout (decides when to POST). Agent-facing formatting moves into `klodi_pending`'s response shape. Below-floor auto-reject is explicitly out of scope — a nice-to-have, not shipped in this plan. |
| `src/index.ts` (OpenClaw plugin entry) | **Becomes the OpenClaw adapter** at `adapters/openclaw/`: a thin shim that declares `klodi-mcp` as its MCP server and registers a webhook handler with OpenClaw's plugin-service mechanism. |

For existing OpenClaw users: the `@4gpts/klodi` package on ClawHub ships a new major version that does the above. `${klodi_home}/` state is preserved byte-for-byte; `klodi_register` run once post-upgrade registers the webhook URL and pulls the HMAC secret into `${klodi_home}/wake.hmac`.

This is the only file-level migration in the plan. Every other adapter is new code.

## Identity and authorization

Unchanged from today for the data plane: browser OAuth → backend → NKey stored on disk at `0600`. Each adapter seeds credentials into the same `${klodi_home}/` path, so one user on multiple hosts means one NKey file means one `klodi_user_id` — inventory, reputation, floor-price rules all travel with the user automatically, with no "link accounts" flow.

**No Auth0 resource server is required for Tier-A.** The stdio MCP path authenticates at the NATS layer with the user's NKey, exactly like today. OAuth 2.1 and Auth0-as-identity-kernel become necessary only when Tier-B forces a hosted MCP (because those hosts can't spawn a local subprocess). Defer until then.

### `${klodi_home}` — path resolution

Resolution order is the same on every host: explicit `klodi_home` plugin config → `KLODI_HOME` env var → platform default.

| Host | Platform default |
|---|---|
| OpenClaw | `~/.openclaw/workspace/.klodi/` (unchanged — preserves existing users) |
| Every other host, Linux | `$XDG_CONFIG_HOME/klodi/` (or `~/.config/klodi/` if XDG is unset) |
| Every other host, macOS | `~/Library/Application Support/klodi/` |
| Every other host, Windows | `%APPDATA%\klodi\` |

On-disk layout — both credential files at `0600`, optionally backed by OS keychain per [0002](./0002-keychain-backed-credentials.md):

```
${klodi_home}/
├─ nats.creds           # long-lived NKey for backend NATS (unchanged from today)
├─ wake.hmac            # per-user HMAC secret for verifying inbound fanout POSTs (new)
├─ config.json          # non-secret klodi state (unchanged from today)
├─ policies/            # seeded templates, user-editable (unchanged from today)
├─ sell/                # per-listing strategy files (unchanged from today)
└─ buy/                 # per-search strategy files (unchanged from today)
```

### First-run and repeat-install flow

On first invocation of `klodi_register`:
1. Binary detects no existing creds, opens a browser to the backend's OAuth endpoint.
2. User completes sign-in; backend issues NKey + per-user HMAC secret; redirects to a local listener the binary stood up.
3. Binary writes `nats.creds` and `wake.hmac` into `${klodi_home}/` at `0600`.
4. Binary POSTs the adapter's webhook URL to the backend, which upserts the user's single wake-channel record.

On any subsequent invocation — e.g., the user installs the adapter on a second host and its setup flow runs `klodi_register` again — `klodi_setup_status` detects the existing `nats.creds` (the same check the current plugin uses), skips OAuth, and re-POSTs the new host's webhook URL. The backend overwrites the previous wake channel with the new one.

### Wake channel: last-write-wins

The wake-fanout keeps **one** `{webhook_url, hmac_secret}` per user. Registering on a second host replaces the previous registration. Only the most recently registered host receives push wakes; earlier hosts fall back to `klodi_pending` on next session activity.

This is deliberately the simplest lookup shape: one row per user, one POST per event, no list iteration, no per-device routing table. Multi-host users are a small fraction of the population and the degradation (session-start polling on quieted hosts instead of instant wake) is bounded — events are not lost, only wake latency shifts. The schema trivially extends to multi-channel later if real usage warrants it, without breaking any existing adapter contract.

OpenClaw follows the same rule: registering on OpenClaw after registering on Hermes overwrites Hermes's webhook. Users running klodi on multiple hosts pick their "primary" implicitly by running `klodi_register` there last.

### Credentials summary

| Credential | Lifetime | Stored by | Adapter handles it? |
|---|---|---|---|
| NKey | long-lived, public-key | `${klodi_home}/nats.creds` at `0600` | Yes — seeded by `klodi_register`, unchanged from today |
| Wake-channel HMAC secret | long-lived, rotatable | Server side: DB + KMS; client side: `${klodi_home}/wake.hmac` at `0600` | Read on inbound POST verification |

No MCP access tokens, no refresh tokens, no token-rotation lifecycle — because there is no MCP session on our servers.

### Subprocess lifecycle

The stdio MCP binary reads `nats.creds` once at startup, opens a NATS connection for request-reply on first tool call, and keeps it alive for the subprocess's lifetime. When the host tears down the MCP session, the subprocess and its NATS connection die together. No cross-session state, no reconnect loop, no orphaned subscriptions — the whole of `src/service/nats.ts`'s long-lived connection management in today's plugin can be elided in the stdio MCP build.

## Language and runtime

Almost all language concerns stay on the client, re-using today's code:

| Component | Language | Why |
|---|---|---|
| Skill bundle (`SKILL.md`, policies, templates) | Markdown | Universal; every agent-skills client reads it directly |
| `klodi-mcp` stdio server | TypeScript, Bun-compiled | Reuses existing `src/tools/*.ts` and `src/lib/*.ts` one-for-one |
| Setup flow | Whatever the host's plugin runtime prefers (TS for OpenClaw, Python for Hermes/nanobot, Rust for Moltis/IronClaw/ZeroClaw) | Minimal (~100 LoC); per-host anyway |
| Webhook handler | Same language as setup flow | Verifies HMAC, pokes host's native wake primitive |
| Host manifest | Host's native format | Metadata only |
| Wake fanout service | TypeScript / Node on our infra | We pick |

**We do not need a Python port of tool logic to reach Hermes, nor a Rust port for Moltis/IronClaw/ZeroClaw.** Tool logic lives in the compiled Bun binary; each adapter's per-host glue (setup + webhook handler) is small enough to write in the host's preferred language.

## Versioning

Five artifacts version independently. The rule that makes this tractable: **the backend API is always backward-compatible; clients never check its version.**

| Artifact | Cadence | Version scheme | Distribution |
|---|---|---|---|
| klodi backend API | continuous | internal, no client-visible version | deploy |
| Wake fanout service | continuous | internal; payload shape is additive-only | deploy |
| Skill bundle | weekly-ish | semver, git tag `skill-vX.Y.Z` | static HTTPS at `skill.klodi.ai/v<N>/` + `@4gpts/klodi-skill` npm |
| `klodi-mcp` binary | moderate | semver, git tag `mcp-vX.Y.Z` | npm + Bun-compiled signed binaries on GitHub Releases |
| Host adapter (per host) | per host, independent | semver per adapter | host's registry |
| On-disk user state (`${klodi_home}/...`) | on adapter upgrade | seeded once, preserved on upgrade | filesystem |

### Additive-only contracts

Standard web-API discipline: never remove tools, never break call shapes, never remove response fields. The wake fanout's POST envelope is additive-only for the same reason. No client ever needs a `minServerVersion` check.

### Compatibility rule: server leads, skill trails

Always ship backend capability **before** any skill version references it. A skill that names a tool the server hasn't deployed yet produces a hard "tool not found." The inverse is benign — unused capacity. This is the only release-coordination discipline the team has to hold.

## Threat-model deltas

The cloud pivot of the prior draft introduced seven new threat rows (A through G) covering aggregated credentials, multi-tenant MCP isolation, OAuth session tokens, wake dispatcher abuse, and fake-MCP-endpoint attacks. **The stdio-MCP + wake-fanout architecture eliminates most of them**, because credentials stay on the user's disk and there is no multi-tenant hosted session state. What's left:

### What moved vs. today

| Asset | Before (OpenClaw in-process plugin) | After (stdio MCP + fanout, all hosts including OpenClaw) |
|---|---|---|
| NATS credentials | On user's disk, `0600` | **Unchanged** — still on user's disk, `0600`, one user per machine |
| Session authentication | NKey signature at NATS layer | **Unchanged** |
| NATS wake subscription | User's machine (the plugin process) | **Server-side** (in the fanout), for every host including OpenClaw. The subscription holds no user credentials — it reads from the stream the backend already publishes |
| Tool-call dispatch | Plugin → NATS → backend | Stdio MCP subprocess → NATS → backend — same shape, different process host |
| Wake delivery | NATS push to the plugin process | Signed HMAC webhook from fanout → host's inbound webhook → adapter-side verification → host's native wake primitive |

### What did not move

- **Strategy privacy.** Floor prices, walk-away rules, `sell/*.md`, `buy/*.md` still live on the user's disk. The skill still gates what leaves the machine. The fanout sees only marketplace events the backend already has; the webhook payload carries no strategy content.
- **Policy hard rules.** `security.md` still lives on disk, still enforced by the skill. Backend enforcement remains the server-side defense-in-depth layer.
- **Workstation-owner trust anchor.** Unchanged. Threats from other software running as the same UID remain the user's composition decision. See [`docs/plans/README.md`](./README.md) § Out of scope.

### New threat-model rows (proposed for `THREAT_MODEL.md`)

| # | Threat | Scope | Mitigation |
|---|---|---|---|
| D | **Wake-fanout abuse.** Compromise of the fanout or the wake-channel lookup table enables (a) spurious wakes (spam/DoS on the user's agent), (b) suppressed wakes (user misses a live deal), (c) metadata exfiltration via crafted payloads. | cloud | Signed wake payloads (HMAC-SHA256) with adapter-side verification; rate-limit per-user wake delivery; wake payloads carry only `{user_id, kind, timestamp}` — no event content; audit every wake dispatched; rotate HMAC secrets on explicit user request. |
| E | **Webhook-endpoint forgery.** A network-level attacker sends a forged POST to the adapter's webhook endpoint, triggering spurious agent wakes. | host | HMAC verification on every inbound POST before the adapter pokes the host's wake primitive. Constant-time comparison. Reject unsigned or mis-signed payloads; rate-limit verification failures to contain probing. |

**Not applicable under this architecture:**
- Row A from the prior draft (aggregated credential store compromise) — we do not aggregate user NATS credentials server-side.
- Row B (cross-tenant MCP session leakage) — there are no hosted MCP sessions.
- Row C (MCP session-token theft) — there are no MCP session tokens.
- Row F (fake MCP endpoint) — there is no public MCP endpoint to spoof.
- Row G (token lifecycle weakness) — there are no OAuth tokens on the Tier-A path.

These rows become relevant again when Tier-B forces a hosted MCP; reinstate as part of that work, not this one.

### Launch gating

Rows D and E must be implemented and tested before the fanout goes to any user. That is the whole new-threat list for Tier-A — a small, bounded delta instead of seven new rows plus a full multi-tenant security review.

## Messaging and positioning

Today's README leans on "your strategy stays on your machine." That phrasing stays accurate:

| Layer | Lives where | Visible to klodi backend? |
|---|---|---|
| **Strategy** — floor prices, walk-away thresholds, private facts, policy bodies, per-listing reasoning | User's disk, in `${klodi_home}/policies/`, `sell/*.md`, `buy/*.md` | No — the skill gates what leaves the machine |
| **Infrastructure** — listing content, offer terms, channel messages, transaction details, public ratings | Backend (always has been; has to be, for a marketplace) | Yes — this is the marketplace |

The architecture doesn't change the strategy/infrastructure split. The NKey still lives on the user's disk. Tool calls still originate from a process on the user's machine — a `klodi-mcp` subprocess spawned by whichever host the user is running. The only *new* data flow is the outbound webhook POST from our fanout to the host's webhook — and that POST carries no strategy content and no marketplace content, just "there's something pending, call `klodi_pending`."

### Writing rules

1. **Say "strategy," not "data."** "Your strategy stays on your disk" is accurate. "Your data stays on your machine" is not — listing content, by definition, is public.
2. **Name infrastructure honestly.** Tool calls go through `klodi.4gpts.com`'s NATS cluster — same as today. Wake is a signed POST from a fanout service next to the backend. No hosted MCP.
3. **Surface the cross-host identity upside.** One `klodi_user_id` across every agent and every host is a genuine product win — one NKey, one reputation, one floor-price set. Market it.
4. **Preserve the sovereignty claims that actually hold.** The skill still gates outgoing messages. `security.md` still lives on disk. Uninstalling the adapter leaves state on disk.

### Timing

No hero-copy rewrite is required on the README. The existing privacy language still holds. New hosts get per-adapter READMEs that inherit the current framing.

## Registry accounting

One listing per host. The klodi skill-without-backend is useless; a standalone skill listing would confuse users. Only bundled plugins or MCP entries that reference our service.

**Naming discipline: one canonical listing name across every registry — `@4gpts/klodi`.** We do not invent host-specific names like `@4gpts/klodi-hermes` or `@4gpts/klodi-moltis`; each registry is already its own namespace, and a consistent identifier makes cross-registry discovery and brand recall easier. Underlying distribution varies by ecosystem — a community-curated ECOSYSTEM map (Hermes Atlas), a language-specific package manager (npm on ClawHub, pip, cargo), or a docs recipe. When a channel can't represent the `@scope/name` form (e.g., PyPI has no scoped-package convention), the published package name translates to an ecosystem-appropriate form (`klodi`, `4gpts-klodi`), but the listing identifier and user-facing install command stays `@4gpts/klodi`.

### Per-host listing map

| Host / registry | Listing | Underlying distribution | Notes |
|---|---|---|---|
| **ClawHub** (OpenClaw) | `@4gpts/klodi` | npm-backed | Existing listing. Next release is the unified-architecture migration — same package name, same install command, new internals. |
| **Hermes Atlas** | `@4gpts/klodi` (entry in community-curated `ECOSYSTEM.md`) | GitHub (monorepo subdir `adapters/hermes/`) | Submission is a PR to the [Hermes Atlas repo](https://github.com/nous-research/) adding a bullet with repo URL, short description, and maturity level (start at **Beta**, → **Stable** after Tier-A soak). Hermes CLI installs directly from GitHub; pip may be invoked for Python-dep resolution but there is no PyPI package per se. Propose "marketplace/commerce" category per 0009 if one doesn't exist. |
| **Moltis** plugin list | `@4gpts/klodi` | cargo or GitHub (TBD per Moltis convention) | Rust adapter; bundles `klodi-mcp`. Confirm submission shape during the Moltis rollout week. |
| **ZeroClaw** docs | `@4gpts/klodi` | docs recipe pointing at the monorepo | MCP server config pointing at bundled `klodi-mcp`. |
| **IronClaw** docs | `@4gpts/klodi` | docs recipe pointing at the monorepo | Same. |
| **nanobot** wiki | `@4gpts/klodi` | docs recipe pointing at the monorepo | Bundled skill + MCP recipe page. |
| **`agentskills.io`** | `klodi` (skill listing, cross-host) | skill catalog | Cross-cutting. Any agentskills.io-compatible host picks us up without a per-host listing. One entry; uses the bare product name because the catalog is skill-only and not an `@scope/name`-style registry. |
| **Anthropic Marketplace** (future, Cowork-focused) | `@4gpts/klodi` (plugin + remote MCP) | Anthropic marketplace | Cowork-centric; Tier-B, partnership-driven. |
| **Nebula / Arahi / Vellum** (future) | `@4gpts/klodi` integration catalog entry | partner catalog | Partnership-driven, one per platform. |

**Counts:** 6 primary Tier-A listings + 1 cross-host (`agentskills.io`) + Tier-B to be added when partnerships close. Call it ~7 discovery surfaces at v1 steady state.

### Source of truth

Maintain a single `registry/listings.yaml` in this repo; per-adapter CI renders it into each registry's expected format. Drift-free by construction. One edit to YAML, N rendered listings go out on next CI run.

## MCP endpoint registration — a non-problem

1. **Plugin installation is MCP registration.** Each adapter's plugin manifest declares `command: klodi-mcp` (or the host's equivalent for declaring stdio MCP servers). When the user installs the adapter, the host's plugin loader wires the MCP subprocess into its config natively — same path the host uses for any other plugin that ships a local MCP server.

2. **`klodi_register` is identity + wake registration.** Today's OAuth flow — user says "register me on klodi," browser opens, backend returns NKey — is unchanged. New: during that same flow, the adapter POSTs `{webhook_url}` to the backend and stores the returned `hmac_secret` locally. One sign-in, one identity, one webhook registered.

The user never sees multiple registrations. Install the adapter, complete one browser flow, done.

### What we do not do

- We do not modify host config files from our setup scripts.
- We do not ship a cross-language helper library for registration.
- We do not expose a separate "register wake channel" tool call; it happens inside `klodi_register`.

## Reuse scorecard

| Asset | Shared across how many hosts |
|---|---|
| klodi backend (API, NATS, R2) | all |
| Wake fanout service | all, OpenClaw included |
| Skill bundle (`SKILL.md` etc.) | all, byte-for-byte |
| `klodi-mcp` stdio binary | all, OpenClaw included |
| Setup flow template | all (parameterized by host) |
| Webhook handler | all (host-specific glue, same shape: HMAC-verify → poke host's wake primitive) |
| Host manifest | 1:1, metadata only |

Per-host incremental cost after the first two adapters ship: **metadata + ~30 lines of setup + a webhook handler.**

## Rollout

| Week | Deliverable |
|---|---|
| 1 | Extract `klodi-plugin/packages/klodi-mcp` — JSON-RPC loop wrapping existing `src/tools/*.ts` + `src/lib/*.ts`; tsup-compiled ESM single-file binary; standalone `@4gpts/klodi-mcp` npm package; smoke-test against any MCP client. Move the existing OpenClaw plugin into `klodi-plugin/adapters/openclaw/` as the first adapter. Stand up wake-fanout service — NATS subscriber, per-user webhook lookup, HMAC signing, rate limits, register-webhook endpoint on the backend. Row D and E mitigations implemented and tested. **Shipped 2026-04-24** (PR #35). |
| 2 | **OpenClaw adapter ready-to-flip webhook path.** Added `adapters/openclaw/src/service/webhook.ts` — HMAC-verify + envelope-parse + wakeAgent() dispatch. **Not wired into `src/index.ts`** because OpenClaw's plugin runtime does not yet expose the inbound HTTP webhook primitive (see § Open questions). The in-process NATS consumer in `src/service/nats.ts` continues to own wake until verified; flipping is a one-import-line change. **Shipped 2026-04-24** (feat/multi-host-adapters). |
| 2 | **Hermes** adapter at `adapters/hermes/` — Python setup (`klodi-hermes-setup` CLI) + webhook handler (library + standalone daemon) + skill bundle + envelope module + config.yaml fragment renderer + 66 unit tests + live integration test (`services/wake-fanout/scripts/live-verify-hermes.mjs`) round-tripping the real fanout → real Python handler end-to-end. **Shipped 2026-04-24.** |
| 3 | **Moltis** adapter at `adapters/moltis/` — Rust crate (envelope + handler + hyper server + setup + webhook binaries) with full unit-test suite. Shares the TS + Python fixture so the signature round-trips byte-for-byte across languages. **Shipped 2026-04-24** (Rust toolchain required to build; `cargo test` verified by inspection + matching fixture). |
| 4 | **ZeroClaw, IronClaw, nanobot** adapters at `adapters/{zeroclaw,ironclaw,nanobot}/`. ZeroClaw + IronClaw re-use the Moltis Rust crate as a path dependency (envelope + handler + hyper server shared); only the host-specific wake callback differs. Silent-drop wake callbacks removed — both now ship a real hyper-util HTTP client and refuse to start without either a configured forward URL or `--allow-observe-only`. nanobot is Python; ships sibling copies of `envelope.py`, `installer.py`, `webhook_handler.py` (no cross-adapter pip dep per § philosophy — within-language duplication is cheaper than drift risk). **Shipped 2026-04-24.** |
| 5+ | Tier-B work begins. Anthropic Marketplace submission prep (Cowork-focused materials, security review package). BD conversations with Nebula, Arahi, Vellum. When the first Tier-B partner commits, that is when the hosted MCP + OAuth resource server enters scope. |

One engineer, 4 weeks to land every Tier-A host on the unified architecture. Tier-B kicks off in week 5 and is sales-cycle-bound, not engineering-bound.

## Principles

1. **Backend stays the source of truth.** The only new server-side component is a dumb fanout — no tool logic on our infra that isn't already in the backend.
2. **One client binary, every host.** Tool implementations live in a single `klodi-mcp` subprocess consumed by every adapter, OpenClaw included. No per-host tool logic, no host-specific plugin code beyond a thin webhook handler.
3. **One skill, verbatim.** Never fork `SKILL.md` per host.
4. **Wake is a signed outbound POST.** No local wake-relay binary; no hosted MCP dispatcher. Hosts without an inbound webhook ship at polling tier or don't ship.
5. **Auth0 enters the picture only when Tier-B forces it.** For Tier-A, NKey-on-disk is the authentication model, unchanged.
6. **Additive-only contracts.** No `minServerVersion` checks, no version-matrix coordination.

## Open questions

- **OpenClaw webhook + stdio MCP support — STILL OPEN.** The unified architecture assumes OpenClaw's plugin runtime supports (a) declaring a stdio MCP server in the manifest and (b) exposing an inbound HTTP endpoint that a plugin service can register. (a) is confirmed working in production (PR #35). (b) is still unverified against the OpenClaw version we target. The OpenClaw adapter therefore keeps the in-process NATS consumer in `src/service/nats.ts` as the documented fallback — `src/service/webhook.ts` is shipped, unit-tested (25 tests green), and ready-to-flip when (b) lands. Flipping is a single-import swap in `src/index.ts`.
- **Claude Cowork inbound channel.** Cowork exposes outbound webhooks and a task-assignment API; whether either is usable as a third-party-driven wake channel is not confirmed from public docs. Resolve when Cowork work starts — this is a Tier-B concern, not a Tier-A blocker.
- **Per-host trust-model variants.** The "workstation owner is the trust anchor" model holds for every Tier-A host targeted here. Cowork's Team/Enterprise "admin installs for users" pattern may produce a different trust boundary; resolve during Tier-B scoping.
- **When remote MCP enters scope.** Trigger: the first Tier-B partner that commits to an integration and cannot spawn a local subprocess. At that point, the hosted MCP + OAuth RS + threat rows A/B/C/F/G from the prior draft come back into scope, scoped to that partner's integration — not as a Tier-A default.

## Post-implementation notes (2026-04-24)

These are discoveries from actually building the weeks 2–4 adapters — additions that refine the plan without changing its direction.

### Hermes plugin shape (corrected mid-build)

Real Hermes plugins (verified against `hermes-cloudflare-plugin`) ship as a GitHub repo with `plugin.yaml` + `__init__.py` at the root exposing `register(ctx)` — not as a pip-installable Python package with a `src/<name>/` subpackage. Install path: `hermes plugins install <owner>/<repo>` clones into `~/.hermes/plugins/<name>/`, prompts for `requires_env`, then `hermes plugins enable <name>` loads `__init__.py`. No container, no publish step — GitHub is the registry.

The klodi Hermes adapter's tool handlers (33 tools) do NOT reimplement klodi logic in Python; each handler forwards to a long-lived `klodi-mcp` stdio subprocess via `KlodiMcpClient` (JSON-RPC over stdin/stdout, serialized on a lock). The Hermes-facing tool surface is a lightweight schema declaration layer; marketplace logic stays in the shared binary per § *One client binary, every host*.

### "No cross-language helper library" extends within-language

When the Hermes adapter moved to the flat Hermes-plugin shape, nanobot (also Python) could no longer `from klodi_hermes.installer import ...`. Rather than introduce a `klodi-common-python` package, nanobot ships byte-identical sibling copies of `envelope.py`, `installer.py`, `webhook_handler.py`. Drift is the failure mode we care about, and 300 lines of controlled duplication is cheaper to own than a shared-lib dep graph. CI parity check is left as a follow-up (tracked, not blocking).

### Silent-drop wake callbacks are the worst failure mode

Row D of the threat model warns about suppressed wakes. Initial Rust implementations of `moltis_wake`, `passthrough_to_zeroclaw`, `post_to_ironclaw` were stubbed to return `true` without actually forwarding — a daemon that 200s to the fanout while never waking the agent is precisely the Row D failure. All three now use `hyper-util` HTTP clients for real POST, and refuse to start unless either a forward URL is configured OR `--allow-observe-only` is explicitly set. Observe-only mode is reserved for dev/test, never production.

### Input validation lives at the adapter boundary

Setup CLIs accept operator-supplied `webhook_url` and `host_slug`. Without validation, a typo silently registers a dead wake channel (fanout keeps POSTing to a broken URL; user never gets a wake). All setup CLIs now validate `webhook_url` (https anywhere, http only on loopback) and `host_slug` (`[a-z0-9][a-z0-9._-]*`) before any round-trip with the klodi backend. Moltis's setup additionally escapes both values when emitting `moltis.plugin.toml` so a pathological slug can't inject phantom TOML sections.

### Integration tests cross the language boundary

Python + Rust + TS unit tests can only prove each implementation is self-consistent. The end-to-end proof is `services/wake-fanout/scripts/live-verify-hermes.mjs`: it spawns the real Python Hermes webhook daemon as a subprocess, creates a `wake_channels` row, invokes the fanout's `dispatch()` in-process, asserts the Python handler sees the signed POST, verifies HMAC, logs `wake_observed`, and rejects tampered sigs (401) + wrong `kind` (400). This test caught a Python bound-method bug where `KlodiWebhookHandler.wake_callback = <function>` made the callback a bound method on dispatch; the fix was `staticmethod()` at assignment.

### Per-host details now locked in

| Host | Language | Flat-layout | Silent-drop gate | Notes |
|------|----------|-------------|-----------------:|-------|
| OpenClaw | TS | n/a (existing `src/` layout) | — | Webhook path ready-to-flip; in-process NATS remains active |
| Hermes | Python | **yes** (plugin.yaml + __init__.py at root) | — (relies on Hermes gateway's native HMAC) | `register(ctx)` wires 33 tools; wake via Hermes's `platforms.webhook.extra.routes` |
| Moltis | Rust | n/a (Cargo crate) | `MOLTIS_WAKE_URL + MOLTIS_AGENT_TOKEN` or `--allow-observe-only` | hyper-util HTTP POST to Moltis persistent-agent API |
| ZeroClaw | Rust | n/a | `--allow-observe-only` or ZeroClaw `/hooks/wake` URL | Canonical deployment points fanout directly at ZeroClaw; passthrough binary is defense-in-depth |
| IronClaw | Rust | n/a | `--allow-observe-only` or IronClaw event URL | Forward to IronClaw event-trigger endpoint |
| nanobot | Python | n/a (pip package) | — (nanobot CLI publish is the forward) | Publishes on nanobot event bus channel; agent subscribes |

## Non-goals

- No hosted MCP server in v1. Deferred until Tier-B forces it.
- No local wake-relay binary, ever. If a host can't accept a signed inbound webhook, we don't close the gap with a local daemon.
- No adapters for coding-first hosts in v1 (Cursor, Claude Code CLI, Goose, OpenCode, Letta, Emdash, Amp, Kiro, OpenHands, Workshop, fast-agent).
- No Python or Rust ports of tool logic. Tool logic lives in the compiled Bun binary.
- No host-specific skill forks.
- No klodi-owned registry. Each host's existing registry is our distribution channel.
- No backend rework. The fanout is additive.
- **No enterprise-specific product.** klodi targets personal use and small business; the stdio-MCP path is the default, not a privacy-maximalist escape hatch.
