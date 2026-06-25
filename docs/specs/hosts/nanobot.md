# nanobot — klodi adapter spec

**Status:** ratified (lifecycle ownership deferred per D.4)
**Adapter source:** `klodi-plugin/adapters/nanobot/`
**Distribution:** pip `klodi-nanobot`

## 1. Identity

nanobot is a lifecycle-driven Python agent host. Agents subscribe to an event bus; the klodi adapter ships as two CLIs (`klodi-nanobot-setup` and `klodi-nanobot-daemon`) plus tool definitions consumable from any nanobot agent that imports `klodi-nanobot`. The daemon runs out-of-process from the agent and forwards each wake to the agent's event-bus channel via `nanobot events publish <channel> <body>`. The adapter is written in Python (3.10+) and imports `klodi-nats-client`.

host_shape: in_agent

## 2. Tool registration

- **Registration API:** nanobot exposes tool decorators / catalog import; `nanobot_tools.py` exports `TOOL_DEFINITIONS` (OpenAI-function-shape JSON Schemas) and `call_tool(name, args)` for the agent runtime to wire up.
- **Schema source:** `klodi-nats-client`'s bundled JSON Schema export (originally generated from `klodi-plugin/packages/tool-catalog/dist/schemas.json`). Augmented inside `nanobot_tools.py::_build_definitions()`.
- **Tool families:**
  - **NATS request/reply passthrough:** every catalog tool wraps `KlodiClient.request(subject, params)` via `call_tool`.
  - **Local-state tools:** none in `nanobot_tools.py` today; `klodi-nanobot-setup` handles registration / config bootstrap out-of-band.
  - **Direct JetStream publish:** `publish_channel_message(channel_id, body)` exposed for channel writes.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/dist/schemas.json`.

## 3. Lifecycle

- **Hook points:** `klodi-nanobot-daemon` is a long-running process the user supervises (systemd, foreman, etc.). The daemon owns the NATS connection and the event-bus forward for the lifetime of its process.
- **`client.connect()`:** at daemon start.
- **`client.close()`:** at daemon stop (signal handler).
- **Restart / reload / sleep:** restart the daemon to recover. OS sleep → idle WS → server `ping_interval` (20s) detects stale → `nats-py` reconnects.

## 4. Wake primitive

- **Native mechanism:** `nanobot events publish <channel> <body>` (subprocess invocation of the nanobot CLI).
- **Helper signature:** `_forward_wake(envelope)` in `nanobot_daemon.py` formats the wake text and shells out to `nanobot events publish`.
- **Failure semantics:** subprocess failure → handler raises → consumer naks → JetStream redelivers.
- **Per-host wake-routing config:** the channel name (default `klodi`) must be registered on nanobot's event bus; `klodi-nanobot-setup --channel <name>` does this best-effort at install time.

## 5. Setup particulars

- **Phases:** the daemon is the operational unit. `klodi_setup_status` tooling is not exposed inside the agent for nanobot today; setup state is observable via the daemon's logs and the existence of `${klodi_home}/{nats.creds,config.json}`.
- **Issue codes:** none reported through a setup tool yet (deferred to Phase 7).
- **Fix kinds:** n/a.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default (same as Hermes via the shared `nanobot_installer.py`).

## 6. Skill delivery path

- **Build-time bundle:** `klodi-plugin/adapters/nanobot/scripts/copy-skill.py` copies `klodi-plugin/klodi-skill/` into `klodi-plugin/adapters/nanobot/skills/klodi/`. The wheel includes this via `MANIFEST.in` (`recursive-include skills *`).
- **Install-time disk write:** `klodi-nanobot-setup` calls `seed_skill_dir(klodi_home, ${plugin_dir}/skills/klodi)` (via `nanobot_installer.py`) which force-copies the bundle into `${klodi_home}/skill/`. Idempotent.
- **Re-seed mechanism:** re-run `klodi-nanobot-setup`. No in-agent reseed tool today (deferred until nanobot exposes a richer in-process tool surface).

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # backend URL, user_id, handle (0600)
├── nats.creds                       # NKey signer (0600)
├── policies/
│   ├── negotiation_style.md         # seeded on first nanobot run
│   └── security.md                  # hard rules
├── skill/                           # canonical klodi skill bundle
└── (sell/, buy/ — populated on use)
```

- **File ownership:** `nanobot_setup_cli.py` + `nanobot_installer.py` own setup-time writes. `nanobot_daemon.py` reads creds/config but never writes the skill or policy trees.
- **Idempotency:** `seed_skill_dir` is force-overwrite. The setup CLI is idempotent.

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/nanobot/tests/test_tools.py` — static catalog shape assertions.
- **Integration / acceptance:** D.4 spec (nanobot wake e2e) — **deferred to Phase 7**. Container fixture requires the nanobot lifecycle ownership to be specified first (per spec line 487 of 0012). For this round: unit coverage of `nanobot_daemon.py` + `nanobot_tools.py` is sufficient.

## 9. Distribution and install

- **Package manager:** pip (`klodi-nanobot`).
- **Install command:**
  ```bash
  pip install --user klodi-nanobot
  klodi-nanobot-setup --channel klodi
  KLODI_NATS_URL=wss://klodi-net.4gpts.com klodi-nanobot-daemon --channel klodi
  ```
- **Required runtime version:** nanobot CLI ≥ current; Python 3.10+.
- **Required env / pre-existing files:** `KLODI_NATS_URL` (or the default `wss://klodi-net.4gpts.com`); `nanobot` CLI on PATH for channel registration.

## 10. Open questions

- Lifecycle ownership: nanobot does not (today) expose a daemon-start hook callable from the agent runtime. The user supervises the daemon manually. A future SDK version could let the daemon attach to the agent lifecycle directly.
- In-agent reseed tool: defer until nanobot grows an in-process tool registry; for now, re-running `klodi-nanobot-setup` is the recovery path.
- Live integration coverage (D.4) is deferred to Phase 7.
