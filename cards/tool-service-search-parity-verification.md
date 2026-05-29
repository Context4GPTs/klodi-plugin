---
type: card
title: Tool→service search parity verification
slug: tool-service-search-parity-verification
work_type: feature        # feature | bug | refactor | chore | docs
tiers: []                 # subset of [unit, integration, e2e] — set by solutions-architect during Discovery from the acceptance criteria below
status: discovery         # backlog | discovery | stand-by | in-dev | review | distilling | pr-ready | done | abandoned
agents: [solutions-architect, product-owner]  # current active agent set; updated by each handoff
priority: 2               # 1 = drop-everything, 2 = normal, 3 = nice-to-have
created: 2026-05-26
updated: 2026-05-29
base_branch: dev
worktree: /Users/knitlybak/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-tool-service-search-parity-verification
branch: card/tool-service-search-parity-verification
pr: null                  # set by expert-developer at in-dev → review
merged_commit: null       # set by /board-tick on PR-merge detection
epic_id: ras-tool-parity
origin: goal:robust-agentic-search
---

## Intent (founder)

Verify the agent's search path and the service return the *same* upgraded, ranked results: the same query through `klodi_search` (and `klodi_searches_create`) and through `p2p.v1.listings.search` must yield identical ranked results, proven by a klodi-stage end-to-end. The tool stays a thin pass-through with a **stable contract** — no breaking changes for openclaw / hermes / nanobot / moltis / ironclaw / zeroclaw; any new query semantics ride existing params or clearly-specified **additive** params. This is the SC7 parity gate: it confirms the now-merged service search improvements reach agents unchanged through the only entry point to search (klodi has no human search UI).

## Epic notes (provisional — sibling Discovery owns the verdict)

**Depends on** `4gpts-p2p-marketplace:semantic-multilingual-fuzzy-listing-matching` (B1, merged → service upgraded) **and** `klodi-stage:golden-dataset-eval-harness-recorded-baseline` (merged → e2e substrate). Both satisfied → this card is ready.

**Likely change sites (shallow guess — Discovery owns the verdict):** the `klodi_search` / `klodi_searches_create` tool adapters (confirm thin pass-through, no shape drift) + a klodi-stage end-to-end that runs one query through the tool and directly through `p2p.v1.listings.search` and asserts identical ranked results.

**Acceptance (from PRD SC7 + per-surface klodi-plugin acceptance):**
- `[e2e]` Same query via `klodi_search` and via the service → identical ranked result set (same items, same order), verified in klodi-stage against the real tool→service path.
- Tool request/response shapes unchanged — no breaking changes for openclaw / hermes / nanobot / moltis / ironclaw / zeroclaw; tool-catalog tests green.
- New query semantics, if any, are additive-only (e.g. an optional similarity-threshold param) — never a rename/removal of existing fields.
- `klodi_search` remains the sole entry point to search.

**Cross-reference:** the founder-owned `4gpts-p2p-marketplace:provision-pgvector-substrate-migrate-embeddings` card changes the service's retrieval substrate (float8[] → pgvector). Parity must hold across that swap — re-verify after it lands, since both touch what the service returns.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — product-owner, solutions-architect

### Approach + alternatives ruled out

<!-- solutions-architect drafts -->

### Affected files / surfaces

<!-- solutions-architect drafts -->

### Risks / failure modes

<!-- solutions-architect drafts -->

### Behavioral framing — what parity means for the only consumer (agents)

`klodi` has no human search UI. The agent is the only caller; therefore parity is judged at the agent-facing wire. The card asserts an invariant in three axes.

**Axis 1 — Parity (SC7 headline).** For any well-formed query, `klodi_search` and a direct request on `p2p.v1.listings.search` return the same `results` array — same `listing_id`s in the same order. The standing-search registration via `klodi_searches_create` records the same `criteria` an equivalent `klodi_search` call would have used to produce a one-shot result page. "Ranking" in this product is the *array order*; the upgraded service may compute order via semantic / multilingual / fuzzy matching, but the agent observes only the order.

What counts as a parity *violation*:

- The tool returns a result list whose `[listing_id, listing_id, …]` sequence diverges from the direct-service call for the same input.
- The tool drops, reorders, or rewrites fields on any `ListingSearchSummary` entry the service emits (e.g. strips a newly-populated `distance_km`, normalises `created_at` precision, mutates `seller_handle` case).
- The tool transforms the inbound query before sending (trims, lowercases, drops a param it doesn't recognise) such that the service receives a different payload than the agent issued.
- `klodi_searches_create` records a `criteria` object whose semantics differ from the same-shaped `klodi_search` call (e.g. defaults a missing `delivery` to a value the one-shot path treats differently).
- Any of the six adapters (openclaw / hermes / nanobot / moltis / ironclaw / zeroclaw) diverges from the others on the same input.

What is *not* a parity violation:

- Adapter-side guard rejections that fire before the call reaches the service (`not_registered`, `connection_not_ready`, `invalid_request` — per [ADR-0011](../docs/decisions/0011-adapter-exception-envelope.md)). The guard chain is documented adapter behavior; failing fast at the guard does not break parity because the service never received the call.
- The ADR-0011 exception envelope wrapping marketplace errors (`marketplace_error` with passthrough in `details`). The tool is expected to translate raw NATS errors into the closed-vocabulary envelope.
- Cosmetic JSON differences that are round-trip-equal (e.g. integer vs JSON-number for `asking_price` so long as the parsed value is identical).

**Axis 2 — Stable contract (no breaking changes across the six adapters).** Every agent already in production was authored against today's `klodi_search` and `klodi_searches_create` shapes. The card asserts that:

- Neither tool is renamed or removed from the canonical catalog (`packages/tool-catalog/src/index.ts`).
- Neither tool's NATS subject (`p2p.v1.listings.search`, `p2p.v1.searches.create`) changes.
- No required `params` field is added; no existing `params` field is renamed, retyped, or removed.
- No `result` field on `ListingSearchSummary` or on `klodi_searches_create`'s `criteria` object is renamed, retyped, or removed.
- All six adapters expose identical agent-facing tool names, parameter sets, and result shapes for these two tools. Drift in any one language is a contract break for that adapter.

**Axis 3 — Additive-only query semantics.** New behavior the service learned (semantic / multilingual / fuzzy / scored ranking) reaches the agent through *existing* params with their pre-upgrade meaning preserved, OR through *new optional* params that an unaware caller can omit and still get the prior behavior path. Concretely:

- `query: "keychron"` cannot silently expand into "semantic neighbourhood of keychron". The existing query keyword keeps matching the way the skill craft section (`skill/SKILL.md` §6) currently teaches.
- A new opt-in (e.g. `similarity_threshold`, `mode: "semantic"`, `language: "el"`) is allowed iff it is `Type.Optional`, has a documented default that reproduces the pre-upgrade behavior, and is added to the canonical catalog — never adapter-local.
- Removing or renaming a query param to make room for new semantics is forbidden; the upgrade rides the existing surface.

### Acceptance criteria

Format: `[tier] Given <state>, when <action>, then <outcome>`. `[?]` = tier tag pending solutions-architect.

**SC7 — Parity gate (headline).**

- `[?] SC7.1` Given a registered klodi-stage harness with the upgraded service active and a known fixture corpus of listings, when the same well-formed query payload is issued through `klodi_search` and directly against `p2p.v1.listings.search`, then both responses return `results` arrays with identical `listing_id` sequences in identical order.
- `[?] SC7.2` Given the same parity setup, when both calls complete, then every per-item field on the direct-service response (`listing_id`, `listing_url`, `title`, `asking_price`, `currency`, `category`, `fulfillment`, `condition`, `distance_km` when populated, `seller_handle`, `seller_rating`, `seller_trades`, `photos`, `created_at`) is present on the corresponding tool response with byte-equal values modulo JSON-round-trip-equal numerics.
- `[?] SC7.3` Given a query containing each upgraded-ranking signal the service now exercises (the golden-dataset query set from the dependency card `klodi-stage:golden-dataset-eval-harness-recorded-baseline`), when both calls run against the recorded baseline, then parity holds for every query in the set — no query produces a tool/service divergence.
- `[?] SC7.4` Given a `klodi_searches_create` registration with criteria `C`, when the marketplace subsequently emits a `search.match` for a listing `L`, then `L` would also appear in a one-shot `klodi_search` issued with `C` against the same service state. (Standing-search criteria are interpreted identically to one-shot search criteria.)
- `[?] SC7.5` Given the cross-referenced pgvector substrate swap (`4gpts-p2p-marketplace:provision-pgvector-substrate-migrate-embeddings`) has landed, when SC7.1 through SC7.4 are re-executed against the post-swap service, then parity continues to hold; substrate change is invisible at the tool wire.

**Stable contract — no breaking changes across openclaw / hermes / nanobot / moltis / ironclaw / zeroclaw.**

- `[?] SC-contract.1` Given the canonical catalog, when the test suite inspects `klodiTools.klodi_search` and `klodiTools.klodi_searches_create`, then both keys exist, both `subject` values equal `p2p.v1.listings.search` and `p2p.v1.searches.create` respectively, and both tools appear in `TOOL_NAMES`.
- `[?] SC-contract.2` Given a snapshot of each tool's `params` and `result` schemas from the prior release (golden fixture), when the current catalog is diffed against it, then the diff is *additive only*: no removed fields, no renamed fields, no retyped fields, no `Type.Optional` → required promotions.
- `[?] SC-contract.3` Given each of the six adapters in turn, when the adapter's exposed tool metadata for `klodi_search` and `klodi_searches_create` is inspected (TS via `registerTool`, Python via the `klodi_*` registry, Rust via the MCP `tools/list` handler), then the agent-facing name, full parameter schema, and result schema are byte-equivalent to the canonical catalog after codegen normalisation.
- `[?] SC-contract.4` Given an agent client written against the pre-upgrade tool schema (a golden agent-payload fixture), when it issues every shape of `klodi_search` and `klodi_searches_create` call it knows, then every call succeeds against every adapter without schema-rejection from the tool's pre-call `args_well_formed` guard (per ADR-0011).

**Additive-only query semantics.**

- `[?] SC-additive.1` Given the canonical catalog post-upgrade, when each new `params` field on `klodi_search` or `klodi_searches_create` is enumerated, then every new field is wrapped in `Type.Optional` and has a documented default value in the catalog description.
- `[?] SC-additive.2` Given an agent that omits every new optional `params` field, when it issues a `klodi_search` against the upgraded service, then for each query in the pre-upgrade behavior baseline the result set the agent receives matches the pre-upgrade matcher's documented contract (existing keywords still match the listings the skill craft section says they should — no silent expansion that surprises an unaware agent).
- `[?] SC-additive.3` Given each existing `params` field on `klodi_search` and `klodi_searches_create` (`query`, `category`, `min_price`, `max_price`, `delivery`, `condition`, `limit`, `cursor`, `slug`), when the upgrade is inspected, then no field is renamed, retyped, or repurposed; every field's documented meaning is preserved.
- `[?] SC-additive.4` Given a new opt-in semantic parameter (if any is introduced), when its catalog description is read, then the description states the pre-upgrade-equivalent default behavior and what an agent gains by setting it — agents discover the new capability from the catalog, not from out-of-band documentation drift.

**Single entry point invariant.**

- `[?] SC-entry.1` Given the agent surface across all six adapters, when the tool registry is inspected, then `klodi_search` and `klodi_searches_create` (the latter exposed via the `klodi_watch` composite in openclaw/Rust) are the only tools whose NATS subject targets `p2p.v1.listings.search` or `p2p.v1.searches.create`; no parallel search path exists.

### Open questions

1. **Skill drift (`skill/SKILL.md` §6).** The canonical skill currently teaches agents that "the matcher is intentionally simple: substring match on title/description/tags + filter intersection (AND). No fuzzy matching, no synonym expansion." If the upgrade introduces semantic / multilingual / fuzzy matching at the service, this guidance becomes misleading even though parity still holds and the contract stays stable. Should an additional acceptance criterion gate that §6 (and the listing/search craft sub-sections) be updated in this card, or is skill-doc realignment a follow-up card? Surface for solutions-architect to call.
2. **Golden parity fixture location.** SC-contract.2 needs a frozen snapshot of `klodi_search` / `klodi_searches_create` `params` + `result` schemas to diff against. Does the existing `packages/tool-catalog/tests/golden/` infrastructure extend to a search-schema golden fixture, or does the dev pair create a new one? solutions-architect to specify.
3. **Per-adapter parity test placement.** SC-contract.3 (six-adapter schema equivalence) has no analogue today. Closest are `packages/tool-catalog/tests/catalog-removal.test.ts` (repo-wide grep) and `packages/tool-catalog/tests/error-codes-cross-language.test.ts` (Py + Rust scan from TS catalog). Does the dev pair extend the cross-language drift gate to cover tool-schema equivalence, or add a new per-adapter assertion? solutions-architect to specify.
4. **Standing-search match parity (SC7.4) test substrate.** Verifying that a `search.match` wake's matching predicate equals a one-shot `klodi_search`'s requires either (a) a klodi-stage scenario that creates a listing after a standing-search registration and observes both the wake and a follow-up one-shot, or (b) a service-layer guarantee that the two paths share the same matcher. (a) is e2e-heavy; (b) is a marketplace-side invariant we should confirm exists. solutions-architect to choose the test substrate.

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

<!-- solutions-architect owns this block. product-owner notes:
the SC7 e2e against the golden dataset is the headline gate; the
stable-contract criteria are best caught at unit/integration (catalog
inspection + per-adapter schema equivalence) so they fail fast in CI
before the e2e runs. -->

## In Dev — <agents>

<!-- implementation + test notes -->

### → Handoff to Review (next agent: code-quality-guardian)

<!-- what to pay attention to, known smells -->

## Review round 1 — code-quality-guardian

<!-- verdict + issues; runs against the open PR's diff (PR was opened by expert-developer at the in-dev → review transition) -->

### → Handoff back to In Dev (if FAIL/REVIEW)

<!-- fix list -->

## Distillation — solutions-architect

<!-- Runs in the worktree on the card branch after Review PASS. Pushes to the same PR. Per the `distillation` skill: SEARCH docs/ INDEX files first; edit existing docs rather than creating duplicates. Captures land at smallest viable scope: inline WHY comments, docs/decisions/, docs/knowledge/, docs/product/, or CLAUDE.md. Then flips status to pr-ready. -->

## PR Ready

<!-- PR url; founder notification fires here -->

<!-- Abandoned section: appended by /board-close. Records date, reason, PR state at close, worktree teardown. Heading is "## Abandoned — founder". -->
