---
id: 0014-tool-symmetry-axes
title: Two tool-symmetry axes — is-registered (manifest) vs should-be-registered (catalog)
tags: [symmetry, drift, manifest, catalog, tools, openclaw, gate, contracts]
card: fix-openclaw-manifest-tool-drift-add-symmetry-gate
commit: d7e4a51
updated_at: 2026-06-22
updated_by_card: fix-openclaw-manifest-tool-drift-add-symmetry-gate
---

# ADR-0014 — Two tool-symmetry axes: is-registered (manifest) vs should-be-registered (catalog)

## Status

Accepted (2026-06-22). Affects the openclaw adapter and the two symmetry gates that guard its tool surface: the new `scripts/check-openclaw-manifest-tools.sh` (this card) and the pre-existing `scripts/check-adapter-tools.sh` (Decision D4).

Sibling to the **D4** review decision (`docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`), which `check-adapter-tools.sh` enforces. That decision locks one axis ("tools live in the catalog or they don't exist"); this ADR names the *second*, orthogonal axis the new gate guards, and records why the two gates read different sources and must never be merged.

## Context

openclaw `2026.5.27 plugins doctor` rejected the klodi plugin: `plugin must declare contracts.tools for: klodi_searches_create, klodi_match_feedback, klodi_setup_reseed_skill`. The adapter registers **35** `klodi_*` tools but `adapters/openclaw/openclaw.plugin.json` `.contracts.tools` declared only **32** — three registered tools were undeclared. `2026.4.15` did not enforce declared==registered at load, so the latent drift only became a hard reject on the image bump. A rejected plugin makes `/v1/models` serve the OpenClaw Control HTML instead of the JSON catalog, so every downstream `callTool` 404s.

The fix needed an in-repo gate so this drift class fails on every change, not downstream on the packed tarball. The repo **already had** a tool-symmetry gate — `check-adapter-tools.sh` — and the tempting move was to extend it (or to derive the new gate's "registered set" from the same `@klodi/tool-catalog` `schemas.json` that gate reads, filtered to openclaw's `host_shape`). Both moves are wrong, because they conflate two genuinely distinct symmetry contracts that happen to read overlapping data.

The non-obvious thing a future contributor needs to know: **there are two tool-symmetry axes, they assert different facts, and a gate built on the wrong source passes silently on the exact drift it was meant to catch.**

## Decision

**There are two orthogonal tool-symmetry axes. Each has its own gate, keyed on its own source. They are never merged, and the manifest gate is keyed on the adapter's source `name:` literals — not on the tool-catalog `host_shape` slice.**

| Axis | Contract | Question it answers | Source of truth | Gate |
|---|---|---|---|---|
| **adapter-source ↔ catalog** | *should-be-registered* | "Does every `klodi_*` the adapter references exist in the catalog, and does every catalog local-tool for this host's shape appear in the adapter?" | `packages/tool-catalog/dist/schemas.json` (the codegen catalog) | `scripts/check-adapter-tools.sh` (Decision D4) |
| **manifest ↔ registered** | *is-registered* | "Does `.contracts.tools` list exactly the tools the adapter actually `registerTool`s?" | static `name:` literals inside `api.registerTool({…})` blocks in `adapters/openclaw/src/tools/*.ts` | `scripts/check-openclaw-manifest-tools.sh` (this card) |

### Why the manifest gate keys on source literals, not the catalog slice

1. **The contract `plugins doctor` validates is manifest ↔ *registered*, not manifest ↔ *catalog-allowlist*.** These are different sets. The catalog says what *should* be registered for the `in_agent` `host_shape`; the registered set is what openclaw *actually* `registerTool`s — which is exactly what `2026.5.27 plugins doctor` checks the manifest against. A catalog-derived gate passes silently whenever the manifest matches the catalog but the adapter under- or over-registers relative to it — the precise drift this card exists to catch. The two sets coincide *today*, but they assert different contracts; only the source-literal set is the one the load-time validator enforces.

2. **The "dynamically-named tools" premise is empirically false.** The original CI-wiring proposal claimed openclaw "registers names dynamically (`name: "n"` interpolated in `discovery.ts` / `setup.ts`)" and so a literal grep would miss them. Verified untrue: every `name:` in `discovery.ts` (57, 94, 119, 210, 245, 265, 302) and `setup.ts` (66, 109, 168, 189) is a static `"klodi_…"` literal — there is **no** `name: "n"` interpolation in openclaw source. (The `name: "n"` seen in `match-feedback-additive.test.ts` is the *catalog codegen* schema, not adapter registration.) 35 grep hits == 35 runtime registrations; a static grep misses nothing.

3. **`schemas.json` is a build artifact** — absent until `pnpm --filter @klodi/tool-catalog codegen`. Keying on `src/tools/*.ts` needs no codegen step and reads the same ground truth `plugins doctor` does.

### Corollaries

- **No deny-list on the manifest gate.** `check-adapter-tools.sh` scans *all* adapters for *any* bare `klodi_*` literal, so it must deny-list non-tool tokens (log-event names like `klodi_plugin_loaded`, env keys like `klodi_home`, package names like `klodi_logger`). The manifest gate scopes extraction to `name:` fields *inside* `registerTool({…})` blocks (a small `-A3` window after the opener), so those tokens are excluded **by construction** — no deny-list needed. The narrower extraction is the reason the two gates cannot share code.
- **Set equality in both directions.** registered-but-undeclared → the load-reject drift; declared-but-unregistered → a stale/typo'd manifest entry. The gate names the offender(s) and the direction.
- **Static-literal assumption is documented, not enforced.** A future tool registered with a computed name (`name: \`klodi_${x}\``) is invisible to the gate — but that omission is itself the smell the gate surfaces (a hand-maintained manifest could not have tracked it either). Documented in the gate header.
- **Enforcement surface is a vitest test.** There is no `.github/`, no pre-commit, no root runner in this repo. The in-repo gate is `packages/tool-catalog/tests/openclaw-manifest-symmetry.test.ts`, auto-discovered by `pnpm -C packages/tool-catalog test`, shelling out to the script via `execFileSync("bash", [GATE])` — the same harness `check-adapter-tools.sh` runs under. "Fails in-repo" means "fails when a contributor or board agent runs the package test" (Completion Protocol step 2), the *same* enforcement level the D4 gate already has. No CI exists; building one is out of scope (a separate infra card).

## Alternatives considered

1. **Extend `check-adapter-tools.sh` to also check the manifest.** Rejected — it enforces a different invariant (adapter-source ⊆ catalog and required-local ⊆ adapter-source), never reads `openclaw.plugin.json`, and carries a deny-list the manifest gate must not inherit. Merging the two axes into one script makes its responsibility incoherent, and a catalog-keyed check would not even catch this drift.

2. **Derive the registered set from the catalog `host_shape` slice (the same `schemas.json` D4 reads).** Rejected — that asserts *should-be-registered*, not *is-registered*. It passes silently whenever the adapter's actual `registerTool` set diverges from the catalog while the manifest still matches the catalog — the exact failure mode. It also rests on the false "dynamically-named tools" premise and requires a codegen build step the source-literal approach avoids.

3. **Rely on `adapters/openclaw/scripts/smoke-plugin-load.sh`.** Rejected — it boots openclaw `2026.4.15` (the floor), which does not enforce declared==registered, and never reads `.contracts.tools`. It is precisely why this drift slipped past existing gates.

4. **Generate `.contracts.tools` from source at build.** Rejected as YAGNI — a gate prevents drift with far less surface. The list stays hand-maintained; the gate makes that safe.

## Security implications

- **No new agent-reachable sink.** The change adds a build-time consistency gate plus three declarations to a manifest the host already trusts; it removes nothing from and adds nothing to the runtime trust boundary. The marketplace remains the authoritative validator of every tool call.
- **Closes a fail-open gap, not opens one.** Before this gate, manifest drift was caught only downstream by the host's loader (and silently mis-served `/v1/models` as Control HTML on reject). The gate moves that failure in-repo and fails *loud* (named offenders, non-zero exit), which is the correct direction for a supply-chain consistency check.
- **No injection surface in the gate.** `node -e` receives the manifest path as `process.argv[1]` (not string-interpolated into the program); grep patterns are static; no network, no secrets.

## References

- **Decision sites (inline `// See ADR-0014` anchors):**
  - The manifest↔registered gate: `scripts/check-openclaw-manifest-tools.sh` (header documents the contract; ADR pointer at the contract block).
  - The corrected manifest: `adapters/openclaw/openclaw.plugin.json` (`.contracts.tools`, 35 entries).
- **In-repo enforcement (vitest):** `packages/tool-catalog/tests/openclaw-manifest-symmetry.test.ts` — shells out to the gate; four `[integration]` cases (in-sync, undeclared-names-exactly-three, reverse-drift phantom, adversarial-noise-excluded).
- **The three registrations that had drifted:** `adapters/openclaw/src/tools/discovery.ts:94` (`klodi_searches_create`), `:302` (`klodi_match_feedback`), `adapters/openclaw/src/tools/setup.ts:189` (`klodi_setup_reseed_skill`).
- **The other axis (should-be-registered):** `scripts/check-adapter-tools.sh` and Decision **D4** in `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`.
- **Test-wrapper precedent:** `packages/tool-catalog/tests/match-feedback-additive.test.ts` — the `execFileSync("bash", [GATE])` pattern the new test mirrors.
