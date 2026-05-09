# ZeroClaw — klodi adapter spec

**Status:** draft (Phase 7 polish)
**Adapter source:** `klodi-plugin/adapters/zeroclaw/`
**Distribution:** cargo `klodi-zeroclaw` (binary crate)

## 1. Identity

ZeroClaw runs the agent inside a long-running daemon that owns one persistent NATS-WS connection. The adapter is a Rust binary crate that ships two control planes: a wake-forwarder daemon (NATS → HTTP `POST /webhook` against ZeroClaw 0.7.4's gateway, with `Authorization: Bearer <zc_…>` and a `{"message": "<JSON-stringified envelope>"}` body) and a stdio MCP server (`klodi-zeroclaw-mcp`) that exposes the tool catalog and skill bundle to the agent. Imports `async-nats` via the workspace `nats-client-rs` package.

host_shape: daemon

## 2. Tool registration

- **Registration API:** stdio MCP server (`klodi-zeroclaw-mcp`) wired into ZeroClaw's `[[mcp.servers]]` config.toml table by `klodi-zeroclaw-register`. ZeroClaw's MCP client wraps each advertised tool as a native agent tool under the `klodi__<tool_name>` prefix.
- **Schema source:**
  - Tool names + NATS subjects: `klodi-plugin/packages/tool-catalog/dist/rust-types.rs` (codegen target consumed by the Rust client + the MCP dispatcher).
  - JSON Schemas served on `tools/list`: `klodi-plugin/packages/tool-catalog/dist/schemas.json` (embedded via `include_str!` into the published crate).
- **Tool families exposed via MCP:**
  - **NATS request/reply passthrough:** every entry in `schemas.json` — dispatched through `KlodiClient::request(<subject>, params)`.
  - **Local diagnostics:** `klodi_setup_status`, `klodi_health` — answered in-process without a NATS round-trip (`klodi_health` does one round-trip through `users.whoami`).
  - **Local filesystem side-effects:** `klodi_setup_reseed_policies` (non-destructive seed of `${klodi_home}/policies/{negotiation_style,security}.md` from the embedded skill bundle), `klodi_watch` (composite: `searches.create` + write `${klodi_home}/buy/<slug>.md`), `klodi_unwatch` (composite: `searches.delete` + delete the buy file).
  - **Direct JetStream publish:** `klodi_channel_message` — calls `KlodiClient::publish_channel_message`.
- **Tools intentionally NOT exposed via MCP:** `klodi_register`, `klodi_register_poll`, `klodi_setup_repair`, `klodi_setup_reseed_skill`. Registration + repair are owned by the `klodi-zeroclaw-register` CLI binary (atomic overwrite via `klodi_secret_write` — re-running it cleanly replaces stale creds while preserving `policies/`, `buy/`, `sell/`). The skill bundle is embedded read-only via `include_dir!` so reseed-skill is unnecessary. `klodi_setup_status`'s `next_action` field surfaces the appropriate CLI command to the agent when registration repair is required.
- **Operator-only tooling (CLI binaries, not MCP tools):** `klodi-zeroclaw-register` (one-shot HTTP registration + policy seeding + ZeroClaw config wiring), `klodi-zeroclaw-daemon` (wake forwarder), `klodi-zeroclaw-channel-message` (script-driven publish), `klodi-zeroclaw-setup-status` (diagnostic).

## 3. Lifecycle

- **Wake forwarder:** `klodi-zeroclaw-daemon` runs under operator supervision; opens its own persistent NATS-WS connection and POSTs to ZeroClaw's `/webhook`. Resolves the bearer token at startup in this priority order: `ZEROCLAW_AGENT_TOKEN` env > sidecar pairing-code at `${KLODI_HOME}/zeroclaw.pairing-code` (consumed and POSTed to `/pair`) > cached token at `${KLODI_HOME}/zeroclaw.token`.
- **MCP server:** ZeroClaw spawns `klodi-zeroclaw-mcp` per agent session per its `[[mcp.servers]]` config. Each subprocess opens a separate persistent NATS-WS connection lazily on first `tools/call` and reuses it for the session's duration.
- **`client.connect()`:** lazy in the MCP path (deferred until first call); eager at daemon start.
- **`client.close()`:** at process exit on both planes.
- **Restart / reload / sleep:** restart the daemon and/or let ZeroClaw re-spawn the MCP subprocess on the next session.

## 4. Wake primitive

- **Native mechanism:** HTTP POST to `ZEROCLAW_WEBHOOK_URL` (default `http://127.0.0.1:7070/webhook`) with `Authorization: Bearer <zc_…>`. Body shape is `{"message": "<JSON-stringified envelope>"}` per ZeroClaw 0.7.4's `/webhook` contract; the agent recovers the structured wake by `JSON.parse`-ing `message`.
- **Bearer source:** `ZEROCLAW_AGENT_TOKEN` env > sidecar pairing-code file at `${KLODI_HOME}/zeroclaw.pairing-code` (one-time, consumed by daemon on startup, POSTed to `/pair` with `X-Pairing-Code: <code>`, resulting `zc_<hex>` token cached at `${KLODI_HOME}/zeroclaw.token` mode 0600) > the cached token from a prior pair.
- **Helper signature:** `run_forwarder(ForwarderConfig { …, body_shape: BodyShape::MessageWrapped })` in `klodi_rust_host::forwarder`; pair logic lives inline in `adapters/zeroclaw/src/bin/daemon.rs`.
- **Failure semantics:** HTTP error → handler returns `Err` → consumer naks → JetStream redelivers. A 401 from `/webhook` (cached bearer no longer valid — typical after a deployment that wipes `gateway.paired_tokens`) currently NAKs and retries until `max_deliver`; recovery requires the operator's init script to drop a fresh pairing code at `${KLODI_HOME}/zeroclaw.pairing-code` and restart the daemon.
- **Per-host wake-routing config:** `ZEROCLAW_WEBHOOK_URL` env var; optional `ZEROCLAW_PAIR_URL` override (defaults to swapping `/webhook` for `/pair` on the same gateway).

## 5. Setup particulars

- **Phases:** `unconfigured` → `registering` → `needs_policy` → `ready`. Driven by file presence + `negotiation_style.md` placeholder detection.
- **In-agent setup tool:** `klodi_setup_status` is exposed via the MCP plane (returns `phase`, `klodi_home`, `creds_present`, `config_present`, `creds_mode_secure`, `negotiation_style_seeded`, `negotiation_style_filled`, `security_policy_seeded`, `user_id`, `handle`, `nats_url`, `issues`, `issue_codes`, `next_action`). The CLI binary `klodi-zeroclaw-setup-status` exposes the same shape for operators.
- **Issue codes:** `not_registered`, `partial_credentials`, `config_unreadable`, `creds_perms` (creds file is group/world-readable), `negotiation_style_missing`, `negotiation_style_unfilled` (template placeholders unresolved), `security_policy_missing`. See `klodi_setup_status` schema.
- **`next_action` shape:** structured `{ kind, message, … }`. `kind` is one of:
  - `cli` — `{ command: "klodi-zeroclaw-register", message }`. Agent surfaces the command; user runs it from a shell. Used for registration / re-registration / config rewrite.
  - `tool` — `{ tool: "klodi_setup_reseed_policies", message }`. Agent invokes it directly.
  - `shell` — `{ shell: "chmod 600 …", message }`. Agent surfaces the command (perms tightening; never auto-executed).
  - `dialog` — `{ path: "policies/negotiation_style.md", message }`. Agent walks the user through filling placeholders.
- **Fix policy:** registration repair = re-run `klodi-zeroclaw-register` (idempotent — atomic overwrite of `nats.creds` + `config.json`; preserves `policies/`, `buy/`, `sell/`, and unrelated `[[mcp.servers]]` blocks). Policy reseed = `klodi_setup_reseed_policies` (non-destructive). Unfilled `negotiation_style.md` = dialog action.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default via `klodi_rust_host::paths::klodi_home()`.

## 6. Skill delivery path

The canonical klodi skill (`SKILL.md`, `references/*.md`, `templates/*.md`, `policies/security.md`) ships **embedded** in the published `klodi-zeroclaw` crate via `include_dir!`. The MCP server advertises every file under `klodi://skill/<rel-path>` on `resources/list`; the agent reads them on demand via `resources/read`. The embedded copy is read-only — single source of truth, no version skew across upgrades. `klodi_setup_reseed_skill` is therefore unnecessary on ZeroClaw and is not registered.

User-editable policy files live separately on disk under `${klodi_home}/policies/`. `klodi-zeroclaw-register` seeds them **non-destructively** at install time from the embedded bundle (`templates/negotiation_style.template.md` → `policies/negotiation_style.md`; `policies/security.md` → `policies/security.md`). Subsequent re-runs preserve every operator edit; `klodi_setup_reseed_policies` provides the same non-destructive seed at runtime. Per-search and per-listing strategy files (`buy/<slug>.md`, `sell/<slug>.md`) are written by `klodi_watch` and the listing-lifecycle hooks.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # 0600 — seeded by klodi-zeroclaw-register
├── nats.creds                       # 0600 — seeded by klodi-zeroclaw-register
├── zeroclaw.pairing-code            # one-time, operator-written; daemon reads + deletes
├── zeroclaw.token                   # 0600 — cached `zc_<hex>` bearer minted by daemon
├── policies/
│   ├── negotiation_style.md         # 0644 — seeded once from skill template; user-edited
│   └── security.md                  # 0644 — seeded as-is from bundle
├── buy/<slug>.md                    # 0644 — written by klodi_watch persist=true
└── sell/<slug>.md                   # 0644 — written by listing-lifecycle hooks

~/.zeroclaw/config.toml              # mutated by klodi-zeroclaw-register
                                     # — adds the `[[mcp.servers]] name = "klodi"` entry
```

- **File ownership:** `klodi-zeroclaw-register` writes klodi's `config.json` + `nats.creds`, seeds `policies/` non-destructively, and inserts the `[[mcp.servers]]` entry into ZeroClaw's `config.toml`. The wake daemon is read-only on `nats.creds` + `config.json`; on first boot it consumes `zeroclaw.pairing-code` (operator-written) and writes `zeroclaw.token` (mode 0600) with the minted bearer. The MCP server is read-only on creds/config and writes `buy/<slug>.md` (in `klodi_watch`) and removes them (in `klodi_unwatch`).
- **Idempotency:** re-running `klodi-zeroclaw-register` after upgrade overwrites `nats.creds` + `config.json` atomically and replaces only the `klodi` `[[mcp.servers]]` entry; `policies/`, `buy/`, `sell/`, and unrelated server blocks are preserved verbatim. `klodi_setup_reseed_policies` is non-destructive — present files are never overwritten.

## 8. Test entry points

- **Unit:** `klodi-plugin/packages/klodi-rust-host/src/{mcp,host_mcp_config}.rs` cargo tests (catalog round-trip, embedded skill bundle integrity, `config.toml` upsert idempotency, secure-mode setup-status).
- **Integration / acceptance:** **deferred to Phase 7** — end-to-end agent-to-agent flow with two ZeroClaw containers exchanging offers.

## 9. Distribution and install

- **Package manager:** cargo (`klodi-zeroclaw`).
- **Install command:**
  ```bash
  cargo install klodi-zeroclaw
  klodi-zeroclaw-register   # OAuth + writes nats.creds, config.json,
                            # and the [[mcp.servers]] entry in ~/.zeroclaw/config.toml
  # Drop ZeroClaw's startup pairing code so the daemon mints + caches the bearer:
  echo "$PAIRING_CODE" > "${KLODI_HOME:-$HOME/Library/Application Support/klodi}/zeroclaw.pairing-code"
  ZEROCLAW_WEBHOOK_URL=http://127.0.0.1:7070/webhook \
      klodi-zeroclaw-daemon
  # Or pre-pair manually and pass ZEROCLAW_AGENT_TOKEN=<zc_…> instead.
  # ZeroClaw spawns klodi-zeroclaw-mcp on demand per agent session.
  ```
- **Required runtime version:** ZeroClaw core ≥ 0.7.4 (introduces the `/webhook` + `/pair` routes; older builds shipped `/hooks/wake` which is no longer supported).
- **Required env / pre-existing files:** `ZEROCLAW_WEBHOOK_URL` and a bearer source (either `ZEROCLAW_AGENT_TOKEN` or a sidecar pairing-code file at `${KLODI_HOME}/zeroclaw.pairing-code`); `KLODI_NATS_URL`. See `docs/ENVIRONMENT.md` for the full env contract.

## 10. Open questions

- Hard-fail policy when `~/.zeroclaw/config.toml` exists with malformed TOML — currently `klodi-zeroclaw-register` exits with a wrapped TOML parse error. Confirm whether ZeroClaw's own setup expects the file to never exist before first run.
- Lifecycle integration with ZeroClaw's plugin manager when available (auto-restart on klodi adapter upgrade).
