# Hermes — klodi adapter spec

**Status:** ratified
**Adapter source:** `klodi-plugin/adapters/hermes/`
**Distribution:** pip `klodi-hermes`; Hermes plugin clone via `hermes plugins install Context4GPTs/klodi-plugin`

## 1. Identity

Hermes is a Python agent runtime with a plugin model that clones a repo into `~/.hermes/plugins/<name>/`, reads `plugin.yaml`, and calls `register(ctx)` from `__init__.py`. The agent runs in-process inside the Hermes daemon. The adapter is written in Python (3.10+) and imports `klodi-nats-client` (workspace package, currently `nats-py` based with the same NATS-WS stack as the other adapters).

host_shape: in_agent

## 2. Tool registration

- **Registration API:** `ctx.register_tool(name=, toolset=, schema=, handler=, ...)`. Skills register via `ctx.register_skill(name, skill_md_path)`.
- **Schema source:** `klodi-nats-client` carries the JSON Schema export from `klodi-plugin/packages/tool-catalog/dist/schemas.json` (codegen output). Local tools have hand-written JSON Schema in `local_tools.py` / `register.py` / `watch.py`.
- **Tool families:**
  - **NATS request/reply passthrough:** registered via `register_request_tools(ctx, check_fn)` in `tools.py`; each tool wraps `KlodiClient.request(subject, params)`.
  - **Local-state tools:** `klodi_register` / `klodi_register_poll` (browser OAuth), `klodi_setup_*` (filesystem health checks + reseed), `klodi_watch` / `klodi_unwatch` (server-side standing searches plus on-disk buy file).
  - **Direct JetStream publish:** `klodi_channel_message` publishes via `client.publish_channel_message(channel_id, body)`.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/dist/schemas.json` (consumed by `klodi-nats-client` at import time); adapter wrappers in `klodi-plugin/adapters/hermes/tools.py`.

## 3. Lifecycle

- **Hook points:** `register(ctx)` is called once at plugin load (after `hermes plugins enable klodi`). There is no explicit unload hook in the SDK today; resources release at process exit. `shutdown(ctx)` is exposed on the module for future SDK versions and for tests.
- **`client.connect()`:** called inside `register(ctx)` immediately after tool registration, so the connection is open by the time the agent issues its first call.
- **`client.close()`:** called by `shutdown(_ctx)`; on Hermes today this only fires under explicit test teardown.
- **Restart / reload / sleep:** Hermes restart → `register(ctx)` re-runs → connection re-established. Plugin reload (`hermes plugins reload klodi`) is not in the current SDK; users restart the daemon. OS sleep → idle WS → server `ping_interval` (20s) detects stale → `nats-py` reconnects on next request.

## 4. Wake primitive

- **Native mechanism:** `ctx.inject_message(text, role=...)`. Hermes's event bus delivers the message into the active session.
- **Helper signature:** `handle_notification(envelope)` and `handle_channel_message(envelope)` in `wake_handlers.py`; both call into `ctx.inject_message(...)` after formatting the wake text from the catalog payload.
- **Failure semantics:** handler exception → `klodi-nats-client` consumer naks → JetStream redelivers per `max_deliver: 5` / `ack_wait: 30s`. Per-consumer LRU dedup on `event_id` absorbs duplicates.
- **Per-host wake-routing config:** none required. Hermes's event bus delivers in-process; there is no cross-session routing question.

## 5. Setup particulars

- **Phases:** all five canonical phases (`unregistered | corrupt | degraded | needs_policy | ready`) — same surface as OpenClaw.
- **Issue codes:** mirror OpenClaw — `not_registered`, `partial_credentials`, `invalid_config`, `creds_perms`, `nats_disconnected`, `whoami_failed`, `policy_files_missing`, `policy_unfilled`. No host-specific codes.
- **Fix kinds:** mostly `tool` (e.g., `klodi_register`, `klodi_setup_repair`, `klodi_setup_reseed_policies`, `klodi_setup_reseed_skill`). `creds_perms` is `shell`. `policy_unfilled` is `dialog`.
- **`${klodi_home}` resolution:** `KLODI_HOME` env → platform default (`~/Library/Application Support/klodi` on macOS, `${XDG_CONFIG_HOME}/klodi` on Linux, `%APPDATA%/klodi` on Windows).

## 6. Skill delivery path

- **Build-time bundle:** `klodi-plugin/klodi-skill/` is the canonical source. `klodi-plugin/adapters/hermes/scripts/copy-skill.py` copies the tree into `klodi-plugin/adapters/hermes/src/klodi_hermes/skills/klodi/` (gitignored). The wheel includes this via `MANIFEST.in` (`recursive-include skills *`); `__init__.py::_register_skills` registers everything under `${plugin_dir}/skills/` with Hermes's skill API at plugin load.
- **Install-time disk write:** `klodi-hermes-setup` calls `seed_skill_dir(klodi_home, ${plugin_dir}/skills/klodi)` (via `hermes_installer.py`) which force-copies the bundle into `${klodi_home}/skill/`. Idempotent.
- **Re-seed mechanism:** `klodi_setup_reseed_skill` local tool re-runs the same copy at runtime (used after a plugin upgrade if the on-disk skill drifts).

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # backend URL, user_id, handle (0600)
├── nats.creds                       # NKey signer (0600)
├── policies/
│   ├── negotiation_style.md         # seeded from skill template; user-edited
│   └── security.md                  # hard rules; verbatim copy
├── skill/                           # canonical klodi skill bundle (force-copied)
│   ├── SKILL.md
│   ├── policies/
│   ├── references/
│   └── templates/
├── sell/<slug>.md                   # per-listing strategy (plugin-authored, user-edited)
└── buy/<slug>.md                    # per-standing-search strategy
```

- **File ownership:** `local_tools.py` owns `config.json` reads and `klodi_setup_*` writes. `register.py` writes `nats.creds` + `config.json` after a successful claim. `watch.py` owns `buy/<slug>.md`. The skill tree is owned by `hermes_installer.py::seed_skill_dir` and the `klodi_setup_reseed_skill` handler in `local_tools.py`.
- **Idempotency:** `seed_skill_dir` force-overwrites the skill bundle (canonical-source-of-truth model). Policy seeding is non-destructive (`_seed_if_absent`).

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/hermes/tests/test_register.py`, `test_local_tools.py`, `test_skill_install.py`. Stubs allowed.
- **Integration / acceptance:** D.3 spec (Hermes wake e2e) calls for a real Hermes container fixture adapted from `demo/docker-compose.hermes.yml`. The adapted compose lives at `klodi-plugin/adapters/hermes/tests/integration/docker-compose.hermes.e2e.yml`; orchestration via `tests/e2e/` reusing `tests/e2e/global-setup.ts`. Real NATS, real Postgres, real Hermes container with the adapter installed; assert wake reaches Hermes session via the event/session log.

## 9. Distribution and install

- **Package manager:** pip (`klodi-hermes`); Hermes plugin clone (`hermes plugins install Context4GPTs/klodi-plugin`).
- **Install command:**
  ```bash
  pip install --user klodi-hermes              # CLI for KLODI_HOME setup + skill seed
  klodi-hermes-setup                           # ensures ${klodi_home}/skill/ is populated
  hermes plugins install Context4GPTs/klodi-plugin   # registers the adapter
  hermes plugins enable klodi
  ```
- **Required runtime version:** Hermes plugin SDK v0.3.0+; Python 3.10+.
- **Required env / pre-existing files:** none. `KLODI_HOME` and `KLODI_API_URL` env vars optional.

## 10. Open questions

- Hermes plugin SDK does not expose a hot-reload / unload hook today. Connection lifetime is the daemon's lifetime; if Hermes adds an unload hook, wire `shutdown(ctx)` into it.
- Live integration coverage (D.3) is planned but not yet landed in this round.
