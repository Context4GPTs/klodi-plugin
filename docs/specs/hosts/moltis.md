# Moltis — klodi adapter spec

**Status:** draft (Phase 7 polish)
**Adapter source:** `klodi-plugin/adapters/moltis/`
**Distribution:** cargo `klodi-moltis` (binary crate)

## 1. Identity

Moltis is a host runtime where the agent runs out-of-process. The klodi adapter ships two control planes from one cargo install: a wake-forwarder daemon (NATS → HTTP `/agents/<agent>/wake`) and a stdio MCP server (`klodi-moltis-mcp`) that exposes the tool catalog and skill bundle to the agent. Imports `async-nats` via the workspace `nats-client-rs` package.

host_shape: daemon

## 2. Tool registration

- **Registration API:** stdio MCP server (`klodi-moltis-mcp`) wired into Moltis's `[[mcp.servers]]` config.toml table by `klodi-moltis-register`. Moltis's MCP client wraps each advertised tool as a native agent tool under the `klodi__<tool_name>` prefix.
- **Schema source:**
  - Tool names + NATS subjects: `klodi-plugin/packages/tool-catalog/dist/rust-types.rs` (codegen target consumed by the Rust client + the MCP dispatcher).
  - JSON Schemas served on `tools/list`: `klodi-plugin/packages/tool-catalog/dist/schemas.json` (embedded via `include_str!` into the published crate).
- **Tool families exposed via MCP:**
  - **NATS request/reply passthrough:** every entry in `schemas.json` — dispatched through `KlodiClient::request(<subject>, params)`.
  - **Local diagnostics:** `klodi_setup_status`, `klodi_health` — answered in-process without a NATS round-trip (`klodi_health` does one round-trip through `users.whoami`).
  - **Local filesystem side-effects:** `klodi_setup_reseed_policies` (non-destructive seed of `${klodi_home}/policies/{negotiation_style,security}.md` from the embedded skill bundle), `klodi_watch` (composite: `searches.create` + write `${klodi_home}/buy/<slug>.md`), `klodi_unwatch` (composite: `searches.delete` + delete the buy file).
  - **Direct JetStream publish:** `klodi_channel_message` — calls `KlodiClient::publish_channel_message`.
- **Tools intentionally NOT exposed via MCP:** `klodi_register`, `klodi_register_poll`, `klodi_setup_repair`, `klodi_setup_reseed_skill`. Registration + repair are owned by the `klodi-moltis-register` CLI binary (atomic overwrite via `klodi_secret_write` — re-running it cleanly replaces stale creds while preserving `policies/`, `buy/`, `sell/`). The skill bundle is embedded read-only via `include_dir!` so reseed-skill is unnecessary. `klodi_setup_status`'s `next_action` field surfaces the appropriate CLI command to the agent when registration repair is required.
- **Operator-only tooling (CLI binaries, not MCP tools):** `klodi-moltis-register` (one-shot HTTP registration + policy seeding + Moltis config wiring), `klodi-moltis-daemon` (wake forwarder), `klodi-moltis-channel-message` (script-driven publish), `klodi-moltis-setup-status` (diagnostic).

## 3. Lifecycle

- **Wake forwarder:** `klodi-moltis-daemon` is supervised by the operator (systemd, foreman, etc.); opens its own persistent NATS-WS connection and POSTs to the configured wake URL.
- **MCP server:** Moltis spawns `klodi-moltis-mcp` per agent session per its `[[mcp.servers]]` config. Each subprocess opens a separate persistent NATS-WS connection lazily on first `tools/call` and reuses it for the session's duration.
- **`client.connect()`:** lazy in the MCP path (deferred until first call); eager at daemon start.
- **`client.close()`:** at process exit on both planes.
- **Restart / reload / sleep:** restart the daemon and/or let Moltis re-spawn the MCP subprocess on the next session. OS sleep → idle WS → server `ping_interval` (20s) detects stale → `async-nats` reconnects.

## 4. Wake primitive

- **Native mechanism:** HTTP POST to a Moltis-side wake URL configured via env (`MOLTIS_WAKE_URL`, e.g. `http://127.0.0.1:5000/agents/default/wake`). Bearer auth via `MOLTIS_AGENT_TOKEN`.
- **Helper signature:** `forward_wake(envelope, target_url)` in `src/forwarder.rs`.
- **Failure semantics:** HTTP error → handler returns `Err` → consumer naks → JetStream redelivers per `max_deliver: 5` / `ack_wait: 30s`.
- **Per-host wake-routing config:** the operator sets the Moltis wake URL via env at daemon start. Klodi does not enforce — if the URL is wrong, wakes fail and JetStream redelivery surfaces the failure in operator logs.

## 5. Setup particulars

- **Phases:** `unconfigured` → `registering` → `needs_policy` → `ready`. Driven by file presence + `negotiation_style.md` placeholder detection.
- **In-agent setup tool:** `klodi_setup_status` is exposed via the MCP plane. The CLI binary `klodi-moltis-setup-status` exposes the same shape for operators.
- **Issue codes:** `not_registered`, `partial_credentials`, `config_unreadable`, `creds_perms` (creds file is group/world-readable), `negotiation_style_missing`, `negotiation_style_unfilled` (template placeholders unresolved), `security_policy_missing`.
- **`next_action` shape:** structured `{ kind, message, … }`. `kind` is one of:
  - `cli` — `{ command: "klodi-moltis-register", message }`. Agent surfaces the command; user runs it from a shell. Used for registration / re-registration / config rewrite.
  - `tool` — `{ tool: "klodi_setup_reseed_policies", message }`. Agent invokes it directly.
  - `shell` — `{ shell: "chmod 600 …", message }`. Agent surfaces the command (perms tightening; never auto-executed).
  - `dialog` — `{ path: "policies/negotiation_style.md", message }`. Agent walks the user through filling placeholders.
- **Fix policy:** registration repair = re-run `klodi-moltis-register` (idempotent — atomic overwrite of `nats.creds` + `config.json`; preserves `policies/`, `buy/`, `sell/`, and unrelated `[[mcp.servers]]` blocks). Policy reseed = `klodi_setup_reseed_policies` (non-destructive). Unfilled `negotiation_style.md` = dialog action.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default via `klodi_rust_host::paths::klodi_home()`.

## 6. Skill delivery path

The canonical klodi skill (`SKILL.md`, `references/*.md`, `templates/*.md`, `policies/security.md`) ships **embedded** in the published `klodi-moltis` crate via `include_dir!`. The MCP server advertises every file under `klodi://skill/<rel-path>` on `resources/list`; the agent reads them on demand via `resources/read`. The embedded copy is read-only — single source of truth, no version skew across upgrades.

User-editable policy files live separately on disk under `${klodi_home}/policies/`. `klodi-moltis-register` seeds them **non-destructively** at install time from the embedded bundle (`templates/negotiation_style.template.md` → `policies/negotiation_style.md`; `policies/security.md` → `policies/security.md`). Subsequent re-runs preserve every operator edit; `klodi_setup_reseed_policies` provides the same non-destructive seed at runtime. Per-search and per-listing strategy files (`buy/<slug>.md`, `sell/<slug>.md`) are written by `klodi_watch` and the listing-lifecycle hooks.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # 0600 — seeded by klodi-moltis-register
├── nats.creds                       # 0600 — seeded by klodi-moltis-register
├── policies/
│   ├── negotiation_style.md         # 0644 — seeded once from skill template; user-edited
│   └── security.md                  # 0644 — seeded as-is from bundle
├── buy/<slug>.md                    # 0644 — written by klodi_watch persist=true
└── sell/<slug>.md                   # 0644 — written by listing-lifecycle hooks

~/.moltis/config.toml                # mutated by klodi-moltis-register
                                     # — adds the `[[mcp.servers]] name = "klodi"` entry
```

- **File ownership:** `klodi-moltis-register` writes klodi's `config.json` + `nats.creds`, seeds `policies/` non-destructively, and inserts the `[[mcp.servers]]` entry into Moltis's `config.toml`. The wake daemon and MCP server are read-only on `nats.creds` + `config.json`. The MCP server writes `buy/<slug>.md` (in `klodi_watch`) and removes them (in `klodi_unwatch`).
- **Idempotency:** re-running `klodi-moltis-register` after upgrade overwrites `nats.creds` + `config.json` atomically and replaces only the `klodi` `[[mcp.servers]]` entry; `policies/`, `buy/`, `sell/`, and unrelated server blocks are preserved verbatim. `klodi_setup_reseed_policies` is non-destructive — present files are never overwritten.

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/moltis/src/` cargo tests cover register trim-helpers and per-host bookkeeping. Wire-level encoding contracts are tested in `klodi-plugin/packages/nats-client-rs/`.
- **Integration / acceptance:** **deferred to Phase 7** (no live container fixture this round; no Moltis Docker image proven out yet for klodi).

## 9. Distribution and install

- **Package manager:** cargo (`klodi-moltis` binary crate).
- **Install command:**
  ```bash
  cargo install klodi-moltis
  klodi-moltis-register   # OAuth + writes nats.creds, config.json,
                          # and the [[mcp.servers]] entry in ~/.moltis/config.toml
  MOLTIS_WAKE_URL=http://127.0.0.1:5000/agents/default/wake \
  MOLTIS_AGENT_TOKEN=<bearer> \
      klodi-moltis-daemon
  # Moltis spawns klodi-moltis-mcp on demand per agent session.
  ```
- **Required runtime version:** Moltis core ≥ current (specific minimum TBD when Phase 7 ratifies).
- **Required env / pre-existing files:** `MOLTIS_WAKE_URL` and `MOLTIS_AGENT_TOKEN` for the daemon; `KLODI_NATS_URL` for the connection. See `docs/ENVIRONMENT.md` for the full env contract.

## 10. Open questions

- Hard-fail policy when `~/.moltis/config.toml` exists with malformed TOML — currently `klodi-moltis-register` exits with a wrapped TOML parse error.
- Lifecycle integration: can Moltis adopt the daemon as a managed service, or must operators always supervise it externally?
