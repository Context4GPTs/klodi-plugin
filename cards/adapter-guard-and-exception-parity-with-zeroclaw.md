---
type: card
title: Adapter guard and exception parity with zeroclaw
slug: adapter-guard-and-exception-parity-with-zeroclaw
work_type: feature
tiers: []
status: discovery
agents: [solutions-architect, product-owner]
priority: 2
created: 2026-05-23
updated: 2026-05-23
base_branch: main
worktree: /Users/knitlybak/GitHub/4gpts/klodi/klodi-plugin/.claude/worktrees/card-adapter-guard-and-exception-parity-with-zeroclaw
branch: card/adapter-guard-and-exception-parity-with-zeroclaw
pr: null
merged_commit: null
---

## Intent (founder)

**Problem:** Of klodi-plugin's six adapters, only zeroclaw — the most recently built — wraps transaction-affecting tools (`klodi_transactions_accept`, `klodi_assets_withdraw`, and the rest of that family) in a complete guard set, and only zeroclaw returns a structured exception envelope that tells the calling agent what failed, why, and how to recover. The other five adapters (openclaw, hermes, nanobot, moltis, ironclaw) either lack the guards or surface failures as opaque messages, so agent behaviour diverges across hosts and recovery logic isn't portable.

**Goal:** openclaw, hermes, nanobot, moltis, and ironclaw expose the same guarded tool surface as zeroclaw — identical tool names, identical guard semantics (pre-call validation, post-call invariants, host-side authorisation checks) — adapted only where a host's binding model genuinely differs (e.g., Python typed dict vs Rust struct, MCP vs custom transport). Every rejection or runtime error returns the same structured exception envelope zeroclaw returns: error code, human-readable message, machine-readable cause, and a recovery hint the agent can act on. Discovery distills zeroclaw's pattern into a shared contract so future adapters inherit parity by default.

**Success signal:** A shared adversarial test matrix — one fixture per guarded tool × per failure mode — runs against all six adapters and produces equivalent exception envelopes (modulo host-driven binding flavour), and an agent calling `klodi_transactions_accept` against any adapter receives the same error code and recovery hint zeroclaw returns for the same failure.

---

<!--
The sections below get filled in progressively by agents.
Each agent reads the previous stage's "Handoff" section, does its work,
appends its own findings and a new "Handoff" section pointing at the next stage.
All commits land on the card/<slug> branch (the same worktree this file lives in).
-->

## Discovery findings — <agents tag themselves here>

<!-- Filled jointly by product-owner and solutions-architect. -->

### Approach + alternatives ruled out

<!-- 1–3 lines per alternative, with the reason it lost -->

### Affected files / surfaces

<!-- bulleted list -->

### Risks / failure modes

<!-- bulleted list — what could break -->

### Acceptance criteria

<!--
Each criterion is tagged with the test tier that verifies it. Format:

- `[tier] Given <state>, when <action>, then <outcome>`

tier ∈ {unit, integration, e2e}. The `tiers:` frontmatter is the union of tiers used here.
See .claude/skills/adversarial-testing/references/testing-tiers.md for tier definitions.
Both product-owner and solutions-architect are responsible for these — product-owner
frames the behavior, solutions-architect tags the tier.
-->

### Open questions (if any)

<!-- escalate to founder if blocking -->

### → Handoff to In Dev (next agents: expert-developer, qa-developer)

<!-- specific guidance for the dev pair: where to start, constraints,
test strategy -->

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
