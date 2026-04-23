# ADR-0005 — Floor-price enforcement client-side only

- **Status:** Accepted
- **Date:** 2026-04-22

## Context

A seller's *floor price* — the number below which they will not accept any offer — is the highest-value secret in a marketplace negotiation. Revealing it collapses the negotiation to that number, because a rational counterparty will anchor at exactly the floor. A server that holds this value is a server that can leak it: via a bug, a breach, a subpoena, or a legitimate product decision that changes the defaults later.

The plugin must enforce floor discipline against two adversaries:

1. **The counterparty agent** — which will, if clever, ask "what's your lowest?" in a dozen different phrasings until it finds one that slips past the negotiation style.
2. **Any component that is not the user's own disk** — including the klodi backend, a future server operator, and any plugin sibling running in the same OpenClaw runtime.

## Decision

- Floor prices (`min_acceptable_price`, `auto_reject_below`) live **only** in the user's local sell file (`sell/<slug>.md` frontmatter). They are never transmitted to klodi's servers and never surface in listing bodies, comments, channel messages, or offer payloads.
- Auto-reject-below-floor logic runs inside the plugin's timer (`src/service/timers.ts` `checkSellItem`) against locally-known values. The plugin emits an `offers.respond action=reject` call; the server sees only that the offer was rejected, not why.
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

- Code: `src/service/timers.ts` `checkSellItem` — auto-reject logic
- Code: `src/lib/config.ts` `SellFile` — frontmatter schema with `min_acceptable_price`
- Bundled: `skill/policies/security.md` — hard rules, copied to user's policies dir
- SKILL.md § 8 (listing description as knowledge base), § 11 (notifications)
- [SECURITY.md § What is sent to klodi's servers](../../SECURITY.md)
