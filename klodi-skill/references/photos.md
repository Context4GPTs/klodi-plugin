# Photos — one tool call, paths or URLs

Pass photos directly to `klodi_list_create` or `klodi_list_update`. The tool accepts image URLs or absolute local file paths in the same `photos` array — there is no separate mint step.

## How it works

- **Image URLs** (`http://`, `https://`) are forwarded verbatim to the marketplace at the same index.
- **Absolute local file paths** are content-sniffed against the magic bytes, uploaded directly to klodi's signed object storage by the adapter, and replaced with the durable `asset_url` at the same index before the listing request is dispatched.

Mixed arrays are supported. Order is preserved across both kinds — index 0 of the input is index 0 of the listing.

Per ADR-0006, binary content never transits klodi-operated compute. The adapter performs the direct PUT to signed storage on the agent's behalf.

## Constraints

- **Allowlist:** `image/jpeg`, `image/png`, `image/webp`. Rejection is based on sniffed bytes, not the file extension — a `.jpg` file containing PDF bytes is rejected as PDF.
- **Per-file size:** up to 10 MB.
- **Per-listing count:** up to 10 photos.
- **Absolute paths only:** relative paths (`./img.jpg`), tilde-expansion (`~/img.jpg`), and `file://` URLs are rejected. Telegram-style hosts already produce absolute paths under `/tmp/`; pass them through unchanged.

## Atomic failure

If any photo fails (path not absolute, missing file, bytes sniff outside the allowlist, oversize, sensitive directory), the entire `klodi_list_create` or `klodi_list_update` call fails with a structured error naming the offending path and the stage at which it failed (`absolute_path`, `realpath`, `content_type`, `size`, `mint`, `put`). No listing is created or updated. Partial success is not possible — the agent's ordered set of photos is the contract.

## Common patterns

- **Local file from a chat host.** Pass the absolute path the host supplies (Telegram, Discord, etc. all materialise the attachment under a temporary directory). The adapter handles the upload.
- **Existing hosted URL.** Pass the URL through unchanged. No upload is attempted, no R2 bytes are transferred.
- **Mixed array.** `photos: ["https://cdn.example/old.jpg", "/tmp/new.png"]` keeps the URL at index 0 and uploads the path at index 1; the resulting listing carries both in that order.
- **Updating a listing's photos.** `klodi_list_update photos: [...]` is full-array replacement and obeys the same atomicity rule. Re-include URLs the user wants to keep; new entries can be a mix of URLs and local paths.
- **No photos.** `klodi_list_create photos` is optional. The matcher does not score listings on photo presence today, but buyers respond strongly — surface this to the user when they skip photos on a non-trivial item.
