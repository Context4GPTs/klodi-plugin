---
id: 0008-bundled-deps-host-ignore-scripts
title: Runtime deps via `bundleDependencies` + host-enforced `--ignore-scripts`
tags: [publish, supply-chain, superseded]
card: pre-harness
commit: 07522fc
updated_at: 2026-04-30
updated_by_card: pre-harness
---

# ADR-0008 — Runtime deps via `bundleDependencies` + host-enforced `--ignore-scripts`

## Status

**Superseded** by [ADR-0009](./0009-vendored-ts-workspace-deps.md) on 2026-04-30. Supersedes [ADR-0003](./0003-vendored-runtime-dependencies.md). Original date: 2026-04-27.

Addressed *Install Mechanism — the previous packaging (ADR-0003) maintained two parallel sources of truth for the runtime dependency graph and depended on ClawHub-specific ingest behaviour. The plugin must boot identically through every supported install path while preserving the no-install-time-code-execution guarantee.*

> **Why superseded.** The decision below assumed ClawHub's ingest preserved the top-level `node_modules/` while stripping only `dist/node_modules/`. Inspection of `clawhub@<version>/dist/cli/commands/packages.js` (lines 517 and 542) showed `node_modules/` is hardcoded into the publish-time ignore list — it is stripped from every depth of the tree at upload, with no `bundleDependencies` awareness. The published 0.2.0 tarball reached users without the workspace deps, and `npm install` on the user's host failed to resolve `@klodi/nats-client@0.1.0` and `@klodi/tool-catalog@0.1.0` against the public registry (where they do not exist). ADR-0009 ports the cross-language vendor pattern (see `adapters/{hermes,ironclaw,moltis,nanobot,zeroclaw}/scripts/vendor.py`) to the TypeScript adapter: workspace deps ride into the tarball as inlined source under `dist/_vendor/_klodi_openclaw_<pkg>/` rather than as nested `node_modules/<pkg>/` packages.

## Context

The OpenClaw plugin imports `@klodi/tool-catalog`, `@klodi/nats-client` (workspace packages, never published to the public registry) and a small set of public-registry packages (`@nats-io/*`, `ws`, `gray-matter`, `tweetnacl`, `@sinclair/typebox`). All of these must resolve at runtime when the plugin is loaded into an OpenClaw process.

Three install paths the plugin must support:

1. **Direct tarball install** — `openclaw plugins install <tarball.tgz>` against the artefact produced by `scripts/pack-with-bundles.mjs`. (`pnpm pack` itself rejects `bundleDependencies` under `node-linker=isolated` with `ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED`; the wrapper materialises bundles into clean `node_modules/<name>/` and delegates to `npm pack`.)
2. **ClawHub install** — `openclaw plugins install clawhub:@4gpts/klodi` against the registry-served artefact.
3. **Local source install for dev / e2e** — `openclaw plugins install /opt/klodi-plugin` from a bind-mounted source tree.

ADR-0003 satisfied (1)–(3) by vendoring every runtime dependency into `dist/node_modules/` at build time via `vendor-deps.mjs`. That approach had two structural problems:

- **Two sources of truth.** `package.json#dependencies` and the explicit `EXTERNAL` list inside `vendor-deps.mjs` had to stay in lock-step. They drifted (0.1.11 shipped with runtime deps in `devDependencies` only; only the vendoring path resolved them, ClawHub install crashed at load).
- **Two tarball shapes.** ClawHub strips `package/dist/node_modules/` on ingest. Direct-tarball install kept it. The smoke gate had to test both variants and prove both work — the variants only co-exist because of the strip behaviour, which is a registry-implementation detail leaking into the plugin's own packaging design.

OpenClaw 2026.4.15 invokes plugin installs with `npm install --omit=dev --silent --ignore-scripts` (`/app/dist/install-package-dir-BYliCAhg.js:225–230` in the host runtime). That guarantee did not exist explicitly when ADR-0003 was written; with it now verified, the host can re-resolve public-registry transitives at install time without the postinstall risk vendoring was protecting against.

## Decision

- **Workspace deps ride in via `bundleDependencies`.** `package.json#bundleDependencies` lists `@klodi/tool-catalog` and `@klodi/nats-client`. `scripts/pack-with-bundles.mjs` materialises each into `node_modules/<name>/` in the published tarball — a path ClawHub preserves on ingest.
- **Public-registry deps stay in `package.json#dependencies`.** The host's `npm install` resolves them after extraction.
- **`vendor-deps.mjs` and `dist/node_modules/` are removed.** A single tarball shape is published.
- **Bundled workspace `package.json#scripts`, `dependencies`, and `devDependencies` are stripped at pack time** (`pack-with-bundles.mjs` `materialize()`). Stripping `scripts` ensures a bundled workspace dep cannot run install hooks even if the host stops passing `--ignore-scripts`. Stripping `dependencies` is a packaging-mechanics requirement: with the field intact, `npm pack` recursively walks transitive deps to bundle them; under pnpm's `node-linker=isolated` those resolve to `.pnpm/<dep>/node_modules/<dep>/` symlinks, which `npm pack` then records with `package/../../../node_modules/.pnpm/...` directory-traversal entries that produce an unextractable tarball. Runtime still resolves transitives via the outer `package.json#dependencies` after the host's `npm install`.
- **`pack-with-bundles.mjs` rewrites `workspace:*` specifiers to concrete versions** read from each bundled package's own `package.json`. `npm pack` does not do this; without rewrite, `workspace:*` in the published tarball is uninstallable.
- **Min host version pinned.** `openclaw.install.minHostVersion: ">=2026.4.15"` refuses installation on hosts where `--ignore-scripts` enforcement has not been verified.
- **Smoke gate asserts both shape and behaviour.** `scripts/smoke-plugin-load.sh` extracts the packed tarball, asserts (a) bundled workspace deps present at `node_modules/@klodi/<name>/`, (b) `dist/node_modules/` absent (regression guard against re-introduced vendoring), then runs `openclaw plugins install` end-to-end against the pinned image and greps for the `klodi_plugin_loaded` marker.

## Alternatives considered

1. **Keep vendoring (ADR-0003).** Rejected. Two-source-of-truth drift caused real production failures (0.1.11). The fix that eventually shipped (declare deps in both lists) re-introduces the same drift surface for every future dep change.
2. **Publish `@klodi/tool-catalog` and `@klodi/nats-client` to the public npm registry.** Rejected. They are private internal contracts shared across the plugin tree, not stable public surfaces. Public versioning would force semver discipline on internal refactors.
3. **`npm install` on the host without `--ignore-scripts`.** Rejected. This re-opens transitive `postinstall` execution on the user's machine. The host enforcement is the load-bearing constraint here; without it the design degrades.
4. **Bundle public-registry deps too.** Rejected. ClawHub's strip behaviour deliberately removes nested `node_modules/` to force registry-driven dep resolution; bundling public deps would either be stripped (back to square one) or carved out by a registry-specific exception. Re-resolution via `npm install` is the path the registry expects.

## Security implications

The install-time code execution guarantee from ADR-0003 is **preserved**, but the mechanism is now layered:

| Layer | Protects against | Mechanism |
|---|---|---|
| 1 | Plugin's own install scripts | `package.json#scripts` has no `preinstall`/`install`/`postinstall` (verifiable: `grep -E '"(pre\|post)?install"' package.json` returns only the `openclaw.install` config block) |
| 2 | Bundled workspace deps' install scripts | `pack-with-bundles.mjs` `materialize()` strips `scripts` from each bundled `package.json` before `npm pack` |
| 3 | Public-registry transitive deps' install scripts | OpenClaw `>=2026.4.15` passes `--ignore-scripts` to `npm install` (`install-package-dir-BYliCAhg.js:225–230`); plugin pins `openclaw.install.minHostVersion: ">=2026.4.15"` |

**New trust dependency.** Layer 3 lives in the host, not in the plugin. If a future host version drops `--ignore-scripts`, transitive postinstalls become reachable — the runtime deps today (`@nats-io/*`, `ws`, `tweetnacl`, `@sinclair/typebox`, `gray-matter`) declare none, but that is observed-not-contractual. The `minHostVersion` pin is the contract: a bump moves the supported floor and re-runs the smoke gate against the new host version, which structurally re-verifies the flag.

**Single tarball shape.** The previous "did variant A pass but variant B fail?" failure mode is eliminated — there is one tarball, exercised end-to-end against the pinned host image before publish.

**Reproducibility.** `pack-with-bundles.mjs` is deterministic given a clean working tree. Mutations are confined to (a) `package.json` (`workspace:*` → concrete version), (b) `node_modules/<bundleDep>/` (symlink → lean directory). Both are recorded before mutation and restored in `finally` — source tree returns to git-clean on success or failure.

**Auditability.** `tar -tzf <tarball> | sort` enumerates every file shipped. The bundle surface is exactly `node_modules/@klodi/<name>/` (workspace) and `package.json#dependencies` (public). No `dist/node_modules/`, no minification, no bundler.

## References

- Code: `klodi-plugin/adapters/openclaw/scripts/pack-with-bundles.mjs`
- Code: `klodi-plugin/adapters/openclaw/scripts/smoke-plugin-load.sh`
- Code: `klodi-plugin/adapters/openclaw/package.json#bundleDependencies`, `package.json#openclaw.install.minHostVersion`
- Host evidence: `alpine/openclaw:2026.4.15` `/app/dist/install-package-dir-BYliCAhg.js:225–230` invokes `npm install --omit=dev --silent --ignore-scripts`
- Supersedes: [ADR-0003](./0003-vendored-runtime-dependencies.md)
- Related: [SECURITY.md § Dependencies](../../SECURITY.md), [THREAT_MODEL.md § T7](../THREAT_MODEL.md)
