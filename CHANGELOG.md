# Changelog

All notable changes to klodi-plugin (every adapter — `@4gpts/klodi` for OpenClaw, `klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All adapters move together — they share a single version line. Pre-1.0 the public surface is not yet stable — check this file on every upgrade before bumping the pinned version.

## [Unreleased]

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

## [0.2.0] — 2026-04-25

**0012 — NATS-native host plugins.** All adapters now hold a single persistent NATS-WebSocket connection per session for both tool calls and wakes. The webhook plane, the `klodi-mcp` Node binary, and host cron paths are retired. References: `docs/plans/0012-nats-native-host-plugins.md`, `../docs/reviews/2026-04-25-0012-first-pass-review.md`.

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
