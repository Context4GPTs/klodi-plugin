---
id: 0014-tool-symmetry-axes
title: Three tool-symmetry axes — manifest↔registered, referenced⊆catalog, catalog↔registered-by-name
tags: [symmetry, drift, manifest, catalog, tools, openclaw, gate, contracts]
card: fix-openclaw-manifest-tool-drift-add-symmetry-gate
commit: d7e4a51
updated_at: 2026-06-23
updated_by_card: fix-klodi-searches-delete-catalog-drift
---

# ADR-0014 — Three tool-symmetry axes: manifest↔registered, referenced⊆catalog, catalog↔registered-by-name

## Status

Accepted (2026-06-22). Extended 2026-06-23 (card `fix-klodi-searches-delete-catalog-drift`) with the **third axis** and its gate `scripts/check-catalog-registered.sh` — see the third table row, the "Why a third axis" section, and Alternative #5.

Affects the openclaw adapter and the three symmetry gates that guard its tool surface: `scripts/check-openclaw-manifest-tools.sh`, the pre-existing `scripts/check-adapter-tools.sh` (Decision D4), and `scripts/check-catalog-registered.sh`.

Sibling to the **D4** review decision (`docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`), which `check-adapter-tools.sh` enforces. That decision locks one axis ("tools live in the catalog or they don't exist"); this ADR names the other two orthogonal axes each remaining gate guards, and records why the three gates read different sources and must never be merged.

## Context

openclaw `2026.5.27 plugins doctor` rejected the klodi plugin: `plugin must declare contracts.tools for: klodi_searches_create, klodi_match_feedback, klodi_setup_reseed_skill`. The adapter registers **35** `klodi_*` tools but `adapters/openclaw/openclaw.plugin.json` `.contracts.tools` declared only **32** — three registered tools were undeclared. `2026.4.15` did not enforce declared==registered at load, so the latent drift only became a hard reject on the image bump. A rejected plugin makes `/v1/models` serve the OpenClaw Control HTML instead of the JSON catalog, so every downstream `callTool` 404s.

The fix needed an in-repo gate so this drift class fails on every change, not downstream on the packed tarball. The repo **already had** a tool-symmetry gate — `check-adapter-tools.sh` — and the tempting move was to extend it (or to derive the new gate's "registered set" from the same `@klodi/tool-catalog` `schemas.json` that gate reads, filtered to openclaw's `host_shape`). Both moves are wrong, because they conflate two genuinely distinct symmetry contracts that happen to read overlapping data.

The non-obvious thing a future contributor needs to know: **there are multiple tool-symmetry axes, they assert different facts, and a gate built on the wrong source passes silently on the exact drift it was meant to catch.** This ADR originally named two; card `fix-klodi-searches-delete-catalog-drift` found a *third* that both existing gates were structurally blind to (see "Why a third axis" below).

## Decision

**There are three orthogonal tool-symmetry axes. Each has its own gate, keyed on its own source. They are never merged, and the gates that read the adapter are keyed on the adapter's source `name:` literals — not on the tool-catalog `host_shape` slice.**

| Axis | Contract | Question it answers | Source of truth | Gate |
|---|---|---|---|---|
| **adapter-source ↔ catalog** | *should-be-registered* | "Does every `klodi_*` the adapter references exist in the catalog, and does every catalog local-tool for this host's shape appear in the adapter?" | `packages/tool-catalog/dist/schemas.json` (the codegen catalog) | `scripts/check-adapter-tools.sh` (Decision D4) |
| **manifest ↔ registered** | *is-registered* | "Does `.contracts.tools` list exactly the tools the adapter actually `registerTool`s?" | static `name:` literals inside `api.registerTool({…})` blocks in `adapters/openclaw/src/tools/*.ts` | `scripts/check-openclaw-manifest-tools.sh` |
| **catalog ↔ registered-by-name** | *is-reachable-by-its-own-name* | "Is every request/reply `klodiTools` key registered on the gateway under that **same name** — i.e. does every advertised name actually resolve?" | `Object.keys(klodiTools)` in `packages/tool-catalog/src/index.ts` (request/reply keys) ⊆ openclaw `registerTool({name:…})` literals | `scripts/check-catalog-registered.sh` (card `fix-klodi-searches-delete-catalog-drift`) |

### Why the manifest gate keys on source literals, not the catalog slice

1. **The contract `plugins doctor` validates is manifest ↔ *registered*, not manifest ↔ *catalog-allowlist*.** These are different sets. The catalog says what *should* be registered for the `in_agent` `host_shape`; the registered set is what openclaw *actually* `registerTool`s — which is exactly what `2026.5.27 plugins doctor` checks the manifest against. A catalog-derived gate passes silently whenever the manifest matches the catalog but the adapter under- or over-registers relative to it — the precise drift this card exists to catch. The two sets coincide *today*, but they assert different contracts; only the source-literal set is the one the load-time validator enforces.

2. **The "dynamically-named tools" premise is empirically false.** The original CI-wiring proposal claimed openclaw "registers names dynamically (`name: "n"` interpolated in `discovery.ts` / `setup.ts`)" and so a literal grep would miss them. Verified untrue: every `name:` in `discovery.ts` (57, 94, 119, 210, 245, 265, 302) and `setup.ts` (66, 109, 168, 189) is a static `"klodi_…"` literal — there is **no** `name: "n"` interpolation in openclaw source. (The `name: "n"` seen in `match-feedback-additive.test.ts` is the *catalog codegen* schema, not adapter registration.) 35 grep hits == 35 runtime registrations; a static grep misses nothing.

3. **`schemas.json` is a build artifact** — absent until `pnpm --filter @klodi/tool-catalog codegen`. Keying on `src/tools/*.ts` needs no codegen step and reads the same ground truth `plugins doctor` does.

### Why a third axis (the gap both gates were blind to)

The two axes above both compare the manifest or the catalog against the *adapter's registered set* — neither asserts that an **advertised catalog name resolves under that same name**. A request/reply `klodiTools` key can be consumed only for its `.subject` (read inside a *different* tool's handler) and never claimed as a `registerTool({name:…})` literal. It is then a **ghost**: declared in the catalog (so codegen advertises it to every host), but 404s on the gateway because no tool by that name is exposed.

`klodi_searches_delete` was exactly that — `index.ts` declared it; openclaw's `registerUnwatch` read its `.subject` but registered the handler as `klodi_unwatch` (`discovery.ts`), so `callTool("klodi_searches_delete")` 404'd. Both existing gates passed: the manifest gate (`manifest ↔ registered`) saw `klodi_unwatch` on both sides and was correctly GREEN — it never reads `klodiTools`; `check-adapter-tools.sh` (`referenced ⊆ catalog`) saw the name *referenced* (`discovery.ts:208`) and *in the catalog*, also GREEN — it never asserts the reverse (that a catalog key is registered under its own name). The drift lived on the one axis no gate covered.

The resolution was DROP, not register: the delete capability stays reachable via the `klodi_unwatch` composite (which also unlinks the local `buy/<slug>.md` policy file — a raw `klodi_searches_delete` would orphan it). The subject `p2p.v1.searches.delete` survives as a bare literal at its call sites; only the ghost *name* was removed. The new gate makes a re-introduced ghost fail in-repo.

Note the openclaw-specificity of this axis: openclaw registers each request/reply tool **individually by name**, whereas the Python adapters (hermes, nanobot) dispatch *all* request/reply tools generically by iterating `TOOL_SCHEMAS`. So the same ghost surfaced non-404 on Python (an accidental byproduct of generic iteration) and 404 on openclaw. The gate keys on the openclaw `name:` literals because openclaw is the in_agent host where by-name resolution is the actual contract.

### Corollaries

- **No deny-list on the manifest gate.** `check-adapter-tools.sh` scans *all* adapters for *any* bare `klodi_*` literal, so it must deny-list non-tool tokens (log-event names like `klodi_plugin_loaded`, env keys like `klodi_home`, package names like `klodi_logger`). The manifest gate scopes extraction to `name:` fields *inside* `registerTool({…})` blocks (a small `-A3` window after the opener), so those tokens are excluded **by construction** — no deny-list needed. The narrower extraction is the reason the two gates cannot share code.
- **Set equality in both directions (manifest gate only).** registered-but-undeclared → the load-reject drift; declared-but-unregistered → a stale/typo'd manifest entry. The manifest gate names the offender(s) and the direction. **The third gate is deliberately one-directional** (`catalog ⊆ registered`, `comm -23` on the catalog side): openclaw legitimately registers *more* names than the request/reply catalog — every local tool (`klodi_unwatch`, `klodi_watch`, `klodi_health`, `klodi_setup_*`, `klodi_match_feedback`, …). Those extra registrations are simply outside the compared (catalog) set and are never flagged. Set-equality both ways would falsely fail on every local tool.
- **Static-literal assumption is documented, not enforced.** A future tool registered with a computed name (`name: \`klodi_${x}\``) is invisible to the gate — but that omission is itself the smell the gate surfaces (a hand-maintained manifest could not have tracked it either). Documented in the gate header.
- **Enforcement surface is a vitest test.** There is no `.github/`, no pre-commit, no root runner in this repo. The in-repo gates are `packages/tool-catalog/tests/openclaw-manifest-symmetry.test.ts` and `packages/tool-catalog/tests/catalog-registered-symmetry.test.ts`, auto-discovered by `pnpm -C packages/tool-catalog test`, each shelling out to its script via `execFileSync("bash", [GATE])` — the same harness `check-adapter-tools.sh` runs under. "Fails in-repo" means "fails when a contributor or board agent runs the package test" (Completion Protocol step 2), the *same* enforcement level the D4 gate already has. No CI exists; building one is out of scope (a separate infra card).

## Alternatives considered

1. **Extend `check-adapter-tools.sh` to also check the manifest.** Rejected — it enforces a different invariant (adapter-source ⊆ catalog and required-local ⊆ adapter-source), never reads `openclaw.plugin.json`, and carries a deny-list the manifest gate must not inherit. Merging the two axes into one script makes its responsibility incoherent, and a catalog-keyed check would not even catch this drift.

2. **Derive the registered set from the catalog `host_shape` slice (the same `schemas.json` D4 reads).** Rejected — that asserts *should-be-registered*, not *is-registered*. It passes silently whenever the adapter's actual `registerTool` set diverges from the catalog while the manifest still matches the catalog — the exact failure mode. It also rests on the false "dynamically-named tools" premise and requires a codegen build step the source-literal approach avoids.

3. **Rely on `adapters/openclaw/scripts/smoke-plugin-load.sh`.** Rejected — it boots openclaw `2026.4.15` (the floor), which does not enforce declared==registered, and never reads `.contracts.tools`. It is precisely why this drift slipped past existing gates.

4. **Generate `.contracts.tools` from source at build.** Rejected as YAGNI — a gate prevents drift with far less surface. The list stays hand-maintained; the gate makes that safe.

5. **Fold the third axis into `check-adapter-tools.sh` or `check-openclaw-manifest-tools.sh` instead of a new gate.** Rejected for the same one-gate-per-axis reason the first two stay separate: the third axis asserts a *distinct* contract (`catalog-request/reply ⊆ registered-by-name`) on *distinct* sources (`klodiTools` keys vs openclaw `name:` literals). `check-adapter-tools.sh` enforces the *reverse* subset (`referenced ⊆ catalog`) and carries a deny-list this gate must not inherit; the manifest gate never reads `klodiTools`. Merging would make either script's responsibility incoherent and reintroduce the blindness that hid the ghost. The third axis also must NOT derive its registered set from the catalog `host_shape` slice (Alternative #2's mistake) — it keys on the same source-`name:` ground truth the manifest gate uses, the only set that reflects what actually resolves on the gateway.

## Security implications

- **No new agent-reachable sink.** The change adds a build-time consistency gate plus three declarations to a manifest the host already trusts; it removes nothing from and adds nothing to the runtime trust boundary. The marketplace remains the authoritative validator of every tool call.
- **Closes a fail-open gap, not opens one.** Before this gate, manifest drift was caught only downstream by the host's loader (and silently mis-served `/v1/models` as Control HTML on reject). The gate moves that failure in-repo and fails *loud* (named offenders, non-zero exit), which is the correct direction for a supply-chain consistency check.
- **No injection surface in the gate.** `node -e` receives the manifest path as `process.argv[1]` (not string-interpolated into the program); grep patterns are static; no network, no secrets.

## References

- **Decision sites (inline `// See ADR-0014` anchors):**
  - The manifest↔registered gate: `scripts/check-openclaw-manifest-tools.sh` (header documents the contract; ADR pointer at the contract block).
  - The corrected manifest: `adapters/openclaw/openclaw.plugin.json` (`.contracts.tools`, 35 entries).
  - The catalog↔registered-by-name gate: `scripts/check-catalog-registered.sh` (header documents the third-axis contract and points here).
  - The subject-consumer switch the DROP required: `adapters/openclaw/src/tools/discovery.ts` (`registerUnwatch` — bare `"p2p.v1.searches.delete"` literal) and `packages/klodi-rust-host/src/mcp/tools.rs` (`dispatch_unwatch`), each carrying a `// See ADR-0014` WHY comment.
- **In-repo enforcement (vitest):**
  - `packages/tool-catalog/tests/openclaw-manifest-symmetry.test.ts` — shells out to the manifest gate; four `[integration]` cases (in-sync, undeclared-names-exactly-three, reverse-drift phantom, adversarial-noise-excluded).
  - `packages/tool-catalog/tests/catalog-registered-symmetry.test.ts` — shells out to the catalog gate; four cases (real-tree GREEN, phantom-catalog-key fails-and-names, two adversarial "local-tool / non-tool token must not leak" cases).
- **The three registrations that had drifted (manifest axis):** `adapters/openclaw/src/tools/discovery.ts:94` (`klodi_searches_create`), `:302` (`klodi_match_feedback`), `adapters/openclaw/src/tools/setup.ts:189` (`klodi_setup_reseed_skill`).
- **The ghost that hid on the third axis:** `klodi_searches_delete` — declared in `klodiTools` (`packages/tool-catalog/src/index.ts`), consumed only as a `.subject` inside `registerUnwatch`, never registered by name → dropped by card `fix-klodi-searches-delete-catalog-drift`; the `p2p.v1.searches.delete` subject survives under `klodi_unwatch`.
- **The other axis (should-be-registered):** `scripts/check-adapter-tools.sh` and Decision **D4** in `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`.
- **Test-wrapper precedent:** `packages/tool-catalog/tests/match-feedback-additive.test.ts` — the `execFileSync("bash", [GATE])` pattern the new test mirrors.
