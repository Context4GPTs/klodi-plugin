# Changelog

All notable changes to klodi-plugin (every adapter — `@4gpts/klodi` for OpenClaw, `klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All adapters move together — they share a single version line. Pre-1.0 the public surface is not yet stable — check this file on every upgrade before bumping the pinned version.

## [Unreleased]

### Fixed

- **klodi-{zeroclaw,moltis,ironclaw}-register:** the host `config.toml` merge step now accepts both `[[mcp.servers]]` (headered) and `servers = [{ … }]` (inline) representations of `mcp.servers`. Previously the inline form failed with `[[mcp.servers]] exists but isn't an array-of-tables — refusing to overwrite`, blocking re-runs of register on any `config.toml` rewritten by another writer — e.g. ZeroClaw's daemon persisting `config.toml` after a pairing event, which materializes the headered block as an inline table with the Server struct's default fields (`args`, `headers`). The two TOML forms are semantically identical (both deserialize to the same `Vec<Server>`); the merge step now mutates either form in place, updating only the `klodi` entry while preserving every other entry and the writer's chosen syntax. Rejection is reserved for `mcp.servers` being a non-array or an array containing non-tables.

## [0.2.2] — 2026-05-07

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

This release brings the Rust MCP surface to feature parity with openclaw / hermes for the user-editable policy and standing-search workflows. Prior to this version, Rust hosts could not customize negotiation policies or persist per-search strategy across sessions — the embedded skill bundle covered the canonical (read-only) skill but skipped the operator-edited surfaces. The whole "your agent, your rules" durable-boundary contract now works the same on Claude Code (openclaw) and on the Rust hosts.

### Added

- **klodi-{zeroclaw,moltis,ironclaw}: three new MCP tools** that close the parity gap with openclaw / hermes:
  - `klodi_setup_reseed_policies` — non-destructive seed of `${KLODI_HOME}/policies/{negotiation_style,security}.md` from the embedded skill bundle. Existing files are preserved verbatim; the agent calls this to restore a deleted policy file without touching the user's edits to the others.
  - `klodi_watch` — composite tool. `persist=true` registers a server-side standing search via `p2p.v1.searches.create` AND writes `${KLODI_HOME}/buy/<slug>.md` with frontmatter (query, max_price, target_price, delivery, action_on_match) so the agent reads the user's strategy when `search.match` wakes arrive. `persist=false` is a one-shot equivalent of `klodi_search`.
  - `klodi_unwatch` — composite tool. Calls `p2p.v1.searches.delete` and removes the buy file. Idempotent on missing files.
- **`klodi_setup_status` is now actually actionable.** New phase `needs_policy` between `registering` and `ready`, driven by file presence + `negotiation_style.md` placeholder detection. New issue codes: `not_registered`, `partial_credentials`, `negotiation_style_missing`, `negotiation_style_unfilled`, `security_policy_missing`. New structured `next_action: { kind, message, … }` field where `kind` is `cli` (run a host-specific binary), `tool` (call another klodi MCP tool), `shell` (chmod-style command surfaced for the user to run), or `dialog` (prompt the user to fill a template). Per-host CLI name (`klodi-ironclaw-register` / `klodi-moltis-register` / `klodi-zeroclaw-register`) substitutes into the messages so the agent surfaces the right command for the current host.
- **klodi-{zeroclaw,moltis,ironclaw}-register: policy seeding on first registration.** After persisting `nats.creds` + `config.json`, the register binary now calls `klodi_rust_host::policy_seed::seed_policies_if_absent` to write `policies/{negotiation_style,security}.md` from the embedded skill bundle. Non-destructive — re-runs preserve every operator edit. Failures here are logged but don't block registration (creds are already on disk; the next `klodi_setup_status` surfaces the missing policy via `negotiation_style_missing` / `security_policy_missing`).
- **`${KLODI_HOME}` layout symmetry with TS / Py hosts.** New on-disk subtrees: `policies/` (user-editable), `buy/<slug>.md` (written by `klodi_watch`), `sell/<slug>.md` (written by listing-lifecycle hooks). Path helpers added to `klodi_rust_host::paths` (`policies_dir`, `buy_dir`, `sell_dir`, `negotiation_style_path`, `security_policy_path`, `buy_file_path`, `sell_file_path`).

### Changed

- **klodi-rust-host:** `mcp::skill_data` promoted to top-level `skill_bundle` module so the `include_dir!`-embedded canonical skill bundle is reachable from the registration flow (which is not gated behind the `mcp` feature). `include_dir` becomes a non-optional dep; `mcp` feature now gates only `rmcp` + `toml_edit`.
- **klodi-rust-host:** `SetupStatus` shape extended with `negotiation_style_seeded`, `negotiation_style_filled`, `security_policy_seeded`, `issues[]` (typed structs replacing the prior flat `issue_codes` strings — the legacy `issue_codes` field is preserved for back-compat), and `next_action: Option<NextAction>`. Phase enum gains a new `needs_policy` variant. `klodi_setup_status_with_register_cli(klodi_home, cli_name)` exposed for adapter binaries to substitute their host-specific register CLI name into the generated messages; the existing `klodi_setup_status(klodi_home)` defaults the name to `klodi-register`.
- **klodi-{zeroclaw,moltis,ironclaw}-mcp:** `McpConfig` gains a `register_cli: String` field so the host-specific binary name flows into `dispatch_setup_status`. Adapter `mcp.rs` binaries set it explicitly (`klodi-ironclaw-register`, `klodi-moltis-register`, `klodi-zeroclaw-register`).
- **`klodi_setup_status` description** in `tools/list` no longer references `klodi_register` (which is not on the Rust MCP surface). Replaced with a description that points at the structured `next_action` field for recovery directives.
- **Spec § 6 (Skill delivery path)** for ironclaw / moltis / zeroclaw: clarifies the split between the embedded canonical skill (`klodi://skill/<rel-path>`, read-only, no drift) and the on-disk user-editable policy files (`${KLODI_HOME}/policies/`, seeded once non-destructively from the same bundle). Spec § 7 (Local-state files) adds the new `policies/`, `buy/<slug>.md`, `sell/<slug>.md` entries with file-mode + ownership notes.
- **Rust adapter READMEs** (ironclaw / moltis / zeroclaw): new "Files in `${KLODI_HOME}`" and "Repair / bad credentials" sections. Documents the re-run-the-register-binary recovery flow that was previously buried in spec § 5.

## [0.2.1] — 2026-05-06

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

### Added

- **klodi-{zeroclaw,moltis,ironclaw}:** new `klodi-<host>-mcp` binary per Rust adapter — a stdio Model Context Protocol server that exposes the full klodi tool catalog (every `klodi_*` request/reply tool from `packages/tool-catalog/dist/schemas.json` plus the local `klodi_setup_status`, `klodi_health`, `klodi_channel_message`) and the canonical skill bundle (`klodi-plugin/skill/`) to the host's agent. The host spawns the binary on demand per agent session per its `[[mcp.servers]]` config; the agent reads each skill file via MCP `resources/read` under `klodi://skill/<rel-path>`. This closes the in-agent tool-surface gap from the 0.2.0 multi-host build plan, where the Rust adapters shipped only the wake forwarder and the agent had no way to call `klodi_list_create`, respond to offers, or send channel messages without operator intervention. Implementation lives in shared `klodi_rust_host::mcp` so all three adapters reuse one body — only the bin wrapper and the host config path differ per host.
- **klodi-<host>-register** (zeroclaw / moltis / ironclaw) now writes the `[[mcp.servers]]` block into the host's `config.toml` at the end of registration:
  - `klodi-zeroclaw-register` → `~/.zeroclaw/config.toml` (or `$ZEROCLAW_CONFIG`)
  - `klodi-moltis-register` → `~/.moltis/config.toml` (or `$MOLTIS_CONFIG`)
  - `klodi-ironclaw-register` → `~/.ironclaw/config.toml` (or `$IRONCLAW_CONFIG`)

  Each is idempotent — re-running after an upgrade replaces the `klodi` entry only and preserves any unrelated server blocks. The new behavior is on by default; pass `--skip-<host>-config` for hosts that only forward wakes and don't run the agent locally.
- **Skill bundle delivery via MCP resources.** Each published Rust adapter crate now embeds `klodi-plugin/skill/` at compile time via `include_dir!` and serves each file under `klodi://skill/<rel-path>`. Single source of truth — no on-disk seeding step, no operator-edited drift, no `klodi_setup_reseed_skill` analogue needed on these hosts.

### Changed

- **klodi-rust-host:** new `mcp` Cargo feature gates the MCP server module (`klodi_rust_host::mcp`) and the host config writer (`klodi_rust_host::host_mcp_config` — the latter formerly `zeroclaw_config`, generalised to take the host-name string). Daemon-only adapters (any future host that doesn't expose an MCP client) keep their lean dependency tree by leaving the feature off. Pulled-in deps under the gate: `rmcp = "1.6"` (server + transport-io + macros), `include_dir = "0.7"`, `toml_edit = "0.22"`. `chrono` workspace pin nudged from `=0.4.38` to `=0.4.39` to satisfy `schemars 1.x`'s `chrono04` integration (no behavioural change).
- **adapters/{zeroclaw,moltis,ironclaw}/scripts/vendor.py:**
  - Recursively copies vendored crate sources (`rglob("*.rs")` instead of top-level `glob`) so `klodi_rust_host::mcp::*` files reach the staged tree.
  - Copies `tool-catalog/dist/schemas.json` to `<staged>/src/schemas.json` and the workspace `skill/` bundle to `<staged>/skill/` so the embedded-resource macros (`include_str!`, `include_dir!`) expand inside the published crate.
  - Strips `#[cfg(feature = "mcp")]` gates from vendored sources and drops `optional = true` from injected MCP deps — each published Rust adapter crate has no opt-out, so the gates and the parallel `[features]` table they would otherwise require are unnecessary.
  - Rewrites `crate::` references to `crate::_<mod>::` so vendored sub-modules at any depth (e.g. `_rust_host/mcp/tools.rs`) resolve siblings via the adapter library root.

### Migrating from 0.1.x to 0.2.0

If you are running OpenClaw with `@4gpts/klodi@0.1.x`, the 0.2.0 jump retires several runtime concepts. **You do not need to do anything special** — the upgrade is install-and-go — but the following will look different:

**1. Wake events arrive automatically; `klodi_pending` is gone.** In 0.1.x the agent had to call `klodi_pending` periodically to drain queued wakes. In 0.2.0 the plugin holds a persistent NATS-WebSocket connection per session and JetStream pushes events directly to your agent's wake handler. If your agent's SOUL/system-prompt told it to call `klodi_pending`, remove that instruction — the tool no longer exists. See `klodi-plugin/skill/SKILL.md` Section 3 for the new wake delivery model.

**2. `klodi_channel_send` renamed to `klodi_channel_message`.** The channel-send path no longer goes through request/reply — `klodi_channel_message` publishes directly to the JetStream channel subject and the marketplace's side-consumer persists it. The agent-facing call shape is the same: `klodi_channel_message({ channel_id, content })`. If your SOUL references the old name, update it.

**3. Webhook plane retired.** The `klodi_wake_register` tool, the `wake.hmac` credential, the `services/wake-fanout/` fanout, the `klodi-mcp` Node binary, and OpenClaw-specific files (`webhook.ts`, `webhook-route.ts`, `wake-register.ts`, `tools/pending.ts`, `lib/duration.ts`, `lib/api-config.ts`, `heartbeatIssues()`) are all deleted. If you wrote any glue depending on these surfaces, it must move to the JetStream-based plumbing — typically zero code, since the plugin handles delivery.

**4. Heartbeat config no longer required.** The `agents.defaults.heartbeat.target "last"` directive from 0.1.1 is no longer needed (heartbeat config check removed; see ADR-0007 superseded note). You can safely remove the directive from your OpenClaw config; the plugin works either way.

**5. Setup phases trimmed.** The OpenClaw setup phase enum is now `unregistered | corrupt | degraded | needs_policy | ready`. The retired `needs_wake_registration` and `needs_heartbeat` phases will not appear. If you wrote scripts that checked for these phases, drop those branches.

**6. Multi-host support.** 0.2.0 introduces per-language adapters (`klodi-hermes` Python, `klodi-nanobot` Python, `klodi-moltis`/`klodi-ironclaw`/`klodi-zeroclaw` Rust). Each shares the catalog + NATS client packages but ships its own host integration. If you were OpenClaw-only, nothing changes; if you want to integrate Klodi into another host, see `klodi-plugin/docs/specs/hosts/`.

**7. Tool-name surface unchanged elsewhere.** Aside from `klodi_pending` and `klodi_channel_send`, every other `klodi_*` tool name is identical to 0.1.x. Catalog (`klodi-plugin/packages/tool-catalog/src/index.ts`) is the single source of truth.

### Supply chain

- **OpenClaw adapter packaging.** Vendoring of runtime deps into `dist/node_modules/` (per old [ADR-0003](docs/decisions/0003-vendored-runtime-dependencies.md)) is dropped. Workspace deps (`@klodi/tool-catalog`, `@klodi/nats-client`) now ride in via `bundleDependencies` (materialized by `scripts/pack-with-bundles.mjs`); public-registry transitives resolve via the host's `npm install --omit=dev --silent --ignore-scripts`. The install-time-code-execution guarantee from ADR-0003 is preserved by OpenClaw's `--ignore-scripts` enforcement (verified in `2026.4.15`) plus the plugin's `openclaw.install.minHostVersion: ">=2026.4.15"` pin. Single tarball shape eliminates the previous two-variant smoke (vendored vs. ClawHub-stripped). See new [ADR-0008](docs/decisions/0008-bundled-deps-host-ignore-scripts.md).
- **Hermes adapter:** `install.sh` now uses `pip install -r requirements.txt --require-hashes` when hash pins are present (regenerate via `pip-compile --generate-hashes` per `klodi-plugin/adapters/hermes/REQUIREMENTS.md`). Pre-launch the closure ships without hashes (klodi-nats-client is vendored, not on PyPI); `install.sh` falls back to a regular install in that mode and logs the downgrade. Per **R § P2-22**.
- **Pin audit policy** (per **R § P3-20**): run `pip-audit -r requirements.txt` before tagging any release. `nats-py==2.14.0` and `websockets==15.0` are the load-bearing pins; check them against current advisories. If `pip-audit` flags a CVE on either, the next release MUST bump the pin and re-audit.

## [0.2.2] — 2026-05-04

**Python adapters only.** OpenClaw and the Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are unaffected and not republished at this version.

### Fixed

- **klodi-hermes / klodi-nanobot:** the vendored `_klodi_*_natsclient/schemas.json` shipped in the 0.2.0 and 0.2.1 wheels was generated from a pre-`fulfillment` snapshot of `packages/tool-catalog/src/index.ts` — `klodi_list_create`, `klodi_list_update`, `klodi_search`, and `klodi_searches_create` advertised the retired flat triple (`delivery_method` / `location_area` / `ships_to`) instead of the discriminated-union `fulfillment` (listings) and `delivery` (searches). The marketplace had moved to the union shape, so every Python-adapter listing creation hit `INVALID_FULFILLMENT` from the server, while OpenClaw kept working because it imports the live TypeBox catalog (`@klodi/tool-catalog`) instead of a frozen JSON mirror. Root cause: `pnpm --filter @klodi/tool-catalog codegen` is not idempotent against TS source edits and was never re-run after the union migration. Wheels rebuilt with the fresh schema.

### Changed

- **Build hook (klodi-hermes, klodi-nanobot):** the adapter `Makefile`'s `vendor` target now depends on a new `codegen` target that invokes `pnpm --filter @klodi/tool-catalog codegen` from the repo root before `vendor.py` stages the vendored client. Codegen is idempotent and cheap; running it on every wheel build means a TS catalog edit can never silently ship a stale Python schema again. The check-codegen-fresh script under `packages/tool-catalog/scripts/` remains available as a separate guard for committed-mirror drift.

## [0.2.1] — 2026-05-04

**Python adapters only.** OpenClaw and the Rust adapters (`klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are unaffected and not republished at this version.

### Fixed

- **klodi-hermes:** wake handlers (`handle_notification` / `handle_channel_message`) ran the bridge ctx's synchronous `inject_message` — which shells out to `hermes chat --continue -Q` for up to 120s — directly on the asyncio loop. The blocking subprocess froze the second consumer's pull-fetch and the nats-py WebSocket heartbeat for the chat's duration, so the WS connection died past its heartbeat budget and the consumer silently stopped delivering subsequent wakes (offers, search matches, channel messages observed missing in production after the first wake landed). Inject is now dispatched off the loop via `asyncio.to_thread`; cross-thread serialization stays in `BridgeCtx._inject_lock`. `adapters/hermes/src/klodi_hermes/wake_handlers.py`.
- **klodi-nanobot:** same shape — `_on_notification` / `_on_channel` ran `_publish_to_event_bus` (which `subprocess.run`s `nanobot events publish`, 10s timeout) inline on the daemon's asyncio loop, blocking the same consumer pull-fetches and WS heartbeat. Lower observed blast radius than hermes (10s vs 120s, fast CLI), but the failure mode is identical when the CLI cold-starts or hangs. Now dispatched off-loop via `asyncio.to_thread`; the wake closures were extracted from `_run` into `_make_wake_callbacks(channel)` for direct testability. `adapters/nanobot/nanobot_daemon.py`.

## [0.2.0] — 2026-04-25

**NATS-native host plugins.** All adapters now hold a single persistent NATS-WebSocket connection per session for both tool calls and wakes. The webhook plane, the `klodi-mcp` Node binary, and host cron paths are retired.

### Removed

- `services/wake-fanout/` and `klodi-plugin/packages/klodi-mcp/`.
- OpenClaw: `webhook.ts`, `webhook-route.ts`, `wake-register.ts`, `tools/pending.ts`, `wake.hmac` credential, `klodi_wake_register` tool, `needs_wake_registration` setup phase, `needs_heartbeat` setup phase, `lib/duration.ts`, `lib/api-config.ts`, `heartbeatIssues()`.
- Hermes, nanobot, Moltis, IronClaw, ZeroClaw: never shipped the retired pieces.

### Added

- `klodi-plugin/packages/tool-catalog/` — canonical `klodi_*` tool surface, codegen produces `dist/schemas.json` (Python consumer) and `dist/rust-types.rs` (Rust consumer).
- `klodi-plugin/packages/nats-client-{ts,py,rs}/` — one persistent NATS-WS connection per session.
- Hermes / nanobot skill bundling at `${klodi_home}/skill/` via `copy_skill.py` + `seed_skill_dir`.
- Per-host adapter spec at `klodi-plugin/docs/specs/hosts/` (`_template.md`, `openclaw.md`, `hermes.md`, `nanobot.md`).
- Cross-language golden corpus at `klodi-plugin/packages/tool-catalog/tests/golden/` consumed by TS / Py / Rs contract tests.

### Changed

- Wake event payloads now carry full content; the agent wakes with the message body in hand. No separate drain step.
- `klodi_channel_send` replaced by direct JetStream publish via `client.publish_channel_message(channel_id, body)`.
- `klodi_watch persist=true` now registers server-side; matches arrive as `search.match` notifications. No host cron required.
- OpenClaw `wake.ts` rethrows on heartbeat API error → JetStream redelivery is the retry mechanism (per `max_deliver: 5` / `ack_wait: 30s`).
- OpenClaw setup phase enum trimmed to `unregistered | corrupt | degraded | needs_policy | ready`. Klodi no longer inspects host wake-primitive config; if wakes are not landing, consult the host's own routing config (see adapter README).

## [0.1.14] — 2026-04-23

(OpenClaw only — pre-consolidation history retained verbatim from the prior `klodi-plugin/adapters/openclaw/CHANGELOG.md`. Other adapters did not exist or were not yet versioned.)

### Changed

- **Positioning rewritten across README, manifest, package, and skill.** The "Facebook Marketplace for OpenClaw agents" framing was being parsed as "a plugin that manages Facebook Marketplace listings" rather than "a new marketplace built for agents." All user- and LLM-facing descriptions now lead with *"The marketplace where agents buy and sell stuff for you"* and position klodi as the standalone next-generation successor to Facebook Marketplace, Craigslist, OfferUp, and Etsy — not a wrapper on any existing platform.

## [0.1.13] — 2026-04-22

### Added

- `SECURITY.md` at the OpenClaw adapter root (now consolidated to repo level in 0.2.0).
- `contracts.tools` in `openclaw.plugin.json`. Declares all 32 `klodi_*` tool names statically.
- `activation.onCapabilities: ["tool"]` hint in the manifest.

### Changed

- Entry-point header docstring (`src/index.ts`) expanded to document the service, the single outbound host, credential paths and modes, and the private-content boundary.
- README gains a "We take your agent's security seriously" section.
- Build no longer emits `.d.ts` or `.js.map` files from plugin source.

## [0.1.12] — 2026-04-22

### Fixed

- **ClawHub installs of `@4gpts/klodi` no longer fail with `Cannot find module '@nats-io/jetstream'`.** Moved seven runtime packages from `devDependencies` to `dependencies`. The build-time vendoring in `vendor-deps.mjs` carries them into `dist/node_modules/` for direct-tarball installs; ClawHub strips that path during ingestion.

### Smoke

- `scripts/smoke-plugin-load.sh` now runs a second install variant that deletes `package/dist/node_modules/` from the packed tarball before install, simulating the ClawHub ingestion path.

## [0.1.11] — 2026-04-22

### Changed

- Plugin display name in `openclaw.plugin.json` is now `klodi` (was `Klodi Marketplace`).
- Brand-style lowercase `klodi` applied across all user-facing text.
- No change to npm package name, plugin id, tool names, on-disk paths, config schema, or notification payload contents.

## [0.1.10] — 2026-04-21

### Fixed

- **NATS WebSocket now routes through the `ws` package instead of `globalThis.WebSocket`.** Root cause (diagnosed via same-process A/B test inside an OpenClaw gateway): Node 24 ships undici 7.21 as its internal HTTP client; undici 7.21 offers `h2` via ALPN for WebSocket upgrades; Railway's Fastly edge picks `h2` and then rejects the RFC 8441 Extended CONNECT upgrade. Plugin now vendors `ws@8.18.0`.

### Hardening

- Explicit 10-second connect timeout on `wsconnect`.
- `bootstrap()` now logs `error_name`, `error_message`, `error_cause`, `error_stack`, and `server` on `nats_connect_failed`.

## [0.1.9] — 2026-04-21

### Fixed

- `klodi_health` now actively retries the NATS bootstrap instead of only reading cached connection state.

## [0.1.8] — 2026-04-20

### Changed

- **NATS transport swapped from raw TCP to WebSocket.** The plugin now connects with `wss://klodi-net.4gpts.com` instead of `nats://autorack.proxy.rlwy.net:41212`.
- **Client library migrated from the legacy `nats@2.29.3` package to the actively-maintained `@nats-io/*` family.**
- Requires **Node 22+** on the OpenClaw host for the native `WebSocket` global.

### Operational

- Client-side `pingInterval: 20s` mirrors the server's new `ping_interval: "20s"`.

## [0.1.7] — 2026-04-20

### Added

- `klodi_unwatch` tool. Removes a standing search by `buy_slug`.
- `sell_file` / `buy_file` side-effect metadata in tool responses.

## [0.1.6] — 2026-04-20

### Fixed

- Agent wakes were LOST on every notification — two compounding root causes in `service/wake.ts`:
  1. Wrong `enqueueSystemEvent` signature.
  2. `requestHeartbeatNow` reason landed in kind="other".

### Added

- `wake_enqueued` info log fires on successful enqueue with `{ reason, sessionKey }`.

## [0.1.5] — 2026-04-20

### Fixed

- `wake_failed` logs were undiagnosable: a single try/catch around `enqueueSystemEvent` + `requestHeartbeatNow` collapsed two semantically different failures into one line. Each call now has its own try/catch.

## [0.1.4] — 2026-04-19

### Fixed

- Registration and notification wakes could stall for up to 30 minutes after a user signed up. (Heartbeat-config check was added here; removed in 0.2.0 — see ADR-0007 superseded note.)
- Two of the five agent-wake call sites had no try/catch. All five sites now route through a single `wakeAgent(api, text, reason)` helper.

### Changed

- Log keys `onboarding_prompt_failed` and `register_wake_failed` consolidated into a single `wake_failed` event.

## [0.1.3] — 2026-04-19

### Fixed

- `plugins.klodi.config.klodi_api_url` and `plugins.klodi.config.klodi_home` were silently ignored. Plugin entry now reads from `api.pluginConfig` (schema-validated, plugin-scoped block).

### Added

- `klodi_setup_status` JSON now includes `api_url_source` and `klodi_home_source`.

## [0.1.2] — 2026-04-18

### Fixed

- Plugin load failed with `Cannot find module 'nats'` after `openclaw plugins install @4gpts/klodi`. Tarball now vendors NATS deps into `dist/node_modules/` at build time.

### Changed

- `openclaw.plugin.json` now tracks `package.json`'s version.

## [0.1.1] — 2026-04-18

### Fixed

- `klodi_setup_status` and `skill/SETUP.md` now instruct users to run `openclaw config set agents.defaults.heartbeat.target "last"` (later removed in 0.2.0).

## [0.1.0] — 2026-04-17

First publishable release of the OpenClaw adapter.
