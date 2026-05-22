---
id: 0006-direct-to-storage-photo-uploads
title: Direct-to-storage photo uploads via signed URLs
tags: [uploads, r2, marketplace]
card: pre-harness
commit: d365332
updated_at: 2026-04-30
updated_by_card: pre-harness
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

`klodi_assets_upload_url` requests a set of **presigned URLs** from the klodi API (NATS subject `p2p.v1.assets.upload-url`), one per photo. The client (the agent, via whatever HTTP library it chooses) then PUTs the binary directly to R2 (Cloudflare's object storage) using the signed URL. klodi-operated compute never sees a byte of photo data.

The response also includes the public `asset_url` the user passes back to `klodi_list_create` / `klodi_list_update` as the photo reference. The presigned URL enforces:

- **Content-type allow-list** (`image/jpeg`, `image/png`, `image/webp`) at signing time.
- **Size ceiling** of 10MB per file, 10 files per request, enforced in the sign step.
- **Short TTL** on the signed URL (bounded by the klodi backend's signing policy).

## Alternatives considered

1. **Proxy uploads through klodi API.** Rejected: see Context. Every downside, zero upside once signed URLs exist.
2. **Direct CDN upload via a user-supplied storage account.** Rejected: forces the user to have an R2/S3 relationship with Cloudflare/AWS, adds a billing story, and removes the plugin's ability to enforce content-type / size limits at the platform level.
3. **Embed photos as base64 inside the listing body.** Rejected: photo payload now transits NATS, bloats every `klodi_list_get`, and dies at NATS's per-message ceiling.

## Security implications

- **Binary never transits klodi-operated compute.** A full compromise of the klodi NATS server or API leaks zero photo bytes.
- **Narrow attack surface at sign time.** The API endpoint that signs URLs sees only metadata (filename, content-type, size) — a few hundred bytes of structured JSON — not the binary itself. Format-confusion attacks against image decoders are bounded to what R2 does, and R2 does not decode.
- **Content-type and size enforced before the client can upload.** A client that tries to upload 100MB of executable wrapped as image/jpeg gets EACCES from R2, because the presigned URL was cut for `image/jpeg` at 10MB.
- **Bounded URL lifetime.** A leaked signed URL expires; the equivalent persistent upload endpoint would remain exploitable.
- **Single code path for all binary.** Every photo-bearing tool (`klodi_list_create`, `klodi_list_update`) consumes `asset_url` strings that came from `klodi_assets_upload_url`. Auditors verify one flow.

## References

- Code: `adapters/openclaw/src/tools/media.ts` — single call site for the OpenClaw adapter; per-language adapters mint via the same NATS subject (`p2p.v1.assets.upload-url`).
- [SECURITY.md § Network behavior](../../SECURITY.md) (`Photo uploads bypass the klodi API entirely`)
- `skill/references/photo_upload_flow.md` — agent-facing two-step flow.
