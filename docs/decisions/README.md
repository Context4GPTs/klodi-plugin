# Architecture Decision Records

Each ADR documents one architectural choice that a security reviewer, auditor, or future maintainer might otherwise have to reverse-engineer. ADRs are **append-only**: if a decision is revised, the new ADR supersedes the old one rather than mutating history.

## Why this directory exists

The [SECURITY.md](../../SECURITY.md) policy describes *what* the plugin does. These ADRs explain *why we chose the design that produces that behavior*, and what alternatives we considered and rejected. Together with [THREAT_MODEL.md](../THREAT_MODEL.md) they form the justification layer for the public posture.

Inline code comments reference ADRs by ID (e.g. `// See ADR-0002`) at the actual decision sites, so auditors can jump from source to rationale in one hop.

## Frontmatter

Each ADR has YAML frontmatter matching the harness `distillation` contract (`.claude/skills/distillation/SKILL.md`):

```yaml
---
id: NNNN-<kebab-slug>       # matches filename, no `.md` suffix
title: <human-readable>
tags: [<tag>, ...]          # add `superseded` for retired ADRs
commit: <sha>               # last commit that meaningfully changed the body
updated_at: <YYYY-MM-DD>
---
```

## Body shape

Each ADR is short, self-contained, and section-ordered:

- **`## Status`** — `Accepted`, `Superseded by [ADR-NNNN](./NNNN-slug.md) on <date>`, or `Deprecated`. Include the original acceptance date and the review concern addressed.
- **`## Context`** — what forced the choice.
- **`## Decision`** — what we did.
- **`## Alternatives considered`** — what we rejected and why.
- **`## Security implications`** — direct consequences for the trust model.
- **`## References`** — code paths (`file:line`), related ADRs, SECURITY.md sections.

## Adding a new ADR

1. Pick the next sequential ID (`ls docs/decisions/`).
2. Create `NNNN-kebab-slug.md` with the frontmatter and section order above.
3. Add a row to [`INDEX.md`](./INDEX.md) at the top — INDEX is sorted newest `updated_at` first.
4. If the new ADR supersedes an existing one: update the superseded ADR's `## Status` section, add the `superseded` tag to its frontmatter, and update its INDEX row.
5. Inline `// See ADR-NNNN` comments at the relevant source-code decision sites.

## Index

[`INDEX.md`](./INDEX.md) is the single source of truth for what ADRs exist. This README is **static format documentation** — do not duplicate the index table here.
