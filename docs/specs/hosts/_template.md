# <Host Name> — klodi adapter spec

**Status:** <draft | ratified | deprecated>
**Adapter source:** `klodi-plugin/adapters/<host>/`
**Distribution:** <e.g., npm `@4gpts/klodi`, pip `klodi-hermes`, cargo `klodi-moltis`>

## 1. Identity

One paragraph: what this host is, where the agent runs (in-process / out-of-process), what
language the adapter is written in, what NATS client library it imports.

## 2. Tool registration

How the adapter declares klodi tools to the host runtime.

- Registration API (e.g., `api.registerTool({...})` for OpenClaw, `ctx.register_tool(...)` for Hermes).
- Schema source — is it the catalog's TypeBox / generated JSON Schema / generated Rust types?
- For each tool family, whether it's a NATS request/reply passthrough or a local-state tool
  (browser-OAuth, file-write, direct JetStream publish).
- Reference to the catalog file the adapter imports.

## 3. Lifecycle

The connection-ownership contract from 0012 § Lifecycle.

- What lifecycle events the adapter hooks (e.g., OpenClaw `gateway:startup` /
  `agent:bootstrap` / `command:new` / `command:reset`; Hermes daemon start/stop).
- When `client.connect()` is called.
- When `client.close()` is called.
- What happens on host restart, plugin reload, OS sleep.

## 4. Wake primitive

How the adapter wakes the agent when a notification or channel message arrives.

- The host's native wake mechanism (e.g., `api.runtime.system.requestHeartbeatNow` for OpenClaw,
  `ctx.event_bus.publish(...)` for Hermes, `POST /event-trigger` for IronClaw).
- What signature the wake helper exposes (`wakeAgent(api, text, reason)` etc.).
- Failure semantics — does the helper throw on error so the JetStream consumer naks and
  redelivers, or catch-and-log?
- Per-host wake-routing config the user must set (e.g., OpenClaw `agents.defaults.heartbeat.target = "last"`).
  This is **informational** — klodi does not enforce host config; the README points users at
  the host's docs.

## 5. Setup particulars

What `klodi_setup_status` returns for this host that's host-specific.

- Phases the adapter can return (subset of the canonical
  `unregistered | corrupt | degraded | needs_policy | ready`).
- Issue codes the adapter emits.
- Which fixes are `kind = shell | tool | dialog`.
- The `${klodi_home}` resolution rule used.

## 6. Skill delivery path

Where the adapter materializes `klodi-plugin/skill/` for the agent to read.

- Build-time bundle path (e.g., npm package's `skill/` root, wheel's `package_data`).
- Install-time disk write (e.g., `${klodi_home}/skill/` on first `klodi-<host>-setup`).
- Re-seed mechanism (e.g., `klodi_setup_reseed_skill` or `klodi_setup_reseed_policies` extension).
- For Rust daemons (Moltis / IronClaw / ZeroClaw): which directory the host's agent reads
  instructions from, and how the daemon (or its setup CLI) places the skill there.

## 7. Local-state files

Files the adapter manages on disk (sell/buy files, policy files, creds).

- Path layout under `${klodi_home}`.
- File ownership (which adapter code reads/writes each file).
- Idempotency / overwrite rules.

## 8. Test entry points

Where each test from the 0012 first-pass review acceptance table lives for this host.

- **Unit** — `*.test.ts` / `test_*.py` adjacent to the source.
- **Integration** — `klodi-plugin/adapters/<host>/tests/integration/` (or `tests/e2e/` for full-stack).
- Real-Docker fixture file (e.g., `docker-compose.e2e.yml` services, `tests/e2e/global-setup.ts`
  orchestration), or "deferred" with the open question that needs to be answered first.

## 9. Distribution and install

How users install this adapter.

- Package manager (npm / pip / cargo / direct binary).
- Install command (e.g., `pip install klodi-hermes`, `openclaw plugins install @4gpts/klodi`).
- Required version of the host runtime.
- Required env vars or pre-existing files.

## 10. Open questions

Anything unresolved for this host that blocks a future phase. Cross-reference to the spec
or to the relevant review.
