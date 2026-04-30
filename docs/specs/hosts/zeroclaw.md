# ZeroClaw — klodi adapter spec

**Status:** draft (Phase 7 polish)
**Adapter source:** `klodi-plugin/adapters/zeroclaw/`
**Distribution:** cargo `klodi-zeroclaw` (binary crate)

## 1. Identity

ZeroClaw runs the agent inside a long-running daemon that owns one persistent NATS-WS connection. The adapter is a Rust binary crate; the daemon forwards each wake event to ZeroClaw's HTTP `/hooks/wake` endpoint. Imports `async-nats` via the workspace `nats-client-rs` package.

host_shape: daemon

## 2. Tool registration

- **Registration API:** binary crate CLI surface; in-agent registration TBD when ZeroClaw exposes a plugin-tool API.
- **Schema source:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs`.
- **Tool families:**
  - **NATS request/reply passthrough:** dispatched through `KlodiClient::request(...)`.
  - **Local-state tools:** `klodi-zeroclaw-register` (HTTP-only).
  - **Direct JetStream publish:** `klodi-zeroclaw-channel-message` binary.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs`.

## 3. Lifecycle

- **Hook points:** `klodi-zeroclaw-daemon` runs under operator supervision.
- **`client.connect()`:** at daemon start.
- **`client.close()`:** at daemon stop (signal handler).
- **Restart / reload / sleep:** restart the daemon.

## 4. Wake primitive

- **Native mechanism:** HTTP POST to `ZEROCLAW_HOOKS_WAKE_URL` (e.g. `http://127.0.0.1:7070/hooks/wake`). Bearer auth via `ZEROCLAW_AGENT_TOKEN`.
- **Helper signature:** `forward_wake(envelope, target_url)` in `src/forwarder.rs`.
- **Failure semantics:** HTTP error → handler returns `Err` → consumer naks → JetStream redelivers.
- **Per-host wake-routing config:** `ZEROCLAW_HOOKS_WAKE_URL` env var.

## 5. Setup particulars

- **Phases:** no in-agent `klodi_setup_status` today.
- **Issue codes:** none (deferred to Phase 7).
- **Fix kinds:** n/a in-agent.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default via `src/default_paths.rs`.

## 6. Skill delivery path

**Deferred to Phase 7.** Same open question as Moltis / IronClaw — out-of-process agent, daemon never sees skill content. See § 10.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # 0600
└── nats.creds                       # 0600
```

- **File ownership:** `klodi-zeroclaw-register` writes both files; daemon reads only.

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/zeroclaw/src/` cargo tests; wire encoding tested in `nats-client-rs/`.
- **Integration / acceptance:** **deferred to Phase 7**.

## 9. Distribution and install

- **Package manager:** cargo (`klodi-zeroclaw`).
- **Install command:**
  ```bash
  cargo install klodi-zeroclaw
  klodi-zeroclaw-register
  ZEROCLAW_HOOKS_WAKE_URL=http://127.0.0.1:7070/hooks/wake \
  ZEROCLAW_AGENT_TOKEN=<bearer> \
      klodi-zeroclaw-daemon
  ```
- **Required runtime version:** ZeroClaw core ≥ current (TBD).
- **Required env / pre-existing files:** `ZEROCLAW_HOOKS_WAKE_URL` and `ZEROCLAW_AGENT_TOKEN`; `KLODI_NATS_URL`. See `docs/ENVIRONMENT.md` for the full env contract.

## 10. Open questions

- Skill delivery (§ 6): same as Moltis / IronClaw.
- In-agent setup tool surface.
- Lifecycle integration with ZeroClaw's plugin manager when available.
