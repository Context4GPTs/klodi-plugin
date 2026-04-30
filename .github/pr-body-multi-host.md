# multi-host

Reshapes the repo from a single TS plugin into a polyglot monorepo: 6 host adapters under `adapters/` and 8 shared internal packages under `packages/`. Backend wire is now NATS-WebSocket only — the webhook plane and the `klodi_pending` drain step are retired (per [plan 0012](../docs/plans/0012-nats-native-host-plugins.md)).

## What's new

- **Adapters** (one per host): `adapters/{openclaw,hermes,nanobot,ironclaw,moltis,zeroclaw}` — TS, Python, and Rust.
- **Shared packages** (internal, vendored into adapter bundles, never published standalone):
  - `packages/{logger,nats-client}-{ts,py,rs}`
  - `packages/tool-catalog` (TypeBox source of truth → JSON Schema for Python, serde structs for Rust).
- **TS package independence**: each TS package (`adapters/openclaw`, `packages/{logger-ts,nats-client-ts,tool-catalog}`) installs from its own directory. Cross-package deps use `file:` refs (e.g. `"@klodi/nats-client": "file:../../packages/nats-client-ts"`), mirroring the per-package independence already used by Python and Rust packages. No root `package.json`, no pnpm workspace.
- **Docs**: per-host specs under `docs/specs/hosts/`; rollout/security plans under `docs/plans/`.

## Coverage parity vs `main`

Old `src/__tests__/` was 28 files. New layout: 17 files / 202 tests in `adapters/openclaw/src/__tests__/`, plus tests inside the shared packages. Net coverage is comparable; what moved or dropped:

**Coverage moved into shared packages** (tested there now, not duplicated in the adapter):
- `lib/nats-client.test.ts`, `service/nats.test.ts`, `service/nats-handler-integration.test.ts` → `packages/nats-client-ts/tests/` (66 tests, 4 skipped).
- `lib/schemas.test.ts` → `packages/tool-catalog/tests/golden/` (golden fixtures).

**Coverage dropped (code was deleted)** — call out for reviewers:
- `service/notifications.test.ts`, `service/timers.test.ts` — internal pollers replaced by JetStream durable consumers in `wake-pump.ts`.
- `lib/api-config.test.ts`, `lib/duration.test.ts`, `lib/markdown-sections.test.ts` — helpers folded into `lib/config.ts` / `paths.ts` / removed.
- `tools/pending.test.ts` — `klodi_pending` retired; wakes carry full payloads.
- Heartbeat-cadence validation in old `lib/setup-state.test.ts` — host owns wake routing now (see plan 0012); plugin no longer inspects `agents.defaults.heartbeat.every`.

**Behaviors deliberately not re-asserted** because the underlying API changed:
- `klodi_search` `pickup_radius`/`ships_to` mapping — folded into the new `delivery: DeliveryFilter` discriminated union (`{method:"any"|"pickup"|"ship"|"digital", ...}`).
- Old buy-file fields (`check_every`, `last_checked`, `seen_listings`) — standing searches are server-side; buy files are pure on-disk policy.
- `klodi_setup_repair` exact internal-call ordering — the file-removal contract is what's locked; client teardown methods (`stopWakePump`, `closeClient`) replaced the old `resetNatsState`.

## CI / release wiring

All workflows had a pre-existing `klodi-plugin/...` path prefix bug (the YAMLs assumed this repo was checked out as a subdirectory called `klodi-plugin/` inside a parent monorepo). Fixed in:
- `klodi-plugin-release.yml` — paths corrected; install/build flow rewritten for the no-workspace model (per-package `pnpm install --frozen-lockfile` + `pnpm build` in dep order); npm + ClawHub publish now go through `pack-with-bundles.mjs` so the published tarball has concrete versions and bundled `node_modules/@klodi/*`.
- `klodi-plugin-smoke.yml` — paths corrected; smoke script handles its own per-package install + build.
- `klodi-adapters-pypi-release.yml`, `klodi-adapters-crates-release.yml`, `klodi-shared-crates-release.yml`, `klodi-plugin-rust.yml` — `klodi-plugin/` prefix stripped from every `working-directory`, `--manifest-path`, `pip install`, `pytest`, `make -C`, `twine` invocation.
- `pack-with-bundles.mjs` — fixed the same parent-monorepo path assumption (`REPO_ROOT/klodi-plugin/packages` → tarball's own `node_modules`); rewrite logic now handles `file:` refs instead of the retired `workspace:*`.
- `smoke-plugin-load.sh` — replaced `pnpm --filter @4gpts/klodi... build` with explicit dep-order `pnpm install + pnpm build` per package.
- Smoke + release stay on `workflow_dispatch` only until the first manual run is green; auto-on-push trigger blocks are commented in place.

## Repo hygiene

- `adapters/openclaw/skill/` removed from the tree and added to `adapters/openclaw/.gitignore` — `copy-skill.mjs` reseeds it from canonical `skill/` at every build, so the committed copy was a duplicate.
- README gained a "Repository layout" table making the published-vs-internal distinction explicit (adapters publish; `packages/*` are vendored-only).

## Verification

```
# Build TS deps in topological order (no workspace; file: refs)
( cd packages/tool-catalog   && pnpm install --frozen-lockfile && pnpm build )
( cd packages/nats-client-ts && pnpm install --frozen-lockfile && pnpm build )
( cd adapters/openclaw       && pnpm install --frozen-lockfile && pnpm build )

# Run tests
( cd adapters/openclaw    && pnpm test )   # 202 tests green
( cd packages/logger-ts   && pnpm install && pnpm test )   # 14 green
( cd packages/nats-client-ts && pnpm test )   # 66 green / 4 skipped

# Pack a publishable tarball with bundleDeps materialized
( cd adapters/openclaw && pnpm pack:inspect )
```

Smoke + release jobs need a manual `workflow_dispatch` once before re-enabling auto triggers.

## Out of scope (follow-ups)

- Dedicated CI for `packages/*` test runs (currently rely on adapter smoke + workspace `pnpm -r test`).
- Reseed of an `EnterPlanMode`-equivalent integration suite for end-to-end NATS flows — kept in the marketplace repo per the existing split.
- CONTRIBUTING.md / CODEOWNERS — defer or add separately; per-adapter READMEs cover the language toolchain entry points.
