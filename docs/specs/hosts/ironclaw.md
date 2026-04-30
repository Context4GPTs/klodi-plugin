# IronClaw — klodi adapter spec

**Status:** draft (Phase 7 polish)
**Adapter source:** `klodi-plugin/adapters/ironclaw/`
**Distribution:** cargo `klodi-ironclaw` (binary crate)

## 1. Identity

IronClaw runs the agent inside a long-running daemon that owns one persistent NATS-WS connection. The adapter is a Rust binary crate; the daemon forwards each wake event to IronClaw's HTTP `/event-trigger` endpoint. Imports `async-nats` via the workspace `nats-client-rs` package.

host_shape: daemon

## 2. Tool registration

- **Registration API:** IronClaw plugin entry registers tools via its plugin lifecycle; in this round the adapter is supervised externally and exposes tool surface via the binary crate's CLI.
- **Schema source:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs`.
- **Tool families:**
  - **NATS request/reply passthrough:** dispatched through `KlodiClient::request(...)`.
  - **Local-state tools:** `klodi-ironclaw-register` (HTTP-only).
  - **Direct JetStream publish:** `klodi-ironclaw-channel-message` binary.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/dist/rust-types.rs`.

## 3. Lifecycle

- **Hook points:** `klodi-ironclaw-daemon` runs under operator supervision (systemd or IronClaw's plugin lifecycle, when available).
- **`client.connect()`:** at daemon start.
- **`client.close()`:** at daemon stop (signal handler).
- **Restart / reload / sleep:** restart the daemon; idle WS recovers via server-side ping.

## 4. Wake primitive

- **Native mechanism:** HTTP POST to `IRONCLAW_EVENT_URL` (e.g. `http://127.0.0.1:7171/event-trigger`). Bearer auth via `IRONCLAW_AGENT_TOKEN`.
- **Helper signature:** `forward_wake(envelope, target_url)` in `src/forwarder.rs`.
- **Failure semantics:** HTTP error → handler returns `Err` → consumer naks → JetStream redelivers.
- **Per-host wake-routing config:** `IRONCLAW_EVENT_URL` env var.

## 5. Setup particulars

- **Phases:** no in-agent `klodi_setup_status` today.
- **Issue codes:** none (deferred to Phase 7).
- **Fix kinds:** n/a in-agent.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default via `src/default_paths.rs`.

## 6. Skill delivery path

**Deferred to Phase 7.** Same open question as Moltis — out-of-process agent, daemon never sees skill content. See § 10.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # 0600
└── nats.creds                       # 0600
```

- **File ownership:** `klodi-ironclaw-register` writes both files; daemon reads only.
- **Idempotency:** registration overwrites on success.

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/ironclaw/src/` cargo tests; wire encoding tested in `nats-client-rs/`.
- **Integration / acceptance:** **deferred to Phase 7**.

## 9. Distribution and install

- **Package manager:** cargo (`klodi-ironclaw`).
- **Install command:**
  ```bash
  cargo install klodi-ironclaw
  klodi-ironclaw-register
  IRONCLAW_EVENT_URL=http://127.0.0.1:7171/event-trigger \
  IRONCLAW_AGENT_TOKEN=<bearer> \
      klodi-ironclaw-daemon
  ```
- **Required runtime version:** IronClaw core ≥ current (specific minimum TBD when Phase 7 ratifies).
- **Required env / pre-existing files:** `IRONCLAW_EVENT_URL` and `IRONCLAW_AGENT_TOKEN`; `KLODI_NATS_URL`. See `docs/ENVIRONMENT.md` for the full env contract.

## 10. Open questions

- Skill delivery (§ 6): same as Moltis — needs a documented IronClaw mechanism for plugin-supplied agent instructions.
- In-agent setup tool surface.
- Lifecycle integration with IronClaw's plugin manager when available.
