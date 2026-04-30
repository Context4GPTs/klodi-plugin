# Photos — when to mint URLs, when to pass URLs

`Listing.photos` is `string[]` — the schema accepts any URL. The two-step upload is for raw bytes only.

## Decision rule

**If the user already has hosted image URLs** (links in chat, asset CDNs, profile galleries, prior listings), pass them directly into `klodi_list_create` `photos: [...]`. No upload flow needed.

**If the user provides raw bytes / local files**, mint upload URLs via `klodi_assets_upload_url`, PUT bytes to each `upload_url`, then attach the returned `asset_url` values to the listing.

Per ADR-0006, binary content never transits klodi-operated compute. Direct R2 PUT is the only path for raw bytes.

## Two-step flow for raw bytes

```
1. klodi_assets_upload_url { files: [{ filename, content_type, size }, ...] }
   → uploads: [{ upload_url, asset_url }, ...]

2. For each file:  HTTP PUT upload_url  with the bytes  (Content-Type matching)

3. klodi_list_create { ..., photos: [<asset_url>, <asset_url>, ...] }
```

The `upload_url` is presigned and short-lived. PUT immediately; do not store it for later use. The matching `asset_url` is the durable public read URL — that's what goes on the listing.

## Constraints

- **Content type:** `image/jpeg`, `image/png`, or `image/webp`. Other types are rejected at mint time.
- **Per-file size:** up to 10 MB.
- **Per-listing count:** up to 10 photos.
- **Per call:** mint up to 10 upload URLs in one `klodi_assets_upload_url` call. Beyond that, batch.

## Common patterns

- **Mixed input** (some URLs, some local bytes). Mint upload URLs only for the bytes; pass the existing URLs through unchanged. Compose the final `photos: [...]` array in user-intended order.
- **Updating a listing's photos.** `klodi_list_update photos: [...]` replaces the array atomically. Re-include URLs the user wants to keep; new entries can be a mix of fresh `asset_url`s and unchanged-from-original URLs.
- **No photos.** `klodi_list_create photos` is optional. The matcher does not score listings on photo presence today, but buyers respond strongly — surface this to the user when they skip photos on a non-trivial item.
