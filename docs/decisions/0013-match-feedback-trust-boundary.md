---
id: 0013-match-feedback-trust-boundary
title: Match-feedback emit — action-not-label trust boundary, body-id validation
tags: [trust-boundary, feedback, flywheel, publish, adapters, catalog, nats]
commit: 68f3f83
updated_at: 2026-05-30
---

# ADR-0013 — Match-feedback emit: action-not-label trust boundary, body-id validation

## Status

Accepted (2026-05-30). Affects the in-agent adapters (openclaw, hermes, nanobot) and the three `nats-client-{ts,py,rs}` publish helpers. The daemon adapters (moltis, ironclaw, zeroclaw) carry no in-agent tool surface and are unaffected (the crate ships the Rust payload + validator only for cross-crate wire-parity testing).

Builds directly on the `klodi_channel_message` publish precedent established in [[0011-adapter-exception-envelope]] (envelope/guard contract) and shares the catalog→three-helpers→golden-fixture mechanism that [[0012-tool-request-payload-parity]] locked for the *request* path. This is **not** request-payload parity (that is 0012, titled and scoped around `klodi_search` raw pass-through): this ADR governs a one-way `kind: "publish"` emit (`klodi_match_feedback`) and the two trust-boundary rules that make its wire shape safe to feed into a training corpus. Kept a separate ADR per the repo's one-topic-per-ADR rule — folding a feedback-emit trust boundary into 0012's "raw search payload pass-through" decision would make that ADR's title misdescribe its contents, exactly the dilution 0012 itself refused when it declined to fold into 0011.

## Context

SC8's self-reinforcement flywheel (goal: robust-agentic-search) needs accept/dismiss signals to build a `ranking` golden-dataset slice. The marketplace capture (`search_match_examples`, SC8a) and the klodi-stage curation (`flywheel:curate`, SC8b) both shipped, but nothing emitted the signal — `flywheel.json` stayed `[]`. This change added the emit half: when an agent reaches a pursue-or-dismiss verdict on a `search.match` wake, the plugin publishes a feedback signal over NATS for the marketplace to record.

Two design questions on this path have non-obvious answers that a future contributor would otherwise get wrong by cloning the nearest precedent (`klodi_channel_message`) too faithfully:

1. **What does the wire carry — the agent's action, or the training label it implies?** The corpus needs a `positive` / `hard_negative` label per example. The tempting shortcut is to compute the label in the plugin and put it on the wire.
2. **How are the listing/search identifiers validated?** `klodi_channel_message`'s helper asserts strict UUID-v4 on its ids. Cloning that guard verbatim is the path of least resistance.

Both shortcuts are wrong, for the same underlying reason: **the plugin is the untrusted edge of a training-data pipeline.** The signal it emits becomes ground truth that retrains the ranker, so the wire contract has to be defensible against a misbehaving or compromised agent — not merely functional for a well-behaved one.

## Decision

**The match-feedback wire carries the agent's *action* (`outcome: "pursued" | "dismissed"`), never the ± training label; and the body identifiers are validated as marketplace slug / bounded-string, *not* as subject-path UUIDs — so the strict UUID-v4 guard from `publishChannelMessage` is deliberately not cloned.**

### 1. Emit the action, derive the label server-side

The wire body is exactly `{ search_slug, listing_id, outcome, action_on_match? }` with `additionalProperties: false`, and `outcome` is a closed `{ "pursued", "dismissed" }` literal union. The positive / hard-negative label is **never** on the wire — the marketplace derives it server-side (`labelForOutcome`, which throws on any out-of-set outcome).

The principle is a trust boundary: **an agent reporting what it did is trustworthy; an agent asserting its own training label is not.** "I pursued this match" is a fact about the agent's behavior the marketplace can record at face value. "This is a positive training example" is a claim about ground truth that only the pipeline owner may make. If the plugin could stamp the label, a single misaligned agent could poison the corpus by inverting it. So:

- The catalog params schema has no `label` field and is `additionalProperties: false` — there is **no field through which a label could be smuggled**. The closed `outcome` union is the only signal-bearing input.
- `labelForOutcome` lives server-side and is the sole label authority; it throws on any outcome outside the closed set, so a malformed emit fails loudly rather than silently mislabeling.

`additionalProperties: false` + the closed `outcome` union are not stylistic — they *are* the enforcement of this boundary.

### 2. Body ids are not subject-path ids — drop the UUID-v4 guard

`search_slug` and `listing_id` ride in the JSON **body**, not in the NATS **subject** (the subject is the hardcoded constant `p2p.v1.searches.match_feedback`, identical in all three languages, with no caller input interpolated). `publishChannelMessage` asserts strict UUID-v4 (`assertUuidV4` / `is_uuid_v4`) on `channel_id` / `sender_user_id` **because those tokens flow into the subject path** — the guard is a subject-injection defence. There is no such surface here, so cloning the guard would defend against a threat that does not exist while **wrongly rejecting valid ids the marketplace accepts**.

The helpers therefore validate against the marketplace's *actual* constraints, before any wire write:

- `search_slug` — pattern `^[a-z0-9][a-z0-9._-]{0,119}$` (the buy-file slug the agent already holds; never a UUID).
- `listing_id` — a 1..64-char non-empty string (a non-UUID id like `"listing-7f3a"` must be accepted; the marketplace re-reads the Listing row as the real gate).
- `outcome` — must be in the closed set.

This is the single load-bearing divergence from the `klodi_channel_message` clone, and it is intentional. The validation order is slug → listing_id length → outcome, all before the publish, in all three languages.

### 3. `action_on_match` provenance is reported honestly

The buy file's `action_on_match` mode in effect (`notify` default, or `negotiate`) rides along as provenance and is reported as the **real** mode — never rewritten to `notify` to "save" a signal. SC8b curation drops any row whose `action_on_match ∉ {null, 'notify'}`, because a `negotiate` auto-pursue is an action the *user* never judged and must not become a positive example. Mislabelling `negotiate` as `notify` to keep the signal would poison the corpus; honest reporting (knowing it will be curated out) is the correct behavior. Absent provenance is **omitted** from the body, not sent as `null`.

### Mechanism (shared with 0011/0012)

The tool is a single `LOCAL_TOOLS` entry (`klodi_match_feedback`, `kind: "publish"`, `host_shapes: ["in_agent"]`) in `packages/tool-catalog/`, the codegen source of truth; `pnpm codegen` propagates the schema to the Python mirrors and Rust. Three hand-written `publish_match_feedback` helpers (one per `nats-client-{ts,py,rs}`) serialize byte-identical wire bodies (field order, `Nats-Msg-Id` header = a client-minted `event_id` for JetStream dedup, conditional `action_on_match` key). The three in-agent adapters register the tool natively. This is the same catalog→three-helpers spine `klodi_channel_message` uses; the additive-safety proof for the daemon trio is that their local-tool allowlist stays empty.

## Alternatives considered

1. **Put the ± label on the wire (let the plugin compute it).** Rejected — crosses the trust boundary above. The label is ground truth for a training corpus; an untrusted agent edge must not assert it. `additionalProperties: false` + a closed `outcome` union structurally prevent it; `labelForOutcome` is the server-side authority.

2. **Clone `publishChannelMessage`'s strict UUID-v4 guard for `listing_id` / `search_slug`.** Rejected — that guard is a *subject-path* injection defence; these ids ride in the body, not the subject. Cloning it rejects legitimate non-UUID listing ids the marketplace accepts, breaking the emit for any non-UUID id, while defending a surface that does not exist. Validate against the marketplace's real slug / bounded-string constraints instead.

3. **Rewrite a `negotiate` `action_on_match` to `notify` so the signal survives curation.** Rejected — a `negotiate` auto-pursue is an action no human judged; admitting it as a positive example poisons the corpus. The emit reports the real mode and lets SC8b curation drop it.

4. **Fold this into ADR-0012 as a publish-path section.** Rejected per the one-topic-per-ADR rule. 0012 is scoped around raw request-payload pass-through for `klodi_search`; this is a one-way publish emit with its own trust-boundary rules. Cross-referenced, not merged — the same call 0012 made when it declined to fold into 0011.

5. **Request/reply tool, or piggyback the emit on `klodi_channel_create` / `klodi_unwatch`.** Rejected — request/reply implies a round-trip the write-only signal does not need; piggybacking couples the signal to channel/unwatch lifecycles and silently drops the hard-negative case (a dismiss with no follow-up would emit nothing). The signal is orthogonal and stands alone.

## Security implications

- **The plugin is the untrusted edge of a training pipeline; the wire contract is the trust boundary.** It carries facts the agent is authoritative for (its own action) and excludes claims it is not (the training label). The closed `outcome` union + `additionalProperties: false` are the enforcement, not decoration.
- **No subject-injection surface.** The subject is a hardcoded constant in all three helpers; no caller input enters it. The body-id validation defends payload well-formedness against the marketplace's schema, not the subject path — which is why the UUID-v4 guard is correctly absent.
- **Authorship is the authenticated NATS connection, not a body field.** No `user_id` / `handle` rides on the wire; the publisher's JWT establishes the searcher identity, exactly as channel publishes are scope-locked to the authenticated user. A forged-authorship attempt has no field to forge.
- **Fail-loud on malformed input.** Bad slug, empty/over-long `listing_id`, and out-of-set `outcome` are rejected before any wire write (structured `ValueError` / `KlodiError::InvalidContent` / `Error`); `labelForOutcome` throws server-side on any outcome it cannot map. A malformed emit never silently becomes a mislabeled corpus row.

## References

- **Decision sites (inline `// See ADR-0013` anchors at the body-id validation surprise):**
  - TS helper: `packages/nats-client-ts/src/publish.ts` (`publishMatchFeedback`, slug/listing-id validation)
  - Python helper: `packages/nats-client-py/src/klodi_nats_client/publish.py` (`publish_match_feedback`)
  - Rust helper: `packages/nats-client-rs/src/publish.rs` (`validate_match_feedback`, `MatchFeedbackPayload`)
- **Catalog (single source of truth):** `packages/tool-catalog/src/local-tools.ts` (`klodi_match_feedback` entry; `MatchFeedbackSlug` / `MatchFeedbackListingId` / `MatchFeedbackOutcome` fragments)
- **In-agent registrations:** `adapters/openclaw/src/tools/discovery.ts` (`registerMatchFeedback`), `adapters/hermes/src/klodi_hermes/tools.py` (`handle_match_feedback`), `adapters/nanobot/nanobot_tools.py` (`_PUBLISH_TOOLS` + `handle()` branch)
- **Schema / contract tests:** `packages/tool-catalog/tests/match-feedback-schema.test.ts` (closed outcome union + `additionalProperties:false` + FORBIDDEN_PARAM_FIELDS), `packages/tool-catalog/tests/match-feedback-additive.test.ts`, `packages/tool-catalog/tests/match-feedback-marketplace-contract.e2e.test.ts`
- **Per-stack publish parity tests:** `packages/nats-client-ts/tests/publish-match-feedback.test.ts`, `packages/nats-client-py/tests/test_publish_match_feedback.py`, `packages/nats-client-rs/tests/publish_match_feedback_test.rs`
- **Marketplace contract (separate repo, the wire's source of truth):** `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts` — subject `p2p.v1.searches.match_feedback`, payload `{ search_slug, listing_id, outcome, action_on_match? }`, `labelForOutcome` (server-side label authority)
- **Related:** [[0011-adapter-exception-envelope]] — the `klodi_channel_message` publish precedent this clones (and the envelope/guard contract the registrations inherit). [[0012-tool-request-payload-parity]] — the request-path sibling sharing the catalog→helpers→golden mechanism (opposite direction of the call: pass-through input parity vs one-way feedback emit).
