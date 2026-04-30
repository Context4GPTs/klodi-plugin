# PLAN-0005 — Decision on photo metadata (EXIF GPS, device IDs)

- **Status:** Planned — needs a decision, then either code or an ADR update
- **Type:** Design decision → code or docs
- **Related:** ADR-0006, THREAT_MODEL T13

## Gap

ADR-0006 covers the *upload surface* for photos (content-type and size enforcement at sign time, R2 rejects mismatch, no klodi-operated compute sees the binary). It does not address what rides *inside* the binary:

- **EXIF GPS coordinates** on photos taken with a phone reveal the user's home or pickup location.
- **Device identifiers** (camera serial, phone model) correlate a seller's listings across accounts.
- **Timestamps** reveal when the listed item was photographed — useful for both legitimate buyers and stalkers.

R2-hosted photos are public-by-URL once the `asset_url` is embedded in a listing. Metadata rides along. This is a privacy leak the current architecture does not even document.

## Decision required

Pick one of:

1. **Client-side strip before upload.** The plugin re-encodes the image through a metadata-stripping pipeline before PUT. Zero user action; largest engineering cost (image decode libraries are a CVE-rich surface — conflicts with ADR-0006's "no image parsing in klodi compute"; but we'd be parsing on the user's host, not on the server).
2. **Server-side strip on ingest.** R2 is dumb storage; this requires inserting a processing step. Re-introduces klodi-compute-sees-binary which ADR-0006 deliberately avoided.
3. **Strip in the signed-URL contract.** R2 / Cloudflare Images has transform-on-upload features. Investigate whether the presigned URL can bake in a transform that drops EXIF without the plugin decoding the image.
4. **Document the residual risk and push responsibility to the user.** Add a SKILL.md note telling the agent to warn the user at `klodi_list_create` time; add a THREAT_MODEL row acknowledging the leak.

Option 3 is likely the right answer if Cloudflare supports it; option 4 is the zero-engineering fallback; option 1 is the fallback's fallback.

## Why deferred

Needs investigation of Cloudflare's transform-on-upload capability before committing to a path. Option 4 is cheap but should only be the final answer if options 1–3 are all worse.

## Definition of done

- Written decision (extension of ADR-0006 or new ADR) naming one of the four options.
- If 1/2/3: implementation + test coverage.
- If 4: SKILL.md updated and THREAT_MODEL gains a row for "photo metadata leaks user location / device identity."
