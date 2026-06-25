# Sell and buy file format

Sell and buy files live under `${klodi_home}/sell/<slug>.md` and `${klodi_home}/buy/<slug>.md`. Each one has structured YAML frontmatter (parsed by the plugin) and a freeform markdown body (read by the agent for policy and dialogue context).

The plugin creates these files automatically on `klodi_list_create` (sell) and `klodi_watch persist=true` (buy). The agent edits the body — never the slug, never a parallel file. The slug's trailing `-<listing_id[:6]>` makes it stable across sessions and discoverable by `findSellFileByListingId`.

## Sell file frontmatter

```yaml
---
listing_id: <uuid>
min_acceptable_price: <integer cents>
auto_reject_below: <integer cents or null>
transaction_id: <uuid or null>
---
```

`min_acceptable_price` is the floor — never sent to the server, never shared with counterparties. `auto_reject_below`, when set, is enforced by the plugin: offers below it are rejected without waking the agent.

## Buy file frontmatter

```yaml
---
query: <search terms>
max_price: <integer cents>
target_price: <integer cents>
delivery: { "method": "any" }
action_on_match: <notify|negotiate>
---
```

`delivery` is a single-line JSON object — one of four discriminated-union shapes. Each variant exposes only its own fields; the type system rejects cross-variant fields.

| Variant | Shape | Use when |
|---|---|---|
| Any | `{ "method": "any" }` | Default. User has no delivery preference. |
| Pickup | `{ "method": "pickup", "radiusKm": 25 }` | Local pickup; `radiusKm` uses the buyer's profile location. Omit `radiusKm` for any-distance pickup. |
| Ship | `{ "method": "ship", "to": "US-NY" }` | Must be shipped; `to` is ISO 3166 country or country-subdivision. Omit for any-destination. |
| Digital | `{ "method": "digital" }` | Digital delivery only. |

`action_on_match`:
- `notify` — agent surfaces the match to the user, takes no other action.
- `negotiate` — agent opens a channel and engages per the negotiation policy (still escalates per `## Always Ask Me First` rules).

There are no timing fields. Standing searches are server-side; matches arrive as `search.match` wakes. The buy file is policy + dialogue digest only. A standing search has no automatic end — when a deal closes via this buy file, the agent prompts the user about `klodi_unwatch` (per SKILL.md §3 `transaction.completed`); otherwise the search keeps matching.

## Body — conventional sections

Use these sections as relevant; omit when empty. The agent's session-start scan looks for these exact headers — keep the names verbatim.

### Sell file body

```markdown
## Private Facts
<!-- Never share unless policy authorizes OR user approves -->
- Serial #: ...
- Known defects not visible in photos
- Batteries NOT included

## Public Knowledge
<!-- Already reflected in listing.description -->
- USB-C, original charger included
- Purchased 2023-04, light use

## Open Questions
<!-- Buyer-asked, pending user input -->
- [ ] @buyer1 (2026-04-15): optical zoom on rear camera?

## Logistics Plan
### Pickup
- Areas: Williamsburg, Greenpoint, LES
- Windows: weekends, weekdays after 18:00
- Meeting spots: coffee shops only, never home address
### Payment
- Cash, Venmo (@handle)
- Never: PayPal goods, crypto, check

## Active Negotiations
### Channel <uuid> — @buyer1
- Agreed: $120, pickup Saturday 14:00 at Devoción Williamsburg
- Pending: buyer confirmation of spot
- Agreed inclusions: original charger. Excluded: batteries.
```

### Buy file body

```markdown
## Evaluation Criteria
- Minolta or Canon preferred
- Working light meter required
- No obvious cosmetic damage

## Logistics Constraints
### Pickup
- Areas I can reach: Manhattan below 96th, Brooklyn west of Prospect Park
- Times: weekends
### Shipping
- Acceptable carriers: USPS Priority, UPS
- Will pay shipping up to $20
### Payment
- Will pay: Venmo, cash, Zelle

## Active Negotiations
### Channel <uuid> — @seller1
- Listing: <listing_id>
- Proposed terms: ...
- Pending: my decision on pickup spot
```

## Editing rules

- **Never publish a `## Private Facts` entry to listing.description without explicit user approval.** Hard rule from `policies/security.md` — overrides any permissive `## Authorization` setting.
- **`category` is editable in place via `klodi_list_update`.** If Q&A reveals it was set wrong, correct it with a single `klodi_list_update { listing_id, category }` — not `klodi_list_withdraw` + `klodi_list_relist` (that destructive path cancels transactions, drops offers, and closes channels).
- **If `listing.description` exceeds ~8 bullets, restructure** (reorganize, consolidate, rewrite) before any further append. Unbounded growth is a leak vector.
- **Agreed offer `terms` (on the server) are the canonical record.** `## Active Negotiations` is a summary; the offer's `terms` snapshot is the audit trail in disputes.
