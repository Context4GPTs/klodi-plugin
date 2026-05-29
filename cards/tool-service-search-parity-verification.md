---
type: card
title: Tool→service search parity verification
slug: tool-service-search-parity-verification
work_type: feature        # feature | bug | refactor | chore | docs
tiers: [unit, integration, e2e]  # union of the tiers used in the Discovery acceptance criteria
status: in-dev            # backlog | discovery | stand-by | in-dev | review | distilling | pr-ready | done | abandoned
agents: [qa-developer, expert-developer]                # current active agent set; updated by each handoff
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

**Chosen approach (solutions-architect).** A **two-tier parity gate**, all in `klodi-stage` for e2e plus per-stack integration tests in this repo:

1. **Tool-level golden parity tests (per-stack, integration tier, in this repo).** Hit `klodi_search` and `klodi_searches_create` through each adapter surface (openclaw / hermes / nanobot / Rust-shared-host serving moltis/ironclaw/zeroclaw) and assert each emits the *same on-wire `p2p.v1.listings.search` (resp. `p2p.v1.searches.create`) request payload* for a fixed set of input cases drawn from a golden fixture. The fixture is the canonical input matrix (empty-strings, nulls, omitted, present-with-typical-values per param) — same role the envelope-golden fixture at `packages/tool-catalog/tests/fixtures/envelope-golden.json` plays for [[0011-adapter-exception-envelope]]. New fixture lives at `packages/tool-catalog/tests/fixtures/search-payload-golden.json`. Catalog inspection assertions (PO's `SC-contract.1`, `SC-contract.2`, `SC-additive.*`) ride the same suite at `packages/tool-catalog/tests/`.
2. **End-to-end equivalence test (e2e tier, in sibling repo klodi-stage).** Extend `klodi-stage/e2e/eval/` with a new `eval-tool-equivalence.e2e.test.ts` that runs the existing golden dataset (`klodi-stage/e2e/eval/dataset.json`) twice — once via the service path (`natsRequest('p2p.v1.listings.search', payload)`, the current `scoreCase` arm) and once via the **tool path** through a representative adapter. Asserts identical `rankedRefs` case-by-case. Reuses `seedCase` / `loadDataset` / `searchPayload` / the per-slice metric machinery — the harness gains a tool-path arm, not a duplicate dataset.

Why split: tier (1) gives **mechanical proof** that no stack's payload-shape transform mutates meaningful semantics (catches the openclaw `compactPayload` divergence preemptively — see Risks). Tier (2) gives **observational proof** that the upgraded service search reaches the agent unchanged (closes SC7.1 through SC7.3, and on re-run after the pgvector card, SC7.5). The PO's `SC7.4` (standing-search ↔ one-shot matcher equivalence) rides tier (2) by issuing `klodi_searches_create` with criteria `C` and then immediately `klodi_search` with `C` and asserting the latter's result set is a superset of the listings the marketplace would have considered for a `search.match` (PO Open Q4 closure below).

**Alternatives ruled out:**

- *Single e2e through one adapter (openclaw) only — no per-stack tier (1).* Lost — would not catch cross-stack drift. The whole reason hermes / nanobot / Rust adapters exist as separate stacks is that we cannot assume what openclaw does is what they do. Today the hermes `klodi_watch` legacy paths (`adapters/hermes/src/klodi_hermes/watch.py:160`) and nanobot's `handle_watch` (`adapters/nanobot/nanobot_local_tools.py:777`) still emit `INVALID_REQUEST` / `transport_error` codes outside the closed ADR-0011 vocabulary — drift survives on these surfaces *today* in adjacent code. Trusting "one adapter = all adapters" is exactly the assumption ADR-0011 was filed to disprove.
- *Run the full eval harness through each of the six adapters in tier (2).* Lost — ~5 minutes per case × 200 cases × 6 adapters is hours of wall-clock; the integration-tier golden fixture in tier (1) catches stack divergence at the payload level mechanically. Tier (2) needs only one representative adapter to prove the wire round-trip is preserved end-to-end. Per CLAUDE.md "No bloat".
- *Push the parity assertion into per-adapter unit suites only (no shared fixture).* Lost — three test runners (vitest / pytest / cargo) sharing a JSON fixture is exactly the precedent ADR-0011's envelope-golden file established. A shared fixture is the *contract*; per-adapter assertions are mechanical against it.
- *Assert on the response shape rather than the request payload.* Lost — response shape is the marketplace's contract; if the service drifted, a faithful pass-through tool would faithfully transmit the drift, and parity-by-response would still pass (silently). The request payload is where the tool layer can silently transform input and break parity *unobservably* from the outside. Both shapes are asserted (response checked in tier (2) end-to-end by the ranked-list comparison; PO `SC7.2` covers per-field response equality), but the *request* payload is where the architectural risk lives.
- *Re-record the klodi-stage `baseline.json` after the pgvector swap.* Already explicitly disallowed in `klodi-stage/e2e/eval/eval-pgvector-equivalence.e2e.test.ts:11-29` (the trap-guard comment block — re-recording invisibly ships the regression). Tier (2) inherits the same discipline: diff against the **retained** baseline, never against a fresh self-diff.
- *Snapshot the entire result-list and assert exact equality at tier (2).* Considered, lost on grounds of test brittleness — tier (2)'s assertion is `rankedRefs[]` equality (the slot-by-slot listing-id sequence), not the entire response object (which would refuse to tolerate `created_at` nanosecond churn between two real-time round-trips). `rankedRefs` is the agent-observable contract; PO's `SC7.2` per-field equality is asserted on a single representative case at tier (1) where the fixture pins the marketplace state.

### Affected files / surfaces

**klodi-plugin (this repo) — additive only, no breaking edits to runtime code:**

- `packages/tool-catalog/tests/fixtures/search-payload-golden.json` — NEW. The fixed input matrix; one entry per case shape (empty-query / null-category / pickup-with-radius / ship-with-to / digital / any / cursor-set / limit-set / minimal / fully-populated). Conventions mirror the envelope-golden fixture (`_doc` + `_when` per entry). Each entry pairs an `input` (catalog params) with an `expected_wire_payload` (what the marketplace's NATS subject should receive).
- `packages/tool-catalog/tests/search-payload-golden.test.ts` — NEW. The fixture-shape validator (R1/R2 analogue): every input is valid per `klodiTools.klodi_search.params` (or `klodi_searches_create.params`), every `expected_wire_payload` is a subset of catalog-declared keys, no fixture entry exercises a non-catalog field. Also asserts the **single-entry-point invariant** (PO `SC-entry.1`): exactly one catalog tool maps to `p2p.v1.listings.search` and exactly one to `p2p.v1.searches.create`.
- `packages/tool-catalog/tests/search-schema-snapshot.test.ts` — NEW. Carries PO `SC-contract.2` + `SC-additive.*`: a frozen snapshot of `klodi_search` + `klodi_searches_create` `params` + `result` schemas (serialised via TypeBox JSON Schema). Diff is additive-only (no removed / renamed / retyped / Optional→required-promoted fields). The snapshot lives in-suite (alongside the test) per the existing `packages/tool-catalog/tests/golden/` precedent for cross-fixture invariants.
- `adapters/openclaw/src/__tests__/tools/discovery.test.ts` — EDIT (add two parity test blocks). Loads the JSON fixture, drives `klodi_search` / `klodi_searches_create` per case, asserts the captured `rawRequest`'s payload matches `expected_wire_payload` byte-for-byte.
- `adapters/hermes/tests/test_tools.py` — EDIT (add parity test). Same shape — captures `client.request(subject, args)` and asserts payload-equality per case.
- `adapters/nanobot/tests/test_tools.py` — EDIT. Same.
- `packages/klodi-rust-host/tests/search_payload_parity.rs` — NEW. Drives `dispatch_passthrough` for `ToolName::KlodiSearch` / `ToolName::KlodiSearchesCreate`, captures the payload sent to `client.request`, asserts equality. Uses the existing test helper pattern from `packages/klodi-rust-host/tests/envelope_parity.rs`.

**klodi-stage (sibling repo, separate card, separate PR — referenced as the e2e substrate this card hands off to):**

- `klodi-stage/e2e/eval/eval-tool-equivalence.e2e.test.ts` — NEW (in the sibling repo). Tier (2). Re-uses the existing `bin/init`-booted pgvector stack. Loops the dataset twice: arm A = `scoreCase(c, opts)` (current service-path arm), arm B = `scoreCaseViaTool(c, opts)` which routes through a representative adapter. Per-case assert: `runA.rankedRefs === runB.rankedRefs` (slot-by-slot equality).
- *The actual klodi-stage edits are a sibling card filed in the klodi-stage repo by the goal-orchestrator once this card lands the golden fixture + per-stack tier (1) tests. This card hands off the contract those e2e tests must hold.*

**Surfaces touched on the production runtime path: ZERO.** No live adapter handler is edited by this card under default outcomes (see Risks → openclaw `compactPayload` for the one conditional edit). The tool→service contract is already a thin pass-through; this card's deliverable is the **mechanical proof** of pass-through across every stack.

### Risks / failure modes

- **Cross-stack payload-transform drift (HIGH — central architectural concern).** Three stacks have different request-payload-construction behavior for `klodi_search`:
  - **openclaw (TS)** runs `compactPayload(params)` at `adapters/openclaw/src/tools/discovery.ts:60` — drops `undefined` / `null` / empty-string values and strips the adapter-internal flags `persist` / `action_on_match` / `target_price`.
  - **Rust shared host** uses `dispatch_passthrough` at `packages/klodi-rust-host/src/mcp/tools.rs:234` — `Value::Object(args)` sent verbatim to the catalog subject, NO transform.
  - **hermes/nanobot (Python)** route via `register_request_tools` / `call_tool` at `adapters/hermes/src/klodi_hermes/tools.py:186` and `adapters/nanobot/nanobot_tools.py:97` — `args` passed raw to `client.request(subject, args)`, NO transform.

  Concrete failure: `klodi_search({ query: "", category: null })` → `{}` on openclaw → `{query: "", category: null}` on every other stack. The pgvector substrate and dense-vector ranking are exactly the surfaces most sensitive to "empty query string" vs "absent query field". This is the failure tier (1) catches; the PO's `SC7.3` would also catch it at tier (2) on any query that hits the empty-arg edge.

  **Architectural resolution (recommended): strip `compactPayload` from openclaw's `klodi_search` arm — ship raw catalog-shaped payload from every stack.** The marketplace handler is the contract; the tool layer has no business deciding what "empty" means on the service's behalf. The strip-fields (`persist` / `action_on_match` / `target_price`) remain inside `klodi_watch` (those are the composite's adapter-internal flags, not catalog tool params). Confirm during RED in dev — if any fixture case has *currently* legitimate cross-stack disagreement on the wire, the question goes to the founder, but the default is removal.

- **Hidden `klodi_watch` legacy envelopes contaminating `klodi_search` test fixtures (MEDIUM).** `adapters/hermes/src/klodi_hermes/watch.py:155-164` and `adapters/nanobot/nanobot_local_tools.py:786-797` still emit `INVALID_REQUEST` / `transport_error` / `INVALID_SLUG` codes inside their `handle_watch` composites — *outside* the ADR-0011 envelope vocabulary. **These paths are NOT in scope** for this card (scope is `klodi_search` + `klodi_searches_create` only). Mitigation: the test fixture exercises only the catalog tools' host-registered handlers; the `klodi_watch` composite layer is explicitly skipped. The dev pair must wire the per-stack tests to the catalog-passthrough entry point, not the `klodi_watch` composite. (This is also a separate problem for a follow-up card — flagged.)

- **Ranking non-determinism — already mitigated upstream.** The pgvector card already proves the substrate yields deterministic per-slice metrics across runs (HNSW exact-neighbor at eval scale ≈ 200, per `klodi-stage/e2e/eval/eval-pgvector-equivalence.e2e.test.ts:145`). Tier (2) inherits the guarantee. *Failure mode:* operator runs tier (2) on a corpus larger than HNSW's stable-neighbor range and sees flaky ordering. Mitigation: tier (2) pins `klodi-stage/e2e/eval/dataset.json`, so corpus size is fixed and within determinism range. Test failure carries a clear pointer to the determinism contract.

- **pgvector substrate swap (HIGH, scheduled).** `4gpts-p2p-marketplace:provision-pgvector-substrate-migrate-embeddings` changes the service substrate (float8[] → pgvector). The current klodi-stage harness gates that swap at the service level; tier (2) tool-equivalence must be **re-run** after the substrate swap to re-prove tool-side parity holds across the substrate change. The card already names this re-verification (PO `SC7.5`); the architecture encodes it by making tier (2) a regression test the loop can re-fire on demand — it depends on the booted stack, not a one-shot fixture.

- **Tool-catalog shape drift (LOW, gated).** Catalog `params` / `result` shapes (TypeBox at `packages/tool-catalog/src/index.ts:353`, codegen'd to JSON Schema + Rust types) are the contract. Any breaking edit is caught by the new `search-schema-snapshot.test.ts` (PO `SC-contract.2`) plus the existing `packages/tool-catalog/tests/catalog-removal.test.ts` (the rip-out gate). A safe **additive** change (e.g. an optional `similarity_threshold`) is permitted by the card and would pass the gates with a coordinated fixture + snapshot update.

- **`klodi_search` as the SOLE search entry point (INVARIANT).** Catalog enforces this — only one tool maps to `p2p.v1.listings.search`. Risk: a future card adds a second tool that also wraps the subject. Mitigation: the new fixture-validator `search-payload-golden.test.ts` carries a structural assertion (PO `SC-entry.1`).

- **Test infrastructure split between klodi-plugin and klodi-stage (MEDIUM, mitigated).** Integration-tier tests live in klodi-plugin (per-adapter), the e2e tier lives in klodi-stage. They share the golden fixture but ship from separate repos. Mitigation: the fixture lives at `packages/tool-catalog/tests/fixtures/search-payload-golden.json` in klodi-plugin (the codegen source-of-truth repo); klodi-stage imports it via the workspace path or a vendored copy (same pattern as how klodi-stage references the marketplace's NATS helpers from its own integration suite). No cross-repo branch coordination needed for tier (1); tier (2) is staged after this card lands as a sibling klodi-stage card.

- **PO `SC7.4` — standing-search ↔ one-shot matcher equivalence (MEDIUM, dependency).** Verifying that a `search.match` wake's matching predicate equals a one-shot `klodi_search`'s predicate requires either (a) klodi-stage scenario that creates a listing post-registration and observes both the wake and a follow-up one-shot result, or (b) a service-layer guarantee that the two paths share the same matcher. **Architectural choice:** (b) — the marketplace already documents `searches_create.criteria` as evaluated by the same handler that runs `listings.search` (per the catalog's `klodi_searches_create.description` and the canonical skill's tool inventory). The tier (1) parity test for `klodi_searches_create` proves the *registration* payload reaches the service intact; the service-side identity of matcher code is a marketplace invariant, not a plugin contract. Tier (2) covers the end-to-end with a single representative scenario (one `klodi_searches_create` followed by one matching listing and one `klodi_search` with the same criteria — assert the listing appears in both arms). PO Open Q4 closed by this paragraph.

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

Format: `[tier] Given <state>, when <action>, then <outcome>`. Tier tags assigned by solutions-architect.

**SC7 — Parity gate (headline).**

- `[e2e] SC7.1` Given a registered klodi-stage harness with the upgraded service active and a known fixture corpus of listings, when the same well-formed query payload is issued through `klodi_search` and directly against `p2p.v1.listings.search`, then both responses return `results` arrays with identical `listing_id` sequences in identical order.
- `[e2e] SC7.2` Given the same parity setup, when both calls complete, then every per-item field on the direct-service response (`listing_id`, `listing_url`, `title`, `asking_price`, `currency`, `category`, `fulfillment`, `condition`, `distance_km` when populated, `seller_handle`, `seller_rating`, `seller_trades`, `photos`, `created_at`) is present on the corresponding tool response with byte-equal values modulo JSON-round-trip-equal numerics.
- `[e2e] SC7.3` Given a query containing each upgraded-ranking signal the service now exercises (the golden-dataset query set from the dependency card `klodi-stage:golden-dataset-eval-harness-recorded-baseline`), when both calls run against the recorded baseline, then parity holds for every query in the set — no query produces a tool/service divergence.
- `[e2e] SC7.4` Given a `klodi_searches_create` registration with criteria `C`, when the marketplace subsequently emits a `search.match` for a listing `L`, then `L` would also appear in a one-shot `klodi_search` issued with `C` against the same service state. (Standing-search criteria are interpreted identically to one-shot search criteria.)
- `[e2e] SC7.5` Given the cross-referenced pgvector substrate swap (`4gpts-p2p-marketplace:provision-pgvector-substrate-migrate-embeddings`) has landed, when SC7.1 through SC7.4 are re-executed against the post-swap service, then parity continues to hold; substrate change is invisible at the tool wire.

**Stable contract — no breaking changes across openclaw / hermes / nanobot / moltis / ironclaw / zeroclaw.**

- `[integration] SC-contract.1` Given the canonical catalog, when the test suite inspects `klodiTools.klodi_search` and `klodiTools.klodi_searches_create`, then both keys exist, both `subject` values equal `p2p.v1.listings.search` and `p2p.v1.searches.create` respectively, and both tools appear in `TOOL_NAMES`.
- `[integration] SC-contract.2` Given a snapshot of each tool's `params` and `result` schemas from the prior release (golden fixture), when the current catalog is diffed against it, then the diff is *additive only*: no removed fields, no renamed fields, no retyped fields, no `Type.Optional` → required promotions.
- `[integration] SC-contract.3` Given each of the six adapters in turn, when the adapter's exposed tool metadata for `klodi_search` and `klodi_searches_create` is inspected (TS via `registerTool`, Python via the `klodi_*` registry, Rust via the MCP `tools/list` handler), then the agent-facing name, full parameter schema, and result schema are byte-equivalent to the canonical catalog after codegen normalisation.
- `[integration] SC-contract.4` Given an agent client written against the pre-upgrade tool schema (a golden agent-payload fixture), when it issues every shape of `klodi_search` and `klodi_searches_create` call it knows, then every call succeeds against every adapter without schema-rejection from the tool's pre-call `args_well_formed` guard (per ADR-0011).

**Additive-only query semantics.**

- `[integration] SC-additive.1` Given the canonical catalog post-upgrade, when each new `params` field on `klodi_search` or `klodi_searches_create` is enumerated, then every new field is wrapped in `Type.Optional` and has a documented default value in the catalog description.
- `[e2e] SC-additive.2` Given an agent that omits every new optional `params` field, when it issues a `klodi_search` against the upgraded service, then for each query in the pre-upgrade behavior baseline the result set the agent receives matches the pre-upgrade matcher's documented contract (existing keywords still match the listings the skill craft section says they should — no silent expansion that surprises an unaware agent).
- `[integration] SC-additive.3` Given each existing `params` field on `klodi_search` and `klodi_searches_create` (`query`, `category`, `min_price`, `max_price`, `delivery`, `condition`, `limit`, `cursor`, `slug`), when the upgrade is inspected, then no field is renamed, retyped, or repurposed; every field's documented meaning is preserved.
- `[unit] SC-additive.4` Given a new opt-in semantic parameter (if any is introduced), when its catalog description is read, then the description states the pre-upgrade-equivalent default behavior and what an agent gains by setting it — agents discover the new capability from the catalog, not from out-of-band documentation drift.

**Single entry point invariant.**

- `[unit] SC-entry.1` Given the agent surface across all six adapters, when the tool registry is inspected, then `klodi_search` and `klodi_searches_create` (the latter exposed via the `klodi_watch` composite in openclaw/Rust) are the only tools whose NATS subject targets `p2p.v1.listings.search` or `p2p.v1.searches.create`; no parallel search path exists.

**Cross-stack payload parity (architect-added, addresses Risks → cross-stack payload-transform drift).**

- `[integration] SC-parity.1` Given any input case in `packages/tool-catalog/tests/fixtures/search-payload-golden.json`, when `klodi_search` is invoked through each of openclaw (vitest) / hermes (pytest) / nanobot (pytest) / Rust-shared-host (cargo test), then every stack captures and forwards a `p2p.v1.listings.search` NATS request payload byte-equal to the fixture's `expected_wire_payload`.
- `[integration] SC-parity.2` Given any input case in the same fixture, when `klodi_searches_create` is invoked through each of openclaw / hermes / nanobot / Rust-shared-host, then every stack captures and forwards a `p2p.v1.searches.create` NATS request payload byte-equal to the fixture's `expected_wire_payload`.

`tiers:` frontmatter: `[unit, integration, e2e]` (union — `unit` from SC-additive.4 + SC-entry.1; `integration` from the SC-contract / SC-additive.{1,3} / SC-parity rows; `e2e` from SC7.* + SC-additive.2).

### Open questions

1. **Skill drift (`skill/SKILL.md` §6).** The canonical skill currently teaches agents that "the matcher is intentionally simple: substring match on title/description/tags + filter intersection (AND). No fuzzy matching, no synonym expansion." If the upgrade introduces semantic / multilingual / fuzzy matching at the service, this guidance becomes misleading even though parity still holds and the contract stays stable.
   **Architect answer (PO Open Q1):** Skill-doc realignment is a **separate, follow-up card**. This card's invariant is *tool↔service wire parity* — the agent surface (catalog params + result) is unchanged. Skill copy edits do not gate the SC7 parity proof and would expand scope unproductively. A follow-up `klodi-plugin:skill-search-guidance-realign` card lands the SKILL.md §6 update after the semantic surface is exercised in tier (2) and a representative agent run informs the new copy. Filed as a non-blocking follow-up; the goal-orchestrator can spin it off `origin: goal:robust-agentic-search` automatically once this card merges.

2. **Golden parity fixture location.** SC-contract.2 needs a frozen snapshot of `klodi_search` / `klodi_searches_create` `params` + `result` schemas to diff against. Does the existing `packages/tool-catalog/tests/golden/` infrastructure extend to a search-schema golden fixture, or does the dev pair create a new one?
   **Architect answer (PO Open Q2):** **Extend the existing `packages/tool-catalog/tests/golden/`** directory. The directory exists, the convention (one JSON snapshot per assertion target) is established by the prior generation. Add `packages/tool-catalog/tests/golden/search-schemas.json` carrying TypeBox-emitted JSON-Schema for both tools' `params` and `result`. The `search-schema-snapshot.test.ts` (named in Affected files) is the consumer. Same place, same convention.

3. **Per-adapter parity test placement.** SC-contract.3 (six-adapter schema equivalence) has no analogue today. Closest are `packages/tool-catalog/tests/catalog-removal.test.ts` (repo-wide grep) and `packages/tool-catalog/tests/error-codes-cross-language.test.ts` (Py + Rust scan from TS catalog). Does the dev pair extend the cross-language drift gate to cover tool-schema equivalence, or add a new per-adapter assertion?
   **Architect answer (PO Open Q3):** **Per-adapter assertions inside each adapter's existing test suite, driven by the shared golden fixture from Q2 + the request-payload golden.** Reasoning: the cross-language drift gate scans for literal strings in source (suitable for error-code drift, where the comparable unit is a code literal); tool schema equivalence is a *runtime metadata* check (what does `klodi_search`'s `registerTool` actually expose to the host?). Source-scanning would either reimplement TypeBox→JSON-Schema or rely on brittle regex over schema spread. The per-adapter test instead loads the tool's catalog-registered handler in-process (it already does for the parity test from `SC-parity.{1,2}`), inspects the registered metadata (`api.getTool("klodi_search").parameters` for openclaw, the registry entry for Python, the rmcp `Tool.input_schema` for Rust), and compares to the golden snapshot. The cross-language drift gate stays focused on error-code literals.

4. **Standing-search match parity (SC7.4) test substrate.** Verifying that a `search.match` wake's matching predicate equals a one-shot `klodi_search`'s requires either (a) a klodi-stage scenario that creates a listing after a standing-search registration and observes both the wake and a follow-up one-shot, or (b) a service-layer guarantee that the two paths share the same matcher. (a) is e2e-heavy; (b) is a marketplace-side invariant we should confirm exists.
   **Architect answer (PO Open Q4):** Closed in Risks (paragraph "PO `SC7.4` — standing-search ↔ one-shot matcher equivalence"). The architectural answer is (b) at the contract level — the marketplace's `searches.create` documentation states the same matcher; the tier (1) parity test for `klodi_searches_create` proves the *registration* payload reaches the service intact; tier (2) covers one end-to-end representative scenario. The full (a) substrate (every standing-search emission re-verified by one-shot) is unnecessary for the SC7 gate.

5. **(architect-added) Single source of truth for the per-stack request capture stub.** Each per-stack test needs a stub that captures `(subject, payload)` calls without dialing NATS. openclaw already has `adapters/openclaw/src/__tests__/helpers/mock-nats.js`. Python lacks an equivalent at the `client.request` boundary — `adapters/hermes/tests/test_tools.py` uses inline `unittest.mock.patch`. Rust has `packages/klodi-rust-host/tests/envelope_parity.rs` but no `KlodiClient` request-capture helper for search payloads. **Architect call:** dev introduces a thin per-stack capture helper inside each adapter's existing test-helpers directory; no shared cross-language fixture infrastructure is needed (the JSON fixture is the contract; the helpers are read-only consumers).

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

**Where to start.**

1. **qa-developer first (RED tests).**
   a. Write `packages/tool-catalog/tests/fixtures/search-payload-golden.json` — the fixed input matrix (one case per shape variant: empty-query, null-category, pickup-with-radius, ship-with-to, digital, any, cursor-set, limit-set, minimal, fully-populated). Mirror the envelope-golden conventions (`_doc`, `_when`, per-entry `_doc`). Each entry pairs an `input` with an `expected_wire_payload` — what should arrive on the NATS subject.
   b. Generate `packages/tool-catalog/tests/golden/search-schemas.json` — TypeBox-emitted JSON-Schema snapshot of both tools' `params` + `result`. The snapshot is produced once at the start of dev (in-suite helper that serialises the catalog schemas), then frozen; subsequent runs diff against it.
   c. Write the fixture-shape validator at `packages/tool-catalog/tests/search-payload-golden.test.ts` (catalog conformance per entry, single-entry-point invariant) and the schema-diff validator at `packages/tool-catalog/tests/search-schema-snapshot.test.ts` (PO `SC-contract.2`, `SC-additive.*`).
   d. Write the four per-stack parity tests: openclaw vitest (`adapters/openclaw/src/__tests__/tools/discovery.test.ts` — extend), hermes pytest (`adapters/hermes/tests/test_tools.py` — extend), nanobot pytest (`adapters/nanobot/tests/test_tools.py` — extend), Rust cargo (`packages/klodi-rust-host/tests/search_payload_parity.rs` — new). Each loads the JSON fixture, drives the tool's handler, captures the request payload via a per-stack capture stub (mock-nats.js / unittest.mock.patch / a cargo-test KlodiClient request-capture helper), asserts payload-equality per case.
   e. Add per-adapter schema-equivalence tests (PO `SC-contract.3`): each per-adapter suite loads its host-registered tool metadata for `klodi_search` + `klodi_searches_create` and compares to the golden snapshot.
2. **expert-developer (GREEN).** With the runtime path already a thin pass-through on most stacks, the expected path is:
   a. Tier (1) RED across openclaw on the `query: ""`/`category: null` cases (per Risks → openclaw `compactPayload`).
   b. **Remove `compactPayload` from the `klodi_search` arm** in `adapters/openclaw/src/tools/discovery.ts:60` (the call inside `runOneShotSearch` at line 117 stays — that's the `klodi_watch` composite, which keeps the strip-fields). The catalog says what fields exist; the marketplace says what they mean; the tool's job is to forward unchanged. `klodi_watch` keeps `compactPayload` because `persist`/`action_on_match`/`target_price` are adapter-internal flags, not catalog fields.
   c. Re-run; all four stacks GREEN on tier (1).
   d. If a fixture case shows real, non-trivial cross-stack disagreement that the architect default doesn't resolve (e.g. a stack outright rejects an input the catalog accepts), surface immediately — the answer is a clarifying assumption, not a workaround.

**Constraints.**

- **No breaking change** to catalog `params` / `result` shapes. The card prohibits renames/removals on the wire. Tier (1) structural gates (`search-schema-snapshot.test.ts`, `catalog-removal.test.ts`) enforce this.
- **No new runtime dependency.** Existing JSON-fixture loading pattern (envelope-golden) is the precedent. Do not introduce a fixture-DSL or a schema generator.
- **No production-runtime code changes** outside the one openclaw `compactPayload` removal above. If parity holds across all four stacks for every fixture case (impossible — see Risks), this is a tests-only PR. Either way, the diff is small.
- **Function caps:** new test helpers stay under 100 lines / complexity 8 / 5 positional params / 100-char lines per `CLAUDE.md`.
- **CLAUDE.md tooling:** vitest for TS, pytest for Py, cargo test for Rust. Lint with oxlint / ruff / clippy.
- **No mocks for the catalog or the schemas.** The catalog source-of-truth IS the input to the snapshot test. Per-stack stubs intercept *only* the NATS-client request boundary (so we observe what the tool would have sent without a live broker).

**Test strategy.**

- **Tier (1) integration tests are the bar this PR must clear.** They mechanically prove cross-stack payload-shape equivalence and catalog-shape immutability. Test data: the JSON fixture is the spec — never modify it to make a test pass (per CLAUDE.md `adversarial-testing` discipline).
- **One failing fixture case on any stack is sufficient to FAIL the parity gate.** The gate is "every stack agrees with the marketplace contract", not "most stacks agree".
- **Tier (2) is the headline gate but lives in klodi-stage (separate card).** This card's deliverable for tier (2) is the contract those e2e tests must hold; the architect's handoff note in the sibling card will reference the golden fixture by path.
- **No live NATS broker for tier (1).** Per-stack stubs intercept at the `client.request` boundary. The whole point of tier (1) is that no broker, no marketplace, no service is involved — only the tool layer's input-to-payload mapping.
- **Skill drift is out of scope** (PO Open Q1 closed) — do not edit `skill/SKILL.md` §6 in this card.

**Distillation note (architect's later pass).** Two doc captures look likely if dev confirms the openclaw `compactPayload` removal:
- Inline WHY comment at the deletion site in `adapters/openclaw/src/tools/discovery.ts` referencing the parity rule.
- Possible new ADR-0012 (sole-entry-point + raw payload pass-through invariant) **or** an extension to ADR-0011 (envelope parity → input parity). The architect's distillation pass searches `docs/decisions/INDEX.md` first per the `distillation` skill; the call between "extend ADR-0011" vs "new ADR-0012" gets made at distillation time against the final diff.

## In Dev — qa-developer, expert-developer

### RED phase — qa-developer

**Sentinel.** `/tmp/.claude-qa-active-a61888a7` (60-minute TTL).

**Files added (tier 1 integration parity — SC-parity.{1,2} + SC-contract.{2,3} + SC-additive.{1,3} + SC-entry.1).**

- `packages/tool-catalog/tests/fixtures/search-payload-golden.json` — the shared input matrix. 12 `klodi_search` cases + 6 `klodi_searches_create` cases covering empty-string / null / omitted / present, every `delivery` variant, cursor, limit, minimal, fully-populated. Mirrors the envelope-golden conventions (`_doc` + `_when` per entry).
- `packages/tool-catalog/tests/golden/search-schemas.json` — frozen JSON-Schema snapshot of `klodi_search` + `klodi_searches_create` `params` + `result`, generated from the TypeBox catalog. The contract record; the in-suite test below is the gate.
- `packages/tool-catalog/tests/search-payload-golden.test.ts` — fixture-shape validator + single-entry-point invariant (SC-entry.1). 70 cases, all GREEN today (the fixture is correctly built; the test fails when a fixture edit drifts off-spec).
- `packages/tool-catalog/tests/search-schema-snapshot.test.ts` — SC-contract.2 + SC-additive.{1,3} stable-contract gate. 14 cases, all GREEN today (no catalog drift yet); will trip on any breaking edit.
- `adapters/openclaw/src/__tests__/tools/search-payload-parity.test.ts` — openclaw vitest parity test. **22 tests, 10 FAIL today (RED).** Three failing modes:
  - 3 × `klodi_search` divergence cases (empty-string query, null category, empty+null mix) — `compactPayload` at `discovery.ts:60` drops `null`/`""`/`undefined` values, so `{query: "", category: null}` becomes `{}` on the wire while every other stack forwards verbatim. Architect's named smoking-gun input.
  - 6 × `klodi_searches_create` cases + 1 × schema-equivalence — `klodi_searches_create` is not registered as a standalone tool in openclaw today; only the `klodi_watch` composite reaches `searches.create`.
- `adapters/hermes/tests/test_search_payload_parity.py` — hermes pytest. **20 tests, all PASS today.** Hermes's `build_request_handler` calls `client.request(subject, args)` with raw args — already conformant. The gate locks against future regression.
- `adapters/nanobot/tests/test_search_payload_parity.py` — nanobot pytest. **20 tests, all PASS today.** Same posture as hermes — `call_tool` forwards args verbatim. Regression lock.
- `packages/klodi-rust-host/tests/search_payload_parity.rs` — Rust cargo integration test (`--features mcp`). **FAILS TO COMPILE today (6 E0603 / E0432 errors)** because `mcp::tools` is private and the helper functions don't exist yet. That IS the RED state — the dev introduces the helpers during Green (see Green-phase guidance below).

**Existing tests still passing.** Re-ran openclaw `discovery.test.ts` (12/12 PASS). The spy-reset change in `beforeEach` only affects the parity test file; the existing `discovery.test.ts` retains its own assertion patterns.

**RED-phase test infra note (worktree).** The worktree was missing `node_modules` for openclaw + tool-catalog (symlinked from main checkout after `pnpm install`), and the hermes/nanobot venvs needed a fresh `uv sync` (the prior venvs had absolute-path shebangs to a no-longer-existent sibling repo). Codegen run: `pnpm --filter @klodi/tool-catalog codegen` produced `dist/rust-types.rs` so the klodi-rust-host build resolves. Python tests run with `PYTHONPATH="$PWD/../../packages/nats-client-py/src[:$PWD/src]"` to surface `klodi_nats_client` (vendored at build time, not installed via uv).

### → Handoff to expert-developer (Green phase)

**Headline RED state to fix.** The architectural drift is in **openclaw** (TypeScript) and the missing **Rust helpers**. Hermes + nanobot are already pass-through-correct; their tests are regression locks, not Green-phase work.

**Failing tests + expected behavior.**

1. **openclaw — `compactPayload` divergence (3 failing `klodi_search` cases)**.
   - File: `adapters/openclaw/src/__tests__/tools/search-payload-parity.test.ts`.
   - Failures: `search_empty_query_string`, `search_null_category`, `search_empty_string_and_null_mix`.
   - Expected: `{query: ""}`, `{query: "laptop", category: null}`, `{query: "", category: null}` reach `client.request("p2p.v1.listings.search", payload)` byte-equal to the fixture's `expected_wire_payload`.
   - Got today: `{}` for every case (compactPayload drops the empty-string and null-valued keys).
   - **Fix (architect's hypothesis, restated):** strip `compactPayload(params)` from the `klodi_search` arm in `adapters/openclaw/src/tools/discovery.ts:60` (one line — replace `const payload = compactPayload(params);` with `const payload = params;`, then verify the type). The marketplace's `listings.search` handler is the contract; the tool layer has no business deciding what "empty" means on the service's behalf. KEEP `compactPayload` inside `runOneShotSearch` (line ~117 of `discovery.ts`, the `klodi_watch` composite) because the strip-fields `persist` / `action_on_match` / `target_price` ARE adapter-internal flags that should NOT reach the marketplace — but they are NOT catalog params, so the fixture doesn't exercise them through the direct `klodi_search` path. Add an inline `// See ADR-0011 SC-parity.1` comment at the removal site (distillation will pick this up later).

2. **openclaw — missing `klodi_searches_create` registration (6 failing parity + 1 schema-equivalence test)**.
   - File: same as above.
   - Failures: every `searches_create_*` case + `klodi_searches_create registered metadata mirrors klodiTools.klodi_searches_create`.
   - Got today: `Error: Tool "klodi_searches_create" not registered. Registered tools: klodi_search, klodi_watch, klodi_unwatch, klodi_searches_list, klodi_comment`.
   - **Fix:** add a `registerSearchesCreate(api)` function alongside `registerSearch(api)` in `discovery.ts`, registered via `registerDiscoveryTools(api)`. Mirror the existing `registerSearchesList` pattern (it's the smallest analogue — pure pass-through, no compactPayload). The handler body:
     ```typescript
     function registerSearchesCreate(api: PluginAPI): void {
       const tool = klodiTools.klodi_searches_create;
       api.registerTool({
         name: "klodi_searches_create",
         label: "Register Standing Search",
         description: tool.description,
         parameters: tool.params,
         async execute(_id, params) {
           const guard = runPreCallGuardsResult(
             params,
             [{ field: "slug", kind: "non_empty_string" }],
             { registerCli: OPENCLAW_REGISTER_CLI },
           );
           if (guard) return guard;
           try {
             const result = await rawRequest(tool.subject, params);
             return jsonResult(result);
           } catch (e) {
             return envelopeToolResult(e);
           }
         },
       });
     }
     ```
     Then `registerDiscoveryTools(api)` calls `registerSearchesCreate(api)` after `registerSearch(api)`. Note: the architect's discovery handoff names only the `compactPayload` removal as the Green-phase change; this `searches_create` registration is the second drift this QA pass surfaced. It is the SAME architectural class (cross-stack pass-through invariant) and the SAME tiny patch shape. Confirming the call: hermes (`register_request_tools` iterates the catalog excluding only `_is_local_tool` set; `klodi_searches_create` is NOT in that set) and nanobot (`TOOL_DEFINITIONS` excludes `_LOCAL_TOOLS`; `klodi_searches_create` is NOT in that set) both already register it directly. Rust (`build_tool_list` iterates the catalog and includes every entry where `ToolName::from_name(name).is_some()`) does too. openclaw is the outlier.

3. **Rust — missing `pub` helpers (whole `search_payload_parity.rs` fails to compile)**.
   - File: `packages/klodi-rust-host/tests/search_payload_parity.rs`.
   - Compile errors: `module tools is private`. The test references `klodi_rust_host::mcp::tools::payload_for_passthrough` and `klodi_rust_host::mcp::tools::tool_input_schema_for`.
   - **Fix (two small helpers + visibility tweak).** In `packages/klodi-rust-host/src/mcp/mod.rs`, change `mod tools;` to `pub mod tools;` (matching `pub mod envelope;` and `pub mod guards;`). In `packages/klodi-rust-host/src/mcp/tools.rs`, add two pure helpers:
     ```rust
     /// Lift the payload-construction line from `dispatch_passthrough`
     /// into a pure function. The Rust pass-through is a one-line
     /// identity transform (no compaction, no defaults) — this helper
     /// captures that contract so the parity test can exercise it
     /// without dialing NATS. See ADR-0011 SC-parity.1/.2.
     pub fn payload_for_passthrough(args: JsonObject) -> Value {
         Value::Object(args)
     }

     /// Look up a tool's input schema by name from the catalog the Rust
     /// dispatcher consumes. Returns `None` for unknown tools. The
     /// parity test uses this to assert per-adapter schema equivalence
     /// against the canonical TS catalog (SC-contract.3).
     pub fn tool_input_schema_for(name: &str) -> Option<&'static Value> {
         schemas::catalog().tools.get(name).map(|entry| &entry.params)
     }
     ```
     `schemas::catalog()` already exists and `dispatch_passthrough` already uses it at line 60-71. Lifetimes work because the catalog is a process-wide static.
   - Then refactor `dispatch_passthrough` to use the helper (`let payload = payload_for_passthrough(args);` replacing the inline `Value::Object(args)` at line 271) — one-line readability fix that pins the test contract at the production site.

**Constraints (Green-phase).**

- **NO weakening of any parity test.** The fixture IS the contract; the implementation matches the fixture. If you discover a case where the spec is genuinely wrong (not just inconvenient), raise it explicitly — never edit the test to pass.
- **NO breaking change** to catalog `params` / `result` shapes. The schema-snapshot test trips on any rename/removal.
- **Inline distillation note:** add `// See ADR-0011 SC-parity.{1,2}` comments at both edit sites (openclaw `discovery.ts` compactPayload deletion + the new `registerSearchesCreate` site, plus the Rust `payload_for_passthrough` helper site). solutions-architect's later distillation pass picks these up.
- **No new runtime dependency.** Existing JSON-fixture loading + the catalog re-export are the precedents.
- **Function caps:** new helpers stay under 100 lines / complexity 8 / 5 positional params / 100-char lines per CLAUDE.md.

**Verification after Green.**

- `cd packages/tool-catalog && pnpm vitest run tests/search-payload-golden.test.ts tests/search-schema-snapshot.test.ts` → 84/84 still passes.
- `cd adapters/openclaw && pnpm vitest run src/__tests__/tools/search-payload-parity.test.ts` → 22/22 passes (was 12/22).
- `cd adapters/hermes && PYTHONPATH="$PWD/../../packages/nats-client-py/src:$PWD/src" .venv/bin/python -m pytest tests/test_search_payload_parity.py` → 20/20 still passes.
- `cd adapters/nanobot && PYTHONPATH="$PWD/../../packages/nats-client-py/src" .venv/bin/python -m pytest tests/test_search_payload_parity.py` → 20/20 still passes.
- `cd packages/klodi-rust-host && cargo test --features mcp --test search_payload_parity` → 6 tests pass (was 0 — compile error).

**Pre-existing failures in the openclaw suite (NOT the parity gate).** `pnpm vitest run` against openclaw also shows ~19 unrelated failures in `policy-seeding.test.ts`, `setup-state.test.ts`, `setup.test.ts`, `register-poller.test.ts` — these are missing-skill-bundle / missing-policy-template issues from the worktree env (`adapters/openclaw/skill/` directory doesn't exist in the worktree, only in the main checkout). They pass against the main checkout. Not part of this card's scope; ignore them for Green verification. If they stay broken after PR open, file a follow-up infra card.

**Open question for expert (no answer needed before Green starts — flag for discussion if it lands).** SC7.4 expects the `klodi_searches_create.criteria` reply to mirror the agent-submittable shape on `klodi_search`. The catalog's `criteria` object today is `{query, category, delivery, min_price, max_price}` — but `klodi_search.params` ALSO accepts `condition`, `limit`, `cursor`. Is `criteria` deliberately a strict subset (one-shot-only params excluded from standing-search registration), or is this a catalog drift the dev should reconcile? Re-check during Green; if drift, raise it before fixing — the answer affects whether SC7.4 is a test addition or a catalog edit.

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
