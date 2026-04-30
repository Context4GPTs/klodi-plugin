# PLAN-0001 — ADR for the skill/hard-rules agent-policy architecture

- **Status:** Planned
- **Type:** Documentation (no code change)

## Gap

`skill/policies/security.md` is copied verbatim into `$klodi_home/policies/security.md` on first run and is the fallback contract for the agent — it sits behind threats T1 (floor extraction), T10 (private→public promotion), and T12 (prompt injection). It is load-bearing for the trust model yet has no ADR explaining:

- Why agent-instructions-as-policy is a sound control at all (it relies on the LLM to honor the file).
- What happens if the user edits their local copy and drifts from the bundled canonical.
- Whether drift is reconciled, warned, or ignored at load time.
- What the threat is if another plugin or user-space process tampers with the local copy.
- Why `negotiation_style.md` is user-authored but `security.md` is seeded-and-treated-as-immutable.

The review (§6) flagged this as the most significant undocumented architectural choice.

## Proposed approach

Write ADR-0008 covering:

1. **Context** — the agent is the enforcement point; the file is the contract; SKILL.md §3 tells the model to treat it as hard constraint.
2. **Decision** — bundled seed + verbatim copy + no automatic reconciliation in v1.
3. **Alternatives considered** — server-side policy enforcement (rejected per ADR-0005 logic), in-process policy engine (rejected: adds surface, duplicates the model's job), user-authored from scratch (rejected: social-engineering risk against the user).
4. **Security implications** — honest accounting of what "the LLM honors a file" is worth, and what it isn't.
5. **Open question** — local-file tampering detection. If the bundled version disagrees with the user's copy, warn? Overwrite? Refuse to start? Defer the answer or resolve it inside the ADR.

## Why deferred

The documentation work is independent of code; the open question on drift-detection is worth thinking through properly rather than rushing.

## Definition of done

- `docs/decisions/0008-skill-policy-architecture.md` committed and indexed in `docs/decisions/README.md`.
- T1, T10, T12 rows in THREAT_MODEL.md cross-reference ADR-0008.
- Drift-handling behavior either implemented or explicitly marked as a residual risk in the ADR.
