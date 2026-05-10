# Architecture Decision Records

Each ADR documents one architectural choice that a security reviewer, auditor, or future maintainer might otherwise have to reverse-engineer. They are append-only: if a decision is revised, the new ADR supersedes the old one rather than mutating history.

## Why this directory exists

The [SECURITY.md](../../SECURITY.md) policy describes *what* the plugin does. These ADRs explain *why we chose the design that produces that behavior*, and what alternatives we considered and rejected. Together with [THREAT_MODEL.md](../THREAT_MODEL.md), they form the justification layer for the public posture.

Inline code comments reference ADRs by ID (e.g. `// See ADR-0002`) at the actual decision sites, so auditors can jump from source to rationale in one hop.

## Format

Each ADR is a short, self-contained markdown file:

- **Status** — Accepted, Superseded, Deprecated.
- **Context** — what forced the choice.
- **Decision** — what we did.
- **Alternatives considered** — what we rejected and why.
- **Security implications** — direct consequences for the trust model.
- **References** — code paths, related ADRs, SECURITY.md sections.

## Index

| ID | Title | Status |
|---|---|---|
| [0001](./0001-persistent-websocket-connection.md) | Persistent WebSocket connection (not polling) | Accepted |
| [0002](./0002-on-disk-nkey-credentials.md) | On-disk NKey credentials at mode 0600 | Accepted |
| [0003](./0003-vendored-runtime-dependencies.md) | Runtime dependencies vendored into `dist/node_modules/` | Superseded |
| [0004](./0004-preserve-state-on-uninstall.md) | Preserve `$klodi_home` on uninstall | Accepted |
| [0005](./0005-client-side-floor-price-enforcement.md) | Floor-price enforcement client-side only | Accepted |
| [0006](./0006-direct-to-storage-photo-uploads.md) | Direct-to-storage photo uploads via signed URLs | Accepted |
| [0007](./0007-timer-cadence-clamp.md) | Timer cadences with parse clamps and silent auto-reject | Accepted |
| [0008](./0008-bundled-deps-host-ignore-scripts.md) | Runtime deps via `bundleDependencies` + host-enforced `--ignore-scripts` | Superseded |
| [0009](./0009-vendored-ts-workspace-deps.md) | Workspace TS deps vendored into `dist/_vendor/` at publish time | Accepted |
| [0010](./0010-zeroclaw-browser-pairing-shim.md) | Browser-pairing helper for klodi-zeroclaw (auto-mint + loopback HTTP shim) | Accepted |
