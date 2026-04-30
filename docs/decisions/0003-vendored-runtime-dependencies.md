# ADR-0003 — Runtime dependencies vendored into `dist/node_modules/`

- **Status:** Superseded by [ADR-0008](./0008-bundled-deps-host-ignore-scripts.md) (2026-04-27). Vendoring + `dist/node_modules/` were dropped in favour of `bundleDependencies` for workspace deps + host-enforced `--ignore-scripts` for public-registry transitives. The two-source-of-truth drift between `vendor-deps.mjs` and `package.json#dependencies` (which caused the 0.1.11 install regression) is eliminated. Historical context retained.
- **Date:** 2026-04-22
- **Review concern addressed:** *Install Mechanism — registry metadata said "instruction-only" / no install spec, but the package includes compiled JS files (dist/).*

## Context

The plugin must bring its own runtime dependencies because the OpenClaw host does not run `npm install` against every plugin at install time — that would require network, arbitrary resolution at install time on the user's host, and a lock-file attestation story that does not exist. But the plugin's runtime imports (`@nats-io/*`, `ws`, `tweetnacl`, `@sinclair/typebox`) must resolve from *somewhere* on the user's disk.

Two install sources ingest different slices of this tree:
- Direct tarball install (`openclaw plugins install /path/to/tarball.tgz`) ships `dist/node_modules/` intact.
- ClawHub registry install strips `dist/node_modules/` and re-materialises deps via the host flow (see `scripts/smoke-plugin-load.sh`).

Both paths must boot cleanly. This ADR covers the local-vendored variant.

## Decision

`vendor-deps.mjs`, run at build time after `tsc`, copies each runtime dependency listed in `package.json#dependencies` into `dist/node_modules/`. The plugin entry point is `dist/index.js`; Node's resolution walks up from there and finds every dep co-located. No install-time script on the user's host runs `npm install`.

The tarball published to npm and ClawHub includes `dist/` per `package.json#files`. The ClawHub ingest strips `dist/node_modules/` before serving, but the source commit that built the tarball is recorded in ClawHub's `verification.sourceCommit` field — so a user can reproduce the exact bytes from the git ref they are installing.

Auditors see: `src/` (TypeScript, human-readable) → `pnpm build` → `dist/` (compiled JS + vendored node_modules, also human-readable). No minification, no bundling, no obfuscation.

## Alternatives considered

1. **Run `npm install` in the plugin host at install time.** Rejected: requires network during install, introduces ephemeral dep resolution on every install, makes reproducible builds impossible, and hands arbitrary npm lifecycle scripts (`postinstall`, `preinstall`) a foothold on the user's machine. The plugin currently declares no install scripts of its own (`package.json` has no `scripts.preinstall` / `scripts.postinstall`) — we want the same guarantee for transitive deps, which bundling enforces.
2. **Bundle everything with esbuild / rollup into a single `dist/index.js`.** Rejected: loses readability. An auditor reviewing `dist/` sees the original package files laid out the way the ecosystem publishes them; bundling collapses the module graph into one ~10MB file that cannot be diff-reviewed. It also complicates the crash-stack story (no meaningful frames).
3. **Leave deps in `package.json#dependencies` and require the host to resolve.** The ClawHub registry path does exactly this today — so the dependencies block has to stay correct anyway. But requiring *only* this path would break direct tarball install for users who want to pin to a local checkout (the `"install.localPath"` contract in `package.json#openclaw.install`).

## Security implications

- **No install-time code execution.** Nothing in the plugin runs shell commands, network requests, or lifecycle hooks at install time on the user's host. The host extracts a tarball and reads the manifest; the runtime code runs only when the plugin is *loaded* into the gateway process.
- **No native modules.** Every runtime dep in the vendored set is pure JavaScript (`ws`, `tweetnacl`, `@sinclair/typebox`, the `@nats-io/*` stack). The `package.json#dependencies` list is the authoritative source and is short enough to audit by hand. See SECURITY.md § Dependencies for the explicit enumeration.
- **Reproducibility.** The tarball is a function of the source commit. Run `pnpm pack` against the same `git show --stat <commit>` tree and you produce byte-identical output (modulo timestamp metadata the user can recompute). `clawhub package inspect @4gpts/klodi --json` reveals which commit the registry served for each published version.
- **Auditable.** `tar -tzf <tarball> | sort` enumerates every file that lands on the user's disk. `pnpm pack:inspect` in `package.json` is a one-liner.
- **Smoke-tested both paths.** `scripts/smoke-plugin-load.sh` runs `openclaw plugins install` against two tarball variants (with and without vendored modules) inside the official OpenClaw Docker image. Any regression in the dependency graph (e.g. 0.1.11's accidental devDeps-only declaration) fails the variant-B gate before publish.

## References

- Code: `vendor-deps.mjs`
- Code: `scripts/smoke-plugin-load.sh`
- Manifest: `package.json#files`, `package.json#dependencies`, `package.json#openclaw.install`
- [SECURITY.md § Build and distribution integrity](../../SECURITY.md)
- [SECURITY.md § Dependencies](../../SECURITY.md)
