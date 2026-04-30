# PLAN-0004 — Supply-chain attestation for published tarballs

- **Status:** Planned
- **Type:** CI / publish pipeline change
- **Related:** ADR-0003, THREAT_MODEL T6

## Gap

ADR-0003 establishes source-to-build reproducibility: the tarball is a pure function of the source commit, `pnpm-lock.yaml` pins the dep graph, and `clawhub` records a `verification.sourceCommit`. None of this is verifiable without user action — and more importantly, none of it is enforced at install time or observable in the registry.

A compromised maintainer token (or a typosquatting attack) could publish a malicious tarball that installs normally. Registry consumers have no cryptographic attestation that the tarball they received matches the advertised source commit.

## Proposed approach

1. **npm publish provenance.** `npm publish --provenance` generates a sigstore attestation signed with the OIDC identity of the GitHub Actions workflow that built the tarball. Consumers can verify: "this exact tarball was built by workflow X in repo Y at commit Z."
2. **Publish from a pinned GitHub Actions workflow.** The workflow commits to `.github/workflows/publish.yml`, runs in a hardened environment, and is the sole token-holder for npm. No local `npm publish` from a maintainer laptop.
3. **ClawHub verification alignment.** ClawHub's `verification.sourceCommit` should consume the provenance attestation rather than accept a self-asserted commit.
4. **Document the verification path.** README § verification explains how a paranoid user runs `npm view @4gpts/klodi --json | jq .dist.attestations` and checks the provenance manually.

## Why deferred

- Requires CI workflow rewrite and npm token rotation (current publish path is manual).
- ClawHub integration is a coordination item with the platform team.
- Zero impact on v1 behavior — provenance is additive.

## Definition of done

- `.github/workflows/publish.yml` publishes with `--provenance`.
- Manual publish path is removed (or gated behind an emergency break-glass).
- ADR-0003 § Security implications gains a "Publish-time attestation" bullet.
- THREAT_MODEL T6 cites the attestation as a concrete mitigation rather than residual risk.
