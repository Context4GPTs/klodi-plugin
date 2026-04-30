# Moltis — klodi adapter spec

**Status:** draft (Phase 7 polish)
**Adapter source:** `klodi-plugin/adapters/moltis/`
**Distribution:** cargo `klodi-moltis` (binary crate)

## 1. Identity

Moltis is a host runtime where the agent runs out-of-process. The klodi adapter is a long-running tokio daemon (Rust) that owns one persistent NATS-WS connection and forwards each wake event to the host's local agent-wake API as an HTTP POST. The adapter is written in Rust and imports `async-nats` via the workspace `nats-client-rs` package.

host_shape: daemon

## 2. Tool registration

- **Registration API:** Moltis tools are exposed via the binary crate's CLI subcommands and via Moltis's HTTP control plane. Tools are not registered into an in-process agent runtime today.
- **Schema source:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs` (codegen output) compiled into the binary.
- **Tool families:**
  - **NATS request/reply passthrough:** every catalog tool dispatched through `KlodiClient::request(ToolName::*.subject(), &params, None)`.
  - **Local-state tools:** `klodi-moltis-register` (HTTP-only registration flow) handles credential bootstrap.
  - **Direct JetStream publish:** `klodi-moltis-channel-message` binary publishes via `KlodiClient::publish_channel_message(channel_id, body)`.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs`.

## 3. Lifecycle

- **Hook points:** `klodi-moltis-daemon` is supervised by the operator (systemd, foreman, etc.). Long-running tokio process.
- **`client.connect()`:** at daemon start.
- **`client.close()`:** at daemon stop (signal handler).
- **Restart / reload / sleep:** restart the daemon. OS sleep → idle WS → server `ping_interval` (20s) detects stale → `async-nats` reconnects.

## 4. Wake primitive

- **Native mechanism:** HTTP POST to a Moltis-side wake URL configured via env (`MOLTIS_WAKE_URL`, e.g. `http://127.0.0.1:5000/agents/default/wake`). Bearer auth via `MOLTIS_AGENT_TOKEN`.
- **Helper signature:** `forward_wake(envelope, target_url)` in `src/forwarder.rs`.
- **Failure semantics:** HTTP error → handler returns `Err` → consumer naks → JetStream redelivers per `max_deliver: 5` / `ack_wait: 30s`.
- **Per-host wake-routing config:** the operator sets the Moltis wake URL via env at daemon start. Klodi does not enforce — if the URL is wrong, wakes fail and JetStream redelivery surfaces the failure in operator logs.

## 5. Setup particulars

- **Phases:** the adapter does not expose `klodi_setup_status` in-agent today. Setup state is observable via daemon logs and the existence of `${klodi_home}/{nats.creds,config.json}`.
- **Issue codes:** none reported through a setup tool yet (deferred to Phase 7).
- **Fix kinds:** n/a in-agent. Operator-driven shell fixes for daemon misconfig.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default via `src/default_paths.rs`.

## 6. Skill delivery path

**Deferred to Phase 7.** The agent runs out-of-process; the daemon never sees the skill content. Open question (see § 10): which directory does the host's agent read instructions from, and how should the daemon (or its setup CLI) place the skill there? Until Moltis exposes a documented "system prompt fragments" surface or an instruction registry, users must load `${klodi_home}/skill/SKILL.md` manually as a system-prompt fragment.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # backend URL, user_id, handle (0600)
└── nats.creds                       # NKey signer (0600)
```

- **File ownership:** `klodi-moltis-register` writes `nats.creds` + `config.json` after a successful registration. The daemon never writes; it reads only.
- **Idempotency:** registration overwrites both files on success.

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/moltis/src/` cargo tests cover register trim-helpers and per-host bookkeeping. Wire-level encoding contracts are tested in `klodi-plugin/packages/nats-client-rs/`.
- **Integration / acceptance:** **deferred to Phase 7** (no live container fixture this round; no Moltis Docker image proven out yet for klodi).

## 9. Distribution and install

- **Package manager:** cargo (`klodi-moltis` binary crate).
- **Install command:**
  ```bash
  cargo install klodi-moltis
  klodi-moltis-register
  MOLTIS_WAKE_URL=http://127.0.0.1:5000/agents/default/wake \
  MOLTIS_AGENT_TOKEN=<bearer> \
      klodi-moltis-daemon
  ```
- **Required runtime version:** Moltis core ≥ current (specific minimum TBD when Phase 7 ratifies).
- **Required env / pre-existing files:** `MOLTIS_WAKE_URL` and `MOLTIS_AGENT_TOKEN` for the daemon; `KLODI_NATS_URL` for the connection. See `docs/ENVIRONMENT.md` for the full env contract.

## 10. Open questions

- Skill delivery (§ 6): which Moltis directory holds agent-instruction fragments, and what is the canonical mechanism for a plugin to register them?
- Setup tool surface: should the adapter mint an in-agent `klodi_setup_status` equivalent, or stay daemon-only?
- Lifecycle integration: can Moltis adopt the daemon as a managed service, or must operators always supervise it externally?
