# PLAN-0007 — Threat model additions

- **Status:** Planned
- **Type:** Documentation (threat enumeration)

## Gap

THREAT_MODEL.md covers T1–T13 well but is missing rows for threats surfaced in the review. Each is small on its own; grouped for batching.

## Rows to add

### T14 — Active malicious klodi backend

*A compromised or rogue klodi server (including a self-hosted backend the user trusts, per SECURITY.md § Scope) actively manipulates the plugin rather than passively leaking data.*

Distinct from T2, which treats the server as a passive leak target. Active attacks include:
- Sending crafted channel messages to jailbreak the user's agent (T12-by-proxy).
- Replaying old offers to confuse client state or create duplicate accepts.
- Omitting events the user is waiting for to create silent failure.
- Sending forged "counterparty accepted pickup" messages to trigger logistics actions.

Mitigations to cite:
- Client-side floor discipline ([ADR-0005](../decisions/0005-client-side-floor-price-enforcement.md)) caps damage on strategic data.
- Hard-rule policy ([skill/policies/security.md](../../skill/policies/security.md)) caps agent behavior regardless of what the server injects.
- Signed offer terms (A8 asset) give the user a disputable audit record.
- **Residual risk:** replay and omission are not currently detected client-side. A nonce/sequence on server-push frames would close this; tracked separately if PLAN-0002's signer abstraction lands.

### T15 — Creds-mode TOCTOU race

*The `loadCreds` mode check warns on drift, but nothing prevents a racing widener between check and read.*

- Severity: low. An attacker with the access needed to widen the file could also just read it directly before the `chmod`.
- Documented-and-accepted is the right outcome; worth a row for completeness.

### T16 — Binary-search floor probing

*Counterparty agents locate the floor price via binary-search on offers, exploiting the "cliff" behavior of silent auto-reject.*

Detailed in [PLAN-0003](./0003-floor-probing-defense.md). T16 should land when PLAN-0003 ships its first mitigation; the row documents both the attack and the mitigation so the two are visible together.

### T17 — Photo metadata leakage

*EXIF GPS, device identifiers, and timestamps ride along with photos to public R2 URLs.*

Detailed in [PLAN-0005](./0005-exif-metadata-scrubbing.md). T17 lands when PLAN-0005 decides.

## Why deferred

T14 and T15 can land now — they're pure doc additions. T16 and T17 should land *with* their respective mitigation plans so the threat-model row is not an orphan pointing at "we know but haven't fixed."

## Definition of done

- T14 and T15 added to THREAT_MODEL.md.
- T16 added when PLAN-0003 ships.
- T17 added when PLAN-0005 decides.
