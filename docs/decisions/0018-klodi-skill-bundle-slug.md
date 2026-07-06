---
id: 0018-klodi-skill-bundle-slug
title: Skill bundle is namespaced `klodi-skill` at build time; `${klodi_home}/skill` install-time stays `skill`
tags: [skill, bundle, vendoring, publish, naming, collision, adapters, openclaw]
commit: 8c35dd0
updated_at: 2026-06-25
---

# ADR-0018 — Skill bundle is namespaced `klodi-skill` at build time; `${klodi_home}/skill` install-time stays `skill`

## Status

Accepted (2026-06-25). Addresses an openclaw `skills`-subsystem load-time collision: the bundle shipped under the generic folder slug `skill`, which the host keys on, so a co-loaded plugin (`sil-openclaw`) that also ships `skill/` won `skill` by resolution order and klodi's playbook silently did not publish.

## Context

The klodi skill bundle is the canonical marketplace playbook — the agent-facing instruction set that makes the broker behave like klodi. One canonical source tree feeds every adapter's build: each adapter copies/stages it into a host-specific location (openclaw npm `files`, hermes/nanobot wheels, moltis/ironclaw staged crates).

OpenClaw keys published skills by the **folder slug** declared in `openclaw.plugin.json#skills` (the last path segment), not by the `SKILL.md` frontmatter `name:`. Under the generic slug `skill`, publication was order-dependent on whatever other plugins were loaded. The fix has to give klodi's bundle a slug no other plugin owns.

The trap this ADR exists to prevent: the word `skill` appears across six adapters in two **categorically different** roles, and a naive "make it consistent" sweep that renames the wrong ones breaks the build or user upgrades. One role is the canonical build input (must be `klodi-skill`); the other is install-time / staged-destination state (must stay `skill`). They look identical in a grep.

## Decision

The build-time bundle is namespaced **`klodi-skill`** at the canonical source **and** at every adapter build destination. The install-time per-user working copy stays **`skill`**.

**`klodi-skill` (the canonical bundle, anywhere it is read or copied as a build input):**
- Canonical source dir `klodi-plugin/klodi-skill/` (the `git mv` from `skill/`, history preserved).
- openclaw: `copy-skill.mjs` SOURCE **and** TARGET, `openclaw.plugin.json#skills` (`["./klodi-skill"]`), `package.json#files`, `scripts/vendor.mjs` `TOP_LEVEL_DIRS`, `src/lib/paths.ts getBundledSkillDir()` (`../../klodi-skill`).
- hermes / nanobot: `copy-skill.py` SOURCE.
- moltis / ironclaw: `vendor.py` `skill_src = REPO_ROOT / "klodi-skill"` — a **hard-fail `SystemExit(1)` gate**; a miss fails `cargo build` loudly, not silently.
- `registry/listings.yaml` `skill_path`, host-spec build-time-bundle prose, the `REPO_ROOT/skill`→`klodi-skill` test fixtures.

**Stays `skill` (three deliberate exceptions — renaming any of them is a regression):**
1. **`${klodi_home}/skill`** — the install-time per-user working copy (`setup.ts` `join(getKlodiHome(), "skill")`, the python installers). User state, never a build input. Renaming it orphans every existing install's skill dir on upgrade.
2. **moltis/ironclaw `skill_dst = STAGED / "skill"`** — the *staged-crate destination shape*, not a reference to the canonical source. It sits one line below the renamed `skill_src` and has no test guarding it; a "consistency fix" here changes the vendored crate layout for zero benefit.
3. **`klodi://skill/<rel-path>` MCP resource URI / `include_dir!`** — dead since the 2026-05-12 wake-prompt redesign deleted the embedded bundle. No agent reads it today; the remaining strings are immutable CHANGELOG/spec history.

**Enforcement is tests, not prose.** `adapters/openclaw/src/__tests__/skill-slug-rename.test.ts` asserts every build-input surface says `klodi-skill` **and** that `${klodi_home}/skill` install-time refs stay `skill` (the install-time over-reach tripwire). It hard-fails if anyone renames in either wrong direction. zeroclaw is intentionally not asserted: its `vendor.py` reads no skill source (no embedded-skill surface to rename).

The frontmatter `name: klodi-skill` / H1 alignment in `SKILL.md` is a consistency follow-on, not the collision fix (the host does not key on frontmatter). Product/marketplace "klodi" prose and the openclaw plugin `id`/`name` are unchanged — `klodi-skill` names the *artifact*, `klodi` names the *product*.

## Alternatives considered

1. **Rename only `openclaw.plugin.json#skills` without renaming the copied folder.** Rejected: the manifest entry must resolve to an existing dir; folder TARGET and manifest key move together or the skill fails to load (worse than the warning).
2. **Leave the canonical source `skill/` and rename only the openclaw destination** (the originally-shipped, narrower fix). Superseded by founder directive: the canonical dir was renamed too so the source name matches the published slug across all six adapters. The original openclaw-only scoping reasoning is preserved for the record.
3. **Also rename `${klodi_home}/skill`.** Rejected: it is per-user state, never registered with the host skill registry, so it cannot collide; renaming breaks user upgrades for no benefit.

## Security implications

Low surface; mostly availability and state integrity rather than the trust boundary.

- **Availability:** namespacing the slug removes a silent failure mode where klodi's playbook did not publish because a stranger plugin won the generic `skill` key. klodi now owns `klodi-skill`; no co-loaded plugin can displace it.
- **User-state integrity:** the install-time `${klodi_home}/skill` boundary is held deliberately. The same directory is preserved across upgrades (cf. [ADR-0004](./0004-preserve-state-on-uninstall.md)); renaming the build slug must not touch it.
- **Supply-chain shape unchanged:** the bundle still ships as inlined bytes per adapter (cf. [ADR-0009](./0009-vendored-ts-workspace-deps.md), [ADR-0003](./0003-vendored-runtime-dependencies.md)); only the leaf folder name changed.

## References

- Code: `adapters/openclaw/copy-skill.mjs` (header), `adapters/openclaw/src/lib/paths.ts:166` `getBundledSkillDir()`, `adapters/openclaw/scripts/vendor.mjs` `TOP_LEVEL_DIRS`
- Hard-fail gate (stays-`skill` trap): `adapters/moltis/scripts/vendor.py:262-268`, `adapters/ironclaw/scripts/vendor.py:262-268`
- Install-time boundary (stays `skill`): `adapters/openclaw/src/tools/setup.ts:210`
- Enforcement: `adapters/openclaw/src/__tests__/skill-slug-rename.test.ts`
- Spec: `docs/specs/hosts/openclaw.md` § 6 "Skill delivery path"
- Registry: `registry/listings.yaml` `skill_path`
- Related: [ADR-0004](./0004-preserve-state-on-uninstall.md), [ADR-0009](./0009-vendored-ts-workspace-deps.md)
