# PLAN-0003 — Defenses against binary-search floor probing

- **Status:** Planned
- **Type:** Design + code change
- **Related:** ADR-0005, ADR-0007, THREAT_MODEL T1

## Gap

ADR-0005 and ADR-0007 claim the silent auto-reject path produces "a cliff, not a gradient" for a probing counterparty. In practice, a cliff *is* a signal: a rational buyer can binary-search the price space — `$1000 → rejected`, `$500 → rejected`, `$750 → accepted-for-negotiation`, etc. — and locate the floor within ~log₂(range) offers. The attack is not explicitly named in the threat model and no mitigation is in place.

The attacker's cost today is effectively zero: submitting offers is free, rejection is silent, and there is no rate limit or friction that scales with probing.

## Proposed approach

Options, in rough order of engineering cost:

1. **Rate-limit offers per buyer-seller pair.** Server-side: a buyer cannot submit more than N offers against the same listing within a time window. Makes probing slow without blocking legitimate renegotiation.
2. **Jitter the reject latency.** Delay rejection by a randomized amount (seconds–minutes). A probing buyer cannot rapidly iterate; the cliff becomes time-diffused.
3. **Aggregate-rejection hint.** Reject with one of several opaque reasons ("below acceptable", "listing paused", "recent activity"), mixing real rejections with decoys. The signal becomes noisy; a probe response is no longer reliable ground truth.
4. **Counter-offer instead of reject near the floor.** When an offer is within X% of the floor, respond with a counter-offer anchored above the floor rather than auto-rejecting. This converts a probe into a negotiation the seller's agent gets woken for — higher friction for the probe, higher conversion for legit buyers.
5. **Require a comment / reserve on each offer.** Makes spamming probes socially or economically costly.

1 and 2 are complementary and cheap. 3 and 4 require more design. 5 is a product decision.

## Why deferred

The mitigation landscape spans client, server, and product. v1 ships with the hard-rule + silent-reject floor defense and accepts the probing residual; the full fix needs cross-team alignment with the klodi backend team.

## Definition of done

- New T14 row in THREAT_MODEL.md explicitly naming the binary-search probe.
- At least mitigation (1) implemented server-side and referenced from T14.
- ADR-0005 updated with a "Residual risk: binary-search probing" paragraph cross-referencing the new mitigation.
