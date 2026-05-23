---
id: 0006-direct-to-storage-photo-uploads
title: Direct-to-storage photo uploads via signed URLs
tags: [uploads, r2, marketplace]
card: pre-harness
commit: d365332
updated_at: 2026-05-23
updated_by_card: fold-uploads-into-listing-tools
---

# ADR-0006 — Direct-to-storage photo uploads via signed URLs

## Status

Accepted (2026-04-22).

## Context

Listings carry photos. The naive path is: client uploads binary to the marketplace API, the API writes to object storage, and clients fetch from the API-owned CDN. That path puts every byte of every photo through klodi-operated compute.

There are three problems with that:

1. **Bandwidth and cost.** Photos are the largest payload in any marketplace interaction; routing them through an application server multiplies the egress bill and creates a CPU-burn step for no functional gain.
2. **Attack surface.** Any API endpoint that accepts arbitrary binary is a candidate for buffer-overflow, decompression-bomb, and format-confusion attacks against the backend. Image parsers have a long history of CVEs.
3. **Regulatory & abuse liability.** Content moderation, DMCA response, and regional-compliance filtering are easier when the binary lives in storage owned-and-operated by a single well-understood subsystem, not smeared across application servers.

## Decision

`klodi_list_create` and `klodi_list_update` accept either image URLs or absolute local filesystem paths in `photos`. When a local path is supplied, the adapter (not the agent) is responsible for the mint + PUT dance:

1. Validate the path is absolute, resolve symlinks via `realpath()`, and reject paths under sensitive directories (`/etc/`, `/var/run/`, `/var/log/`, `/proc/`, `/sys/`, `/root/`, `$KLODI_HOME`, `~/.ssh/`).
2. Content-sniff against the magic-byte table — `image/jpeg`, `image/png`, `image/webp`. Extension is advisory; bytes are authoritative.
3. Enforce 10 MB per file and 10 photos per listing client-side before any network I/O.
4. Mint the entire batch in one NATS request to `p2p.v1.assets.upload-url`, with `files: [{filename, content_type, size}, ...]`. The marketplace returns one `{upload_url, asset_url}` pair per local in index order.
5. Issue concurrent PUTs to each `upload_url` with `Content-Type` matching the sniffed type. R2 enforces both content type and size at the storage layer.
6. Assemble the listing payload's `photos` array by index — URLs pass through, locals are replaced with the matching `asset_url` — and dispatch the listing call.

Atomicity: any rejection at steps 1-3, any mint failure at step 4, or any PUT failure at step 5 aborts the entire call. No listing is created or updated. The error envelope names the offending path and the stage at which it failed.

The standalone `klodi_assets_upload_url` agent tool is removed. The NATS subject (`p2p.v1.assets.upload-url`) is retained as an internal adapter dependency — it is no longer agent-facing.

## Alternatives considered

1. **Proxy uploads through klodi API.** Rejected: see Context. Every downside, zero upside once signed URLs exist.
2. **Direct CDN upload via a user-supplied storage account.** Rejected: forces the user to have an R2/S3 relationship with Cloudflare/AWS, adds a billing story, and removes the plugin's ability to enforce content-type / size limits at the platform level.
3. **Embed photos as base64 inside the listing body.** Rejected: photo payload now transits NATS, bloats every `klodi_list_get`, and dies at NATS's per-message ceiling.

## Security implications

- **Binary never transits klodi-operated compute.** A full compromise of the klodi NATS server or API leaks zero photo bytes.
- **Narrow attack surface at sign time.** The API endpoint that signs URLs sees only metadata (filename, content-type, size) — a few hundred bytes of structured JSON — not the binary itself. Format-confusion attacks against image decoders are bounded to what R2 does, and R2 does not decode.
- **Content-type and size enforced before the client can upload.** A client that tries to upload 100MB of executable wrapped as image/jpeg gets EACCES from R2, because the presigned URL was cut for `image/jpeg` at 10MB.
- **Bounded URL lifetime.** A leaked signed URL expires; the equivalent persistent upload endpoint would remain exploitable.
- **Single code path for all binary.** Every photo-bearing tool (`klodi_list_create`, `klodi_list_update`) runs photo inputs through the adapter's resolution pipeline before the listing request is dispatched. Auditors verify one flow.
- **Content-sniff closes the format-confusion gap.** The pre-card flow trusted the agent's `content_type` argument; the new flow rejects any file whose bytes do not match an allowlisted magic-number prefix, regardless of what the extension claims.
- **Path-traversal defence.** Absolute-path-only inputs, `realpath()`-based symlink resolution, and a sensitive-directory reject list bound the surface a prompt-injected agent can address. The agent cannot point the adapter at `/etc/passwd`, the klodi creds dir, or `~/.ssh/`.

## References

- Code: `adapters/openclaw/src/tools/photos.ts` — the per-adapter helper that runs the validate / sniff / mint / PUT / substitute pipeline. The Python (hermes, nanobot) and Rust (moltis, ironclaw, zeroclaw via `packages/klodi-rust-host`) adapters carry parallel implementations with the same magic-number table and error envelope.
- [SECURITY.md § Network behavior](../../SECURITY.md) (`Photo uploads bypass the klodi API entirely`)
- `skill/references/photos.md` — agent-facing one-step flow (URLs or absolute local paths in `photos`).
