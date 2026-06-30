---
id: 0021-version-aware-skill-seeding
title: Skill seeding is unconditionally version-aware (canonical bundle wins when newer); --no-reseed is demoted to accepted-but-inert and sequenced for cross-repo removal
tags: [skill, bundle, seeding, versioning, reseed, deprecation, cross-repo, hermes, nanobot, installer, parity]
card: make-skill-reseed-and-index-version-aware
commit: ff0efa4
updated_at: 2026-06-30
updated_by_card: make-skill-reseed-and-index-version-aware
---

# ADR-0021 — Version-aware skill seeding; `--no-reseed` demoted to inert

## Status

Accepted (2026-06-30). Affects the install-time skill seed in both Python
adapters — `adapters/hermes/src/klodi_hermes/hermes_installer.py::seed_skill_dir`
and its byte-identical mirror `adapters/nanobot/nanobot_installer.py` (parity gate
`scripts/check-shared-python.sh`) — plus the hermes runtime skill index
`adapters/hermes/src/klodi_hermes/setup_cli.py::install_hermes_skill_index` and the
two setup CLIs. Extends the bundle-naming choice in
[[0018-klodi-skill-bundle-slug]] and shares the state-preservation principle of
[[0004-preserve-state-on-uninstall]] (reseed scope is `skill/` only; the
user-editable siblings survive).

## Context

The klodi skill bundle is the single source of truth — per-user edits to the
bundled skill are unsupported. But `seed_skill_dir` and `install_hermes_skill_index`
treated `--no-reseed` as "never overwrite an existing target." On a **warm volume**
(redeploy onto a persisted `${KLODI_HOME}` / `${HERMES_HOME}`) a newer bundled
SKILL.md was therefore silently rejected: `skill_seeded=False` (the agent kept
reading a stale pre-0.3.5 skill) and `hermes_skill_index=None` (klodi was absent
from the agent's `<available_skills>`). A deploy *flag* could strand a stale skill
indefinitely. **NEVER ship stale.**

Two facts shaped the fix:

1. **The shipped bundle carries no version of its own.** SKILL.md frontmatter has
   no `version:` field. The one value the lockstep release already bumps is the
   **host wheel version**, and the bundle ships *inside* that wheel — so wheel
   version == bundle version with zero drift.
2. **`seed_skill_dir` is a parity-gated shared primitive.** `hermes_installer.py`
   is byte-identical to `nanobot_installer.py` (bar module docstring + logger
   name). Any freshness logic must be host-agnostic — the version string is
   supplied by the *caller*, never a distribution name hardcoded in the primitive.

## Decision

**Seeding is governed UNCONDITIONALLY by an on-disk-vs-bundle version compare; no
flag can suppress an upgrade.** Freshness is tracked by a per-target dotfile
sidecar `.klodi-skill-version` stamped from the wheel version (the on-disk SKILL.md
has none, so the sidecar is the only on-disk truth; a dotfile is invisible to the
prompt-builder manifest scan, which keys on `SKILL.md` only, so it is inert in both
trees). The same decision table governs `seed_skill_dir` and
`install_hermes_skill_index`:

| On-disk state | Action |
|---|---|
| target absent | reseed |
| marker absent / unparseable (legacy warm volume — *the bug*) | **reseed** (fail-safe) |
| on-disk `<` bundle | **reseed** |
| on-disk `==` bundle | no-op (no clobber, no every-boot churn) |
| on-disk `>` bundle (rollback / manually-newer) | no-op (no version regression) |

Fail-safe toward reseed: a missing/unparseable on-disk **or** bundle version
resolves to reseed. The marker is written **LAST, after a successful `copytree`**
(`copy_skill_tree`) — a half-copied tree has no/old marker and re-reseeds next run.
Version compare is a stdlib dotted-numeric int-tuple parse (`packaging.version` is
deliberately avoided — the installer runs before runtime deps exist).

**`--no-reseed` is demoted to accepted-but-inert and sequenced for removal across
two repos.** The flag still parses (the `reseed` param is `del`'d in both governed
functions) but no longer changes behavior; `main()` logs one deprecation line. This
is the load-bearing cross-repo coordination the code cannot express:

- **klodi-plugin (this card):** version-awareness is unconditional; `--no-reseed`
  is accepted-but-inert with a one-line deprecation log.
- **klodi-stage sibling** (`reseed-klodi-skill-every-deploy-drop-no-reseed`): drops
  `--no-reseed` from its boot scripts and inherits the version-aware default.
- **Follow-up card** deletes the dead flag from both Python CLIs once the sibling
  image has shipped.

One consistent meaning across both repos: **`--no-reseed` cannot strand a stale
skill.** This is *not* a prohibited backwards-compat shim — it is a sequenced
cross-process contract removal (a CLI flag consumed by a separate repo's deploy
script), distinct from the internal-shim prohibition in CLAUDE.md.

## Alternatives considered

- **Add `version:` to SKILL.md frontmatter, compare frontmatter↔frontmatter —
  rejected.** Forces YAML parsing into a stdlib-only pre-deps installer and
  re-introduces a hand-maintained field a release can forget to bump — the exact
  stale bug. The wheel version is the one value the lockstep release already bumps.
- **Pure content compare (reseed iff trees differ) — rejected.** Has no direction:
  it would clobber a *newer* on-disk copy with an *older* bundle, violating
  no-regression. No-regression is what forces true version-awareness over
  content-awareness.
- **Hard-remove `--no-reseed` from argparse now — rejected for this card.** A
  transitional caller still passing it (a prod/demo `init.sh` predating the sibling
  change, a third-party PyPI consumer) would get `argparse error: unrecognized
  arguments` → exit 2 → **no skill at all**, strictly worse than the stale skill we
  are fixing. Hence the sequenced inert→delete path.
- **Make the runtime `klodi_setup_reseed_skill` version-aware — rejected
  (out of scope).** It is the explicit *force* escape hatch and stays unconditional;
  it routes through the shared `copy_skill_tree` only so a force-reseed leaves a
  correct marker (behavior stays force).

## Security implications

Reseed scope is narrowed to exactly `${KLODI_HOME}/skill/` and
`${HERMES_HOME}/skills/klodi/`. `copy_skill_tree` only `rmtree`s its single target,
so the user-editable siblings (`policies/`, `sell/`, `buy/`) and credentials
(`nats.creds`, `config.json`) survive by construction — the same
preserve-user-state posture as [[0004-preserve-state-on-uninstall]]. Widening the
reseed target is the regression to guard against; it is pinned by
`test_user_sibling_trees_preserved_on_reseed`.

## References

- **Shared primitives:** `hermes_installer.py` / `nanobot_installer.py` —
  `resolve_skill_version` (caller names its distribution; `PackageNotFoundError`
  → `""` → reseed), `read_skill_version`, `version_is_newer`, `copy_skill_tree`
  (marker-LAST), `SeedOutcome` tri-state. Mirror byte-identically; gate with
  `scripts/check-shared-python.sh`.
- **Governed seeds:** `seed_skill_dir` (`${KLODI_HOME}/skill/`, returns the
  tri-state) and `setup_cli.py::install_hermes_skill_index`
  (`${HERMES_HOME}/skills/klodi/`, returns `Path | None` — `None` only on
  source-missing — so the rebuild refreshes mtime/size and auto-invalidates the
  prompt-builder `<available_skills>` cache).
- **`--no-reseed` sites:** `setup_cli.py` + `nanobot_setup_cli.py` argparse blocks
  (DEPRECATED help text, one-line `klodi_no_reseed_deprecated` warning in `main()`).
- **Force hatch:** `local_tools.py::_handle_setup_reseed_skill` — unconditional
  force, routed through `copy_skill_tree` so the force leaves a correct marker.
- **Sibling card:** klodi-stage `reseed-klodi-skill-every-deploy-drop-no-reseed`
  (epic `klodi-message-user-prod-2026-06`) — drops `--no-reseed` from boot scripts.
- **Related:** [[0018-klodi-skill-bundle-slug]] (bundle naming at build time),
  [[0004-preserve-state-on-uninstall]] (preserve user state principle).
