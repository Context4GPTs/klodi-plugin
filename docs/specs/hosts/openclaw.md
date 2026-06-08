# OpenClaw — klodi adapter spec

**Status:** ratified
**Adapter source:** `klodi-plugin/adapters/openclaw/`
**Distribution:** npm `@4gpts/klodi` (primary via ClawHub, secondary via npm)

## 1. Identity

OpenClaw is a TypeScript agent gateway that loads klodi as an in-process plugin via `definePluginEntry` from `openclaw/plugin-sdk`. The agent runs inside the same Node process as the gateway; the klodi plugin shares its event loop. The adapter is written in TypeScript and imports `@klodi/nats-client` (workspace package, ships with the same NATS-WS stack as the other TS adapters: `@nats-io/nats-core@3.3.1`, `@nats-io/jetstream@3.3.1`, `ws@8.18.0`).

host_shape: in_agent

## 2. Tool registration

- **Registration API:** `api.registerTool({ name, label, description, parameters, execute })` from the OpenClaw plugin SDK.
- **Schema source:** `@klodi/tool-catalog` (TypeBox schemas); each adapter tool wraps a catalog tool descriptor and forwards args via `client.request(subject, params)`.
- **Tool families:**
  - **NATS request/reply passthrough:** identity, listings (`klodi_list_create` / `klodi_list_update` accept absolute local file paths in `photos` and run the adapter-internal mint + direct-to-R2 PUT pipeline before dispatch), discovery (`klodi_search`), offers, transactions, ratings, comments, channel reads.
  - **Local-state tools:** `klodi_register` (browser OAuth handoff), `klodi_register_poll` (manual fallback), `klodi_setup_status` / `klodi_setup_repair` / `klodi_setup_reseed_policies` (filesystem only). `klodi_health` probes the NATS connection and re-bootstraps on failure.
  - **Direct JetStream publish:** `klodi_channel_message` publishes via `client.publishChannelMessage(channel_id, body)` instead of round-tripping through a request/reply.
- **Catalog file:** `klodi-plugin/packages/tool-catalog/src/index.ts` (TypeBox tree); adapter tool wrappers live in `klodi-plugin/adapters/openclaw/src/tools/`.

## 3. Lifecycle

- **Hook points:** `gateway:startup` (probe creds; if present, eagerly connect NATS), `agent:bootstrap` (no-op — connection survives across agent boots), `command:new` (no-op), `command:reset` (no-op — connection persists). The `klodi-mcp` Node binary that previously brokered requests is gone (deleted in 0012).
- **`client.connect()`:** called lazily on the first credential-touching tool call (or eagerly during `gatherChecks` when creds are present). Connection state cached in `src/lib/client.ts`.
- **`client.close()`:** called from `klodi_setup_repair` only. Otherwise, the connection persists for the gateway's lifetime.
- **Restart / reload / sleep:** OS sleep → NATS sees idle WS → server-side `ping_interval` (20s) detects stale → client reconnects on next request. Gateway restart → connection recreated lazily on the next tool call. Plugin reload (`openclaw plugins reload klodi`) → SDK calls `dispose()` → adapter closes the client; next tool call re-bootstraps.

## 4. Wake primitive

- **Native mechanism:** `api.runtime.system.requestHeartbeatNow({ reason, sessionKey })` after `enqueueSystemEvent(text, { sessionKey })`. Both calls happen inside `wakeAgent(api, text, reason)` at `adapters/openclaw/src/service/wake.ts`.
- **Helper signature:** `async wakeAgent(api: PluginAPI, text: string, reason: string): Promise<void>`.
- **Failure semantics:** Enqueue failure → `wake.ts` logs `wake_failed` with `stage: "enqueue"` and returns early (no heartbeat, nothing queued; consumer naks via the outer handler). Heartbeat failure → `wake.ts` logs `wake_failed` with `stage: "heartbeat"` **and rethrows** — the consumer's catch naks the message and JetStream redelivers per `max_deliver: 5` / `ack_wait: 30s` (Decision 4).
- **Per-host wake-routing config (informational):** `agents.defaults.heartbeat.target = "last"` so `requestHeartbeatNow` routes the wake to the user's most recent session. Klodi does not enforce this — if the user runs the OpenClaw default of `target` other than `"last"`, `requestHeartbeatNow` returns success but routes the event to the wrong session and the user sees no wake. Documented as an informational hint in the OpenClaw README.

## 5. Setup particulars

- **Phases:** all five canonical phases (`unregistered | corrupt | degraded | needs_policy | ready`). No host-specific extension.
- **Issue codes:** `not_registered`, `partial_credentials`, `invalid_config`, `creds_perms`, `nats_disconnected`, `whoami_failed`, `policy_files_missing`, `policy_unfilled`. Heartbeat-related codes (`heartbeat_not_last`, `heartbeat_interval_too_long`) were deleted in 0.2.0.
- **Fix kinds:** mostly `tool` (e.g., call `klodi_register` or `klodi_setup_repair`). `creds_perms` is `shell` (`chmod 600 ${getCredsPath()}`). `policy_unfilled` is `dialog`.
- **`${klodi_home}` resolution:** `pluginConfig.klodi_home` → `KLODI_HOME` env → `~/.openclaw/workspace/.klodi`. The resolved value and source (`config | env | default`) are logged at `klodi_plugin_loaded` and surfaced in `klodi_setup_status.config.klodi_home_source`.

## 6. Skill delivery path

- **Build-time bundle:** `klodi-plugin/skill/` is the canonical source. `klodi-plugin/adapters/openclaw/copy-skill.mjs` runs at `pnpm build` and copies the tree into `klodi-plugin/adapters/openclaw/skill/` (gitignored). The npm `files` array includes `"skill"`, so the published tarball ships `skill/` at the package root.
- **Install-time disk write:** OpenClaw's plugin loader extracts the published tarball under `~/.openclaw/extensions/<id>/`; the bundled `skill/` is referenced by `openclaw.plugin.json#skills`. There is no separate "write skill to klodi_home" step — OpenClaw resolves skill files from the plugin's installed root.
- **Re-seed mechanism:** `pnpm copy-skill` at build time. On the user side, re-installing the plugin pulls a fresh skill bundle. `klodi_setup_reseed_policies` re-seeds only the policy files under `${klodi_home}/policies/`.

## 7. Local-state files

```
${klodi_home}/                       # mode 0700
├── config.json                      # backend URL, user_id, handle, NKey public, nats_url (0600)
├── nats.creds                       # NKey signer (0600)
├── policies/
│   ├── negotiation_style.md         # seeded from skill template; user-edited
│   └── security.md                  # hard rules; verbatim copy
├── sell/<slug>.md                   # per-listing strategy (0644, plugin-authored, user-edited)
└── buy/<slug>.md                    # per-standing-search strategy (0644)
```

- **File ownership:** `lib/config.ts` owns both `config.json` and `nats.creds` reads (including the `creds_perms` mode check). `lib/paths.ts` owns `${klodi_home}` resolution. `lib/sell-buy-files.ts` owns per-listing / per-search frontmatter parse + write (one file, both shapes); `service/state.ts` is the side-effect dispatch that tools call after successful NATS operations. `lib/policy-seeding.ts` seeds `policies/{negotiation_style,security}.md` non-destructively. `tools/setup.ts` orchestrates `klodi_setup_repair` (deletes `nats.creds` + `config.json` only) and the reseed tools (`klodi_setup_reseed_policies`, `klodi_setup_reseed_skill`).
- **Idempotency:** policy-seeding helpers are non-destructive — present file → no-op. `klodi_setup_reseed_policies` follows the same rule. `klodi_setup_reseed_skill` is force-overwrite (canonical-source-of-truth model).

## 8. Test entry points

- **Unit:** `klodi-plugin/adapters/openclaw/src/__tests__/service/state.test.ts` and `__tests__/service/wake.test.ts` cover the side-effect dispatch and the wake helper's rethrow contract. Other modules rely on cross-language wire tests in `packages/nats-client-ts/tests/` and the catalog golden corpus.
- **Integration / acceptance:** top-level `tests/e2e/` (`@klodi/tests` workspace) brings up `docker-compose.e2e.yml` with seller + buyer OpenClaw containers and runs `tests/e2e/agent-journey.test.ts`. Wake-specific assertions per Decision 13 D.2 land at `klodi-plugin/adapters/openclaw/tests/integration/wake-e2e.integration.test.ts` (planned).
- **B.3-throw test (Decision 4):** unit test of `wake.ts` mocking `api.runtime.system` so `requestHeartbeatNow` throws once → assert `wake.ts` rethrows. Lives at `klodi-plugin/adapters/openclaw/src/__tests__/service/wake.test.ts`.

## 9. Distribution and install

- **Package manager:** npm (`@4gpts/klodi`) with ClawHub as primary distribution.
- **Install command:**
  ```bash
  openclaw plugins install clawhub:@4gpts/klodi    # ClawHub explicit
  openclaw plugins install @4gpts/klodi             # auto-resolve (ClawHub first, npm second)
  openclaw plugins install /path/to/klodi-plugin/adapters/openclaw   # local checkout
  ```
- **Required runtime version:** `pluginApi >= 2026.4.1`, `minGatewayVersion >= 2026.4.15` (per `package.json#openclaw.compat` and `openclaw.install.minHostVersion`; the 2026.4.15 floor pins the host's `npm install --ignore-scripts` enforcement that ADR-0008 depends on).
- **ClawHub publish — never pass `--owner`.** `package.json#scripts.publish:clawhub*` must omit the `--owner` flag. The package is org-scoped (`@4gpts/klodi`, owner `4gpts`), so ownership is derived from the scoped name; an explicit `--owner` injects a conflicting `ownerHandle` into the server-side `packages:publishRelease` Convex action and crashes it with a bare `[CONVEX A(packages:publishRelease)] Server Error`. Enforced by `src/__tests__/publish-clawhub-owner.test.ts`.
- **Required env / pre-existing files:** none. All paths default; `KLODI_HOME` and `KLODI_API_URL` env vars are optional.
- **Required config keys for plugin load:** none beyond the plugin's own `plugins.entries.klodi` block. In particular, `agents.defaults.model` / `models` is **not** required — the host (`alpine/openclaw:2026.4.15`, the `minGatewayVersion` floor) parses and accepts a config with no model block and installs+loads the plugin against it. Settled empirically by the plugin-load smoke gate (`scripts/smoke-plugin-load.sh`), which deliberately stages a model-less config so the gate proves *load*, not model selection. The plugin reads only `cfg.agents.list` (`src/service/wake.ts`), never the model keys, so a model in the config is inert to klodi regardless.

## 10. Open questions

None at the time of writing. Future:

- If silent wake-routing failures (`heartbeat.target != "last"`) become common in the field, add a runtime probe at install time (publish a synthetic wake; mark `degraded` with `wake_not_landing` if the user's adapter doesn't ack within N seconds). Not in scope for 0012.
- Side-consumer authorization escalation (Decision 12 / threat F.1): defer to operator action triggered by `unauthorized_channel_publish` log signal.
