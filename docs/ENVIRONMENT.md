# Environment variable contract

Single source of truth for every environment variable read by the Klodi plugin and its host adapters. Per **D § P2-28**: when env contract is fragmented (OpenClaw uses `klodi_home`/`klodi_api_url` plugin config keys, Hermes uses `KLODI_HOME`/`KLODI_API_URL`, Rust uses `KLODI_HOME`/`KLODI_API_URL`/`KLODI_CREDS`/`KLODI_CONFIG`), drift is inevitable. This doc is the contract — when in doubt, this file wins.

Each row names the var, the owning component, the default (or `(required)`), the validation rule, and the source-of-truth pointer (file:line). When the source moves, update this doc.

---

## Universal — read by every adapter

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `KLODI_HOME` | All adapters | platform-default (see below) | Absolute path; created with mode `0o700` if absent | `klodi-plugin/packages/nats-client-{ts,py,rs}/src/{config,paths}.*` |
| `KLODI_API_URL` | All adapters | `KLODI_DEFAULT_API_URL` (catalog constant: `https://klodi.4gpts.com`) | `https://` URL; localhost forms accepted in dev | catalog: `klodi-plugin/packages/tool-catalog/src/index.ts` |
| `LOG_LEVEL` | All loggers | `INFO` | One of `DEBUG`/`INFO`/`WARN`/`ERROR`; case-insensitive | `klodi-plugin/packages/tool-catalog/src/logging.ts` (contract); `packages/logger-{ts,py,rs}` (consumers) |

**`KLODI_HOME` platform defaults** (from `klodi_nats_client.paths.default_klodi_home()` and equivalents):

| OS | Default |
|----|---------|
| macOS | `~/Library/Application Support/klodi` |
| Linux (with `XDG_CONFIG_HOME`) | `${XDG_CONFIG_HOME}/klodi` |
| Linux (default) | `~/.config/klodi` |
| Windows | `${APPDATA}\klodi` |

`KLODI_HOME` always overrides the platform default. (The XDG choice is `XDG_CONFIG_HOME`, not `XDG_DATA_HOME`, because Klodi's home directory holds configuration and credentials, not bulk user data — the Rust crate, Python client, and OpenClaw lib all converge on this.)

---

## OpenClaw adapter (TypeScript, in-process)

OpenClaw also accepts the universal vars but internally reads them from the plugin config (set via `openclaw plugins config @4gpts/klodi --set klodi_home=...`). The env-var override is honored at runtime via `klodi-plugin/adapters/openclaw/src/lib/paths.ts` (post-Phase 5 split — formerly `lib/config.ts`).

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `KLODI_HOME` | OpenClaw | (plugin config or platform default) | Absolute path | `klodi-plugin/adapters/openclaw/src/lib/paths.ts` |
| `KLODI_API_URL` | OpenClaw | (plugin config or `KLODI_DEFAULT_API_URL`) | `https://` URL | same |

OpenClaw does NOT read `KLODI_CREDS` or `KLODI_CONFIG` — credentials live at `${KLODI_HOME}/nats.creds` and the active config is `${KLODI_HOME}/config.json` (per `adapters/openclaw/src/lib/paths.ts` `getConfigPath`/`getCredsPath`).

---

## Hermes adapter (Python, in-process)

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `KLODI_HOME` | Hermes | platform default | Absolute path | `klodi-plugin/adapters/hermes/local_tools.py` (post-Phase 5 imports `klodi_nats_client.paths.default_klodi_home`) |
| `KLODI_API_URL` | Hermes | `KLODI_DEFAULT_API_URL` | `https://` URL | `klodi-plugin/adapters/hermes/register.py` |
| `XDG_CONFIG_HOME` | Hermes | (OS provides; default `~/.config`) | Absolute path | `klodi-plugin/packages/nats-client-py/src/klodi_nats_client/paths.py` |

---

## Nanobot adapter (Python, in-process)

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `KLODI_HOME` | Nanobot | platform default | Absolute path | `klodi-plugin/adapters/nanobot/nanobot_local_tools.py` (post-Phase 5) |
| `KLODI_API_URL` | Nanobot | `KLODI_DEFAULT_API_URL` | `https://` URL | `klodi-plugin/adapters/nanobot/nanobot_setup_cli.py` |
| `KLODI_NANOBOT_CHANNEL` | Nanobot | (none — required for daemon mode) | Channel ID for which the daemon is wired | `klodi-plugin/adapters/nanobot/nanobot_daemon.py` |

---

## Rust daemon hosts (Moltis / IronClaw / ZeroClaw)

All three hosts share the same env contract via `klodi_rust_host` in `klodi-plugin/packages/klodi-rust-host/`. Per-binary CLI flags (declared via `clap`'s `#[arg(long, env = "...")]`) read these at startup; defaults below match `klodi_rust_host::paths::*`.

**Shared (read by every Rust host binary):**

| Name | Default | Validation | Source |
|------|---------|------------|--------|
| `KLODI_HOME` | platform default | Absolute path | `klodi-plugin/packages/klodi-rust-host/src/paths.rs:klodi_home()` |
| `KLODI_API_URL` | `KLODI_DEFAULT_API_URL` | `https://` URL | `klodi-plugin/packages/klodi-rust-host/src/register.rs` |
| `KLODI_CREDS` | `${KLODI_HOME}/nats.creds` | Absolute path; mode `0o600` (lenient: `mode & 0o077 == 0`) | `klodi-plugin/adapters/{moltis,ironclaw,zeroclaw}/src/bin/{daemon,channel_message}.rs` (clap arg) |
| `KLODI_CONFIG` | `${KLODI_HOME}/config.json` | Absolute path | same — single shared file, no per-host subdir |

**Per-adapter (read only by the named host's daemon):**

| Name | Owner | Required | Purpose |
|------|-------|----------|---------|
| `MOLTIS_WAKE_URL` | Moltis | yes (no default) | URL the daemon POSTs wakes to (e.g. `http://127.0.0.1:5000/agents/default/wake`) |
| `MOLTIS_AGENT_TOKEN` | Moltis | yes | Bearer token; sent as `Authorization: Bearer <token>` |
| `MOLTIS_HEALTH_PORT` | Moltis | no | Optional. When non-zero, daemon exposes `/healthz` + `/metrics` on this TCP port |
| `IRONCLAW_EVENT_URL` | IronClaw | yes (no default) | URL the daemon POSTs wakes to |
| `IRONCLAW_AGENT_TOKEN` | IronClaw | yes | Bearer token |
| `IRONCLAW_HEALTH_PORT` | IronClaw | no | Same as Moltis |
| `ZEROCLAW_WEBHOOK_URL` | ZeroClaw | no — defaults to `http://127.0.0.1:7070/webhook` | URL the daemon POSTs wakes to (ZeroClaw 0.7.4's `/webhook` route) |
| `ZEROCLAW_PAIR_URL` | ZeroClaw | no — derived from `ZEROCLAW_WEBHOOK_URL` by replacing `/webhook` with `/pair` | Override only when the gateway exposes `/pair` at a non-canonical path |
| `ZEROCLAW_AGENT_TOKEN` | ZeroClaw | one of: env, cached token, or sidecar pairing-code at `${KLODI_HOME}/zeroclaw.pairing-code` | Bearer token (`zc_<hex>` minted by ZeroClaw's `/pair`) |
| `ZEROCLAW_HEALTH_PORT` | ZeroClaw | no | Same as Moltis |

Source for per-adapter vars: `klodi-plugin/adapters/{moltis,ironclaw,zeroclaw}/src/bin/daemon.rs` `Cli` struct.

**Daemon CLI flags** (not env vars but worth co-locating):

| Flag | Default | Purpose |
|------|---------|---------|
| `--health-port` | `0` (off) | When non-zero, daemon exposes `/healthz` (200/503) and `/metrics` (Prometheus) on this TCP port |

---

## Marketplace service

The marketplace is configured via `services/marketplace/src/env.ts`. See that file for the authoritative validation logic; this table summarizes.

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `DATABASE_URL` | Marketplace | (required) | Postgres URL | `services/marketplace/src/env.ts` |
| `NATS_URL` | Marketplace | (required) | NATS URL (`nats://`/`tls://`/`ws://`/`wss://`) | same |
| `NATS_TOKEN` | Marketplace | none | String | same |
| `NATS_CREDS_PATH` | Marketplace | none | Absolute path | same |
| `NATS_QUEUE_GROUP` | Marketplace | `marketplace` | String | same |
| `AUTH_MODE` | Marketplace | (required) | `header` (dev only) or `nats-jwt` (prod) | same |
| `R2_ACCOUNT_ID` | Marketplace | (required) | String | same |
| `R2_ACCESS_KEY_ID` | Marketplace | (required) | String | same |
| `R2_SECRET_ACCESS_KEY` | Marketplace | (required) | String | same |
| `R2_BUCKET_NAME` | Marketplace | (required) | String | same |
| `R2_PUBLIC_URL` | Marketplace | (required) | URL | same |
| `WEB_URL` | Marketplace | (required) | URL | same |
| `UPLOAD_URL_TTL_SECONDS` | Marketplace | `900` (15min) | Integer | same |
| `MAX_PHOTOS_PER_LISTING` | Marketplace | `10` | Integer | same |
| `MAX_PHOTO_SIZE_BYTES` | Marketplace | `10485760` (10MB) | Integer | same |
| `DEFAULT_EXPIRES_HOURS` | Marketplace | `1440` (60d) | Integer | same |
| `CHANNEL_EXPIRY_DAYS` | Marketplace | `60` | Integer | same |
| `PG_CONNECTION_TIMEOUT_MS` | Marketplace | `5000` | Integer | same |
| `SHUTDOWN_TIMEOUT_MS` | Marketplace | `10000` | Integer | same |
| `CHANNEL_FILTER_RECONCILER_MS` | Marketplace | `30000` | Integer | same |
| `USER_CONSUMER_RECONCILER_MS` | Marketplace | `300000` (5min) | Integer | same |
| `STANDING_SEARCH_MAX_PER_USER` | Marketplace | `50` | Integer | same |
| `NOTIFICATION_WORKER_TEAM_SIZE` | Marketplace | `4` | Integer (pg-boss concurrency) | same |
| `SIDE_CONSUMER_VIOLATION_THRESHOLD` | Marketplace | `3` | Integer (per-user; ERROR when crossed) | `services/marketplace/src/channels-stream-consumer.ts` |
| `SIDE_CONSUMER_VIOLATION_WINDOW_MS` | Marketplace | `3600000` (1h) | Integer (rolling window) | same |
| `NODE_ENV` | Marketplace | (none) | `production` enforces `AUTH_MODE=nats-jwt` | `services/marketplace/src/env.ts` |

---

## Web app (`apps/web`)

The web app reads Auth0 + NATS-account credentials for the per-user JWT mint endpoint. Config is split across `apps/web/src/lib/auth0.ts`, `apps/web/src/lib/nats-creds.ts`, and `apps/web/src/lib/db.ts`.

| Name | Owner | Default | Validation | Source |
|------|-------|---------|------------|--------|
| `AUTH0_BASE_URL` | Web | (required) | URL | `apps/web/src/lib/auth0.ts` |
| `AUTH0_ISSUER_BASE_URL` | Web | (required) | URL | same |
| `AUTH0_CLIENT_ID` | Web | (required) | String | same |
| `AUTH0_CLIENT_SECRET` | Web | (required) | String (secret) | same |
| `AUTH0_SECRET` | Web | (required) | String (cookie-encryption secret) | same |
| `AUTH0_MANAGEMENT_CLIENT_ID` | Web | (required) | String (Auth0 Management API client) | same |
| `AUTH0_MANAGEMENT_CLIENT_SECRET` | Web | (required) | String (secret) | same |
| `NATS_SERVER_URL` | Web | (required) | NATS URL | `apps/web/src/lib/nats-creds.ts` |
| `NATS_ACCOUNT_PUBLIC_KEY` | Web | (required) | NKey public account | same |
| `NATS_ACCOUNT_SIGNING_KEY` | Web | (required) | NKey seed (secret) | same |
| `DATABASE_URL` | Web | (required) | Postgres URL | `apps/web/src/lib/db.ts` |
| `R2_*` | Web | (required) | (mirrors Marketplace) | various |

---

## Test / CI environment

These are not deployment vars; they configure tests.

| Name | Owner | Default | Purpose |
|------|-------|---------|---------|
| `INTEGRATION` | Tests | unset | Set to `1` to enable integration tests (otherwise skipped) |
| `TEST_NATS_URL` | Tests | `ws://localhost:8080` | Override NATS endpoint for tests (read by `tests/integration/cross-language-wire.test.ts` + orchestrator) |
| `TEST_NATS_WS_URL` | Tests | `ws://localhost:8080` | Legacy alias used by some Python/Rust tests; prefer `TEST_NATS_URL` |
| `STRICT_ADAPTER_TOOLS` | CI gate | unset | Set to `1` to make `klodi-plugin/scripts/check-adapter-tools.sh` fail on missing local-tool implementations (default behavior is warn-only) |

---

## Deprecated / removed

| Name | Removed in | Replacement |
|------|------------|-------------|
| `KLODI_LOG_PAYLOADS` | Phase 4 | Use `LOG_LEVEL=DEBUG` (KlodiLogger redacts at INFO and below) |
| `KLODI_PLUGIN_REPO_URL` | Phase 3 | Hardcoded official URL in `klodi-plugin/adapters/hermes/install.sh` |
| `ZEROCLAW_HOOKS_WAKE_URL` | klodi-zeroclaw 0.2.4 | Renamed to `ZEROCLAW_WEBHOOK_URL` when ZeroClaw 0.7.4 retired the `/hooks/wake` route in favor of `/webhook`. Update env in lockstep with the version bump. |

---

## Adding a new env var

Before adding a new var:
1. Check whether a catalog constant could replace it (`klodi-plugin/packages/tool-catalog/src/index.ts`). The catalog wins for cross-language values that are part of the contract.
2. If it must be an env var, document it here in the same edit that adds the read.
3. Validate at boundaries; fail fast on missing required.
4. No silent string fallbacks — explicit defaults only.
5. Update `services/marketplace/src/env.ts` if it's a marketplace var (the central env loader).
