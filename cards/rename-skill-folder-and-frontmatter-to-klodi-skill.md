---
type: card
title: Rename skill folder and frontmatter to klodi-skill
slug: rename-skill-folder-and-frontmatter-to-klodi-skill
work_type: bug
tiers: [unit, integration, e2e]
status: distilling
agents: [solutions-architect]
priority: 2
created: 2026-06-25
updated: 2026-06-25
base_branch: main
worktree: /home/ioannis/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-rename-skill-folder-and-frontmatter-to-klodi-skill
branch: card/rename-skill-folder-and-frontmatter-to-klodi-skill
pr: https://github.com/Context4GPTs/klodi-plugin/pull/27
merged_commit: null
---

## Intent (founder)

**Symptom:** At openclaw startup the `skills` subsystem logs a name collision:

```
warn skills {"subsystem":"skills"} plugin skill name collision: "skill" resolves to both
/home/node/.openclaw/extensions/klodi/skill and
/home/node/.openclaw/npm/projects/sil-openclaw/node_modules/sil-openclaw/skill;
only the first will be published
```

The klodi skill ships under the generic folder slug `skill`, which collides with another
plugin (`sil-openclaw`) that also ships a `skill/` folder. The host keys skills by that
folder slug, so only one of the two is published and the choice is resolution-order
dependent.

**Repro:** Load the klodi openclaw plugin alongside `sil-openclaw` (which also ships a
`skill/` folder) in the same openclaw runtime → start the gateway → observe the
`skills`-subsystem `warn` line at load. Always reproduces when both are present.

**Expected vs actual:** Expected — klodi's skill carries a unique, namespaced identity so
it always publishes with no collision warning and adapters reliably save it. Actual — it
shares the slug `skill`, publishing is order-dependent, and the warning fires.

**Resolution (founder-chosen):** Rename to `klodi-skill` in **both** places — the folder
`skill/` → `klodi-skill/` **and** the frontmatter `name:` (`klodi` → `klodi-skill`).
(Premise note for Discovery: the collision is keyed on the **folder slug**, not the
frontmatter `name:`, which is already `klodi`. Folder rename alone clears the warning;
the founder additionally elected to align the frontmatter `name:` to `klodi-skill`.)

**Known cascade points (verified grounding — Discovery to confirm completeness):**
- `skill/` → `klodi-skill/` (the canonical source-of-truth bundle; ADR-0010 topology)
- `adapters/openclaw/openclaw.plugin.json` → `"skills": ["./klodi-skill"]`
- `adapters/openclaw/copy-skill.mjs` → `SOURCE`/`TARGET` (`../../skill` and `./skill`) + reseed messages
- `adapters/openclaw/package.json` → `files: ["skill"]` and the `copy-skill` script wiring
- `skill/SKILL.md` frontmatter `name: klodi` → `name: klodi-skill`
- Sweep the other adapters (hermes / nanobot / moltis / ironclaw / zeroclaw) and any
  `.gitignore` entries for the adapter-local skill copy for the same `skill/` references.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — product-owner, solutions-architect

<!-- Filled jointly by product-owner and solutions-architect. -->

### Product requirement (product-owner)

**One-line requirement:** klodi's skill must carry a unique, namespaced host-visible
identity (`klodi-skill`) so it always publishes with zero `skills`-subsystem collision
warnings regardless of what other plugins are loaded alongside it, and stays reliably
discoverable/saveable by every adapter.

**Why this is a product requirement, not just a build tweak:** the skill is klodi's
*canonical marketplace playbook* — the agent-facing instruction set that makes the broker
behave like klodi at all. If a co-loaded plugin (`sil-openclaw`) wins the generic `skill`
slug, klodi's playbook silently doesn't publish on that host. The product's core behavior
is then resolution-order-dependent on a stranger plugin. Namespacing the identity removes
that coupling permanently: klodi owns the `klodi-skill` slug, no other plugin can.

**Scope of the host-visible identity surface (product-owner read of the cascade):**
- **openclaw — the live collision surface.** The host keys published skills by the
  *folder slug* declared in `openclaw.plugin.json#skills` (`"./skill"`). The frontmatter
  `name:` is not what collides. Renaming the folder to `klodi-skill/` and the manifest
  entry to `"./klodi-skill"` is what clears the warning. Aligning the frontmatter
  `name: klodi → klodi-skill` (founder-elected) keeps the declared identity consistent
  with the slug; it is a correctness/consistency move, not the fix itself.
- **`klodi://skill/<rel-path>` MCP resource URI (Rust adapters) is NOT a live surface.**
  Verified at `packages/klodi-rust-host/src/mcp/resources.rs:14-30`: the resource list is
  empty and `read_skill_resource` always returns `no_skill_bundle` (the 2026-05-12
  wake-prompt redesign deleted the embedded bundle). The `klodi://skill/` strings that
  remain in CHANGELOG/spec prose and one test fixture are historical — the rename does NOT
  need to touch an agent-visible `klodi://` namespace, because no agent reads one today.
- **hermes / nanobot disk path `${klodi_home}/skill/` and intermediate `skills/klodi/`**
  are not the openclaw collision and are not openclaw-host-visible. Propagating the rename
  there is a *consistency* choice, not a *correctness* one — flagged to SA for scope (see
  Open questions). The product requirement above is satisfied by the openclaw rename alone.

### Naming-consistency flags (product-owner)

The name `klodi-skill` reads cleanly as a host-visible skill identity and stays inside the
`klodi-*` family. Two places where the rename changes what a human/agent *sees* — neither
blocks, both should move with the rename for internal consistency:

1. **`skill/SKILL.md` heading `# klodi` (line 9).** The agent reads this file each session;
   the H1 is the skill's self-title. With `name: klodi-skill` in frontmatter, leaving the
   body heading as `# klodi` creates a name/title split. ASSUMPTION: align the H1 to
   `# klodi-skill` so the surfaced identity matches the frontmatter. (Body prose that says
   "klodi" as the *product/marketplace* name — e.g. "your broker on klodi" — must NOT
   change; "klodi" the marketplace ≠ `klodi-skill` the skill artifact.)
2. **The skill `description:` frontmatter is unaffected** — it names the *product* klodi,
   not the artifact, and should stay verbatim.

No end-user-facing or counterparty-facing string changes: the openclaw plugin `id`/`name`
stay `klodi`, all `klodi_*` tool names are untouched, and `${klodi_home}` is untouched. The
only host-visible surface that changes is the skill slug the gateway logs/keys on.

### Approach + alternatives ruled out (solutions-architect)

**Premise confirmed (SA, agreeing with PO):** the collision key is the **folder slug** —
the last path segment of the `openclaw.plugin.json#skills` entry (`"./skill"` → `skill`),
not the `SKILL.md` frontmatter `name:`. The adapter code never reads the skill frontmatter
(`adapters/openclaw/src` has no `gray-matter`/SKILL.md frontmatter consumer; the only
frontmatter parser, `lib/sell-buy-files.ts`, handles sell/buy files). Folder rename clears
the warning; `name:` alignment is the founder's additive, cosmetic-for-the-warning choice.

**Chosen approach — rename openclaw's *published bundle folder + host key only; do NOT
rename the canonical `klodi-plugin/skill/` source dir.** This resolves the PO's Open
question and corrects one assumption in it (see below). The full edit set:

1. `git mv adapters/openclaw/openclaw.plugin.json` stays; edit `#skills` → `["./klodi-skill"]`.
2. `adapters/openclaw/copy-skill.mjs`: change only `TARGET` (`resolve(HERE, "skill")` →
   `resolve(HERE, "klodi-skill")`) and the reseed/help/log message strings. **`SOURCE`
   stays `resolve(HERE, "..", "..", "skill")`** — the canonical source dir name is unchanged.
3. `adapters/openclaw/package.json#files`: `"skill"` → `"klodi-skill"`.
4. `skill/SKILL.md` frontmatter `name: klodi` → `name: klodi-skill` and H1 `# klodi` →
   `# klodi-skill` (PO's consistency call; the canonical *file path* `skill/SKILL.md` is
   unchanged — only its contents).
5. `.gitignore`: the build-copy ignore `klodi-plugin/adapters/*/skill/` no longer matches
   openclaw's new TARGET. Add `klodi-plugin/adapters/openclaw/klodi-skill/` (or broaden the
   glob — see Affected files for the exact, minimal edit).
6. `adapters/openclaw/src/lib/paths.ts:142-145 getBundledSkillDir()`: returns
   `join(here, "..", "..", "skill")` resolving from compiled `dist/lib/paths.js`. In the
   **published** package this resolves to `<pkgroot>/skill`, which no longer exists after
   the TARGET rename → **must change to `"klodi-skill"`**. This is a cascade point the
   founder's list MISSED and is load-bearing (the policy/template seeding reads from here).
7. `adapters/openclaw/src/__tests__/skill-content.test.ts` (6 refs to `REPO_ROOT/skill/…`):
   these read the **canonical source** dir, which we are NOT renaming → **no change needed**
   (they keep pointing at `skill/`). Confirm this is correct in review — if dev mistakenly
   renames the canonical dir, these break.

**Why NOT rename the canonical `klodi-plugin/skill/` source dir (overrides the founder's
literal framing and corrects the PO Open-question assumption):**

The PO's Open question states "renaming the canonical source dir forces *every* adapter's
copy script SOURCE to update regardless — that part is not optional." That is true *only if
you rename the canonical dir*. The collision does not require it, so the correct move is to
**not rename it at all**, making the whole six-adapter propagation moot:

- The canonical `klodi-plugin/skill/` is an internal build input. No host ever sees its
  name — every adapter copies/stages it into an adapter-specific destination
  (`adapters/openclaw/klodi-skill/`, `skills/klodi/`, `<staged>/skill/`). Only the openclaw
  *destination* slug is host-visible, and that is what collides.
- Renaming the canonical dir would force edits to: openclaw/hermes/nanobot copy `SOURCE`,
  moltis/ironclaw `vendor.py stage_mcp_assets` (`skill_src = REPO_ROOT/"skill"`, a
  **hard-fail `SystemExit(1)` gate** — verified `moltis/scripts/vendor.py:262-267`, wired in
  `main()` at :606), `registry/listings.yaml:143 skill_path`, all of `docs/specs/hosts/*.md`,
  README/SECURITY prose, and the `REPO_ROOT/skill` fixtures in `skill-content.test.ts` +
  `packages/tool-catalog/tests/skill-coverage.test.ts:33-34`. Zero of those touch the
  host-facing key → pure risk, no collision payoff.

**Alternatives ruled out:**

- **Alt A — rename canonical `klodi-plugin/skill/` (founder's literal framing).** Ruled out:
  six-adapter blast radius above, none load-bearing for the collision. If naming hygiene of
  the canonical dir is independently desired, that is a separate refactor card.
- **Alt B — change only `plugin.json#skills` without renaming the copied folder.** Ruled
  out: the manifest entry must resolve to an existing dir; if `copy-skill.mjs` still writes
  `./skill` the manifest points at a missing path → skill fails to load. Folder TARGET and
  manifest key move together.
- **Alt C — also rename the install-time `${klodi_home}/skill` target** (`setup.ts:210`,
  `setup.test.ts:258`). Ruled out: that is a per-user working copy, never registered with
  the host skill registry, so it cannot collide. Renaming it breaks user state on upgrade
  for no benefit. Leave it `skill`.
- **Alt D — skip the `name:`/H1 frontmatter change.** Ruled out by founder choice + PO
  consistency rationale; one-line, zero-risk, keeps declared identity aligned with the slug.

### Affected files / surfaces (solutions-architect)

**MUST CHANGE — load-bearing for clearing the collision / keeping the build green:**

- `adapters/openclaw/openclaw.plugin.json` — `"skills": ["./skill"]` → `["./klodi-skill"]`.
- `adapters/openclaw/copy-skill.mjs` — `TARGET` (line 27) `"skill"` → `"klodi-skill"`;
  reseed/help/log strings (lines 4, 8, 12, 15, 37, 40) updated to say `klodi-skill`.
  **Leave `SOURCE` (line 26) pointing at `..`/`..`/`skill`.**
- `adapters/openclaw/package.json` — `files` array `"skill"` → `"klodi-skill"` (line in
  `files: [...]`). The `copy-skill` script name/wiring is unchanged (it invokes the file,
  not the dir).
- `adapters/openclaw/src/lib/paths.ts:144` — `join(here, "..", "..", "skill")` →
  `"klodi-skill"`. **Founder-missed, load-bearing** — governs published policy/template
  seeding via `getBundledSkillDir()`.
- `skill/SKILL.md` (canonical file, path unchanged) — frontmatter `name: klodi` →
  `name: klodi-skill`; H1 `# klodi` → `# klodi-skill`. Do NOT touch `description:` or any
  product/marketplace "klodi" prose.
- `.gitignore` — the openclaw adapter-local copy is now `klodi-skill/`, no longer matched by
  `klodi-plugin/adapters/*/skill/` (line 177). Minimal fix: add a sibling line
  `klodi-plugin/adapters/openclaw/klodi-skill/`. (Broadening to
  `klodi-plugin/adapters/*/klodi-skill/` is acceptable but only openclaw produces that dir.)
  Also `adapters/openclaw/.gitignore:8` (`skill/`) → `klodi-skill/`.

**MUST VERIFY UNCHANGED — these read the canonical source, which is NOT renamed:**

- `adapters/openclaw/src/__tests__/skill-content.test.ts` (6 refs `REPO_ROOT/skill/…`) —
  stay `skill/`. If dev renames the canonical dir, these break — that's the tripwire.
- `packages/tool-catalog/tests/skill-coverage.test.ts:33-34` (`REPO_ROOT/skill`) — unchanged.
- hermes/nanobot `copy-skill.py` SOURCE (`.../skill`), moltis/ironclaw/zeroclaw `vendor.py`
  `skill_src`/`stage_mcp_assets` — all read canonical `REPO_ROOT/skill`, unchanged.
- `registry/listings.yaml:143 skill_path: "klodi-plugin/skill"` — unchanged.
- `docs/specs/hosts/*.md`, README/SECURITY/CHANGELOG/AGENTS prose referencing
  `klodi-plugin/skill/` or `${klodi_home}/skill/` — unchanged (canonical path + install-time
  user dir, neither is the openclaw host key).

**COSMETIC / DOC-DRIFT (optional, non-load-bearing) — update only if trivially in-scope:**

- `docs/specs/hosts/openclaw.md:46-48` — §6 "Skill delivery path" describes the openclaw
  bundle as `skill/` and `openclaw.plugin.json#skills`. Updating to `klodi-skill/` keeps the
  spec honest. Recommended (it documents the host-visible surface that actually changed).
- `adapters/openclaw/README.md:142-148`, `adapters/openclaw/SECURITY.md` — reference the
  bundled `skill/` tree as seen at `${klodi_home}/skill/` (install-time path, unchanged) so
  these largely stay; only update any line that names the *published bundle folder*.

### Risks / failure modes (solutions-architect)

- **Dangling manifest path.** If `plugin.json#skills` is updated but `copy-skill.mjs` TARGET
  is not (or vice-versa), the manifest points at a missing dir → skill silently fails to
  load on the host (worse than the original warning). Mitigation: build + the gateway-load
  smoke gate must run; AC asserts the dir resolves.
- **Founder-missed `paths.ts` regression.** `getBundledSkillDir()` resolves
  `dist/lib/paths.js → ../../skill`. After the TARGET rename the published package has
  `klodi-skill/`, not `skill/`, so policy/template seeding (`getSecurityPolicyTemplatePath`,
  `getNegotiationStyleTemplatePath`) reads a missing path → first-run policy seeding breaks
  silently. This is the highest-risk missed cascade point. Mitigation: change line 144;
  `policy-seeding` unit tests exercise this path.
- **Over-reach into the canonical dir.** If dev follows the founder's literal "rename
  `skill/`" framing and renames the canonical source, it breaks the moltis/ironclaw
  `vendor.py` hard-fail gate and 8+ `REPO_ROOT/skill` test fixtures, and silently changes
  `registry/listings.yaml`. Mitigation: handoff explicitly forbids renaming the canonical
  dir; the unchanged `skill-content.test.ts` fixtures are the tripwire that catches it.
- **`.gitignore` miss → committing the build artifact.** If the ignore pattern isn't updated
  for `klodi-skill/`, the generated openclaw-local copy gets committed (it's a build
  artifact, never hand-edited). Mitigation: AC + `git status` must show the new dir ignored.
- **Stale `${klodi_home}/skill` on upgrade.** Out of scope by design (Alt C), but note: a
  user who already has `${klodi_home}/skill/` keeps it; the install-time target stays
  `skill`, so no user-state migration is needed. This is intentional, not a gap.

### Acceptance criteria

<!--
Each criterion is tagged with the test tier that verifies it. Format:

- `[tier] Given <state>, when <action>, then <outcome>`

tier ∈ {unit, integration, e2e}. The `tiers:` frontmatter is the union of tiers used here.
See .claude/skills/adversarial-testing/references/testing-tiers.md for tier definitions.
Both product-owner and solutions-architect are responsible for these — product-owner
frames the behavior, solutions-architect tags the tier.

Behaviors framed by product-owner; tier tags marked `[tier: SA]` for solutions-architect
to set. Replace each `[tier: SA]` with the chosen `[unit] | [integration] | [e2e]` and
set the `tiers:` frontmatter to their union.
-->

- `[e2e] Given` the klodi openclaw plugin AND a second plugin that also ships a
  generic `skill/` folder (e.g. `sil-openclaw`) are both loaded into the same openclaw
  runtime, `when` the gateway starts, `then` the `skills` subsystem logs NO
  "plugin skill name collision" warning for `skill` — and klodi's skill is published, not
  silently dropped by resolution order.
  <!-- tier: e2e — only a booted gateway with two plugins reproduces the collision; this is
  the canonical proof of the fix. SA note: full two-plugin e2e may not be wired today; see
  Handoff for the pragmatic substitute (gateway-load smoke asserting absence of the warn
  line) the dev pair should add as the minimum gate. -->
- `[integration] Given` the renamed plugin, `when` the openclaw skill loader resolves
  `openclaw.plugin.json#skills`, `then` the entry reads `"./klodi-skill"` and resolves to
  an existing `klodi-skill/` directory containing `SKILL.md` (the skill is resolvable and
  publishable under its new identity, not broken by a stale path).
  <!-- tier: integration — asserts the built artifact: manifest entry + on-disk dir agree.
  Verifiable against the post-`pnpm build` tree (the copy-skill TARGET) without booting a
  host. -->
- `[unit] Given` the renamed skill bundle, `when` its `SKILL.md` frontmatter is read,
  `then` `name:` is `klodi-skill` and the body H1 is `# klodi-skill` (declared identity and
  self-title agree), while the `description:` and all product/marketplace prose still say
  "klodi" verbatim (the artifact rename does not rewrite the product name).
  <!-- tier: unit — a pure string/frontmatter assertion on one file; extends the existing
  skill-content.test.ts style. -->
- `[unit] Given` the renamed repo, `when` the tree is swept for the old skill slug,
  `then` no build-wiring or manifest reference to the generic `skill/` *slug* remains that
  would re-introduce the collision or break the copy/publish path — specifically
  `openclaw.plugin.json#skills`, `copy-skill.mjs` TARGET + reseed messages,
  `package.json#files`, `src/lib/paths.ts getBundledSkillDir()`, and the `.gitignore`
  entries for the adapter-local skill copy all point at `klodi-skill`. (The canonical
  `klodi-plugin/skill/` SOURCE, historical `klodi://skill/`, and `${klodi_home}/skill/`
  references are intentionally OUT of scope — they must stay `skill`.)
  <!-- tier: unit — a static repo-grep assertion (rg over the openclaw adapter tree) that no
  residual openclaw-slug `skill` build reference survives AND that the canonical SOURCE
  refs are untouched. SA note: this guards both directions — missed rename AND over-reach. -->
- `[integration] Given` the openclaw adapter build runs end to end, `when` `pnpm -C
  adapters/openclaw build` (which runs `copy-skill`) completes, `then` the materialized tree
  has the bundle at `adapters/openclaw/klodi-skill/SKILL.md` (not `skill/`), the build does
  not error on a missing source path, and `pnpm -C adapters/openclaw test` passes (including
  the unchanged canonical-source `skill-content.test.ts`).
  <!-- tier: integration — exercises the real copy-skill materialization + tsc + vitest
  pipeline against the renamed TARGET. -->

### Open questions (if any)

<!-- escalate to founder if blocking -->

- **Scope to hermes/nanobot — RESOLVED by SA (build-topology call).** The PO handed this
  decision to SA. **Decision: do NOT rename the canonical `klodi-plugin/skill/` source dir
  at all.** This makes the "every adapter's SOURCE must update" premise moot — the canonical
  dir keeps its name `skill/`, so hermes/nanobot `copy-skill.py` SOURCE, moltis/ironclaw
  `vendor.py stage_mcp_assets` (`skill_src = REPO_ROOT/"skill"`), and zeroclaw are ALL
  untouched. Only openclaw's *destination* slug (`adapters/openclaw/skill/` →
  `adapters/openclaw/klodi-skill/`) and its manifest key move. Rationale and the full
  blast-radius comparison are in "Approach + alternatives ruled out → Alt A". The PO's
  product requirement (zero collision warnings) is fully satisfied by the openclaw-only
  change; non-openclaw adapters never collide (hermes/nanobot already key on `klodi`,
  moltis/ironclaw have no host skill registry, zeroclaw ships no embedded skill).
- **ASSUMPTION (defensible, not escalated): leave `${klodi_home}/skill` and the canonical
  `klodi-plugin/skill/` path as-is.** Recorded because it overrides the founder's literal
  "rename the folder `skill/` → `klodi-skill/`" wording (read as the *canonical* dir). The
  founder's *goal* — a unique host-visible skill identity with no collision — is met; the
  literal canonical-dir rename is broader than the bug and pure risk. If the founder
  specifically wants the canonical dir renamed for naming hygiene, that is a separate
  refactor card, not this bug fix.

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

**This is an openclaw-only rename. Do NOT rename the canonical `klodi-plugin/skill/` source
dir.** Every adapter reads that dir as a build input; renaming it is broad, risky, and
irrelevant to the collision. The only host-visible slug that collides is openclaw's *copied
destination* folder.

**Hard constraint — what stays `skill` (do not touch):**
- `klodi-plugin/skill/` (the canonical source dir, including the path `skill/SKILL.md` — its
  *contents* change, its *path* does not).
- `copy-skill.mjs` `SOURCE` (line 26), hermes/nanobot `copy-skill.py` SOURCE, moltis/ironclaw
  `vendor.py` `skill_src`/`stage_mcp_assets`, zeroclaw vendor.
- `${klodi_home}/skill` install-time target (`setup.ts:210`, `paths.ts getKlodiHome()/skill`).
- `registry/listings.yaml:143 skill_path`, all `docs/specs/hosts/*.md` canonical-path refs,
  the `REPO_ROOT/skill` test fixtures in `skill-content.test.ts` +
  `tool-catalog/tests/skill-coverage.test.ts`. If any of these change, you over-reached.

**Ordered cascade of edits (openclaw adapter only):**

1. **No `git mv` of a directory is needed** — `adapters/openclaw/skill/` is a gitignored
   build artifact, not tracked, so there is nothing to `git mv`. The renamed dir is produced
   fresh by `copy-skill.mjs`. (The founder's "git mv to preserve history" mechanic does not
   apply here precisely because the openclaw-local copy is never committed.)
2. Edit `adapters/openclaw/copy-skill.mjs`: change `TARGET` (line 27) to
   `resolve(HERE, "klodi-skill")`; update the comment/help/log/reseed strings (lines ~4, 8,
   12, 15, 37, 40, 77, 84) from `skill/`/`./skill` to `klodi-skill/`/`./klodi-skill`. **Leave
   `SOURCE` (line 26) unchanged.**
3. Edit `adapters/openclaw/openclaw.plugin.json`: `"skills": ["./skill"]` → `["./klodi-skill"]`.
4. Edit `adapters/openclaw/package.json`: `files` array `"skill"` → `"klodi-skill"`.
5. Edit `adapters/openclaw/src/lib/paths.ts:144`: `join(here, "..", "..", "skill")` →
   `"klodi-skill"`. **Founder-missed, load-bearing** (policy/template seeding). Verify the
   compiled-from-`dist/lib/` resolution: in the published package, `dist/lib/paths.js` →
   `../../klodi-skill` = `<pkgroot>/klodi-skill`, which is where `files: ["klodi-skill"]`
   ships the bundle. Sanity-check the policy-seeding tests still pass after this.
6. Edit `skill/SKILL.md`: frontmatter `name: klodi` → `name: klodi-skill`; H1 `# klodi` →
   `# klodi-skill`. Do NOT touch `description:` or product/marketplace "klodi" prose.
7. Edit `.gitignore`: add `klodi-plugin/adapters/openclaw/klodi-skill/` (the
   `adapters/*/skill/` glob no longer matches). Edit `adapters/openclaw/.gitignore:8`
   `skill/` → `klodi-skill/`.
8. (Recommended, doc-honesty) Edit `docs/specs/hosts/openclaw.md:46-48` §6 to describe the
   published bundle as `klodi-skill/` and `#skills: ["./klodi-skill"]`. The canonical-source
   sentence ("`klodi-plugin/skill/` is the canonical source") stays.

**Test strategy (qa-developer — RED first per TDD):**

- **[unit] residual-slug grep guard.** A test that `rg`-asserts, over
  `adapters/openclaw/{openclaw.plugin.json,package.json,copy-skill.mjs,src/lib/paths.ts}`,
  that no `"./skill"` / `"skill"` *destination* slug survives AND that `copy-skill.mjs`
  `SOURCE` + the `REPO_ROOT/skill` test fixtures still say `skill` (guards over-reach in both
  directions). This is the cheapest regression net and the tripwire for the over-reach risk.
- **[unit] SKILL.md identity.** Extend `skill-content.test.ts` style: assert
  `skill/SKILL.md` frontmatter `name: klodi-skill` and H1 `# klodi-skill`, and that
  `description:`/product prose still contain "klodi". (Reads canonical `REPO_ROOT/skill` —
  unchanged path.)
- **[integration] build + materialization.** `pnpm -C adapters/openclaw build` then assert
  `adapters/openclaw/klodi-skill/SKILL.md` exists and `adapters/openclaw/skill/` does not;
  `pnpm -C adapters/openclaw test` green (note: `pretest` runs `copy-skill`, so the renamed
  TARGET is exercised on every test run). Watch the worktree pnpm stale-snapshot gotcha —
  run `pnpm build:deps` then install if `@klodi/tool-catalog` fails to resolve in a fresh
  worktree.
- **[integration] manifest↔dir agreement.** Assert `openclaw.plugin.json#skills[0]` ===
  `"./klodi-skill"` AND that path resolves to a dir with `SKILL.md` post-build.
- **[e2e/smoke] no collision warning.** Full two-plugin (klodi + sil-openclaw) e2e is the
  ideal proof but is likely not wired today. Pragmatic minimum: extend
  `adapters/openclaw/scripts/smoke-gateway-load.sh` (the existing gateway-boot gate that
  already captures the gateway startup log) to assert the startup log contains NO
  `plugin skill name collision` / `"skill"` warn line attributable to klodi, and that
  `plugins.loaded` still includes `klodi`. If wiring a second colliding plugin into the smoke
  harness is out of scope, at minimum assert the manifest no longer declares the `skill`
  slug (the necessary condition) and leave the two-plugin reproduction as a documented manual
  verification step in the PR.

**Where to start:** `adapters/openclaw/copy-skill.mjs` + `openclaw.plugin.json` together
(they must move as a pair), then `paths.ts:144` (the founder-missed one), then `SKILL.md`
and `.gitignore`. Run `pnpm -C adapters/openclaw build && pnpm -C adapters/openclaw test`
as the inner loop.

## In Dev — expert-developer, qa-developer

### RED established (qa-developer)

Three failing test files written first, per the card's test strategy. All
mirror the existing `skill-content.test.ts` style (plain file reads + anchored
asserts), live in `adapters/openclaw/src/__tests__/`, and run on the adapter's
existing vitest setup. Committed (not pushed) at `53ea6ac`.

**Test files added:**

1. `adapters/openclaw/src/__tests__/skill-slug-rename.test.ts` — **[unit]**
   residual-slug grep guard. Two `describe` blocks guarding BOTH directions:
   - *missed-rename* (currently RED): `openclaw.plugin.json#skills`,
     `package.json#files`, `copy-skill.mjs` TARGET, `paths.ts
     getBundledSkillDir()`, root `.gitignore`, and `adapters/openclaw/.gitignore`
     must all say `klodi-skill`.
   - *over-reach* (currently GREEN — the latch): `copy-skill.mjs` SOURCE, the
     `skill-content.test.ts` `REPO_ROOT/skill` fixtures, and the
     `tool-catalog/tests/skill-coverage.test.ts` fixtures must STILL say `skill`.
     These stay green throughout; they only flip red if the dev renames the
     canonical source dir.
2. `adapters/openclaw/src/__tests__/skill-identity.test.ts` — **[unit]**
   SKILL.md identity. RED: frontmatter `name: klodi-skill` + body H1
   `# klodi-skill`. GREEN latch: `description:` and the "broker on klodi"
   product prose must stay verbatim (artifact rename ≠ product rename).
3. `adapters/openclaw/src/__tests__/skill-bundle-materialization.integration.test.ts`
   — **[integration]** manifest↔dir agreement + build materialization. Runs the
   real `pnpm build` (own 5-min timeout): asserts `skills[0] === "./klodi-skill"`,
   the bundle materializes at `adapters/openclaw/klodi-skill/SKILL.md`, and NOT
   at the old `adapters/openclaw/skill/`.

**[e2e/smoke] — deliberately deferred to the documented manual step.** The card's
own [e2e/smoke] note marks the two-plugin (klodi + sil-openclaw) collision repro
as likely-unwired today, with "assert the manifest no longer declares the `skill`
slug (the necessary condition)" as the minimum gate. That necessary condition is
already covered by the unit `skills[0]` + materialization asserts above. Wiring a
second colliding plugin into `smoke-gateway-load.sh` would be gold-plating beyond
the card's stated minimum, so it stays a documented manual verification step in
the PR — not added here.

**RED failure summary** (worktree deps prepped via `pnpm build:deps && pnpm
install` per the fresh-worktree gotcha):

- Unit (`skill-slug-rename` + `skill-identity`): **8 failed | 5 passed**. The 8
  failures are every rename target (manifest `./skill`, `files: ["skill"]`,
  copy-skill `resolve(HERE, "skill")`, `paths.ts ../../skill`, frontmatter
  `name: klodi`, H1 `# klodi`, both `.gitignore` entries). The 5 passes are the
  over-reach/product-prose latches — correct: nothing has been wrongly changed.
- Integration (`skill-bundle-materialization`): **3 failed | 2 passed**. Build
  runs cleanly in ~4.5s but writes the bundle to `skill/` and the manifest still
  reads `./skill` → the 3 materialization/manifest asserts are RED. (The "build
  runs cleanly" + "skills[0] resolves" passes are latent-correctness gates that
  hold green through the rename.)

Each failing assertion names exactly the surface still carrying the old slug —
fix the implementation, never the test.

### → continuing to GREEN (expert-developer)

Implement the openclaw-only rename per the card's "Ordered cascade of edits"
(steps 1–8): `copy-skill.mjs` TARGET + manifest as a pair, then `paths.ts:144`
(the founder-missed one), `package.json#files`, `skill/SKILL.md` frontmatter+H1,
both `.gitignore` entries, and the recommended `docs/specs/hosts/openclaw.md` §6
doc-honesty edit. **Do NOT rename the canonical `klodi-plugin/skill/` SOURCE dir
or any `REPO_ROOT/skill` reference** — the 5 currently-green over-reach latches
will flip red and block you if you do. Inner loop:
`pnpm -C adapters/openclaw build && pnpm -C adapters/openclaw test`. All 16 RED
assertions must go green; all 5 latches must stay green. Then run
live-verification, open the PR, and write the → Handoff to Review section.

### → Handoff to Review (next agent: code-quality-guardian)

**PR:** https://github.com/Context4GPTs/klodi-plugin/pull/27 (targets `main`; branch
rebased onto origin/main `1663894` so it's born current, not stale).

**GREEN result:** `pnpm -C adapters/openclaw build` clean; `pnpm -C adapters/openclaw
test` → **427 passed | 4 skipped**. The 3 card test files = **18 assertions, all green**
(16 RED-turned-green across slug-rename + identity + materialization; the 5 over-reach /
product-prose latches held green throughout). oxlint clean on the one changed source file
(`paths.ts`). `git status` confirms `adapters/openclaw/klodi-skill/` is ignored.

**What changed (8 files, openclaw-adapter-only):**
- `adapters/openclaw/copy-skill.mjs` — TARGET → `resolve(HERE, "klodi-skill")` + comment/
  help/log strings. SOURCE untouched (`../../skill`).
- `adapters/openclaw/openclaw.plugin.json` — `skills: ["./klodi-skill"]`.
- `adapters/openclaw/package.json#files` — `"skill"` → `"klodi-skill"`.
- `adapters/openclaw/src/lib/paths.ts` — `getBundledSkillDir()` → `../../klodi-skill`.
- `skill/SKILL.md` — frontmatter `name:` + H1 → `klodi-skill` (contents only; path unchanged).
- root `.gitignore` + `adapters/openclaw/.gitignore` — ignore the renamed build artifact.
- `docs/specs/hosts/openclaw.md` §6 — doc-honesty for the new published-bundle slug.

**Scrutinize (highest-signal first):**
1. **`paths.ts` `getBundledSkillDir()` (the founder-missed, load-bearing edit).** Confirm
   the published-package resolution: `dist/lib/paths.js → ../../klodi-skill` =
   `<pkgroot>/klodi-skill`, which is exactly where `package.json#files: ["klodi-skill"]`
   ships the bundle. If this were wrong, first-run policy/template seeding
   (`getSecurityPolicyTemplatePath`, `getNegotiationStyleTemplatePath`) would silently read
   a missing path. The existing policy-seeding tests pass, which exercises this.
2. **Canonical source dir was NOT renamed.** `klodi-plugin/skill/` keeps its name; only its
   SKILL.md *contents* changed (2 lines). The qa over-reach latches assert `copy-skill.mjs`
   SOURCE + the `REPO_ROOT/skill` fixtures (`skill-content.test.ts`,
   `tool-catalog/.../skill-coverage.test.ts`) still say `skill` — all green, proving no
   over-reach. hermes/nanobot/moltis/ironclaw/zeroclaw vendor inputs and
   `registry/listings.yaml skill_path` are untouched.
3. **Manifest↔dir↔gitignore agreement.** `skills[0]` (`./klodi-skill`), the copy-skill
   TARGET dir, `files[]`, and both `.gitignore` entries must all name `klodi-skill`
   consistently — the integration test asserts the built tree materializes `klodi-skill/
   SKILL.md` and leaves nothing at the old `skill/` path.

**Known smells / deliberate trade-offs:**
- **[e2e/smoke] two-plugin collision repro deferred to a documented manual step** (per the
  card's own [e2e/smoke] note — the two-plugin harness is likely unwired today). The
  *necessary condition* (manifest no longer declares the bare `skill` slug) is covered by
  the unit + materialization asserts. Flagged in the PR test plan.
- The build artifact `adapters/openclaw/skill/` from the RED-phase build was trashed by
  hand (copy-skill writes the new TARGET but does not clean the old one); it's gitignored,
  so nothing about it is in the diff. Not a code path — purely local hygiene.
- No `style-quality-guardian` needed: the diff touches build config, a Markdown skill
  title, a spec doc, and gitignores — no UI/CSS/HTML.

## Review round 1 — code-quality-guardian

**Verdict: PASS** (one non-blocking P3 doc-drift note).

This is a tight, correctly-scoped openclaw-only slug rename. The diff is 11 files
(8 source/config/doc + 3 new test files); every host-visible wiring surface moved to
`klodi-skill` in lockstep, the canonical source dir was not touched, and the change is
fully covered by behavior-asserting tests. No security, type-safety, error-handling,
hardcoded-value, legacy, bloat, complexity, or architecture concerns.

### Independent re-verification (did not take the dev's word)

- **Build:** `pnpm -C adapters/openclaw build` → clean exit 0. `copy-skill` reseeds and
  writes the canonical `skill/` bytes into `adapters/openclaw/klodi-skill/`.
- **Test:** `pnpm -C adapters/openclaw test` → **427 passed | 4 skipped** (exactly the
  dev's reported numbers). The 3 card test files run in isolation → **18 passed**.
- **Materialization invariants (all hold):** `adapters/openclaw/klodi-skill/SKILL.md`
  present; old `adapters/openclaw/skill/` absent; `git status --porcelain` shows nothing
  untracked and `git check-ignore` confirms `klodi-skill/SKILL.md` is ignored.
- **Lint:** oxlint (via `pnpm dlx`, not on PATH locally) on the changed `paths.ts` + the
  three new test files → exit 0, no diagnostics.
- **No over-reach:** `git diff --name-only` touches zero of
  hermes/nanobot/moltis/ironclaw/zeroclaw, `registry/listings.yaml`, `tool-catalog`,
  `copy-skill.py`, or `vendor.py`. The 5 over-reach latches are green, independently
  proving the canonical `klodi-plugin/skill/` SOURCE and the `REPO_ROOT/skill` fixtures
  still say `skill`. `skill/SKILL.md` is a 2-line content edit (path unchanged).

### Three flagged-for-scrutiny items — all confirmed correct

1. **`paths.ts getBundledSkillDir()` (founder-missed, load-bearing).** Resolution verified
   against the actual tsconfig: `rootDir: src`, `outDir: dist` ⇒ `src/lib/paths.ts` →
   `dist/lib/paths.js`; from `dist/lib/`, `../../klodi-skill` = `<pkgroot>/klodi-skill`,
   which is exactly where `package.json#files: ["…, "klodi-skill", …]` ships the bundle.
   Only the leaf segment changed, so the relative arithmetic is as correct as before. The
   two consumers (`getSecurityPolicyTemplatePath`, `getNegotiationStyleTemplatePath`)
   inherit it; the policy-seeding suite (`__tests__/lib/policy-seeding.test.ts`,
   `tools/setup.test.ts`) is green, exercising this path. First-run seeding will read the
   right dir.
2. **No over-reach into the canonical source dir.** Confirmed above — green latches + a
   name-only diff that excludes every non-openclaw vendor input and `listings.yaml`.
3. **Manifest ↔ dir ↔ gitignore agreement.** `openclaw.plugin.json#skills[0]`
   (`./klodi-skill`), `copy-skill.mjs` TARGET, `package.json#files`, root `.gitignore`, and
   `adapters/openclaw/.gitignore` all name `klodi-skill` consistently; the integration test
   asserts the built tree materializes `klodi-skill/SKILL.md` and nothing at the old path —
   verified live.

### Test quality

Behavior-asserting, not implementation-coupled: file reads + the real `pnpm build`
materialization (own 5-min timeout). One assertion per surface, bidirectional guards
(missed-rename AND over-reach). Tier coverage matches frontmatter `tiers: [unit,
integration, e2e]` — every AC is tier-tagged; unit + integration are wired; the e2e
two-plugin repro is the card-sanctioned deferral.

### e2e/smoke deferral — acceptable, not a blocking gap

The card's own `[e2e/smoke]` AC note explicitly permits the pragmatic minimum: "assert the
manifest no longer declares the `skill` slug (the necessary condition) and leave the
two-plugin reproduction as a documented manual verification step." That necessary
condition is covered by the unit `skills[0]`/`files[]` asserts and the integration
materialization asserts. Wiring a second colliding plugin into `smoke-gateway-load.sh`
would exceed the card's stated minimum. Judged acceptable.

### Knowledge capture — sufficient

The non-obvious *why* (namespace the slug so the published host key can't collide with
co-loaded plugins shipping a generic `skill/`) is captured inline at the surfaces that
need it: `copy-skill.mjs` header, both `.gitignore` blocks, `paths.ts getBundledSkillDir`
docstring, and `docs/specs/hosts/openclaw.md` §6. No capture gap for the distiller to fill.

### Findings

- **P0 / P1 (blocking):** none.
- **P2:** none.
- **P3 (non-blocking, doc drift):** `adapters/openclaw/README.md:138` still reads
  `wired in via `skills: ["./skill"]` in `openclaw.plugin.json``. That sentence names the
  *manifest entry* this change altered to `["./klodi-skill"]`, so it is now factually
  stale (the SA "Affected files" note flagged README as optional — "only update any line
  that names the published bundle folder" — and line 138 is exactly such a line; it was
  missed). The table rows below it (`skill/SKILL.md`, `skill/references/…`) correctly
  describe the canonical *source* path and must stay `skill/`. This is a doc-honesty nit
  on a non-load-bearing line, not a code path — does not block the merge. Recommend the
  distiller or a follow-up sweep fix line 138 to `skills: ["./klodi-skill"]`.

### → Handoff back to In Dev (if FAIL/REVIEW)

N/A — verdict is PASS. The lone P3 is a non-blocking README doc-drift nit (line 138),
recorded above for the distiller / a follow-up sweep; it does not warrant a ping-pong
back to In Dev.

## Distillation — solutions-architect

<!-- Runs in the worktree on the card branch after Review PASS. Pushes to the same PR. Per the `distillation` skill: SEARCH docs/ INDEX files first; edit existing docs rather than creating duplicates. Captures land at smallest viable scope: inline WHY comments, docs/decisions/, docs/knowledge/, docs/product/, or CLAUDE.md. Then flips status to pr-ready. -->

## PR Ready

<!-- PR url; founder notification fires here -->
