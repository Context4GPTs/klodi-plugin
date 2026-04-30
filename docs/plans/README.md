# Future enhancements

Gaps surfaced by the 2026-04 external review of `docs/`. Each file here is a concrete piece of work deferred past v1 — not because the gap is dismissed, but because the engineering cost, prerequisites, or sequencing pushed it out of scope for the initial security posture.

Unlike ADRs (accepted decisions) and THREAT_MODEL rows (enumerated threats + current mitigations), these documents describe **known shortcomings with a proposed path to close them.** When one ships, fold the result back into the ADR or threat model row it modifies and delete or supersede the plan file.

## Out of scope by design

The workstation owner is the trust anchor: OpenClaw plugin hosts run under a user who has full control over their own machine. Defenses that assume otherwise (adversarial root on the same UID, user against themselves, "uninstall must purge" privacy guarantees against the host operator) are not in scope for this plugin. Threats to the *plugin's state* from *other software running as the same user* are the user's composition decision to own.

## Index

| ID | Title | Source |
|---|---|---|
| [0001](./0001-adr-skill-policy-architecture.md) | ADR for the skill/hard-rules agent-policy model | Review §6 |
| [0002](./0002-keychain-backed-credentials.md) | Keychain / hardware-backed credential storage | ADR-0002 alternative 1 |
| [0003](./0003-floor-probing-defense.md) | Defenses against binary-search floor probing | Review §3 |
| [0004](./0004-npm-publish-provenance.md) | Supply-chain attestation for published tarballs | Review §4 |
| [0005](./0005-exif-metadata-scrubbing.md) | Decision on photo metadata (EXIF GPS, device IDs) | Review §7 |
| [0006](./0006-adr-lifecycle-hygiene.md) | Mark ADRs retrospective; demonstrate supersede flow | Review §1 |
| [0007](./0007-threat-model-additions.md) | Active malicious backend, creds TOCTOU, floor-probing rows | Review §7 |
| [0008](./0008-mitigation-test-evidence.md) | Link every claimed mitigation to a test or inline assertion | Review §8 |
| [0009](./0009-multi-host-marketplace-strategy.md) | Port klodi to non-OpenClaw personal agent runtimes (Hermes, Moltis, Cowork, …) | Product direction 2026-04 |
| [0010](./0010-multi-host-build-plan.md) | Implementation plan for 0009 — package layout, WakeStrategy, rollout | Follow-up to 0009 |
| [0011](./0011-threat-model-wake-fanout.md) | Threat-model additions for the multi-host wake-fanout plane | Follow-up to 0010 |
| [0012](./0012-nats-native-host-plugins.md) | NATS-native host plugins (ratified, shipped in 0.2.0) — replaces the webhook plane with a per-session NATS-WS connection | Follow-up to 0010 |
