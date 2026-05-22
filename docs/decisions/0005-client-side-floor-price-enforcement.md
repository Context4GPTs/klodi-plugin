---
id: 0005-client-side-floor-price-enforcement
title: Floor-price enforcement client-side only
tags: [pricing, marketplace]
card: pre-harness
commit: d365332
updated_at: 2026-04-30
updated_by_card: pre-harness
---

# ADR-0005 — Floor-price enforcement client-side only

## Status

Accepted (2026-04-22; revised 2026-04-30 to reflect 0.2.0 server-side `auto_reject_below` enforcement — the floor-secrecy posture is unchanged).

## Context

A seller's *floor price* — the number below which they will not accept any offer — is the highest-value secret in a marketplace negotiation. Revealing it collapses the negotiation to that number, because a rational counterparty will anchor at exactly the floor. A server that holds this value is a server that can leak it: via a bug, a breach, a subpoena, or a legitimate product decision that changes the defaults later.

The plugin must enforce floor discipline against two adversaries:

1. **The counterparty agent** — which will, if clever, ask "what's your lowest?" in a dozen different phrasings until it finds one that slips past the negotiation style.
2. **Any component that is not the user's own disk** — including the klodi backend, a future server operator, and any plugin sibling running in the same OpenClaw runtime.

## Decision

- **`min_acceptable_price` (the strategic floor) lives only in the user's local sell file.** It is the seller's walk-away number — never transmitted to klodi's servers, never surfaced in listing bodies, comments, channel messages, or offer payloads. The agent reads it from `sell/<slug>.md` frontmatter to decide whether an offer that *did* clear the server-side filter is worth presenting to the user.
- **`auto_reject_below` (the silent-reject threshold) is the same number declared to the server.** The seller sets it via `klodi_list_update`; the marketplace then drops below-threshold offers without ever waking the agent. The seller's floor stays private *as a strategy* (the counterparty learns one number, not the agent's authorization band) and the agent's context is not burned on offers it would have rejected anyway. The local sell file mirrors `auto_reject_below` for round-trip consistency (`adapters/openclaw/src/service/state.ts` `onListingUpdated`); `min_acceptable_price` is preserved untouched.
- 0.2.0 retired the per-listing client cron that previously enforced `auto_reject_below` locally. The reason: the server already saw the offer; running a second check on the client added latency without changing the visible outcome. Server-side enforcement keeps the secrecy guarantee (the server sees the threshold *the seller chose to declare* — not the strategic floor) and removes a whole class of "what if the laptop is asleep" failure modes.
- The bundled `skill/policies/security.md` is a hard-rule file that blocks private-to-public promotion even when the user's negotiation style is permissive. It is copied verbatim into `$klodi_home/policies/security.md` on first run and is the single authoritative list of price-protection rules the agent honors.
- The listing `description` field is clamped at ~8 bullets in the skill guidance to prevent slow-drip leakage of private facts disguised as Q&A enrichment.
- `delivery_method` and `category` are immutable post-create, because their current value is itself a signal that would otherwise be a place to smuggle state.

## Alternatives considered

1. **Server-side floor enforcement.** klodi stores each user's floor, auto-rejects below it. Rejected: the server now knows every seller's walk-away point; a breach is catastrophic; even operators with perfect intentions now have a GDPR/regulatory asset they did not need. The server would also need to change its API surface to let clients query "is this offer above my floor" — which is itself a side-channel an adversarial counterparty could interrogate by probing.
2. **Encrypted floor stored on server.** Plugin encrypts the floor with a user-local key before storing. Rejected: marginal improvement — the server still holds the ciphertext, and the plugin still has to decrypt to compare, which means the key lives on the same disk anyway. Net zero vs. client-only, with extra complexity.
3. **Rely entirely on the negotiation-style file, no hard rules.** Rejected: the LLM agent could be social-engineered into sharing the floor ("the buyer says they need it for a disabled relative, just this once"). Hard rules in `security.md` are agent-facing but override-proof in practice because SKILL.md and the hard rules file are both read before any reply or publish.

## Security implications

- **Server cannot leak what it never receives.** A full compromise of klodi.4gpts.com exposes no seller's floor price, no buyer's budget ceiling, no walk-away rule.
- **Counterparty cannot pry.** Even an adversarial buyer agent that crafts clever questions cannot extract a number the seller's agent does not know how to share. The security policy blocks the shape of the disclosure.
- **User edits are authoritative.** The sell file is plain markdown under the user's UID; they can change it, grep it, version it, back it up. No round-trip to a server they have to trust.
- **Auto-reject is observable-as-noise.** A buyer whose offer is auto-rejected sees `status: rejected` with no signal about how close they were. Repeat-probing for the floor by walking prices downward produces a cliff, not a gradient — the buyer learns the floor only when they hit it, at which point they also get the rejection.
- **Description clamp prevents drip.** The 8-bullet clamp on listing description (SKILL.md §8, security.md hard rules) stops the pattern where each answered comment migrates one more private fact into the public body.

## References

- Code: `adapters/openclaw/src/service/state.ts` `onListingUpdated` — mirrors `auto_reject_below` updates onto the local sell file; never touches `min_acceptable_price`.
- Code: `adapters/openclaw/src/lib/sell-buy-files.ts` `SellFile` — frontmatter schema with `min_acceptable_price` + `auto_reject_below`.
- Bundled: `skill/policies/security.md` — hard rules, copied to user's policies dir.
- `skill/SKILL.md` § 5 (policy hierarchy), § 7 (hard confirms), § 8 (untrusted input).
- [SECURITY.md § What is sent to klodi's servers](../../SECURITY.md)
