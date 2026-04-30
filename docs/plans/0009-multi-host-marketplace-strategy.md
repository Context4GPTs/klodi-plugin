# 0009 — Multi-host marketplace strategy

**Status:** proposed
**Source:** product direction, 2026-04
**Scope:** how klodi — today an OpenClaw-only plugin — reaches the users of other emerging personal-agent runtimes (Hermes, Moltis, IronClaw, Claude Cowork, Goose, nanobot, ZeroClaw, and SaaS peers Nebula/Arahi/memU/Vellum).

## TL;DR

The personal-agent ecosystem fragmented in late 2025–early 2026 into ~a dozen runtimes, but **two open standards unify them at the extension layer**: `agentskills.io` for procedural knowledge (SKILL.md + assets) and MCP for tool calls (JSON-RPC over stdio/HTTP/SSE). klodi is already ~90% compliant with both: our skill lives in `skill/SKILL.md` in the agent-skills format, and our typed tool surface is a thin wrapper over NATS that trivially re-exports as an MCP server. The marketplace itself — listings, offers, channels, transactions, NATS backend — is host-agnostic.

The work, therefore, is not re-implementation per host. It is:

1. A **host-neutral core** (`@4gpts/klodi-core`) that speaks MCP and ships the skill.
2. **Per-host adapters** that wrap the core in whatever packaging/registry the host expects (OpenClaw plugin, Hermes plugin, Cowork marketplace entry, Moltis plugin, WASM tool for IronClaw, etc.).
3. A **distribution plan** per host, ordered by user reach × integration cost.

We keep ClawHub as the canonical OpenClaw channel and treat every other runtime as an additional distribution surface for the same product.

---

## The landscape

Categorized by how a third-party developer ships capability into the agent. Populations and adoption signals are as of 2026-04.

### Tier A — Open-source agents with skill + MCP plugin systems (near-zero marginal cost)

These are the fastest wins: they accept standards-compliant skills and MCP servers, have active plugin registries, and their users install community extensions as a matter of course.

| Runtime | Owner | Plugin surface | Registry | Notes |
|---|---|---|---|---|
| **Hermes Agent** | Nous Research | agent-skills + MCP (client & server); Python skills; CLI subcommands; lifecycle hooks | Hermes Atlas + `agentskills.io` + GitHub taps + skills.sh + (reads ClawHub) | ~96K stars, fastest-growing of 2026. Already auto-imports OpenClaw skills to `~/.hermes/skills/openclaw-imports/`. Our best beachhead. |
| **Claude Cowork / Claude Code** | Anthropic | Skills + MCP + subagents + slash commands, bundled as "plugins" | Official Anthropic Marketplace + community marketplaces (e.g. claudemarketplaces.com) | Largest absolute user base. Approval gate + brand-quality bar. Team/Enterprise admins curate plugins org-wide. |
| **Moltis** | Ry Walker et al. | Rust; plugins + hooks + MCP (stdio + HTTP/SSE, OAuth 2.1) | Moltis-native plugin list | Security-oriented. Persistent agent server. Natural fit for a marketplace-participant agent. |
| **IronClaw** | NEAR AI | WASM tool drop-ins + MCP | Bundled + community | Hot-swap tools without restart. We'd compile the MCP server or a thin proxy to WASM. |
| **ZeroClaw** | zeroclaw-labs / morpheum-labs | Trait-based Rust extensions + MCP client/server | Bundled | Rust-native. MCP route is the pragmatic path; we don't need to port to Rust traits. |
| **Goose** | Block | Skills + MCP | `block.github.io/goose` | Ships as open source. Smaller user base but loyal. |
| **nanobot** | HKU DS Lab | Skills + MCP, multi-surface (Telegram/Discord/Slack/WeChat) | `nanobot.wiki` | 4k-LoC core; good reference for a minimum-dependency MCP build. |
| **OpenCode, Letta, Cursor, OpenHands, Amp, Goose, Kiro, Workshop, Emdash, Ona, fast-agent** | various | All confirmed `agentskills.io` clients per the standard's showcase | host-specific | Coding-first rather than personal-assistant first — klodi is tangential to their primary workflow, but the skill will load if the user opts in. Treat as "free distribution" rather than targeted. |

### Tier B — Closed/SaaS personal agents (partnership model)

These do not expose a neutral plugin ABI that klodi can ship into. Capability is added through their first-party integrations catalog or via a partnership/App-Store-style agreement. Reach is larger per deal but each deal is bespoke.

| Runtime | Integration model | How klodi reaches the user |
|---|---|---|
| **Nebula (nebula.gg)** | "Auto-creates a dedicated agent per connected app" (Slack/GitHub/etc.); 600–1000+ integrations via OAuth | Ship a klodi connector in Nebula's integrations catalog. klodi-the-subagent becomes their "marketplace agent." |
| **Arahi AI / Rahi** | 1500+ native integrations; custom tools available but no open plugin ABI | Same: partnership submission to integrations catalog. |
| **Vellum (personal assistant)** | First-party identity (has its own email, can act); Workflows SDK for agentic systems | Pitch as a workflow template + OAuth integration. |
| **memU** | Memory layer, not a full runtime; Python/JS SDK | Not a direct target — but memU-powered agents are candidates if they have a plugin layer underneath. |
| **Manus AI** (Meta) | Cloud autonomous agent, closed | Requires partnership or public API if one opens. |

### Tier C — Lightweight/experimental (deprioritize)

- **NanoClaw**: intentionally no extension system. Skip.
- **PicoClaw** and other sub-variants: too small to target individually; they inherit from OpenClaw compatibility.

---

## What is portable, what is not

| Layer | Portability | Notes |
|---|---|---|
| Backend (`klodi.4gpts.com`, NATS, R2) | 100% host-agnostic | One backend serves every adapter. |
| Skill (`skill/SKILL.md`, `skill/SETUP.md`, `skill/policies/security.md`, `skill/templates/*`) | `agentskills.io`-compliant already; drop-in on every Tier-A host | The policy files are plain markdown — they don't depend on any host API. |
| Tool surface (`klodi_*`) | Today: typed tools declared in `openclaw.plugin.json`, invoked over NATS from the plugin runtime | Wrap as an MCP server to expose the same surface to any MCP client. Tool names stay identical (`klodi_*`) — MCP `server__tool` prefixing gives us `klodi__list_create`, etc., which is fine. |
| OAuth / credential capture | Browser flow + NKey stored locally at `0600` | Portable. The callback URL is per-runtime only because the "deep link back" varies; the flow itself does not. |
| Event push (NATS WebSocket → agent wake) | OpenClaw-specific today (uses timers/wake primitives from OpenClaw) | MCP has no wake primitive. On non-OpenClaw hosts: either (a) fall back to polling on the host's scheduler (Moltis cron, Hermes scheduler, Cowork — no equivalent yet), or (b) expose an MCP `klodi_pending` that the host runs on activation. Option (b) works everywhere but loses the "3 a.m. nudge" UX. |
| Policy loading from `${klodi_home}/policies/` | Filesystem-based | Portable as long as the host can read local files (all Tier A can). Cowork's Team/Enterprise sandboxing may constrain this — TBD. |
| Manifest (`openclaw.plugin.json`) | OpenClaw-only | Each host has its own manifest (`plugin.json` for Hermes, marketplace.json for Cowork, etc.) — these are thin wrappers around the same core. |

**Shape of the refactor:** extract `@4gpts/klodi-core` containing the MCP server, skill, and policies. OpenClaw's `klodi-plugin` becomes a thin shim that imports the core and declares the NATS-backed event wake path. Each other host gets its own shim in its own repo/package.

---

## Per-host rollout strategy

Ordered by expected reach × integration cost, lowest effort first.

### 1. Hermes Agent (Tier A, top priority)

**Why first:** largest open ecosystem, active plugin curation (Hermes Atlas), already auto-imports OpenClaw skills. Nous Research explicitly positions Hermes as the open counterpart to OpenClaw — their user overlap is high and *growing*.

**Plan:**
- Extract `@4gpts/klodi-core` (MCP server + skill).
- Publish `@4gpts/klodi-hermes` — a Hermes-native plugin that `cargo install`-equivalents the core and registers MCP + skill with Hermes's plugin loader.
- Submit to Hermes Atlas (no existing "marketplace" category → propose one, or file under "payment/commerce" where the x402 USDC plugin lives).
- Verify the Hermes-native scheduler can drive `klodi_pending` polling at 2-minute cadence (our wake substitute).

**Cost estimate:** 1–2 engineering weeks, assuming the core extraction lands cleanly.

### 2. Moltis (Tier A)

**Why second:** smallest surface-area fit. Moltis already supports MCP stdio + HTTP/SSE with OAuth 2.1. Moltis's positioning (secure, persistent, runs on your hardware) is the closest philosophical match to klodi's threat model.

**Plan:**
- Publish the MCP server as a binary or as a Moltis plugin manifest.
- Upstream a PR to the Moltis plugin list.
- No event-wake work: Moltis is persistent and has cron-style scheduling we can use.

**Cost:** <1 week once core is extracted.

### 3. Claude Cowork / Claude Code (Tier A, highest reach, highest bar)

**Why third (not first):** absolute reach is largest, but submission to the Anthropic Marketplace is gated, requires brand/quality review, and the fit inside Cowork (document/department workflows) is tangential to marketplace-trading. Better to land on Hermes/Moltis first, accumulate real users + ratings, then pitch.

**Plan:**
- Package as a Claude Code plugin (skill + MCP server bundled under the Anthropic plugin format).
- Start in the **community marketplaces** (claudemarketplaces.com, ComposioHQ/awesome-claude-plugins) — no approval gate.
- After 3 months of community-marketplace adoption, submit to the official Anthropic Marketplace.
- Cowork has no native wake for third-party plugins → session-start `klodi_pending` call in the skill substitutes.

**Cost:** 1 week to publish community; official submission is weeks of review calendar time, not engineering time.

### 4. ZeroClaw, Goose, nanobot, OpenCode, Letta, OpenHands (Tier A, bundled)

**Why together:** all are `agentskills.io` clients and MCP clients. Once the core exists, shipping to each is mostly a README and a line in each project's plugin/skill list.

**Plan:**
- Publish docs: "Installing klodi on any agent-skills + MCP host." Point at the core.
- Open one PR per host to add klodi to their recommended-skills list or ecosystem page.

**Cost:** a few days, shared across all of them.

### 5. IronClaw (Tier A, needs WASM path)

**Why later:** IronClaw's extension model leans on WASM tools. We can reach their users in two ways:
- **Fast path:** use their MCP client (they support MCP) — same binary as Moltis/Hermes.
- **Native path:** compile our tool surface to WASM as an IronClaw-native tool — more work, tighter UX.

Start with fast path. Revisit native WASM if IronClaw adoption justifies.

### 6. Nebula / Arahi / Vellum (Tier B, partnership)

**Why last in engineering ordering, but start the conversations in parallel:** these are BD tasks, not engineering tasks. Each requires reaching out, proposing an integration, and agreeing on terms. Start outreach now; expect 2–6 month sales cycles per logo.

**Plan:**
- Nebula: apply as a custom integration in their catalog. Pitch "Nebula's marketplace subagent."
- Arahi: submit klodi as a tool in their 1500+ catalog.
- Vellum: pitch as a Workflows SDK template — Vellum's assistants already "take real actions" (email, ordering); marketplace-trading is a natural extension.
- For all three: they host the OAuth, we host the backend. No client-side install required.

---

## Sequencing (single-track, concrete)

| Week | Work |
|---|---|
| 1–2 | Extract `@4gpts/klodi-core`. MCP server on top of the existing tool logic. Full test coverage parity with today's NATS-direct path. |
| 3 | Hermes adapter + submit to Hermes Atlas. |
| 4 | Moltis adapter + upstream PR. |
| 5 | Community-marketplace submission to claudemarketplaces.com + Composio list. |
| 6 | Bundled PRs to Goose, nanobot, ZeroClaw, OpenCode, Letta, OpenHands plugin/skill lists. |
| 7+ | IronClaw fast path; Cowork official-marketplace prep (materials, demo, security review). |
| parallel | BD outreach to Nebula, Arahi, Vellum. |

One engineer, ~6–7 weeks to go from OpenClaw-only to present on every open Tier-A host. Tier B is a sales function, not an engineering function.

---

## Risks and open questions

- **Event wake without OpenClaw primitives.** Our "agent haggles at 3 a.m." pitch leans on OpenClaw's wake API. MCP has no equivalent. Mitigation: on persistent-server hosts (Moltis, Hermes daemon mode) use their scheduler; on ephemeral hosts (Cowork, Claude Code session-based) degrade to session-start pending-event drain and accept the UX hit. Needs a product call on whether we market klodi differently per host or keep the pitch identical and accept latency on some hosts.
- **Policy filesystem assumption.** Cowork Team/Enterprise may sandbox plugin filesystem access in ways that break `${klodi_home}/policies/` reads. Verify before submission.
- **Registry-category politics.** Hermes Atlas and the Anthropic Marketplace do not have a "marketplace/commerce" category today. We may land under "payments" or "integrations." Propose a new category in each if klodi gets meaningful pickup.
- **Brand confusion.** "klodi" is currently "for OpenClaw." Repositioning as "for every personal agent" needs a landing-page rewrite. Out of scope for this plan but a prerequisite to cross-host launches.
- **Security review per host.** Our threat model assumes OpenClaw's trust boundary (workstation owner as trust anchor — see `docs/plans/README.md`). On Hermes and Moltis this is unchanged. On Cowork's Team/Enterprise tier an admin-installs-for-users model may require additional review rows — track in THREAT_MODEL if/when we ship there.

---

## Non-goals (explicit)

- We do not port the backend. One klodi API, many frontend adapters.
- We do not chase runtimes without a plugin surface (NanoClaw, Manus). If they add one, we revisit.
- We do not fork the skill per host. One `SKILL.md`, small host-specific preambles at most.
- We do not build our own registry. ClawHub stays ClawHub (OpenClaw-specific); every other host has its own registry and we submit into theirs.
