---
type: card
title: Remove standalone upload tool, fold uploads into listing tools
slug: fold-uploads-into-listing-tools
work_type: feature
tiers: []
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

<!-- solutions-architect: file-level affected surfaces go here -->

### Risks / failure modes

<!-- solutions-architect: risks + mitigations go here -->

### Acceptance criteria

<!--
product-owner frames each criterion; solutions-architect appends the [tier] tag
and populates the `tiers:` frontmatter. tier ∈ {unit, integration, e2e}; see
.claude/skills/adversarial-testing/references/testing-tiers.md.
-->

**Happy path — local paths.**

- Given the agent is registered and `/tmp/img1.jpg` exists with `image/jpeg` bytes ≤ 10 MB, when it calls `klodi_list_create { title, …, photos: ["/tmp/img1.jpg"] }`, then the adapter mints a presigned URL via `p2p.v1.assets.upload-url`, PUTs the bytes to R2, dispatches `p2p.v1.listings.create` with `photos: ["<asset_url>"]`, and the tool reply carries a listing whose `photos` array contains exactly one durable `asset_url` (and the existing `sell_file` side-effect still fires).
- Given an active listing the agent owns and a local path `/tmp/replacement.png` with valid PNG bytes, when it calls `klodi_list_update { listing_id, photos: ["/tmp/replacement.png"] }`, then the adapter performs the same upload-then-attach substitution and the resulting listing has `photos` containing exactly that one `asset_url` (atomic full-array replacement, matching today's update semantics).

**Happy path — URL pass-through unchanged (regression guard).**

- Given the agent has two hosted image URLs already, when it calls `klodi_list_create { …, photos: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"] }`, then no upload is minted, no R2 PUT occurs, and the listing carries those two URLs verbatim in the order supplied.

**Happy path — mixed arrays preserve order.**

- Given `photos: ["https://cdn.example/keep.jpg", "/tmp/new.png", "https://cdn.example/keep2.webp"]` (URL, local, URL), when `klodi_list_create` is called, then exactly one upload is minted for index 1, the resulting `photos` array on the listing is `["https://cdn.example/keep.jpg", "<asset_url>", "https://cdn.example/keep2.webp"]` in that exact order.
- Given `photos: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]` (three locals) and the marketplace mint endpoint returns three `{upload_url, asset_url}` pairs, when the call succeeds, then index 0, 1, 2 of the resulting `photos` array correspond positionally to a.jpg, b.jpg, c.jpg — even if the adapter issued the PUTs concurrently.

**Error path — invalid content type.**

- Given a local path `/tmp/doc.pdf` containing PDF bytes (or any non-allowlisted type), when `klodi_list_create { …, photos: ["/tmp/doc.pdf"] }` is called, then the tool returns an error result whose body names the offending path and the rejected content type, no upload URL is minted, and no `p2p.v1.listings.create` request is dispatched.
- Given a local path `/tmp/sneaky.jpg` whose bytes sniff as PDF (extension mismatch), when the call is made, then the tool rejects on the sniffed content type — not the extension — and the error message says so explicitly. (Closes ADR-0006 format-confusion gap.)

**Error path — oversize / over-count.**

- Given a local path whose file size exceeds 10 MB, when included in `photos`, then the tool rejects with an error naming the path and the byte-size ceiling; no upload is attempted.
- Given a `photos` array with 11 or more entries (any mix of URLs and paths), when the tool is called, then it returns an error naming the 10-photo-per-listing ceiling before any I/O occurs.

**Error path — unreadable / missing path.**

- Given a path `/tmp/missing.jpg` that does not exist on disk, when included in `photos`, then the tool returns an error whose body names the path and identifies it as not-readable; no listing is created or updated.
- Given a path that is not absolute (e.g. `./img.jpg` or `~/img.jpg`), when included in `photos`, then the tool rejects with a clear "absolute path required" error before any filesystem access.

**Error path — atomic failure across mixed array.**

- Given `photos: ["/tmp/ok.jpg", "/tmp/oversized.jpg"]` where `/tmp/oversized.jpg` exceeds 10 MB, when `klodi_list_create` is called, then no listing is created, no successful upload from `/tmp/ok.jpg` is referenced anywhere in subsequent state, and the error names `/tmp/oversized.jpg`. (Partial success is forbidden.)

**Catalog removal — every adapter.**

- Given a fresh install of any adapter (openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw), when the host enumerates the registered klodi tools, then `klodi_assets_upload_url` is not in the list. The canonical catalog entry, the per-adapter registration call, the plugin manifest (e.g. `hermes/plugin.yaml`), the tool-emoji table, the README tool list, and the `dist/schemas.json` / `dist/rust-types.rs` codegen artefacts no longer mention it.
- Given the bundled skill (`skill/references/photo_upload_flow.md`, `skill/references/tool_inventory.md`), when the agent reads these files, then they instruct passing photos (URLs or local paths) directly to `klodi_list_create` / `klodi_list_update` and contain no reference to `klodi_assets_upload_url` or a separate mint step.

**Cross-language parity.**

- Given the same `photos: ["/tmp/img.jpg"]` input, when the call is made through any of the six adapters, then the externally observable behaviour (NATS subjects hit, R2 PUTs issued, final listing photo array) is identical. Differences in implementation language are not allowed to leak through to the user-visible contract.

### Open questions (if any)

None blocking. Two judgment calls baked into the criteria above that the founder may override:

1. **Atomic failure semantics.** Partial-success (create the listing with the photos that uploaded successfully) is explicitly rejected in favour of all-or-nothing. Rationale: the agent reasoned about the photos as a set; a quietly truncated listing diverges from intent and is harder to debug than a clean error. If the founder prefers partial success with a warning in the reply, that flips one criterion and changes the error-path contract — flag now, not in dev.
2. **Absolute-path-only.** Relative paths (`./img.jpg`), tilde-expansion (`~/img.jpg`), and `file://` URLs are rejected. Rationale: any of those forces the adapter to make assumptions about the host's working directory or user identity that the marketplace can't audit. Telegram-style hosts already produce absolute paths (the OS materialises them under `/tmp/` or similar), so this matches the dominant case without papering over edge cases.

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

<!-- solutions-architect appends this -->

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
