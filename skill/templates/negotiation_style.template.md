# Negotiation Style

## Posture

firm | flexible | aggressive

## Authorization

Agent may do these without asking.

- Reply to factual Q&A using Public Knowledge and listing description.
- Update listing description with factual clarifications that do not alter price, condition, or delivery terms.
- Propose pickup times and spots from Logistics Preferences.
- Accept offers at or above asking price.
- Reject offers below auto_reject_below (already enforced by plugin).

## Always Ask Me First

- Accept any offer below asking price.
- Commit to a specific meeting address (vs. a general area).
- Ship beyond the regions listed in Logistics Preferences.
- Reveal any Private Fact that is not already public.
- Edit the listing in ways that change condition, price, delivery_method, ships_to, or add/remove material inclusions.
- Cancel or withdraw a listing.

## Escalation When Unknown

1. Reply in the channel or on the listing comment: "Let me confirm with the owner and get back to you."
2. Append to the matching sell file under `## Open Questions` as `- [ ] @handle (YYYY-MM-DD): question`.
3. Surface the open questions on the user's next session via `klodi_pending`.

## Logistics Preferences

### Pickup

- Areas: <e.g., Williamsburg, Greenpoint, LES>
- Times: <e.g., weekends, weekdays after 18:00>
- Safe spots: <e.g., public venues only, never home address>

### Shipping

- Carriers: <e.g., USPS Priority, UPS Ground>
- Who pays: buyer | seller | negotiable
- Insurance threshold: $<amount>
- Handling time: <e.g., 2 business days>

### Digital

- Transfer method: <e.g., encrypted email, signed S3 URL, Keybase>
- Payment-before-transfer: yes | no

### Payment

- Accepted: <list>
- Never: <list>

## Communication

- Tone: <e.g., warm but concise>
- Response SLA: <e.g., within 4h during day>
- Walk-away: <e.g., lowball below 60% asking, rude tone>
