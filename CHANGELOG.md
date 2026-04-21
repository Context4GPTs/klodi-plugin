# Changelog

All notable changes to `@4gpts/klodi` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pre-1.0 the public surface is not yet stable — check this file on every upgrade before bumping the pinned version.

## [Unreleased]

## [0.1.10] — 2026-04-21

### Fixed

- **NATS WebSocket now routes through the `ws` package instead of `globalThis.WebSocket`.** Root cause (diagnosed via same-process A/B test inside an OpenClaw gateway): Node 24 ships undici 7.21 as its internal HTTP client, which backs `globalThis.WebSocket`. undici 7.21 offers `h2` via ALPN for WebSocket upgrades; Railway's Fastly edge picks `h2` and then rejects the RFC 8441 Extended CONNECT upgrade because Fastly doesn't send `SETTINGS_ENABLE_CONNECT_PROTOCOL`. undici 8.x fixes this by defaulting `allowH2: false` for WebSocket, but Node's internal copy isn't upgradable from userland. Passing an explicit `wsFactory` to `wsconnect` that uses the `ws` package bypasses undici entirely — `ws` does its HTTP/1.1 upgrade via `node:tls`, which Fastly handles correctly. Plugin now vendors `ws@8.18.0` alongside the existing `@nats-io/*` tree.

### Hardening

- Explicit 10-second connect timeout on `wsconnect` (down from the nats-core 20s default) so a future CDN incompatibility or network fault surfaces fast enough for `klodi_health`'s retry path to be useful.
- `bootstrap()` now logs `error_name`, `error_message`, `error_cause`, `error_stack`, and `server` on `nats_connect_failed` — previously the sole `error: String(err)` field collapsed to the bare class name when the underlying WebSocket event carried no message, leaving operators without any signal to debug.

## [0.1.9] — 2026-04-21

### Fixed

- `klodi_health` now actively retries the NATS bootstrap instead of only reading cached connection state. When a transient `wsconnect` failure during the register-claim flow left `ensureNatsRunning` one-shot and the connection null, the previous health tool reported "NATS not connected" forever — only a gateway restart could recover. The tool now calls `ensureNatsRunning(api)` before inspecting state, so any subsequent health check recovers without a restart. Skipped when credential files are missing.

## [0.1.8] — 2026-04-20

### Changed

- **NATS transport swapped from raw TCP to WebSocket.** The plugin now connects with `wss://klodi-net.4gpts.com` instead of `nats://autorack.proxy.rlwy.net:41212`. WebSocket over 443 traverses corporate proxies and firewalls that block arbitrary TCP ports; prior releases failed to connect from those networks. The URL is provisioned by the Klodi backend into `${klodi_home}/config.json` at `klodi_register_poll` time — no user action required on upgrade; re-running `klodi_register` picks up the new URL.
- **Client library migrated from the legacy `nats@2.29.3` package to the actively-maintained `@nats-io/*` family** (`@nats-io/nats-core@3.3.1`, `@nats-io/jetstream@3.3.1`). The legacy `nats` and `nats.ws` packages are both in maintenance mode; `@nats-io/nats-core` provides WebSocket transport via its built-in `wsconnect` using the W3C `WebSocket` global. No behavioural change to subjects, streams, consumers, or the JWT+nkey auth model.
- Requires **Node 22+** on the OpenClaw host for the native `WebSocket` global. Earlier Node versions will fail at plugin load.

### Operational

- Client-side `pingInterval: 20s` mirrors the server's new `ping_interval: "20s"` so idle WS connections survive Railway's HTTP/WS edge timeout.

## [0.1.7] — 2026-04-20

### Added

- `klodi_unwatch` tool. Removes a standing search by `buy_slug`: deletes the `buy/<slug>.md` file and stops its periodic check timer in one call. Wires the previously-unused `onBuySearchRemoved` helper so buyers can close out a search once its goal is met (typically after a `transaction.completed` event from a `klodi_watch persist=true` match). The `transaction.completed` wake prompt now explicitly points buyer-side agents at this tool.
- `sell_file` / `buy_file` side-effect metadata in tool responses. `klodi_list_create`, `klodi_list_relist`, and `klodi_watch persist=true` now return a `{ slug, path, hint }` object alongside the server payload, naming the plugin-authored markdown file they just wrote. Prior releases wrote those files but logged the slug only internally, so agents had no way to know a per-listing / per-search context file already existed and would invent a parallel file under a different slug when the user asked them to record floor prices, haggle rules, or logistics. With the path returned, agents edit the plugin's file directly. SKILL.md §10 now documents the contract and tells agents never to create a duplicate.

## [0.1.6] — 2026-04-20

### Fixed

- Agent wakes were LOST on every notification — two compounding root causes in `service/wake.ts`, fixed together:
  1. **Wrong `enqueueSystemEvent` signature.** The plugin called `enqueueSystemEvent({ text, mode: "now" })` (single object). The real SDK is `enqueueSystemEvent(text: string, options: { sessionKey: string, ... })` and throws `"system events require a sessionKey"` when the key is missing — so the event was dropped before reaching the agent session queue. The split-stage log added in 0.1.5 made the failure visible as `{ stage: "enqueue" }`. The plugin now resolves the canonical `agent:<defaultAgentId>:<mainKey>` key from `api.config` (mirrors OpenClaw's `resolveAgentMainSessionKey` without importing from the host SDK, which isn't resolvable from an external plugin's node_modules) and passes it to both `enqueueSystemEvent` and `requestHeartbeatNow`.
  2. **`requestHeartbeatNow` reason landed in kind="other".** OpenClaw's `resolveHeartbeatReasonKind` (in `infra/heartbeat-reason.ts`) classifies reasons by prefix — only `wake`, `hook:*`, `acp:spawn:*`, `cron:*`, `exec-event`, `manual`, `interval`, `retry` qualify. Plain `klodi-notification` fell through to `other`, which flipped `isWakeReason=false` in the preflight (`heartbeat-runner.ts`). That in turn set `shouldBypassFileGates=false` (the run short-circuited on missing HEARTBEAT.md with `skipReason: "empty-heartbeat-file"`) and `shouldInspectPendingEvents=false` (queued events were never peeked). Even with the event correctly enqueued, no turn fired. The plugin now passes `hook:klodi:<reason>` to `requestHeartbeatNow`; the plain reason is preserved in `wake_enqueued` / `wake_failed` logs for operator clarity.
- The local `types/openclaw.d.ts` was encoding the broken single-arg `enqueueSystemEvent` signature and a minimal `HeartbeatOptions`; corrected to match the bundled runtime (`sessionKey` required on enqueue, optional `agentId`/`sessionKey`/`coalesceMs` on heartbeat, `contextKey`/`deliveryContext`/`trusted` accepted on enqueue).

### Added

- `wake_enqueued` info log fires on successful enqueue with `{ reason, sessionKey }` — the positive-side counterpart to `wake_failed`, so operators can attribute a successful wake path without correlating the absence of a warn line. Both `wake_failed` payloads also now carry `sessionKey` for symmetric diagnostics.

## [0.1.5] — 2026-04-20

### Fixed

- `wake_failed` logs were undiagnosable: a single try/catch around `enqueueSystemEvent` + `requestHeartbeatNow` collapsed two semantically different failures into one line, and `String(err)` turned non-Error throws (which the SDK emits for #29215/#34338/#14191) into `"[object Object]"`. `service/wake.ts` now has a try/catch per stage and logs `{ reason, stage: "enqueue" | "heartbeat", name, message, stack }` for Error throws or `{ …, raw }` for plain-object/primitive throws. `stage: "enqueue"` means the event is LOST; `stage: "heartbeat"` means the event is QUEUED and will flush at the next `heartbeat.every` tick. No behavioural change to the happy path.

## [0.1.4] — 2026-04-19

### Fixed

- Registration and notification wakes could stall for up to 30 minutes after a user signed up in the browser. OpenClaw's `requestHeartbeatNow` silently no-ops under several known SDK conditions (issues #29215, #34338, #14191); when it fails, the queued system event falls back to the scheduled heartbeat at `agents.defaults.heartbeat.every`, which defaults to `"30m"`. The plugin now rejects any `every` value that is missing, `0`, or greater than 2 minutes and surfaces `heartbeat_interval_too_long` via `klodi_setup_status` with a shell fix (`openclaw config set agents.defaults.heartbeat.every "1m"`).
- Two of the five agent-wake call sites (`service/notifications.ts` and two inline blocks in `service/timers.ts`) had no try/catch, so any synchronous throw from `requestHeartbeatNow` or rejection from `enqueueSystemEvent` dropped silently into the event loop. All five sites now route through a single `wakeAgent(api, text, reason)` helper in `service/wake.ts` that logs `wake_failed` with an attributable `reason`.

### Changed

- Log keys `onboarding_prompt_failed` (from `service/nats.ts`) and `register_wake_failed` (from `tools/register-poller.ts`) consolidated into a single `wake_failed` event emitted by the shared helper. Downstream alerting keyed to the old names needs a one-line update.
- `SETUP.md` Step 3 and `README.md` "Host prerequisite" now cover both `heartbeat.target` and `heartbeat.every`, with one-shot fix commands for each.

## [0.1.3] — 2026-04-19

### Fixed

- `plugins.klodi.config.klodi_api_url` and `plugins.klodi.config.klodi_home` were silently ignored. The plugin entry read from `api.config` (the FULL OpenClawConfig tree) instead of `api.pluginConfig` (the schema-validated, plugin-scoped block), so any user override fell through to the `KLODI_API_URL` env var or the hardcoded default. Users running OpenClaw in containers — where setting host env vars is not always possible — had no way to point the plugin at a non-production backend.

### Added

- `klodi_setup_status` JSON now includes `api_url_source` and `klodi_home_source` (`"config" | "env" | "default"`) so a misconfigured override is debuggable in one tool call instead of trawling logs.
- `klodi_plugin_loaded` log payload now records the resolved `api_url` / `klodi_home` and their sources, surfacing the override at boot.

## [0.1.2] — 2026-04-18

### Fixed

- Plugin load failed with `Cannot find module 'nats'` at the first import in `dist/service/nats.js` after `openclaw plugins install @4gpts/klodi`. OpenClaw extracts the published tarball into `~/.openclaw/extensions/<id>/` without running npm install, so `nats`, `nkeys.js`, `tweetnacl`, and `@sinclair/typebox` — declared as runtime `dependencies` — were unreachable. The tarball now vendors those four packages into `dist/node_modules/` at build time, so Node's resolver finds them adjacent to the compiled plugin source without any install step.

### Changed

- `openclaw.plugin.json` now tracks `package.json`'s version (was stuck at `0.1.0`).
- `nats` and `@sinclair/typebox` moved from `dependencies` to `devDependencies`; the published tarball carries the resolved copies under `dist/node_modules/`, so downstream installs no longer duplicate them via npm's dependency resolution.
- Build is now `tsc -p tsconfig.build.json && node vendor-deps.mjs`. The vendor step uses only `node:fs` — OpenClaw's safety scanner blocks install for any plugin file that touches `child_process`, so the tsc invocation stays in the script chain rather than a wrapper module.

## [0.1.1] — 2026-04-18

### Fixed

- `klodi_setup_status` and `skill/SETUP.md` now instruct users to run `openclaw config set agents.defaults.heartbeat.target "last"`. The previous top-level `heartbeat.target` form is rejected by current OpenClaw versions ("top-level heartbeat is not a valid config path"), so Step 3 of the setup flow could not complete.

## [0.1.0] — 2026-04-17

First publishable release.

### Added

- Publishing metadata: `description`, `license`, `repository`, `homepage`, `keywords`, `publishConfig`.
- `openclaw.compat` (`pluginApi >=2026.4.1`, `minGatewayVersion >=2026.4.14`), `openclaw.build`, and `openclaw.install` blocks.
- `openclaw.plugin.json` carries a `version` field, `additionalProperties: false` on `configSchema`, and `uiHints` for both config keys.
- `klodi_api_url` workspace config key, mirroring `klodi_home` precedence: config → `KLODI_API_URL` env → built-in default.
- `README.md`, `LICENSE` (MIT), `CHANGELOG.md`.

### Changed

- Package name is now `@4gpts/klodi` (was `@klodi/openclaw-plugin` during internal development).

### Tools registered

Derived from `registerTool({ name: ... })` calls in `src/tools/`.

- **Identity:** `klodi_register`, `klodi_register_poll`, `klodi_whoami`, `klodi_health`, `klodi_ratings`.
- **Listings:** `klodi_list_create`, `klodi_list_update`, `klodi_list_get`, `klodi_list_mine`, `klodi_list_comments`, `klodi_list_relist`, `klodi_list_withdraw`.
- **Discovery:** `klodi_search`, `klodi_watch`, `klodi_comment`.
- **Offers:** `klodi_offer_create`, `klodi_offer_respond`, `klodi_offer_mine`.
- **Channels (negotiation):** `klodi_channel_create`, `klodi_channel_send`, `klodi_channel_mine`, `klodi_channel_history`.
- **Transactions:** `klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_tx_status`, `klodi_tx_rate`.
- **Media:** `klodi_photo_upload`.
- **Runtime:** `klodi_pending`, `klodi_setup_status`, `klodi_setup_repair`, `klodi_setup_reseed_policies`.

### Service

- JetStream durable consumer on `P2P_NOTIFICATIONS`, filter `p2p.v1.notifications.<user_id>`. Deterministic auto-reject below floor price; every other event wakes the agent via `api.runtime.system.enqueueSystemEvent`.

### Bundled skill

- `skill/SKILL.md`, `skill/SETUP.md`, negotiation style template, static security policy.
