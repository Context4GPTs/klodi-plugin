---
id: 0009-vendored-ts-workspace-deps
title: Workspace TS deps vendored into `dist/_vendor/` at publish time
tags: [publish, vendoring, typescript]
card: pre-harness
commit: 2e8d5d8
updated_at: 2026-06-23
updated_by_card: pack-or-strip-vendored-toolcatalog-sourcemaps
---

# ADR-0009 — Workspace TS deps vendored into `dist/_vendor/` at publish time

## Status

Accepted (2026-04-30). Supersedes [ADR-0008](./0008-bundled-deps-host-ignore-scripts.md). Addresses *Install Mechanism — ADR-0008 assumed ClawHub's ingest preserved top-level `node_modules/` while stripping only `dist/node_modules/`. That assumption was wrong; the published 0.2.0 tarball arrived at users without the workspace deps and `npm install` failed against the public registry.*

## Context

The OpenClaw plugin imports two workspace packages — `@klodi/tool-catalog` and `@klodi/nats-client` — that are private to this repository (`private: true`, never published to the npm registry). It also imports public-registry packages (`@nats-io/*`, `ws`, `gray-matter`, `tweetnacl`, `@sinclair/typebox`) that the host's `npm install` resolves at install time.

ADR-0008 satisfied the workspace-dep half of this graph by riding the `bundleDependencies` mechanism: `pack-with-bundles.mjs` materialised each workspace dep into a top-level `node_modules/@klodi/<name>/` directory inside the tarball, on the assumption that ClawHub's ingest preserved that path. Inspection of the ClawHub publish CLI showed otherwise:

```js
// clawhub/dist/cli/commands/packages.js:517
ig.add([".git/", "node_modules/", `${DOT_DIR}/`, `${LEGACY_DOT_DIR}/`]);

// clawhub/dist/cli/commands/packages.js:542
if (entry.name === ".git" || entry.name === "node_modules") continue;
```

`node_modules/` is hardcoded into both the ignore-pattern set and the directory walker, with no `bundleDependencies` awareness and no path-depth scoping. The CLI strips it at every depth of the source tree at upload time, regardless of whether the publishing tarball had it bundled.

The 0.2.0 publish reached the registry without `node_modules/@klodi/nats-client/` or `node_modules/@klodi/tool-catalog/`. On user installs, `npm install` saw `@klodi/nats-client@0.1.0` and `@klodi/tool-catalog@0.1.0` listed in `package.json#dependencies` (rewritten from `file:` to a concrete version by `pack-with-bundles.mjs`), tried to resolve them against `registry.npmjs.org`, and 404'd. The plugin failed to install.

The structural problem with ADR-0008 is not implementation-fixable: as long as the publish path goes through ClawHub's CLI, no `bundleDependencies` arrangement reaches users. The mechanism has to change.

## Decision

Adopt the build-time vendor pattern already used by every Rust and Python adapter in this repository (`adapters/{hermes,ironclaw,moltis,nanobot,zeroclaw}/scripts/vendor.py`):

- **Workspace deps are vendored into the publish artefact as inlined source.** `scripts/vendor.mjs` stages a publish-ready tree at `adapters/openclaw/.publish-stage/` containing the adapter's compiled JS plus a peer copy of each workspace dep's compiled JS under a private namespace:
  ```
  .publish-stage/dist/_vendor/_klodi_openclaw_natsclient/
  .publish-stage/dist/_vendor/_klodi_openclaw_toolcatalog/
  ```
  The leading underscore + adapter slug is the cross-language convention for collision avoidance when multiple `klodi-*` adapters install into the same environment. This mirrors the Python vendoring that produces `_klodi_hermes_natsclient/` inside the `klodi-hermes` wheel.

- **Import specifiers are rewritten in the staged compiled JS.** `vendor.mjs` walks `.publish-stage/dist/**/*.js` and replaces `from "@klodi/nats-client"` (and any sub-path imports) with relative paths to `dist/_vendor/_klodi_openclaw_natsclient/index.js` (likewise for `tool-catalog`). The regex is anchored to `from`/`import`/`require` positions so JSDoc references and runtime strings are not touched. Source `.ts` files are never modified — `pnpm dev`, `pnpm test`, `pnpm build` continue to resolve the workspace deps via the symlinks pnpm creates from `file:` specifiers.

- **The published `package.json` strips workspace deps from `dependencies`.** Source declares `@klodi/nats-client` and `@klodi/tool-catalog` under `dependencies` because they are real runtime deps (the source code imports them; tsc resolves them during build). At publish time, `vendor.mjs` writes a copy of `package.json` with the workspace entries removed — they ride into the artefact as inlined source under `dist/_vendor/`, not as registry-fetchable packages, so leaving them in `dependencies` would cause `npm install` to 404 on the user's host. This mirrors the hermes pattern: `klodi_nats_client` is a real dep at the source level but does not appear in the published `pyproject.toml#dependencies` because the vendored namespace ships physically inside the wheel.

- **Public-registry deps stay in `dependencies` unchanged.** The host's `npm install` resolves `@nats-io/*`, `ws`, `gray-matter`, `tweetnacl`, `@sinclair/typebox` from the public registry as it always did.

- **The publish-staging mechanism is `clawhub package publish .publish-stage`** rather than `clawhub package publish "$PWD"`. ClawHub's CLI is content-agnostic at the directory level — pointing it at the staged tree gives it the publish-ready bytes directly. The source tree (with workspace `file:` deps in `dependencies` and tsc-rooted at `src/`) never gets uploaded.

- **`bundleDependencies` is removed from source.** It is structurally dead: ClawHub strips `node_modules/` regardless. Leaving it in source `package.json` invites the next maintainer to reinstate the failed mechanism.

- **`pack-with-bundles.mjs` is removed.** Its responsibility was the materialisation that `bundleDependencies` required. With the vendor model, the file does not exist.

- **Smoke gate asserts the new shape.** `scripts/smoke-plugin-load.sh` extracts the packed tarball and asserts:
  - `dist/_vendor/_klodi_openclaw_natsclient/index.js` and `dist/_vendor/_klodi_openclaw_toolcatalog/index.js` exist (vendor staging reached the artefact)
  - Neither `package/node_modules/` nor `package/dist/node_modules/` exists (no leftover bundling, no regression to ADR-0008's mechanism)
  - The published `package.json` has no `@klodi/*` in `dependencies` and no `bundleDependencies` field (publish-time strip ran)

## Alternatives considered

1. **Patch the ClawHub CLI to honour `bundleDependencies`.** Rejected. Slowest path; you'd own the upstream change anyway since clawhub is a 4GPTs-adjacent tool. Even after a CLI fix, every plugin still has to wait for the new clawhub release to ship before publishes work — a brittle coupling.

2. **Publish `@klodi/tool-catalog` and `@klodi/nats-client` to the public npm registry.** Rejected for the same reason as in ADR-0008: they are private internal contracts. Public versioning would force semver discipline on internal refactors. They also intentionally lack the API stability the public registry implies — `tool-catalog` in particular is the codegen source for cross-language schemas (Rust, Python).

3. **Inline the workspace deps with esbuild/rollup.** Rejected. esbuild produces a single bundled `dist/index.js` that loses TypeScript's source-level structure (separate files for `tools/`, `lib/`, `service/`). The current shape has `dist/index.js` register-import each tool module from a per-tool file, which is meaningful for debugging and host introspection. Bundling also adds a build-time tooling layer where pure tsc has been sufficient.

4. **Vendor permanently into `adapters/openclaw/src/_vendor/`** (delete `packages/{logger-ts,nats-client-ts,tool-catalog}` and live with the source-level fork). Rejected. `packages/tool-catalog` is the canonical schema source consumed by the Rust and Python adapters' codegen pipelines (`vendor.py` for hermes/nanobot, `Cargo.toml` path-deps for ironclaw/moltis/zeroclaw). Forking its source into `adapters/openclaw/src/` would create cross-language drift between TypeScript runtime parsing and Python/Rust generated bindings. The build-time vendor (this ADR) keeps `packages/tool-catalog/` as single source of truth.

## Security implications

The install-time code-execution guarantee from ADR-0003 is **preserved**, with a different layered structure:

| Layer | Protects against | Mechanism |
|---|---|---|
| 1 | Plugin's own install scripts | `package.json#scripts` declares no `preinstall`/`install`/`postinstall`. Verifiable: `grep -E '"(pre\|post)?install"' package.json` returns only the `openclaw.install` config block. |
| 2 | Vendored workspace deps' install hooks | None can run because no nested `package.json` ships under `dist/_vendor/`. The vendored copy is plain `.js` files only — npm has no manifest to script-execute, regardless of whether the host passes `--ignore-scripts`. |
| 3 | Public-registry transitive deps' install scripts | OpenClaw `>=2026.4.15` passes `--ignore-scripts` to `npm install` (`/app/dist/install-package-dir-BYliCAhg.js:225–230`). Plugin pins `openclaw.install.minHostVersion: ">=2026.4.15"`. |

**Layer 2 is now structurally absent rather than mitigated.** ADR-0008's Layer 2 protection ("`pack-with-bundles.mjs` strips `scripts` from each bundled `package.json`") was a defence-in-depth mitigation that assumed bundled workspace deps existed in the tarball as installable npm packages. Under this ADR, they don't exist as npm packages at all — they exist as source files under a directory the host's `npm install` does not traverse. The threat shape disappears with the mechanism.

**Layer 3 is unchanged.** Trust still lives in the host. A future host version that drops `--ignore-scripts` re-opens transitive postinstalls; the `minHostVersion` pin is the contract that holds the floor.

**Single tarball shape.** Same as ADR-0008: one tarball, exercised end-to-end against the pinned host image before publish. ClawHub-served and direct-tarball installs receive byte-identical content (the `.publish-stage/` directory).

**Reproducibility.** `vendor.mjs` is deterministic given a clean working tree. It mutates only `.publish-stage/` (a gitignored, recreated-from-scratch directory). The source tree is never modified — `pnpm install`, `pnpm test`, `pnpm build` continue to resolve workspace deps via the existing pnpm symlinks.

**Auditability.** `tar -tzf <tarball> | sort` enumerates every file shipped. The vendor surface is exactly `dist/_vendor/_klodi_openclaw_<pkg>/*.js` (workspace, two namespaces) and `package.json#dependencies` (public registry). No `node_modules/` at any depth, no minification, no bundler-generated code.

"Exactly `*.js`" carries a **self-containment rider**: each vendored `.js` may not ship a reference to an artefact the tarball does not contain. The source deps build with `sourceMap: true`, so tsc appends a trailing `//# sourceMappingURL=<name>.js.map` comment to every `.js`; `vendor.mjs` deliberately copies only `.js` (not `.js.map`), so that comment would otherwise become a dangling reference, and every downstream load logs a non-fatal `ENOENT *.js.map`. `vendor.mjs`'s `rewriteImports()` pass therefore strips the comment from each staged vendored `.js`, aligning the vendored copy with the map-free contract the adapter's own dist already honours (`tsconfig.build.json` `sourceMap: false`). Packing the maps was rejected: their `sources` point at un-vendored `../src/*.ts` with no `sourcesContent`, so packing them relocates the `ENOENT` one level down rather than removing it, while growing the tarball.

## References

- Code: `klodi-plugin/adapters/openclaw/scripts/vendor.mjs`
- Code: `klodi-plugin/adapters/openclaw/scripts/smoke-plugin-load.sh`
- Code: `klodi-plugin/adapters/openclaw/package.json#dependencies`, `package.json#openclaw.install.minHostVersion`
- Cross-language pattern: `klodi-plugin/adapters/hermes/scripts/vendor.py` (Python analogue), `klodi-plugin/adapters/ironclaw/scripts/vendor.py` (Rust analogue via `Cargo.toml` path-deps)
- ClawHub strip evidence: `clawhub/dist/cli/commands/packages.js:517` and `:542` — `node_modules/` hardcoded into the upload-time ignore list
- Host evidence: `alpine/openclaw:2026.4.15` `/app/dist/install-package-dir-BYliCAhg.js:225–230` invokes `npm install --omit=dev --silent --ignore-scripts`
- Supersedes: [ADR-0008](./0008-bundled-deps-host-ignore-scripts.md)
- Related: [SECURITY.md § Dependencies](../../SECURITY.md), [THREAT_MODEL.md § T7](../THREAT_MODEL.md)
