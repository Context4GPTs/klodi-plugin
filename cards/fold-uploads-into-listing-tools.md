---
type: card
title: Remove standalone upload tool, fold uploads into listing tools
slug: fold-uploads-into-listing-tools
work_type: feature
tiers: [unit, integration, e2e]
status: discovery
agents: [solutions-architect, product-owner, product-marketer]
priority: 2
created: 2026-05-23
updated: 2026-05-23
base_branch: main
worktree: /Users/knitlybak/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-fold-uploads-into-listing-tools
branch: card/fold-uploads-into-listing-tools
pr: null
merged_commit: null
---

## Intent (founder)

**Problem:** The plugin exposes `klodi_assets_upload_url` as a standalone agent-facing tool, forcing a two-step dance (mint presigned URL → PUT binary → attach the returned `asset_url` to a listing) before a listing can carry photos. Hosts like Telegram hand the agent local file paths (the OS materialises an absolute, temporary path for each attached photo); today the agent has no way to feed those paths into `klodi_list_create` / `klodi_list_update` without orchestrating the mint+PUT dance itself.

**Goal:** Across all six adapters (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw), `klodi_list_create` and `klodi_list_update` accept local file paths in their `photos` parameter. The adapter resolves the path, mints the presigned URL internally via the existing `p2p.v1.assets.upload-url` NATS subject, PUTs the bytes to R2, and attaches the resulting `asset_url`. The standalone `klodi_assets_upload_url` tool is removed from every adapter's tool catalog. A media allowlist (file extension + content-type) gates which paths are accepted, scoped to what the marketplace web app can render — today `image/jpeg`, `image/png`, `image/webp` per ADR-0006; Discovery confirms or extends.

**Success signal:** An agent receiving Telegram-style local file paths submits a listing in a single tool call — `klodi_list_create { ..., photos: ["/tmp/img1.jpg", "/tmp/img2.png"] }` — the listing renders correctly in the marketplace web app, and `klodi_assets_upload_url` no longer appears in any adapter's tool catalog.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — product-owner, solutions-architect

<!-- Filled jointly by product-owner and solutions-architect. -->

### Approach + alternatives ruled out

**Chosen approach.** `photos` in `klodi_list_create` and `klodi_list_update` stays a single ordered `string[]`, but each element can now be either an `http(s)://` URL (passed through unchanged, as today) or a local absolute filesystem path (resolved by the adapter, content-sniffed, uploaded via the existing `p2p.v1.assets.upload-url` subject + R2 PUT, then substituted with the returned `asset_url` before the listing request is sent). Order is preserved across the substitution. The standalone `klodi_assets_upload_url` tool is removed from every adapter's tool catalog, from the canonical `klodiTools` map, and from the bundled `skill/` references. ADR-0006's content-type allowlist (`image/jpeg`, `image/png`, `image/webp`) and size ceiling (10 MB/file, 10 photos/listing) apply unchanged — they are now enforced inside the listing tool, before the listing request is dispatched.

**Atomicity rule.** If any local path fails resolution, content-type validation, or upload, the entire listing call fails with a structured error that names the offending path; no listing is created or updated. Partial success is silently wrong — the agent reasoned about the photos as an ordered set, and persisting a subset would diverge from intent.

**Content-type discrimination.** Local paths are validated by content sniffing the first bytes (magic number), not by file extension. Extension is advisory only — a `.jpg` file containing PNG bytes is uploaded as `image/png` (or rejected if neither matches the allowlist). This closes the format-confusion gap that the standalone tool sidestepped by demanding an explicit `content_type` from the agent.

**Alternatives ruled out.**

1. **Keep `klodi_assets_upload_url` alongside the new behaviour.** Rejected — two ways to do one thing inflates the tool surface the agent reasons over and makes the skill harder to teach. Per `CLAUDE.md` "no backwards compatibility", we replace, not layer.
2. **Add a sibling parameter `photos_local: string[]`.** Rejected — bifurcates the listing schema. Hosts (notably Telegram) hand the agent a single ordered array; forcing it into two parameters loses ordering between URLs and paths and forces the agent to do a partitioning step the adapter is better placed to do.
3. **Server-side proxy upload (client POSTs bytes to klodi API, API writes to R2).** Rejected by ADR-0006 § Alternatives — binary must not transit klodi-operated compute. Direct-to-R2 PUT is the only sanctioned path.
4. **Treat any non-URL string as a path heuristically.** Rejected — relative paths, file:// URLs, and adversarial strings (e.g. shell-expanded `~`) become a security surface. Require absolute paths only; reject everything else with a clear error.

### Affected files / surfaces

**Shared catalog (single source of schema truth — change here cascades).**

- `packages/tool-catalog/src/index.ts` — delete the `klodi_assets_upload_url` entry (lines 696–726). The `klodiTools` map is the source consumed by openclaw (direct TS import), hermes/nanobot (via codegen `schemas.json`), and all three Rust adapters (via codegen `rust-types.rs::ToolName`). Removing the entry here is the single point that propagates removal everywhere downstream.
- `packages/tool-catalog/dist/schemas.json`, `packages/tool-catalog/dist/index.d.ts`, `packages/tool-catalog/dist/index.js`, `packages/tool-catalog/dist/rust-types.rs` — regenerated by `pnpm -C packages/tool-catalog codegen`. Verify `klodi_assets_upload_url` / `KlodiAssetsUploadUrl` / `p2p.v1.assets.upload-url` are gone post-codegen.
- `packages/logger-py/src/klodi_logger/schemas.json`, `packages/nats-client-py/src/klodi_nats_client/schemas.json` — vendored copies of the catalog JSON. Regenerate or copy via whatever script the build pipeline uses (check `packages/tool-catalog/scripts/codegen.mjs` for the write paths). Both currently embed `klodi_assets_upload_url` at line 4962.
- `packages/tool-catalog/scripts/check-golden-coverage.mjs` and `packages/tool-catalog/tests/` — confirm no event/tool fixture mentions the removed name; if any does, drop the assertion.

**openclaw (TypeScript, npm publish target — the only adapter with bespoke `klodi_assets_upload_url` plumbing).**

- `adapters/openclaw/src/tools/media.ts` — **delete**. Standalone tool registration. Re-home its `rawRequest`+timeout pattern as a private helper inside `tools/listings.ts` (or a new `tools/photos.ts` helper module) for use by both `klodi_list_create` and `klodi_list_update`.
- `adapters/openclaw/src/index.ts` — remove `import { registerMediaTools } from "./tools/media.js"` and the `registerMediaTools(api)` call.
- `adapters/openclaw/src/tools/listings.ts` — wire the photo-resolution pipeline into both `registerCreate` and `registerUpdate`: detect locals in `params.photos`, content-sniff, atomic mint+PUT, substitute. The existing `rawRequest(tool.subject, params)` becomes `rawRequest(tool.subject, { ...params, photos: resolvedPhotos })`.
- `adapters/openclaw/src/__tests__/tools/media.test.ts` — **delete**. The behavior moves into `listings.test.ts` (extend its create/update suites with the local-path scenarios). Reuse `mock-nats.ts` / `mock-plugin-api.ts` / `temp-home.ts` helpers — they already mock the NATS request layer, and `temp-home.ts` gives the writable on-disk scratch needed for path resolution fixtures.
- `adapters/openclaw/openclaw.plugin.json` line 29 — drop `"klodi_assets_upload_url"` from `contracts.tools`. (Order matters: the array is sorted; keep alphabetical.)
- `adapters/openclaw/README.md` line 132 — remove the `klodi_assets_upload_url` bullet from the tool list.
- `adapters/openclaw/SECURITY.md` — if it duplicates the root `SECURITY.md` line about `klodi_assets_upload_url`, mirror the rewrite.

**hermes (Python, PyPI — catalog-driven; no bespoke media plumbing).**

- `adapters/hermes/src/klodi_hermes/plugin.yaml` line 78 — drop `- klodi_assets_upload_url` from `provides_tools`.
- `adapters/hermes/src/klodi_hermes/tools.py` line 70 — drop the `"klodi_assets_upload_url": "📸"` emoji row. Hermes's `register_request_tools` already iterates `TOOL_SCHEMAS` from the catalog, so the tool stops registering automatically once it's gone from `schemas.json`.
- `adapters/hermes/README.md` line 52 — strike `klodi_assets_upload_url` from the "NATS-backed" tool list.
- Adapter-side photo plumbing for `klodi_list_create`/`klodi_list_update`: introduce a helper inside `klodi_hermes/tools.py` (or a sibling `photos.py`) that runs on the request-bridge handler for those two tool names — sniff content type via `magic` or stdlib `imghdr`/manual magic-number check, mint via `client.request("p2p.v1.assets.upload-url", {...})`, PUT bytes via `httpx` (already a dependency of `klodi-nats-client`). Tests under `adapters/hermes/tests/` (new `test_tools_photos.py`).

**nanobot (Python, PyPI — catalog-driven; same shape as hermes).**

- `adapters/nanobot/nanobot_tools.py` — extend `call_tool` (or wrap its dispatch in `handle`) so calls to `klodi_list_create` and `klodi_list_update` route through the photo-resolution helper before hitting `client.request(subject, args)`. No `plugin.yaml`-equivalent to edit — nanobot reads its tool list directly from the catalog.
- `adapters/nanobot/nanobot_tools.py` `_PUBLISH_TOOLS` and `_LOCAL_TOOLS` frozensets — confirm no `klodi_assets_upload_url` reference (none today, but verify post-change).
- `adapters/nanobot/tests/test_tools.py` — extend with the local-path scenarios; the existing fixtures already mock the NATS client so reuse the pattern.

**moltis / ironclaw / zeroclaw (Rust, crates.io — all delegate to `packages/klodi-rust-host`).**

- `packages/klodi-rust-host/src/mcp/tools.rs` `dispatch_passthrough` — intercept `tool == ToolName::KlodiListCreate || tool == ToolName::KlodiListUpdate`, run the photo-resolution pipeline against `args["photos"]`, then call `client.request(tool.subject(), &mutated_payload, None)`. The existing `dispatch_passthrough` is the only place to wire this — every Rust adapter shares it.
- `packages/klodi-rust-host/src/mcp/tools.rs` — once `klodi_assets_upload_url` is removed from the catalog, `ToolName::KlodiAssetsUploadUrl` ceases to exist; the existing `list_all_tools` loop drops the row automatically. Update the test on line 506 to add `assert!(!names.contains(&"klodi_assets_upload_url"))`.
- `packages/klodi-rust-host/Cargo.toml` line 68 — `reqwest = "=0.12.9"` with `rustls-tls` is already present; no new dep needed for the R2 PUT.
- New module: `packages/klodi-rust-host/src/mcp/photos.rs` (suggested) — pure-Rust helper: validate absolute path, read bytes, sniff content type (use the `infer` crate or a hand-rolled 4-byte magic check to avoid a dep), mint via `KlodiClient::request("p2p.v1.assets.upload-url", ...)`, PUT bytes via the existing `reqwest::Client`. The Rust adapters themselves (`adapters/{moltis,ironclaw,zeroclaw}/src/bin/mcp.rs`) need no changes — they call into `klodi-rust-host` and inherit the new behavior.
- Tests in `packages/klodi-rust-host/src/mcp/tools.rs` `#[cfg(test)]` and a new file `packages/klodi-rust-host/src/mcp/photos.rs` `#[cfg(test)]`.

**Bundled skill (the canonical marketplace playbook — copied into every TS adapter at build via `copy-skill.mjs`).**

- `skill/references/photo_upload_flow.md` — **rewrite** end-to-end. The current "two-step flow" section is the user-facing instruction to call `klodi_assets_upload_url` first. After this card it's a one-step flow that documents the URL-or-absolute-path semantics, the content-sniff guarantee, and the atomic-failure rule. Consider renaming to `photos.md` for clarity; if renamed, fix the `tool_inventory.md` cross-link.
- `skill/references/tool_inventory.md` line 74 — drop the `klodi_assets_upload_url` row from the "Assets" table. Update the `klodi_list_create` / `klodi_list_update` rows to mention that `photos` accepts both URLs and absolute local paths.
- `skill/SKILL.md` — scan for any other indirect mention of `klodi_assets_upload_url` (none on the read, but verify post-edit).

**Public docs (ADRs, security, threat model, specs).**

- `docs/decisions/0006-direct-to-storage-photo-uploads.md` — update the **Decision** section to note that minting and PUT are now performed adapter-side as part of `klodi_list_create` / `klodi_list_update`, not via a standalone `klodi_assets_upload_url` tool. The allowlist (`image/jpeg`, `image/png`, `image/webp`), the 10MB/file ceiling, the 10-photos/listing cap, the direct-to-R2 invariant, and the security implications are unchanged. Update the **References** section's "Code: `adapters/openclaw/src/tools/media.ts`" line.
- `docs/THREAT_MODEL.md` line 134 — rewrite the threat scenario to name the new entry points (`klodi_list_create.photos`, `klodi_list_update.photos`) instead of the removed standalone tool.
- `docs/specs/hosts/openclaw.md` line 18 — strike the `klodi_assets_upload_url` parenthetical; fold the mint+PUT into the listings sentence.
- `SECURITY.md` line 44 — rewrite to describe the new flow (adapter mints + PUTs internally during `klodi_list_create`/`klodi_list_update`); the public-facing guarantee that "binary never transits klodi-operated compute" is preserved.
- `adapters/openclaw/SECURITY.md` — keep in sync with root `SECURITY.md`.

**Build & publish stage artefacts (gitignored; regenerated by `pnpm build`).**

- `adapters/openclaw/.publish-stage/*` — regenerated on next publish; not touched by hand. Verify a clean `pnpm -C adapters/openclaw build` produces a stage with no `klodi_assets_upload_url` reference.

### Risks / failure modes

- **Cross-language behavioural drift.** Six adapters across three languages each ship their own content-sniff + mint + PUT sequence. Subtle differences (which JPEG magic bytes are accepted, how a streamed PUT handles backpressure, whether content-length is sent) become user-visible: the same `/tmp/img.jpg` succeeds on one adapter and fails on another. *Mitigation:* the cross-adapter parity acceptance criterion below is the contract; the dev pair runs a single shared fixture suite (one set of files, one expected behaviour) against each adapter rather than rewriting tests language-by-language. Centralise the magic-number table in a comment that references ADR-0006's allowlist; if the table later grows (HEIC, AVIF), it grows in one place per language plus the catalog metadata.

- **R2 upload failure mid-array (orphan blobs).** Per the atomicity rule, if path #2 fails after path #1 has already PUT to R2, the listing call must fail clean — but bytes #1 are already at the R2 endpoint, costing storage indefinitely. The standalone tool sidestepped this by minting all URLs in one NATS request and letting the agent reason about cleanup. *Mitigation:* (a) mint the full presigned-URL set in one `p2p.v1.assets.upload-url` call before PUT-ing anything — if mint fails, no PUTs occurred; (b) PUTs are concurrent; on first PUT failure, abort the remaining and report the offending path. Orphan blobs from already-completed PUTs are not cleaned up by the adapter (R2 has no transactional delete). Flag this for product-owner: are orphan-asset costs acceptable, or do we need a server-side TTL on un-attached asset URLs? (My read: TTL is a marketplace-side concern, out of scope for this card. Document the orphan-blob outcome in ADR-0006's security section and move on.)

- **Path traversal / symlink escape.** Accepting an absolute filesystem path puts the adapter on the wrong side of the agent-sandbox boundary. An agent (or a prompt-injected agent) submits `/etc/passwd`, `/var/run/secrets/*`, or a symlink chain that exits a temp directory. The current standalone tool didn't expose this surface because the agent supplied bytes, not paths. *Mitigation:* (a) require absolute paths only (already in the criteria); (b) resolve symlinks before sniffing (`fs.realpath` / `os.path.realpath` / `std::fs::canonicalize`); (c) reject if the realpath leaves a configured allowed-roots set — but the host can't reasonably configure that on Telegram (the OS chooses `/tmp/`-ish). Pragmatic option: reject if the realpath is under common sensitive dirs (`/etc`, `/var`, `$HOME/.ssh`, the klodi creds dir from `paths.ts`/`paths.py`/`paths.rs`). Flag this for dev — sniff-then-PUT is the security contract.

- **Content-type sniff bypass via prefix-craft.** An attacker crafts a file with valid JPEG SOI bytes (`FF D8 FF`) followed by arbitrary binary. Magic-number sniffing accepts the file; R2 stores it; the marketplace renders it as JPEG (browsers tolerate trailing garbage); but a downstream scanner sees the secondary payload. *Mitigation:* this is the same surface ADR-0006 already accepts at the standalone-tool layer (the standalone tool trusts an agent-supplied `content_type`; the new flow at least validates against actual bytes). The new flow is *strictly stronger* than the old. Call it out in the ADR update — no new defence required, but no new offence either.

- **Tool catalog cache invalidation in long-running agent sessions.** An agent that started a session before the upgrade has `klodi_assets_upload_url` in its tool-list cache; it's gone after upgrade. The agent will call a tool that no longer exists and receive a host-specific "unknown tool" error. *Mitigation:* the agent host (openclaw, hermes, etc.) is responsible for re-fetching the tool list on plugin reload; the plugin can't help here. Document in the changelog / migration notes that an agent restart is required after upgrade. Not a blocker.

- **`packages/logger-py/src/klodi_logger/schemas.json` and `packages/nats-client-py/src/klodi_nats_client/schemas.json` go stale.** These are vendored copies of `dist/schemas.json`. If `pnpm codegen` doesn't write to them (or the dev forgets to run a follow-up vendor step), they keep `klodi_assets_upload_url` indefinitely, causing hermes/nanobot to keep registering the tool against a NATS subject the catalog no longer authorises. *Mitigation:* the dev pair runs `pnpm -C packages/tool-catalog codegen` and confirms via `grep -r 'klodi_assets_upload_url' packages/` that **all** copies are clean before declaring done. Add the grep to the completion checklist.

- **Vendored `packages/logger-*` and `packages/nats-client-*` fan-out — three languages, six packages.** Removing the tool from the catalog is the easy part; ensuring every vendored-into-adapter copy (`adapters/*/build/staged/_klodi_*_natsclient/`) regenerates cleanly on next publish is the harder part. *Mitigation:* the build artefacts under `build/staged/` are gitignored and regenerated by per-adapter publish scripts (`scripts/vendor.py`, `copy-skill.mjs`, etc.). Verifying a clean publish-staging cycle for each adapter is part of the completion protocol — `code-quality-guardian` will flag any leftovers.

- **`klodi_list_update` atomicity vs. today's semantics.** Today's `klodi_list_update photos: [...]` replaces the full array atomically *at the marketplace side* — the marketplace either commits all the URLs or rejects all. Once we move mint+PUT inside the adapter, a partial failure during PUT changes the failure boundary from "marketplace rejects everything" to "adapter fails before the marketplace ever sees the update". The acceptance criteria already pick the strict all-or-nothing rule; the risk is documenting that the failure-mode signature (a structured adapter error) differs from a marketplace-side validation rejection. *Mitigation:* the error envelope on failure names the offending path and identifies the failure stage (sniff vs mint vs PUT). The agent sees structured failure either way; no contract regression as long as the envelope is parseable.

- **Concurrent PUTs and ordering.** Per the criterion, indexes 0/1/2 must positionally correspond to a.jpg/b.jpg/c.jpg even if PUTs are concurrent. The mint reply gives `{upload_url, asset_url}` *pairs* in order, so as long as the adapter holds the index-to-pair mapping when launching concurrent PUTs, ordering is preserved. *Mitigation:* explicit in the helper — build the `(index, local_path, upload_url, asset_url)` tuple, fan out PUTs by index, write the asset_url at that index on success. Don't sort by anything else.

- **`fulfillment.digital` listings with no photos at all.** Today, `klodi_list_create` accepts `photos: undefined`. With the new path-resolution helper running early, ensure the helper is a no-op when `photos` is absent or empty — don't accidentally mint zero URLs and break the call. *Mitigation:* trivially covered by an early-return at the helper entry; add a smoke test.

- **Reqwest TLS rebuild costs in Rust (cargo build time).** The Rust host already pulls `reqwest` (line 68 of `klodi-rust-host/Cargo.toml`), so no new build-time cost. Just verify the existing `Client` is reused rather than constructed per call.

### Acceptance criteria

<!--
product-owner frames each criterion; solutions-architect appends the [tier] tag
and populates the `tiers:` frontmatter. tier ∈ {unit, integration, e2e}; see
.claude/skills/adversarial-testing/references/testing-tiers.md.
-->

**Happy path — local paths.**

- [integration] Given the agent is registered and `/tmp/img1.jpg` exists with `image/jpeg` bytes ≤ 10 MB, when it calls `klodi_list_create { title, …, photos: ["/tmp/img1.jpg"] }`, then the adapter mints a presigned URL via `p2p.v1.assets.upload-url`, PUTs the bytes to R2, dispatches `p2p.v1.listings.create` with `photos: ["<asset_url>"]`, and the tool reply carries a listing whose `photos` array contains exactly one durable `asset_url` (and the existing `sell_file` side-effect still fires).
- [integration] Given an active listing the agent owns and a local path `/tmp/replacement.png` with valid PNG bytes, when it calls `klodi_list_update { listing_id, photos: ["/tmp/replacement.png"] }`, then the adapter performs the same upload-then-attach substitution and the resulting listing has `photos` containing exactly that one `asset_url` (atomic full-array replacement, matching today's update semantics).

**Happy path — URL pass-through unchanged (regression guard).**

- [unit] Given the agent has two hosted image URLs already, when it calls `klodi_list_create { …, photos: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"] }`, then no upload is minted, no R2 PUT occurs, and the listing carries those two URLs verbatim in the order supplied.

**Happy path — mixed arrays preserve order.**

- [integration] Given `photos: ["https://cdn.example/keep.jpg", "/tmp/new.png", "https://cdn.example/keep2.webp"]` (URL, local, URL), when `klodi_list_create` is called, then exactly one upload is minted for index 1, the resulting `photos` array on the listing is `["https://cdn.example/keep.jpg", "<asset_url>", "https://cdn.example/keep2.webp"]` in that exact order.
- [integration] Given `photos: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]` (three locals) and the marketplace mint endpoint returns three `{upload_url, asset_url}` pairs, when the call succeeds, then index 0, 1, 2 of the resulting `photos` array correspond positionally to a.jpg, b.jpg, c.jpg — even if the adapter issued the PUTs concurrently.

**Error path — invalid content type.**

- [integration] Given a local path `/tmp/doc.pdf` containing PDF bytes (or any non-allowlisted type), when `klodi_list_create { …, photos: ["/tmp/doc.pdf"] }` is called, then the tool returns an error result whose body names the offending path and the rejected content type, no upload URL is minted, and no `p2p.v1.listings.create` request is dispatched.
- [unit] Given a local path `/tmp/sneaky.jpg` whose bytes sniff as PDF (extension mismatch), when the call is made, then the tool rejects on the sniffed content type — not the extension — and the error message says so explicitly. (Closes ADR-0006 format-confusion gap.)

**Error path — oversize / over-count.**

- [unit] Given a local path whose file size exceeds 10 MB, when included in `photos`, then the tool rejects with an error naming the path and the byte-size ceiling; no upload is attempted.
- [unit] Given a `photos` array with 11 or more entries (any mix of URLs and paths), when the tool is called, then it returns an error naming the 10-photo-per-listing ceiling before any I/O occurs.

**Error path — unreadable / missing path.**

- [unit] Given a path `/tmp/missing.jpg` that does not exist on disk, when included in `photos`, then the tool returns an error whose body names the path and identifies it as not-readable; no listing is created or updated.
- [unit] Given a path that is not absolute (e.g. `./img.jpg` or `~/img.jpg`), when included in `photos`, then the tool rejects with a clear "absolute path required" error before any filesystem access.

**Error path — atomic failure across mixed array.**

- [integration] Given `photos: ["/tmp/ok.jpg", "/tmp/oversized.jpg"]` where `/tmp/oversized.jpg` exceeds 10 MB, when `klodi_list_create` is called, then no listing is created, no successful upload from `/tmp/ok.jpg` is referenced anywhere in subsequent state, and the error names `/tmp/oversized.jpg`. (Partial success is forbidden.)

**Path-traversal / symlink defence (added by solutions-architect).**

- [unit] Given a path `/tmp/safe.jpg` that is a symlink to `/etc/passwd`, when included in `photos`, then the tool rejects after `realpath` resolution with an error identifying the symlink-escape; no bytes are read past the magic-number sniff (which fails the allowlist).
- [unit] Given a path under a sensitive directory (`/etc/…`, `/var/run/…`, `$KLODI_HOME/nats.creds`, an OS-specific equivalent of `~/.ssh/`), when included in `photos`, then the tool rejects with a clear "path outside permitted roots" error before reading any bytes.

**Catalog removal — every adapter.**

- [e2e] Given a fresh install of any adapter (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw), when the host enumerates the registered klodi tools, then `klodi_assets_upload_url` is not in the list. The canonical catalog entry, the per-adapter registration call, the plugin manifest (e.g. `hermes/plugin.yaml`), the tool-emoji table, the README tool list, and the `dist/schemas.json` / `dist/rust-types.rs` codegen artefacts no longer mention it.
- [unit] Given the bundled skill (`skill/references/photo_upload_flow.md`, `skill/references/tool_inventory.md`), when the agent reads these files, then they instruct passing photos (URLs or local paths) directly to `klodi_list_create` / `klodi_list_update` and contain no reference to `klodi_assets_upload_url` or a separate mint step.
- [unit] Given a search across the repo for `klodi_assets_upload_url`, `KlodiAssetsUploadUrl`, and `p2p.v1.assets.upload-url`, when run against the post-merge tree (excluding `docs/decisions/0006-*.md` whose history section may still cite the old name and any cards under `cards/done/`), then no matches are returned.

**Cross-language parity.**

- [e2e] Given the same `photos: ["/tmp/img.jpg"]` input, when the call is made through any of the six adapters, then the externally observable behaviour (NATS subjects hit, R2 PUTs issued, final listing photo array) is identical. Differences in implementation language are not allowed to leak through to the user-visible contract.

**Empty / absent photos (added by solutions-architect — smoke).**

- [unit] Given `klodi_list_create { …, photos: [] }` or a call omitting `photos` entirely (e.g. a digital-only fulfillment), when invoked, then no mint request is issued, no PUT is attempted, and the call proceeds to `p2p.v1.listings.create` unchanged.

### Open questions (if any)

None blocking. Two judgment calls baked into the criteria above that the founder may override:

1. **Atomic failure semantics.** Partial-success (create the listing with the photos that uploaded successfully) is explicitly rejected in favour of all-or-nothing. Rationale: the agent reasoned about the photos as a set; a quietly truncated listing diverges from intent and is harder to debug than a clean error. If the founder prefers partial success with a warning in the reply, that flips one criterion and changes the error-path contract — flag now, not in dev.
2. **Absolute-path-only.** Relative paths (`./img.jpg`), tilde-expansion (`~/img.jpg`), and `file://` URLs are rejected. Rationale: any of those forces the adapter to make assumptions about the host's working directory or user identity that the marketplace can't audit. Telegram-style hosts already produce absolute paths (the OS materialises them under `/tmp/` or similar), so this matches the dominant case without papering over edge cases.

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

**Suggested adapter ordering (do not parallelise — cross-language parity is the chief risk).**

1. **openclaw first.** It's the only adapter with bespoke `media.ts` plumbing to delete, the most test infrastructure already in place (`mock-nats.ts`, `temp-home.ts`, `mock-plugin-api.ts`), and the tightest feedback loop (`pnpm -C adapters/openclaw test`). The photo-resolution helper is born here as a TypeScript reference implementation. Land the openclaw delete + new helper + listings rewire + tests + skill rewrite in one PR slice.
2. **packages/tool-catalog second.** Once openclaw is green and the helper's contract is settled, delete `klodi_assets_upload_url` from `src/index.ts` and run `pnpm codegen`. Verify `dist/schemas.json`, `dist/rust-types.rs`, `packages/logger-py/src/klodi_logger/schemas.json`, and `packages/nats-client-py/src/klodi_nats_client/schemas.json` no longer contain `klodi_assets_upload_url` / `KlodiAssetsUploadUrl` / `p2p.v1.assets.upload-url`. Sanity: re-run `pnpm -C adapters/openclaw test` and `pnpm -C adapters/openclaw build` — these should still pass because openclaw was already using a private helper.
3. **hermes third.** Catalog-driven registration means the tool simply vanishes from `provides_tools` after the codegen step lands; the work here is (a) wiring the Python photo-resolution helper into the request bridge for `klodi_list_create`/`klodi_list_update`, and (b) editing `plugin.yaml`, the tool-emoji table, README. Reuse the openclaw helper's logic structurally (same sniff table, same atomic semantics, same error envelope shape).
4. **nanobot fourth.** Same shape as hermes — extract the helper into a sibling module if practical (`nanobot_photos.py`) so the hermes pattern is mirrored verbatim. The two Python adapters can share a tiny module via `klodi_nats_client` if the helper is dependency-light enough; otherwise duplicate (don't over-abstract for two callers).
5. **Rust trio last (moltis, ironclaw, zeroclaw).** All three delegate to `packages/klodi-rust-host/src/mcp/tools.rs::dispatch_passthrough`. Add the helper there once; all three Rust adapters inherit. The host already pulls `reqwest` with `rustls-tls` so PUT capability exists. Update the `build_tool_list_includes_passthrough_and_local` test to assert the absence of `klodi_assets_upload_url`.
6. **skill/ rewrite last.** Once every adapter is green, rewrite `skill/references/photo_upload_flow.md` and edit `skill/references/tool_inventory.md`. The bundled skill is copied into each TS adapter at build time via `copy-skill.mjs`; rebuild openclaw to verify the new copy lands clean.
7. **Public docs (`docs/decisions/0006-*.md`, `docs/THREAT_MODEL.md`, `docs/specs/hosts/openclaw.md`, `SECURITY.md`)** can fold into the openclaw slice or land as a final docs pass — they're orthogonal to runtime correctness.

**What's shared vs per-adapter.**

- **Shared (delete once, propagates everywhere):** the catalog entry, plus the `dist/*` codegen artefacts. The Rust passthrough loop and the Python `TOOL_SCHEMAS.items()` iterations both pick up the deletion automatically.
- **Shared logically (one helper per language, copied implementation):** the photo-resolution pipeline — absolute-path check, realpath + sensitive-dir reject, content-sniff against `[image/jpeg, image/png, image/webp]`, size check ≤ 10MB, mint via `p2p.v1.assets.upload-url`, PUT via the language's HTTP client. Three implementations (TS / Python / Rust), but the *same* magic-number table and *same* error-envelope shape — verify by fixture parity.
- **Per-adapter (bespoke):** wiring the helper into the create+update tool handlers. Each language's tool-registration shape differs: openclaw uses `api.registerTool` directly; hermes/nanobot iterate the catalog at register time; the Rust host has a central `dispatch_passthrough`. The wiring is mechanical once the helper exists.

**Test strategy.**

- **Per-adapter unit tests** for each error path (invalid type, oversize, missing, non-absolute, symlink escape, sensitive dir) — every adapter independently. These run cheap (`pnpm test`, `uv run pytest`, `cargo test`) and the dev pair should run them on every save.
- **Per-adapter integration tests** for the happy paths (single local, mixed array, atomic failure) — mock the NATS subject `p2p.v1.assets.upload-url` to return synthetic `{upload_url, asset_url}` pairs, mock the HTTP PUT to record bytes and content-type, assert the final `p2p.v1.listings.create` payload. `mock-nats.ts` (openclaw) is the existing template; hermes/nanobot can use `responses`/`httpx_mock`; Rust uses `wiremock`.
- **One e2e covering the full agent-call-with-local-path flow.** Pick openclaw as the e2e host (most mature test infra). Boot the plugin against a `wiremock`-style local stand-in for both the NATS subject and the R2 endpoint. The e2e is the parity reference: every adapter must produce the same observable trace against this fixture set. See the `live-verification` skill.
- **Cross-adapter parity test.** A single fixture directory (e.g. `tests/fixtures/photos/` with `valid.jpg`, `valid.png`, `valid.webp`, `pdf-bytes-as-jpg.jpg`, `oversize.jpg`, `symlink-to-etc-passwd.jpg`) drives one assertion file (`tests/fixtures/photos/expected.json` with the expected error envelope for each). Each adapter's integration suite loads the fixtures and the expected envelopes and asserts shape-for-shape parity. If this is too much infra for one card, defer the parity harness to a follow-up — note it in the card.

**Sequencing constraints.**

- The catalog deletion (step 2) is the destructive step. Until it lands, every other adapter still has `klodi_assets_upload_url` registered, and breaking it before the new path is wired would leave the adapter in a half-state. Land openclaw's complete flow first, then catalog, then iterate adapter-by-adapter.
- Skill rewrite is last. The agent's tool catalog and the skill must stay coherent: if the skill says "call `klodi_assets_upload_url`" while the tool is gone, the agent gets `UNKNOWN_TOOL` errors. Land skill changes only when every adapter is green.
- Do not push intermediate commits to `main`. Card-branch only.

**Founder-flagged judgment calls.**

The two open questions (atomic-vs-partial, absolute-paths-only) are baked into the acceptance criteria above. *Recommendation: do not block dev on a founder ruling.* The criteria pick the safer / less ambiguous option in both cases (all-or-nothing, absolute only), and reverting either is a 30-line follow-up if the founder objects. Dev should proceed; if the founder overrides during review, the change is mechanical.

**Definition-of-done checklist for the dev pair.**

- [ ] `grep -rln 'klodi_assets_upload_url\|KlodiAssetsUploadUrl\|p2p.v1.assets.upload-url' .` returns matches only inside `docs/decisions/0006-*.md` (history-only mentions) and inside `cards/done/` (archive). No matches under `adapters/`, `packages/`, `skill/`.
- [ ] Per-adapter test suites all green (`pnpm -C adapters/openclaw test`, `cd adapters/hermes && uv run pytest`, `cd adapters/nanobot && uv run pytest`, `cargo test -p klodi-moltis -p klodi-ironclaw -p klodi-zeroclaw`).
- [ ] Per-adapter builds clean (`pnpm -C adapters/openclaw build`, `uv build` × 2, `cargo build` × 3).
- [ ] `live-verification` run on at least openclaw — agent calls `klodi_list_create photos: ["/tmp/fixture.jpg"]`, listing renders with R2 URL.
- [ ] `code-quality-guardian` verdict ≥ REVIEW.
- [ ] Distillation pass adds ADR-0006 update + any inline `// See ADR-0006` references in the new photo helpers.

## In Dev — <agents>

<!-- implementation + test notes -->

### → Handoff to Review (next agent: code-quality-guardian)

<!-- what to pay attention to, known smells -->

## Review round 1 — code-quality-guardian

<!-- verdict + issues; runs against the open PR's diff (PR was opened by expert-developer at the in-dev → review transition) -->

### → Handoff back to In Dev (if FAIL/REVIEW)

<!-- fix list -->

## Distillation — solutions-architect

<!-- Runs in the worktree on the card branch after Review PASS. Pushes to the same PR. Per the `distillation` skill: SEARCH docs/ INDEX files first; edit existing docs rather than creating duplicates. Captures land at smallest viable scope: inline WHY comments, docs/decisions/, docs/knowledge/, docs/product/, or CLAUDE.md. Then flips status to pr-ready. -->

## PR Ready

<!-- PR url; founder notification fires here -->

<!-- Abandoned section: appended by /board-close. Records date, reason, PR state at close, worktree teardown. Heading is "## Abandoned — founder". -->
