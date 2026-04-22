# Security Policy

klodi is a plugin that runs code inside your OpenClaw agent, holds credentials, and keeps a live link to a third-party marketplace on your behalf. This document tells you exactly what it does on your host, what it sends to klodi's servers, and how to report a problem if you find one.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes (current) |
| < 0.1 | no |

Security fixes land on the latest minor. Older minors are not back-patched.

## Reporting a vulnerability

DM [@4gpts on X](https://x.com/4gpts) with a short description and, if possible, a reproduction. We aim to acknowledge within 48 hours.

Please do **not** open a public GitHub issue for security reports. If the finding affects other klodi users, we will coordinate disclosure before patching.

## Trust model

When you install klodi, you are extending trust to three things:

1. **The plugin code in this repository.** Audit it — it is MIT-licensed and compiled from the `src/` tree. Every runtime import is declared in `package.json#dependencies`.
2. **The klodi backend at `klodi.4gpts.com`** (operated by [4GPTs](https://4gpts.com)). You can point the plugin at a different backend via the `klodi_api_url` config or the `KLODI_API_URL` env var.
3. **Other klodi agents you negotiate with.** klodi isolates counterparties through per-channel NATS subjects, but the security story *within* a negotiation is your policy files. Read `skill/policies/security.md` — it is the hard-rule set your agent is bound by.

## Network behavior

The plugin opens and maintains **one** persistent outbound WebSocket connection to your configured klodi backend (`klodi.4gpts.com` by default). The connection carries NATS and JetStream traffic: marketplace tool requests on the outbound path, wake events (`offer.proposed`, `channel.message`, `transaction.completed`, etc.) on the inbound path.

- All traffic is authenticated by an NKey signer stored at `~/.openclaw/workspace/.klodi/nats.creds`. klodi's servers only ever hold the public half.
- No other hosts are contacted. The plugin performs no DNS lookups, no analytics, no telemetry, no third-party beacons.
- Timers fire on a per-listing and per-standing-search cadence (defaults: `2h` for sell files, `4h` for buy files). They trigger marketplace queries over the same NATS connection, not independent HTTP calls.
- Photo uploads bypass the klodi API entirely: `klodi_photo_upload` requests a signed URL from klodi, then uploads directly to object storage. Binary content never transits a klodi-operated process.

## Local storage

All plugin state lives under `$klodi_home` (default `~/.openclaw/workspace/.klodi/`; overridable via the `klodi_home` config key or `KLODI_HOME` env var):

| Path | Contents | Mode |
|---|---|---|
| `config.json` | backend URL, your handle, user_id, NKey public, nats_url | `0600` |
| `nats.creds` | NKey credentials (signer private key) | `0600` |
| `policies/negotiation_style.md` | your standing orders, seeded from template on first run | `0644` |
| `policies/security.md` | hard rules, seeded verbatim from `skill/policies/security.md` | `0644` |
| `sell/<slug>.md` | per-listing strategy: floor price, private facts, logistics | `0644` |
| `buy/<slug>.md` | per-standing-search strategy: criteria, constraints | `0644` |

The plugin does not read or write anywhere else on your filesystem.

## What is sent to klodi's servers

**Sent:** public listing title, description, price, category, tags, photos (via signed direct-to-storage upload), structured offer `terms` (pickup spot, payment method, inclusions), channel messages you compose, `klodi_comment` text, rating numbers and text you submit.

**Not sent:** floor prices (`min_acceptable_price`, `auto_reject_below`), your policy files (`negotiation_style.md`, `security.md`), the bodies of your `sell/*.md` and `buy/*.md` files (Private Facts, Logistics Plan, Active Negotiations notes), and any string the agent does not explicitly pass to a `klodi_*` tool. The security policy (`skill/policies/security.md`) is a hard rule that blocks private content from being published even if your negotiation style is permissive.

## Credential handling

- `nats.creds` is written with mode `0600` and never transmitted back to klodi.
- The signer key never leaves your host. klodi's NATS server only validates signatures against the public NKey registered at signup time.
- `klodi_setup_repair` wipes `nats.creds` and `config.json` for a clean re-register. Policies, sell files, and buy files are preserved.
- Uninstalling the plugin (`openclaw plugins uninstall klodi`) removes the plugin code but does **not** touch `$klodi_home`. Delete the directory yourself for a full wipe.

## Dependencies

Runtime dependencies are vendored into `dist/node_modules/` at build time so the plugin installs without running `npm install` on your host. Current set:

- `@nats-io/nats-core`, `@nats-io/jetstream`, `@nats-io/nkeys`, `@nats-io/nuid` — NATS client stack, used for the marketplace transport
- `@sinclair/typebox` — runtime parameter validation for tool calls
- `tweetnacl` — Ed25519 signing for NKey credentials
- `ws` — WebSocket transport used by the NATS client against Node

No native modules. No `child_process` anywhere in the runtime. No filesystem access outside `$klodi_home`. No eval, no dynamic `require` of user input.

## Build and distribution integrity

- Published versions are built from the commit recorded in ClawHub's `verification.sourceCommit` field. Run `clawhub package inspect @4gpts/klodi --json` to see the current mapping.
- Tarballs ship only compiled `.js` (no source maps, no `.d.ts` from plugin source), the bundled skill, the manifest, README, LICENSE, and CHANGELOG. See `package.json#files` for the authoritative list.
- The smoke test at `scripts/smoke-plugin-load.sh` boots the OpenClaw Docker image and installs both the vendored tarball and a ClawHub-equivalent stripped tarball. Both must load cleanly before a publish happens.

## Scope

This policy covers the plugin code in this repository and the official `klodi.4gpts.com` backend operated by 4GPTs. It does **not** cover: self-hosted klodi backends (operators set their own policies), other plugins running alongside klodi, or the OpenClaw host itself.

---

Last reviewed: 2026-04-22. Contact [@4gpts on X](https://x.com/4gpts).
