# klodi registry listings

Single source of truth for per-host discovery surfaces. Per [0010 § Source of truth](../docs/plans/0010-multi-host-build-plan.md#source-of-truth): one `listings.yaml`, N rendered listings — per-adapter CI reads this file and emits the registry-native format.

## Why this shape

Each Tier-A host's registry expects its own listing format (JSON for npm/ClawHub, TOML for cargo, Markdown bullets for Hermes Atlas, docs recipes for ZeroClaw/IronClaw/nanobot). Authoring N listings by hand drifts; a single YAML with per-registry CI rendering doesn't.

## What lives here

- [`listings.yaml`](listings.yaml) — the canonical record. Edit this, commit, and per-adapter CI picks up changes on next release.
- Future: `render-*.mjs` scripts (one per registry) that consume `listings.yaml` and emit the target format. Added when the first adapter ships.

## What stays native

- **npm `package.json`** — ClawHub reads this directly for the OpenClaw adapter. We keep it authoritative for npm-specific metadata (dependencies, scripts, publishConfig) and mirror only the user-facing fields (`description`, `keywords`) from `listings.yaml`.
- **Cargo `Cargo.toml`** — cargo reads this for Rust adapters. Same pattern.
- **Python `pyproject.toml`** — PyPI reads this for Python adapters. Same pattern.

`listings.yaml` is the layer **above** these: it governs the cross-registry listing identifier, maturity level, categories, submission process, and the list of hosts we actually support.
