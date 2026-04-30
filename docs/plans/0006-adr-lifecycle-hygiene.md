# PLAN-0006 — Mark ADRs retrospective; demonstrate supersede flow

- **Status:** Planned
- **Type:** Documentation hygiene

## Gap

All seven ADRs in `docs/decisions/` are dated 2026-04-22. `docs/decisions/README.md` claims the ADR set is append-only with a supersede lifecycle, but there is no evidence the lifecycle has ever run — no "Superseded" status, no ADR that refers back to a revised one. An external reviewer (correctly) reads this as: the batch was written retrospectively in one session, and the "append-only lifecycle" is aspirational rather than operational.

Being retrospective is fine. Not acknowledging it is what costs credibility.

## Proposed approach

1. **Add a note to `docs/decisions/README.md`** stating the 2026-04-22 batch is retrospective: the decisions themselves predate the documents, and the ADRs were written after the fact as part of the security review. Future ADRs are authored at decision time.
2. **Exercise the supersede flow** the next time an ADR's decision is revised. For instance, PLAN-0002 shipping will supersede ADR-0002's credentials choice — that is the natural first supersede. When that happens:
   - New ADR is authored at decision time with a proper date.
   - Old ADR's status changes from `Accepted` to `Superseded by ADR-000X`.
   - `README.md` index reflects the supersede.
3. **Add a style note** to `docs/decisions/README.md` that each ADR should name, in its body, at least one cost the decision imposed — not just rejected alternatives. This combats the "justification, not record" pattern the review flagged.

## Why deferred

Low effort, low urgency. Natural to do alongside the first post-review ADR.

## Definition of done

- `docs/decisions/README.md` notes the retrospective batch and links the review document.
- Next ADR authored goes through the new flow; one existing ADR marked `Superseded` at that point.
