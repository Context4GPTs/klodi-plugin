# `docs/` — Public documentation

This directory holds the public-facing docs for the klodi plugin. The kanban-harness distillation surfaces (`knowledge/`, `product/`, `plans/`, `reports/`) live locally on contributor machines and are **gitignored** — they hold repo-internal context that would leak implementation detail or unshipped product thinking if published.

For contributors, the [`CLAUDE.md`](../CLAUDE.md) at the repo root describes the harness work loop that writes into those internal surfaces.

## Public docs

| Path | Purpose |
|---|---|
| [`decisions/`](./decisions/) | Architecture Decision Records — *why* we chose a design over alternatives. Code references ADRs by ID (`// See ADR-NNNN`). |
| [`specs/hosts/`](./specs/hosts/) | Per-host adapter specs (one Markdown file per supported host: openclaw, hermes, nanobot, moltis, ironclaw, zeroclaw). |
| [`THREAT_MODEL.md`](./THREAT_MODEL.md) | Security posture — assets, trust boundaries, threats, mitigations. Referenced from [`SECURITY.md`](../SECURITY.md). |

## Internal-only (gitignored)

These directories exist on contributor machines but are not shipped:

- `docs/knowledge/` — repo invariants, gotchas, non-obvious flows.
- `docs/product/` — internal product flows, business rules, glossary.
- `docs/plans/` — design plans, work-in-progress thinking.
- `docs/reports/` — investigation reports, post-mortem analyses.

The `distillation` skill (`.claude/skills/distillation/SKILL.md`) writes captures into `knowledge/` and `product/`; per-folder format conventions live in each folder's local `README.md`.

## ADR frontmatter

Each ADR carries the harness frontmatter convention so the distillation skill's `grep INDEX.md` step finds it:

```yaml
---
id: NNNN-<kebab-slug>
title: <human-readable>
tags: [<tag>, ...]
commit: <sha>
updated_at: <YYYY-MM-DD>
---
```

See [`decisions/README.md`](./decisions/README.md) for the ADR body shape (Status / Context / Decision / Alternatives / Security / References).
