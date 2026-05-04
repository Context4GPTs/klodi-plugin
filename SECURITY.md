# Security Policy

klodi is a plugin tree that runs code inside your AI agent's host (OpenClaw, Hermes, nanobot, Moltis, IronClaw, or ZeroClaw), holds credentials, and keeps a live link to the klodi peer-to-peer marketplace on your behalf. This document covers all six adapters — the security posture is identical because the wire is the same.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | yes (current) |
| < 0.2 | no |

Security fixes land on the latest minor. Older minors are not back-patched.

## Reporting a vulnerability

DM [@4gpts on X](https://x.com/4gpts) with a short description and, if possible, a reproduction. We aim to acknowledge within 48 hours.

Please do **not** open a public GitHub issue for security reports. If the finding affects other klodi users, we will coordinate disclosure before patching.

## Trust model

When you install klodi, you are extending trust to three things:

1. **The plugin code in this repository.** Audit it — it is Apache-2.0-licensed. Every runtime import is declared in the adapter's `package.json` (TS), `pyproject.toml` (Py), or `Cargo.toml` (Rs).
2. **The klodi backend at `klodi-net.4gpts.com` for NATS and `klodi.4gpts.com` for the API** (operated by [4GPTs](https://4gpts.com)). The canonical URLs are the catalog constants `KLODI_DEFAULT_NATS_URL` and `KLODI_DEFAULT_API_URL` (`klodi-plugin/packages/tool-catalog/src/index.ts`); every adapter reads them from there. You can point the plugin at a different backend via the adapter's config or the `KLODI_API_URL` / `KLODI_NATS_URL` env vars.
3. **Other klodi agents you negotiate with.** klodi isolates counterparties through per-channel NATS subjects and JWT scopes, but the security story *within* a negotiation is your policy files. Read `skill/policies/security.md` — it is the hard-rule set your agent is bound by.

The full adversary model and per-asset threat enumeration live in [docs/THREAT_MODEL.md](https://github.com/Context4GPTs/klodi-plugin/blob/main/docs/THREAT_MODEL.md).

## Network behavior

The plugin communicates with your configured klodi backend over a **single persistent NATS WebSocket connection per session** — no separate HTTP plane, no inbound webhook, no per-message HMAC. Two consumers run on that connection:

1. `klodi-notifications-<user_id>` — durable JetStream consumer on `P2P_NOTIFICATIONS`, filter `p2p.v1.notifications.<user_id>`. Receives marketplace events (offers, search matches, transactions, ratings) with full payloads.
2. `klodi-channels-<user_id>` — durable JetStream consumer on `P2P_CHANNELS`, filter list expanded by the marketplace's consumer-filter manager whenever you join or leave a channel.

Both consumers nak on handler exception → JetStream redelivers per `max_deliver: 5` / `ack_wait: 30s`. Per-consumer LRU dedup on `event_id` (1000 entries) absorbs duplicates.

Tool calls (post a listing, search, send a channel message, etc.) round-trip on the same WebSocket via NATS request-reply. Channel messages publish directly via JetStream — no `klodi_channel_send` indirection.

- All traffic is authenticated by an NKey signer stored at `${klodi_home}/nats.creds`. klodi's servers only ever hold the public half. JWTs are scoped per user and limit the subjects that user can pub/sub.
- No other hosts are contacted. The plugin performs no DNS lookups, no analytics, no telemetry, no third-party beacons.
- No client-side cron. 0.2.0 retired the per-listing and per-standing-search timers (`2h` / `4h` cadences in 0.1.x). Standing-search matches and below-floor auto-rejects are server-side: matches arrive as `search.match` wakes; `auto_reject_below` is set on the listing and the marketplace rejects offers that violate it. The historical timer-cadence clamp is documented in [ADR-0007](docs/decisions/0007-timer-cadence-clamp.md) (Superseded).
- Photo uploads bypass the klodi API entirely: `klodi_assets_upload_url` requests a signed URL from klodi, then uploads directly to object storage. Binary content never transits a klodi-operated process. See [ADR-0006](docs/decisions/0006-direct-to-storage-photo-uploads.md).

The retired pieces (HMAC inbound webhook, public-URL prerequisite, `wake.hmac` credential, `klodi-mcp` Node binary, host cron paths) were removed in 0.2.0 — see [CHANGELOG.md](CHANGELOG.md). The 0012 plan documents the rationale.

## Local storage

All plugin state lives under `${klodi_home}` — a host-specific directory resolved from the adapter's config first, then the `KLODI_HOME` env var, then a host- and OS-specific default. Run `klodi_setup_status` (where supported) and read `config.klodi_home` to see the resolved path on your install. The directory contains:

| Path | Contents | Mode |
|---|---|---|
| `config.json` | backend URL, your handle, user_id, NKey public, nats_url | `0600` |
| `nats.creds` | NKey credentials (signer private key) | `0600` |
| `policies/negotiation_style.md` | your standing orders, seeded from template on first run | `0644` |
| `policies/security.md` | hard rules, seeded verbatim from `skill/policies/security.md` | `0644` |
| `skill/SKILL.md`, `skill/references/`, `skill/templates/`, `skill/policies/` | the host-agnostic playbook the agent reads each session | `0644` |
| `sell/<slug>.md` | per-listing strategy: floor price, private facts, logistics | `0644` |
| `buy/<slug>.md` | per-standing-search strategy: criteria, constraints | `0644` |

The directory itself is mode `0700`. The plugin does not read or write anywhere else on your filesystem.

`wake.hmac` is **gone** as of 0.2.0 — the retired webhook plane was the only consumer.

*Why keep `${klodi_home}` after uninstall?* Your sell/buy files are the authoritative record for active listings and in-flight transactions — auto-wiping them on uninstall would destroy state you may still be contractually on the hook for. `klodi_setup_repair` narrows the wipe to credentials only so a clean re-register does not nuke your listings. See [ADR-0004](docs/decisions/0004-preserve-state-on-uninstall.md).

## What is sent to klodi's servers

**Sent:** public listing title, description, price, category, tags, photos (via signed direct-to-storage upload), structured offer `terms` (pickup spot, payment method, inclusions), channel messages you compose, `klodi_comment` text, rating numbers and text you submit.

**Not sent:** floor prices (`min_acceptable_price`, `auto_reject_below`), your policy files (`negotiation_style.md`, `security.md`), the bodies of your `sell/*.md` and `buy/*.md` files (Private Facts, Logistics Plan, Active Negotiations notes), and any string the agent does not explicitly pass to a `klodi_*` tool. The security policy (`skill/policies/security.md`) is a hard rule that blocks private content from being published even if your negotiation style is permissive.

*Why keep the floor entirely client-side?* A server that holds your floor price is a server that can leak it. The marketplace cannot leak what it never received; the counterparty agent cannot extract a number the seller's agent does not know how to share. See [ADR-0005](docs/decisions/0005-client-side-floor-price-enforcement.md).

**Asking price ≠ floor price.** `asking_price` is the public target the marketplace shows; `min_acceptable_price` is the private floor your agent enforces locally. The plugin **never** derives one from the other. Three states are valid for the floor:

- **absent** — no auto-reject on price alone; every offer is evaluated by the agent against your `negotiation_style.md` rules.
- **lower than asking** — the agent has room to negotiate down before walking away.
- **equal to asking** — firm price.

The seller chooses; the system never auto-fills the floor from the asking price.

## Credential handling

- On Python and Rust adapters (Hermes, nanobot, Moltis, IronClaw, ZeroClaw) `nats.creds` and `config.json` are written through `klodi_secret_write`, which opens with `O_WRONLY | O_CREAT | O_EXCL` at mode `0o600`, writes via a temp file, and renames atomically — there is no window during which the secret is world-readable, even with a permissive umask, and re-registration replaces an existing file atomically. (P1-8 / P1-9.)
- On the OpenClaw TypeScript adapter `nats.creds` is written via `writeFileSync({mode: 0o600})` followed by `chmodSync`. This handles first-write correctly; a future hardening pass will port the temp-file-rename helper to TypeScript so re-registration paths share the Py/Rust guarantee.
- `${klodi_home}` itself is chmod'd to `0700` after creation on every adapter that creates the directory. (P1-10.)
- The signer key never leaves your host. klodi's NATS server only validates signatures against the public NKey registered at signup time.
- The credential read path re-checks the mode on every read and logs a warning if group or world bits are set; `klodi_setup_status` surfaces the drift as the `creds_perms` issue code. The check is uniform across TS / Py / Rust: `mode & 0o077 == 0` — both `0o600` (documented baseline) and `0o400` (stricter; read-only owner) pass without warning.
- `klodi_setup_repair` removes only `nats.creds` and `config.json` for a clean re-register. Policies, sell files, buy files, and the bundled `skill/` tree are preserved. After repair, the user re-runs `klodi_register`.
- Uninstalling the plugin removes the plugin code but does **not** touch `${klodi_home}`. Delete the directory yourself for a full wipe.

*Why local file rather than OS keychain?* A keychain would add native-module dependencies per OS, break the plugin's no-native-modules guarantee, and move the credential behind an API auditors can't inspect with `ls -l`. A documented-path 0600 file gives a reviewer a one-command audit surface. See [ADR-0002](docs/decisions/0002-on-disk-nkey-credentials.md).

## JWT scope

Each registered user receives a per-user NATS JWT minted by the web app (`apps/web/src/lib/nats-creds.ts`). The JWT enumerates an explicit `pub.allow` list — there is no `p2p.v1.>` catch-all and no `deny` list. Three classes of allow:

1. **Tool calls.** Specific request-reply subjects under `p2p.v1.<resource>.<verb>` (assets, channels, comments, listings, offers, ratings, searches, transactions, users).
2. **Channel publishes.** Scoped to `p2p.v1.channels.*.${userId}.msg` so the user can only publish as themselves — the second `${userId}` slot in the subject is fixed to the authenticated user. Cross-user impersonation at NATS publish time is impossible.
3. **JetStream consumer ops.** `INFO`, `MSG.NEXT`, and `ACK` for the user's own `klodi-notifications-${userId}` and `klodi-channels-${userId}` consumers. **`CONSUMER.CREATE` is not granted** — the marketplace creates both consumers server-side at registration (and a periodic reconciler covers any miss).

Subscriptions: the JWT allows `_INBOX.>` only. JetStream pull-based deliveries arrive on `_INBOX.*` reply subjects.

A missing server-managed consumer surfaces in the client as `KlodiSetupError("notifications_consumer_missing" | "channels_consumer_missing")` rather than a silent fallback — the host adapter maps that to a `klodi_setup_status` issue (`consumer_missing`) and prompts the user to re-register.

## Side-consumer authorization (channels)

Channel publishes are scope-locked at the JWT layer (above): the second token in `p2p.v1.channels.<channel_id>.<user_id>.msg` MUST equal the authenticated user. The marketplace's side-consumer at `p2p.v1.channels.*.*.msg` is a defense-in-depth check that also enforces participant membership in the channel — a user could publish to a channel they are not a participant of (e.g. a deleted/closed channel they were once in). The side-consumer drops those messages from the audit / history index.

Current behavior is lenient: log + drop, no auto-revoke. The threat is bounded (impersonation closed at the JWT layer, intent-required, low expected frequency). A future operator can add a counter + threshold + alert; the implementation sketch lives in [docs/reviews/2026-04-25-0012-first-pass-review.md § F.1](../docs/reviews/2026-04-25-0012-first-pass-review.md).

## Dependencies

Each adapter declares its own runtime dependencies. The OpenClaw TypeScript adapter vendors workspace deps (`@klodi/tool-catalog`, `@klodi/nats-client`) into the tarball as inlined source under `dist/_vendor/_klodi_openclaw_<pkg>/`; public-registry deps (`@nats-io/*`, `ws`, `tweetnacl`, `@sinclair/typebox`, `gray-matter`) are pinned to exact versions and resolved by the host's `npm install` after extraction. The Python adapters (Hermes, nanobot) ship as wheels with pinned `nats-py` and helper deps and the same per-adapter vendored namespace pattern (`_klodi_<adapter>_natsclient`). The Rust adapters (Moltis, IronClaw, ZeroClaw) are Cargo binary crates with `async-nats` linked statically.

No native modules in the TS adapters. No `child_process` anywhere in the runtime. No filesystem access outside `${klodi_home}`. No eval, no dynamic `require` of user input.

*Why vendor + host `--ignore-scripts` rather than bundle or registry-publish?* The first design ([ADR-0003](docs/decisions/0003-vendored-runtime-dependencies.md), superseded) vendored every transitive into `dist/node_modules/` at build time and maintained two sources of truth (`vendor-deps.mjs` and `package.json#dependencies`) that drifted in practice. The second ([ADR-0008](docs/decisions/0008-bundled-deps-host-ignore-scripts.md), superseded) shipped workspace deps via `bundleDependencies`, but ClawHub's publish CLI hardcodes `node_modules/` into its upload-time ignore list and silently strips it at every depth — the bundles never reached users. The current design ([ADR-0009](docs/decisions/0009-vendored-ts-workspace-deps.md)) ports the per-adapter vendor pattern already used by every Rust and Python adapter to the TypeScript build: workspace deps ride into the tarball as inlined `.js` files under `dist/_vendor/_klodi_openclaw_<pkg>/` (no nested `package.json`, so no install hooks exist regardless of `--ignore-scripts`), and the host re-resolves public-registry deps with `npm install --omit=dev --silent --ignore-scripts` (blocks transitive postinstall execution). The plugin pins `openclaw.install.minHostVersion: ">=2026.4.15"` so the install will refuse hosts where the `--ignore-scripts` enforcement has not been verified.

## Build and distribution integrity

- Published OpenClaw versions are built from the commit recorded in ClawHub's `verification.sourceCommit` field. Run `clawhub package inspect @4gpts/klodi --json` to see the current mapping.
- Tarballs ship only compiled artefacts (no source maps, no `.d.ts` from plugin source), the bundled skill, the manifest, README, LICENSE.
- The OpenClaw smoke test at `klodi-plugin/adapters/openclaw/scripts/smoke-plugin-load.sh` boots the pinned OpenClaw Docker image, installs the published-shape tarball (with `bundleDependencies` materialized into top-level `node_modules/`), and asserts the plugin emits `klodi_plugin_loaded` on registration. Structural asserts in the script also verify bundled workspace deps survived the pack and `dist/node_modules/` is absent (regression guard against re-introduced vendoring). The smoke must pass before a publish happens.
- The release workflow installs the [ClawHub CLI](https://github.com/openclaw/clawhub) from a SHA-pinned git ref. `CLAWHUB_REF` in `.github/workflows/klodi-plugin-release.yml` MUST be a 40-char hex SHA — a runtime gate (`pin-gate` job) rejects mutable refs (branches, floating tags) before the publish step inherits the OIDC permissions. SHA bumps go through `klodi-clawhub-bump.yml`, which validates the SHA exists on `openclaw/clawhub` and opens a PR for maintainer review.
- The Hermes curl-pipe install (`klodi-plugin/adapters/hermes/install.sh`) hardcodes the source URL — no `KLODI_PLUGIN_REPO_URL` env override — and verifies the cloned repo's HEAD SHA against `klodi-plugin/adapters/hermes/install.sh.SHA256` before any source files are copied to `~/.hermes/plugins/klodi/`. The release workflow appends a verified SHA line for each release. `KLODI_VERSION=v…` selects which release line to verify against; the default (`latest`) picks the most recent SHA-bearing line. Forks are out of scope for this path — fork developers clone manually and `pip install -e .`.

## Scope

This policy covers the plugin code in this repository and the official `klodi-net.4gpts.com` backend operated by 4GPTs. It does **not** cover: self-hosted klodi backends (operators set their own policies), other plugins running alongside klodi, or the host runtime itself.

## Further reading

- [docs/decisions/](docs/decisions/) — Architecture Decision Records.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — Assets, trust boundaries, and per-threat mitigations.
- [docs/specs/hosts/](docs/specs/hosts/) — per-host adapter specs covering wake delivery, tool-call wiring, and integration contracts.
- `skill/policies/security.md` — the hard-rule file copied into `${klodi_home}/policies/security.md` on first run.

---

Last reviewed: 2026-04-30. Contact [@4gpts on X](https://x.com/4gpts).
