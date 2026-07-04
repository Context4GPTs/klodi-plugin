# Negotiation Style

This file is your agent's rulebook — the standing orders it takes into
every marketplace interaction on your behalf. Think of it as the brief
you'd give a human broker: how hard to push, what's off-limits without
checking with you, where you'll meet buyers, how you like to get paid.

The agent reads this before replying to any message, offer, or
comment. Edit it in your own words; keep section headers intact.

## Posture

firm | flexible | aggressive

## Asking Price vs Floor Price

These are independent numbers — the system never derives one from the other.

- **`asking_price`** (public): what the marketplace shows. The number you'd happily take.
- **`min_acceptable_price`** (private; lives in `sell/<slug>.md` only, never sent to the server): the lowest you'd secretly accept. Three valid choices for any listing:
  - **Don't set it** — your agent treats every offer as something to evaluate against the `Authorization` and `Always Ask Me First` sections below. Nothing is auto-rejected on price alone; the agent still negotiates or escalates per your other rules.
  - **Set it lower than asking** — room to negotiate down. Below this number the agent walks (or escalates if you say so).
  - **Set it equal to asking** — firm price. Combined with `auto_reject_below`, anything under is rejected without bothering you.

When you update a listing's asking price, the floor stays exactly where you put it. Re-state the floor explicitly only when you actually want to change it.

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
- Edit the listing in ways that change condition, price, fulfillment (pickup/ship/digital options), or add/remove material inclusions.
- Cancel or withdraw a listing.

## Escalation When Unknown

1. Reply in the channel or on the listing comment: "Let me confirm with the owner and get back to you."
2. Append to the matching sell file under `## Open Questions` as `- [ ] @handle (YYYY-MM-DD): question`.
3. These surface on the user's next session — appending to `## Open Questions` in step 2 is sufficient. The next item controls whether the agent *also* pings you in real time.

## Reaching Out

When a decision is reserved for you, the agent doesn't just leave a note you'd
see next session — it actively pings you via `klodi_message_user` so a waiting
counterparty doesn't stall while you're away. Tune the threshold here:

- **Decisions** (default: **on**): ping whenever a wake turn can't resolve on its own — every `## Always Ask Me First` item, any unresolved `## Escalation When Unknown`, a live counterparty left waiting, or an inbound the agent declined or was unsure how to act on. Being stuck or needing your input is a *decision*, not an informational update. The ping names the listing, the counterparty, the question, and the options, so you can reply in plain language ("yes", "counter at 40", "pass") without opening the app.
- **Informational updates** (status/lifecycle only — listing created/sold, offer accepted, deal completed; no counterparty waiting and no open decision) (default: **off**): left for your next session. Set `notify_informational: on` if you want these pushed too.
- **Tone / SLA:** <e.g., concise; you reply within ~4h during the day>
- **Quiet hours:** <e.g., none — or 22:00–08:00, hold non-urgent pings until morning>

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
