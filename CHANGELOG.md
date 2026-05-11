# Changelog

All notable changes to klodi-plugin (every adapter — `@4gpts/klodi` for OpenClaw, `klodi-hermes`, `klodi-nanobot`, `klodi-moltis`, `klodi-ironclaw`, `klodi-zeroclaw`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All adapters move together — they share a single version line. Pre-1.0 the public surface is not yet stable — check this file on every upgrade before bumping the pinned version.

## [Unreleased]

### Added (`klodi-zeroclaw` 0.2.9)

> Targets `klodi-zeroclaw 0.2.9`. OpenClaw, the Python adapters
> (klodi-hermes, klodi-nanobot), and the other Rust adapters
> (klodi-moltis, klodi-ironclaw) are unaffected and not republished
> at this version.

The operator-visibility follow-up to the wake-routing changes that shipped in 0.2.6. Notifications and approval prompts now reach every surface the operator might be looking at (dashboard + dedicated klodi session + any operator-configured upstream channels like Telegram/Slack/email).

- **`OperatorChannel` trait + `ChannelRegistry`** in `klodi_rust_host::channels`. Trait mirrors upstream's `(channel_id, recipient, message)` shape so a future host (Hermes, Moltis) can plug new channel types in without touching the dispatch loop. Three implementations land in 0.2.9:
  - `DashboardChannel` — klodi-owned WebSocket transport against `/ws/chat`. Uses the T3 active-session heuristic (most-recent session in `/api/sessions` whose latest message has `role=user` and that isn't in the created-sessions ledger) to find where the operator is currently typing.
  - `DedicatedSessionChannel` — adapter exposing the existing dedicated klodi session as an `OperatorChannel` so registry-driven fan-out treats every surface uniformly.
  - `UpstreamChannel` — delegating wrapper over `zeroclaw channel send <message> --channel-id <id> --recipient <r>`. Klodi does NOT re-implement Telegram/Slack/Discord/etc. clients; upstream's `[reliability]` config owns retry/backoff per medium.
- **`ChannelInvoker::Shell`** (`klodi_rust_host::channels::invoker`) — the transport `UpstreamChannel` wraps. 0.2.9 shells out to the `zeroclaw` CLI (same dependency as the pairing-helper auto-mint). Future variants (`Library`, `Rest`) land here when upstream exposes a stable Rust or REST surface.
- **`${KLODI_HOME}/klodi.toml` `[notifications]` block** — operator-side channel wiring. Missing file = defaults (dashboard auto-active-session enabled, dedicated session always-on, no upstream channels). Schema:
  ```toml
  [notifications]
  batch_window_seconds = 5

  [notifications.dashboard]
  enabled = true
  recipient = "auto"            # T3 active-session
  severity_floor = "operator_important"

  [notifications.dedicated_session]
  enabled = true
  severity_floor = "diagnostic" # see everything

  [[notifications.upstream]]
  channel_id = "telegram"       # MUST be in `zeroclaw channel list`
  recipient = "123456789"
  severity_floor = "approval_request"
  ```
  Upstream channel ids are validated against `GET /api/channels` at daemon startup — unknown ids surface as `klodi_zeroclaw_upstream_channel_unknown` warn logs and are skipped (operator runs `zeroclaw onboard channels` to register the channel, then restarts the daemon).
- **Approval prompts fan out across every enabled channel.** Plugin-gated tools (`klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_list_withdraw`) post the prompt to dashboard + dedicated session + every configured upstream channel. The operator can reply via the dashboard (`/klodi yes:<reqId>` or a bare `yes` within 60s) OR the dedicated klodi session — whichever reply lands first releases the gate. Upstream channels are notification-only in 0.2.9; an operator paged on Telegram must release the gate via dashboard or dedicated session.
- **`/klodi` dashboard reply prefix + bare-affirmation window.** The dashboard channel's polling reply bridge recognises:
  - `/klodi yes:<reqId>` / `/klodi no:<reqId>` — explicit verb + correlation. Both case-insensitive on the `/klodi` prefix.
  - Bare `yes` / `no` / `approve` / `deny` / `confirm` / `cancel` within 60s of an open notification (vocabulary refined via real-use feedback).
- **`klodi_report_to_operator` routes through the registry** when one is configured. The tool now appears on every enabled surface, not just the dedicated session. Severity → channel mapping:

  | Severity | Dashboard | Dedicated session | Upstream |
  |----------|-----------|-------------------|----------|
  | ApprovalRequest | dispatch | dispatch | dispatch |
  | OperatorImportant | dispatch | dispatch | dispatch |
  | Operator | drop | dispatch | drop |
  | Diagnostic | drop | dispatch | drop |
- **Stale-session detection (T5).** Before writing to a destination the channel expects non-empty, `GET /api/sessions` verifies membership AND `message_count > 0`. On detection: log `klodi_zeroclaw_session_resurrection_detected`, record the old id in the created-sessions ledger, post a one-line "🔁 klodi notice — this dashboard session was recreated" breadcrumb in the resurrected session, re-resolve via T3.
- **New artifacts under `${KLODI_HOME}`** (all mode 0600):
  - `zeroclaw.dispatcher_cursor.json` — per-session last-processed-message index for the dashboard reply bridge. Survives daemon restarts.
  - `zeroclaw.created_sessions` — JSON list of session ids klodi has ever written to. Excluded from T3 candidates so klodi never picks its own session as "where the operator is."
  - `approvals/<request_id>.reply.json` — captured operator reply per approval. Written by the daemon's reply-attribution task; read by the MCP server's approval gate when the agent retries without explicit text.
- **Severity-driven dispatch with per-channel filters + batching window.** Each registered channel has a `severity_floor` and optional `event_filter`. The registry's batching window (default 5s, configurable via `klodi.toml`) drops subsequent notifications of the same `event_kind` within the window for the dashboard + upstream surfaces; `ApprovalRequest` bypasses batching unconditionally; the dedicated klodi session sees everything regardless (severity floor = `diagnostic` by default).

### Changed (`klodi-zeroclaw` 0.2.9)

- **`klodi_rust_host::mcp::handler::OperatorChannel` (struct) → `KlodiSessionTarget`** (public API break for out-of-tree consumers of `klodi_rust_host`). The name was reclaimed by the new `klodi_rust_host::channels::OperatorChannel` trait — the renamed struct names what it always was (the dedicated klodi session binding). Internal callers (zeroclaw bin, mcp tools) updated. Out-of-tree consumers should swap `use klodi_rust_host::mcp::OperatorChannel` → `use klodi_rust_host::mcp::KlodiSessionTarget`.
- **Bootstrap-note copy** now lists the multi-surface model — heartbeat surfaces the count of configured channels; the bootstrap note explains that notifications appear in dashboard + dedicated session + each configured upstream channel.

### Migrating from 0.2.8 to 0.2.9 (klodi-zeroclaw operators only)

Drop-in for the default case. The dashboard channel layers on top of the existing dedicated session; default `klodi.toml` is "no file" = sensible defaults.

For operators who want the v0.2.8 single-surface behaviour (dedicated session only): set `notifications.dashboard.enabled = false` in `${KLODI_HOME}/klodi.toml` (file may not yet exist — create it).

For operators who want to receive notifications on Telegram / Slack / email / etc.:
1. Run `zeroclaw onboard channels` (interactive upstream tooling) to register the channel.
2. Add a `[[notifications.upstream]]` block to `${KLODI_HOME}/klodi.toml`:
   ```toml
   [[notifications.upstream]]
   channel_id = "telegram"
   recipient = "123456789"
   severity_floor = "approval_request"  # only approvals
   ```
3. Restart `klodi-zeroclaw-daemon`. The daemon validates the channel id against `GET /api/channels` at startup — typos surface as `klodi_zeroclaw_upstream_channel_unknown` warn logs.

Reply mechanism: the operator can release approval gates from the dashboard (`/klodi yes:<reqId>`) OR the dedicated klodi session (same as v0.2.8 — agent reads the reply inline). Upstream channels are outbound-only in 0.2.9; an operator paged on Telegram must release the gate via dashboard or dedicated session.

## [0.2.8] — 2026-05-10

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

This release closes the dashboard pairing-friction gap. Operators on the canonical "cargo install + run daemon" deployment now go from `klodi-zeroclaw-register` straight to a working dashboard with a single ⌘V + Enter, without `docker exec` or hunting for the gateway's startup pairing code in container logs.

### Added

- **Auto-mint daemon pairing.** When no `ZEROCLAW_AGENT_TOKEN`, no cached `${KLODI_HOME}/zeroclaw.token`, and no sidecar `${KLODI_HOME}/zeroclaw.pairing-code` are present, the daemon now mints its own pairing code by invoking `zeroclaw gateway get-paircode --new` on `PATH` and POSTs it to `/pair` itself. The minted bearer is cached as before. First-boot is zero-touch: the operator no longer has to find the gateway's startup pairing code printed in container logs and write it to a file. Sidecar codes still take precedence — operators who control re-pair flow manually keep the existing semantics.

- **Loopback browser-pairing helper.** `klodi-zeroclaw-daemon` 0.2.8 binds a small HTTP/1.1 server on `127.0.0.1:<port>` (default port 0 = OS-picked ephemeral). Hitting `/` mints a fresh pairing code via the same gateway CLI, renders an HTML page that copies the code to clipboard, and redirects to the gateway dashboard URL. The dashboard's "PAIRING REQUIRED" prompt becomes a single ⌘V + Enter. Codes are minted on every page hit so reloads always produce fresh codes (codes expire ≈60s server-side). The shim's URL is surfaced through three channels:
  - **Heartbeat in the operator's chat session** — the existing one-line `🟢 klodi daemon connected as @…` heartbeat now carries `Browser pairing: <url>` when the helper is running.
  - **Boxed stdout block** at daemon startup with the URL and a freshly-minted code (so even non-interactive deployments see it in logs).
  - **Auto-launch** of the operator's browser at the URL when stdout is a tty (override via `--open-browser={auto,always,never}` / `ZEROCLAW_OPEN_BROWSER`).

  The shim's threat model: loopback bind only (hardcoded 127.0.0.1, never widened by CLI), `Host:` header validation against `127.0.0.1:<port>` / `localhost:<port>` literals (DNS-rebinding defense), `Cache-Control: no-store` + `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff` headers, HTML-safe JSON encoding inside the inline `<script>` (`<` / `>` / `&` rewritten as `\uXXXX` so a hostile dashboard URL can't break out of the script element). Per the repo's `SECURITY.md` trust model, the workstation owner is the trust anchor — local processes running as the operator are inside the boundary, so no PIN / CSRF token is added.

- **New CLI flags on `klodi-zeroclaw-daemon`.** All env-var-backed:
  - `--zeroclaw-cli` (`ZEROCLAW_CLI`, default `zeroclaw`) — path to the gateway CLI used by auto-mint and the shim. When unreachable, both auto-disable and the daemon falls back to the 0.2.7 bearer-resolve flow.
  - `--no-browser-pair-shim` (`ZEROCLAW_BROWSER_PAIR_DISABLE`) — opt out of auto-mint + shim entirely. Use for non-canonical deployments or to keep behaviour identical to 0.2.7.
  - `--browser-pair-shim-port` (`ZEROCLAW_BROWSER_PAIR_PORT`, default `0`) — pin a specific loopback port; default is OS-picked ephemeral.
  - `--zeroclaw-dashboard-url` (`ZEROCLAW_DASHBOARD_URL`) — override the dashboard URL surfaced to the operator. Default: derived from `--zeroclaw-webhook-url` by stripping `/webhook`. Set this when the daemon runs in a container with port-mapped access from the host (e.g. `http://localhost:18793`).
  - `--open-browser={auto,always,never}` (`ZEROCLAW_OPEN_BROWSER`, default `auto`) — controls the OS-native browser launch. `auto` honours tty detection (interactive run = on, systemd / docker compose = off).

### Removed

- **`--legacy-webhook` / `ZEROCLAW_LEGACY_WEBHOOK` (and `BodyShape::MessageWrapped`).** The pre-0.2.6 wake-delivery path that POSTed each event to ZeroClaw's `/webhook` was deprecated in 0.2.6 when wakes moved to `/ws/chat`, retained as a fallback in 0.2.5–0.2.7, and is now removed entirely. Audit confirmed no deployment was setting the flag — every supported gateway (≥ 0.7.4) exposes `/ws/chat`, and the legacy path was unusable in practice on real klodi turns (gateway's hard 30s `TimeoutLayer` vs. typical 60s+ agent turns). Operators on a hypothetical pre-0.7.4 ZeroClaw build that doesn't expose `/ws/chat` would have to stay on klodi-zeroclaw 0.2.7. Touched files: `packages/klodi-rust-host/src/forwarder.rs` (variant + match arms + a now-dead test), `adapters/zeroclaw/src/bin/daemon.rs` (CLI flag, env var, branch, `LEGACY_WAKE_POST_TIMEOUT` constant).

### Migrating from 0.2.7 to 0.2.8 (klodi-zeroclaw operators only)

Drop-in replacement for any operator who was on the canonical `/ws/chat` path (the default in 0.2.6+). Rebuild the daemon (`cargo install klodi-zeroclaw` or pull the new container image) and restart. On first boot after the bump:

1. If the gateway CLI is on `PATH` (canonical deployment), the daemon auto-mints + caches its own bearer when no other source is configured. Existing cached tokens / sidecar pairing-code files / `ZEROCLAW_AGENT_TOKEN` continue to work and take precedence.
2. The loopback shim binds on an ephemeral port; its URL appears in the heartbeat in chat, in a boxed stdout block, and (if running interactively) opens automatically in the operator's browser.
3. To keep auto-pair behaviour disabled (mirrors the 0.2.7 bearer-resolve flow): set `ZEROCLAW_BROWSER_PAIR_DISABLE=1`. To keep auto-pair but suppress the browser launch: set `ZEROCLAW_OPEN_BROWSER=never`.

**Operators who were running with `ZEROCLAW_LEGACY_WEBHOOK=1` set:** unset the env var (or remove the flag); 0.2.8 will refuse to parse it. If your gateway lacks `/ws/chat` (any ZeroClaw build < 0.7.4), pin klodi-zeroclaw to 0.2.7. If your gateway has `/ws/chat`, the WS path will Just Work — that's been the canonical path since 0.2.6.

The interim `demo/scripts/up-zeroclaw.sh:200-233` workaround in the marketplace repo (which `docker exec`s `gateway get-paircode --new` and prints the code) becomes redundant once 0.2.8 ships and can be removed in a follow-up.

## [0.2.7] — 2026-05-10

**klodi-zeroclaw only.** Tag-only re-issue of the 0.2.6 redesign plus the build fix it needed to publish. 0.2.6 was tagged at a commit that contained a `#[cfg]` split in `klodi-rust-host::mcp::tools::dispatch` whose `not(feature = ...)` arm survived the zeroclaw vendor's cfg strip — both halves of the split went live in the staged crate, `cargo publish --dry-run` failed on E0382 + E0596, and the tag never actually shipped to crates.io. 0.2.7 collapses the split to a single `let mut args` with `#[allow(unused_mut)]` for the moltis/ironclaw build that doesn't reach the approval-gate path. The 0.2.6 tag remains on the repo for audit trail; nothing was published under that version.

All operator-facing changes are documented in the [0.2.6] section below.

### Migrating from 0.2.5 to 0.2.7 (klodi-zeroclaw operators only)

Identical to the migration described in [0.2.6] below. There is no separate 0.2.6 → 0.2.7 step — 0.2.6 was never published, so operators upgrading from 0.2.5 land on 0.2.7 directly.

## [0.2.6] — 2026-05-10

> **Never published to crates.io.** This tag exists on the repo for audit trail. The actual publish happened from [0.2.7], which adds the one-line build fix that 0.2.6 needed but didn't have. Operators install 0.2.7; 0.2.6 read as a fully-superseded mirror of 0.2.7's notes.

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

This release replaces the `/webhook` wake-delivery path with a session-based path against ZeroClaw's `/ws/chat`, gives the operator visible heartbeat + bootstrap context the moment the daemon connects, and adds a plugin-side approval gate for irreversible klodi tools. Per-message ack handshake is a known gap (the gateway's `agent_start` frame doesn't carry per-message correlation), deferred until wake volume requires it. The 240s `/webhook` timeout band-aid is dropped by default; the legacy path is still selectable via `--legacy-webhook`.

### Changed

- **klodi-zeroclaw wake delivery (P0):** wakes now write into the operator's persisted ZeroClaw session via `WS /ws/chat?session_id=<uuid>` instead of POSTing to `/webhook`. The 30s `TimeoutLayer` on `/webhook` no longer applies — frame writes return as soon as the gateway acknowledges the WS message, decoupling NATS ack semantics from the agent's full turn duration. The forwarder waits up to 180s for a post-send `agent_start` / `turn_complete` confirmation (covers a typical 60s+ agent turn plus one prior in-flight turn draining), then acks the NATS message regardless — the WS write itself is the durability boundary.

  Concretely: `klodi_rust_host::forwarder::BodyShape` gains a `ZeroClawSession { ws_config, session_id }` variant. `klodi-zeroclaw-daemon` builds it from the resolved bearer + the operator-session UUID at startup. The legacy `MessageWrapped` shape against `/webhook` is still selectable with `--legacy-webhook` / `ZEROCLAW_LEGACY_WEBHOOK=1` for operators on a ZeroClaw build that doesn't expose `/ws/chat`.

### Added

- **Persisted operator session (`${KLODI_HOME}/zeroclaw.session`).** The daemon resolves a single ZeroClaw session per persona at startup: read the cached UUID, probe-resume it via WS, and re-bootstrap from scratch if the gateway no longer recognises it. Idempotent across restarts. Mode 0600. Surfaced by `klodi_setup_status` as the new `zeroclaw_session_present` flag.

- **Plugin-authored heartbeat + bootstrap note.** On every daemon connect the operator's session receives a one-line `🟢 klodi daemon connected as @<handle>` heartbeat. On a freshly-minted session the daemon also posts a multi-line bootstrap note covering the wake event kinds, klodi-namespaced tools, and the approval-via-chat convention. Sessions with prior messages skip the bootstrap note so the operator's chat doesn't accumulate identical intros across restarts.

- **`klodi_report_to_operator` MCP tool.** New tool the agent can call to write a structured note (severity + summary + optional details + optional structured payload) directly into the operator's session. Renders as `ℹ️`/`⚠️`/`🛑` headline + markdown body + fenced JSON block. Available only when `klodi-zeroclaw-mcp` finds both `${KLODI_HOME}/zeroclaw.token` and `${KLODI_HOME}/zeroclaw.session` populated (i.e. the daemon has run at least once).

- **Approval gate for irreversible klodi tools.** Hardcoded gated list: `klodi_tx_confirm`, `klodi_tx_cancel`, `klodi_list_withdraw`. First call posts a `🔒 Operator approval needed (request_id: …)` prompt to the operator session, persists pending state under `${KLODI_HOME}/approvals/<request_id>.json` (mode 0600, reaped after 24h), and returns `{ approval_required: true, request_id, instructions }` to the agent. The agent retries with `_klodi_approval_request_id` + `_klodi_approval_operator_text` set to the operator's verbatim chat reply; the plugin matches the args fingerprint, runs an affirmation/denial regex, and either opens the gate or returns a `denied` / `still_pending` response. Pending state is durable across MCP-server crashes.

  **Scope deliberately narrow.** `klodi_offer_respond`, `klodi_list_update`, and other policy-shaped operations are NOT gated by the plugin — the agent reads the operator's `negotiation_style.md` + on-disk strategy files (`${KLODI_HOME}/{buy,sell}/`) and decides whether to call `klodi_report_to_operator` first. This is a deliberate choice: the plugin is mechanism, not policy; locking a "below-min" or "always-ask" pattern inside the plugin would prevent operators who want different workflows from defining them.

- **`klodi-zeroclaw-mcp` operator-channel binding.** New CLI args `--zeroclaw-ws-url` / `--zeroclaw-http-base` (and matching `ZEROCLAW_WS_URL` / `ZEROCLAW_HTTP_BASE` env vars) override the WS endpoint derived from `--zeroclaw-webhook-url`. Useful when the gateway lives at a non-canonical path.

- **`--adopt-session=<uuid>` operator opt-in.** New CLI arg / `ZEROCLAW_ADOPT_SESSION` env var on `klodi-zeroclaw-daemon`. Default behaviour is unchanged (always mint a fresh dedicated klodi session); this flag is the explicit opt-in for operators who want klodi activity to land in an existing chat session. The daemon probes the gateway to confirm the id resumes; bails loudly on any failure so typos don't silently re-bootstrap.

- **Atomic session bootstrap → first-write.** Combined `bootstrap_session` + first heartbeat write into a single WS lifecycle (`bootstrap_session_with_first_message`) so a freshly-minted session always carries at least one durable user-role message before its WS closes. Closes the empty-session GC window observed against the gateway, where empty-session retention behaviour was unverified during research.

- **Per-session write serialisation.** Notifications + channel-message subscribers write into the same operator session from independent forwarder tasks. Added an `Arc<tokio::sync::Mutex<()>>` in `SharedState`, acquired around the full WS connect → send → drain cycle for `BodyShape::ZeroClawSession`, so writes land in NATS-arrival order even if the gateway's `SessionActorQueue` reordering is incomplete. Per-session throughput is bounded by drain time (typically <2s, capped at 180s).

- **WS reconnect backoff.** Added a per-session consecutive-failure counter; before each WS send, if prior sends have failed, sleep for an exponential backoff (250ms base, 2× multiplier, capped at 30s) under the per-session mutex. Reset on success. Keeps NATS redeliveries from hammering a flapping gateway with fresh handshakes — JetStream's redelivery cadence already adds spacing across wakes, this caps the *additional* per-failure wait. Reuses `klodi_nats_client::backoff::compute_backoff` for shared math.

### Changed (internal)

- **Drain protocol simplification.** `zeroclaw_ws::send_session_message` now treats `agent_start` as the sole expected post-send ack frame. The `turn_complete` arm is dropped — it was unobserved during live research against the gateway, and `agent_start` already proves the gateway routed the message into the agent loop. `turn_complete` (and any other future frame) lands in `InboundFrame::Other` and is silently drained.

### Known gaps

- **No per-message WS ack (known gap).** `agent_start` and `turn_complete` aren't tied to the message that triggered them. For a low-volume marketplace this is fine (the wake count rarely outpaces the agent's serial processing); for high-volume marketplaces the daemon could ack a wake before the agent observes it. Acceptable for now; revisit when measured drop rates demand it.

### Migrating from 0.2.5 to 0.2.6 (klodi-zeroclaw operators only)

Drop-in replacement — no config or env changes. Rebuild the daemon (`cargo build -p klodi-zeroclaw --release` or pull the new container image) and restart. The first daemon start after the bump will:
1. Bootstrap a fresh ZeroClaw session and persist its UUID at `${KLODI_HOME}/zeroclaw.session`.
2. Post a heartbeat + bootstrap note into that session — open ZeroClaw's chat dashboard to read them.
3. Switch the forwarder over to WS-based wake delivery — `klodi_wake_forwarded_via_ws` replaces `klodi_wake_forwarded` in the daemon's logs.

If your deployment requires the legacy `/webhook` path for any reason, set `ZEROCLAW_LEGACY_WEBHOOK=1` (or pass `--legacy-webhook`) and the 0.2.5 behaviour is unchanged.

## [0.2.5] — 2026-05-09

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

### Fixed

- **klodi-zeroclaw wake delivery (P0):** every marketplace wake delivered to `klodi-zeroclaw-daemon` 0.2.4 hit `klodi_wake_forward_transport_error` and JetStream redelivered on a 10s cadence; the agent never produced a turn. Root cause: `ForwarderConfig`'s reqwest client used a hardcoded 10s timeout, but ZeroClaw 0.7.4's `POST /webhook` is **synchronous** — the gateway spawns the agent loop, runs it to completion, and returns the agent's reply (`{"model","response"}`) in the response body. Empirically a trivial `{"message":"ping"}` round-trip already takes ~6s with the daemon's cached bearer; real `channel.message` wakes (agent reasons + calls `klodi_channel_message` to reply) routinely take 15–60s, with a long tool-using turn running considerably longer — well past any 10s budget. Each redelivery also stacked a fresh agent init on the gateway since the previous loop was still running. Fix: `ForwarderConfig` gains a per-adapter `wake_post_timeout: Duration` field; `klodi-zeroclaw-daemon` sets it to 240s, which buys generous headroom for the long-turn tail without blocking other deliveries (the forwarder serves notifications and channel messages on independent subscriber tasks, so a slow wake here does not stall others). Moltis + IronClaw stay on 10s since their wake endpoints ack on receipt and run the agent in the background.

### Migrating from 0.2.4 to 0.2.5 (klodi-zeroclaw operators only)

Drop-in replacement — no config or env changes. Rebuild the daemon (`cargo build -p klodi-zeroclaw --release` or pull the new container image) and restart. After the bump, a single `channel.message` wake produces one `Initializing MCP client` line on the gateway, the daemon's logs show `klodi_wake_forwarded`, and the agent's reply lands in the marketplace channel within ~30s.

## [0.2.4] — 2026-05-09

**klodi-zeroclaw only.** OpenClaw, the Python adapters (klodi-hermes, klodi-nanobot), and the other Rust adapters (klodi-moltis, klodi-ironclaw) are unaffected and not republished at this version.

### Fixed

- **klodi-zeroclaw wake delivery (P0):** ZeroClaw 0.7.4 retired the `/hooks/wake` route in favor of `POST /webhook`. The old route now falls through to the gateway's SPA static-file fallback, which only serves `GET`/`HEAD` — every wake POST got `405 Method Not Allowed`, NAK'd back into JetStream, and redelivered until `max_deliver` exhausted. Today's container rebuild pulled the new ZeroClaw runtime via the `ghcr.io/zeroclaw-labs/zeroclaw:debian` floating tag, so wakes had been silently failing since the upstream tag moved. The daemon now posts to `/webhook` with `Authorization: Bearer <zc_…>`.

### Changed

- **klodi-zeroclaw `--zeroclaw-hooks-wake-url` / `ZEROCLAW_HOOKS_WAKE_URL` renamed** to `--zeroclaw-webhook-url` / `ZEROCLAW_WEBHOOK_URL` to match the new endpoint name. **Hard break** — the old name is no longer read. Default URL changes from `http://127.0.0.1:7070/hooks/wake` to `http://127.0.0.1:7070/webhook`. Init scripts that exported the old var must update in lockstep with the version bump.
- **klodi-zeroclaw forwarder body shape:** the daemon now wraps the structured wake envelope (`{channel, kind, event_id, user_id, payload}`) as a single JSON-stringified `message` field — `{"message": "<json>"}` — to match ZeroClaw 0.7.4's `/webhook` contract, which only accepts that shape and treats unknown top-level keys as an error. The agent recovers the structured wake by `JSON.parse`-ing the `message` field on receipt. No payload is dropped. Implemented as a new `BodyShape::MessageWrapped` variant on `klodi_rust_host::ForwarderConfig`; Moltis and IronClaw stay on the existing `BodyShape::Structured` path with no behavioral change.

### Added

- **klodi-zeroclaw daemon-side pair bootstrap.** The daemon resolves its bearer at startup in this priority order:
  1. `ZEROCLAW_AGENT_TOKEN` env var (operator manages the token themselves).
  2. `${KLODI_HOME}/zeroclaw.pairing-code` — a sidecar one-time pairing code the operator's init script writes per boot. The daemon POSTs `/pair` with `X-Pairing-Code: <code>`, caches the resulting `zc_<hex>` bearer at `${KLODI_HOME}/zeroclaw.token` (mode 0600), and deletes the consumed code file so it cannot be replayed.
  3. `${KLODI_HOME}/zeroclaw.token` — the cached bearer from a prior successful pair.

  This closes the `gateway.paired_tokens` lifecycle gap: deployments that rewrite ZeroClaw's `config.toml` per container boot (dropping all paired bearers) are now self-healing as long as the same init script also refreshes the sidecar code file. Pair endpoint is derived from the webhook URL by replacing the `/webhook` suffix with `/pair`; override via the new `ZEROCLAW_PAIR_URL` / `--zeroclaw-pair-url` for non-canonical layouts.

### Migrating from 0.2.3 to 0.2.4 (klodi-zeroclaw operators only)

1. Update your init script: rename `ZEROCLAW_HOOKS_WAKE_URL=…/hooks/wake` to `ZEROCLAW_WEBHOOK_URL=…/webhook`. (Or rely on the new default — the daemon now defaults to `http://127.0.0.1:7070/webhook` if the env var is unset.)
2. Provide a bearer source. Either:
    - Export `ZEROCLAW_AGENT_TOKEN=<zc_…>` after pairing manually (call `POST /pair` with `X-Pairing-Code: <code>` against ZeroClaw's gateway), OR
    - Drop the gateway's startup pairing code at `${KLODI_HOME}/zeroclaw.pairing-code` so the daemon can mint + cache the bearer itself. Refresh the file on every container boot if your deployment wipes ZeroClaw's `config.toml`.
3. Confirm ZeroClaw core is ≥ 0.7.4. Older builds shipped the retired `/hooks/wake` route; this adapter no longer targets them.

## [0.2.3] — 2026-05-09

**Rust adapters (klodi-zeroclaw, klodi-moltis, klodi-ironclaw).** OpenClaw and the Python adapters (klodi-hermes, klodi-nanobot) are unaffected and not republished at this version.

### Fixed

- **klodi-{zeroclaw,moltis,ironclaw} wake pump (P0):** the Rust NATS consumer dropped every `search.match` and `channel.message` wake with `klodi_consumer_parse_failed` because `packages/nats-client-rs/src/events.rs` had drifted from the canonical TS wire schema in `packages/tool-catalog/src/events.ts`. Two distinct shapes were affected:
  - `SearchMatchListingSummary` still required the legacy flat `delivery_method` (string) and `location_area` (Option<String>) fields. The publisher (`services/marketplace/src/handlers/listings-search-evaluator.ts`) emits the new `fulfillment: DeliveryOffer[]` shape — a TypeBox-validated discriminated union over `pickup` / `ship` / `digital`. The Rust struct now mirrors the TS source of truth: a new `DeliveryOffer` enum (with `PickupLocation` and `ShipOrigin` value types) replaces the flat triple. Pickup coordinates + area now live INSIDE the offer record, ship offers carry `from.country` + `shipsTo`, and `digital` has no extra fields.
  - `ChannelMessageEvent.sequence` was a required `u64`. The publisher (`packages/nats-client-ts/src/publish.ts`) intentionally does NOT embed sequence in the body — JetStream assigns the stream sequence server-side and it cannot be known at mint time. The field is now `#[serde(default)]` so the parse path succeeds; `consumers.rs::process_channel` populates `event.sequence = msg.info()?.stream_sequence` post-parse, so handlers (and the wake-forward POST body) see the real JetStream sequence rather than a missing field.
  - Cross-language contract test (`tests/contract/golden.rs`) and the shared golden corpus at `packages/tool-catalog/tests/golden/{search.match,channel.message}.json` updated in lockstep. Both fixtures still spoke the dead schema — that gap is why the contract suite previously passed against drifted Rust types. The TS host adapters (OpenClaw, Hermes, Nanobot) consume via `nats-client-ts`, which IS the source of truth, so they were never affected.
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
