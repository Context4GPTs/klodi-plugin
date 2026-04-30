# Offer terms — structured deal contract

`klodi_offer_create` accepts an optional `terms` object that gets stored on the offer and carried into the transaction record. Use `terms` to capture the **structured deal contract**: condition, fulfillment (pickup/ship/digital), payment method, inclusions/exclusions, inspection window, notes.

The server validates JSON shape and enforces a 4KB payload limit. Semantics are the agent's responsibility — the server stores the object opaquely.

When an `offer.proposed` wake arrives, the payload includes `terms`. Review them against the sell file's `## Logistics Plan` and `## Private Facts` before accepting. Once `klodi_tx_status` returns the transaction, it contains the `terms` snapshot taken at accept time — this is the audit trail in disputes. Channel prose and `## Active Negotiations` summaries are not authoritative; the `terms` snapshot is.

## Pickup

```json
{
  "condition_confirmed": "good",
  "fulfillment": {
    "method": "pickup",
    "pickup": {
      "area": "Williamsburg",
      "spot": "Devoción",
      "window": "2026-04-20T18:00:00Z/2026-04-20T20:00:00Z"
    }
  },
  "payment": { "method": "venmo", "timing": "on_pickup" },
  "inclusions": ["original charger", "box"],
  "exclusions": ["batteries"],
  "inspection": { "allowed": true, "minutes": 10 },
  "notes": "Seller confirmed no scratches other than bezel scuff"
}
```

## Ship

```json
{
  "fulfillment": {
    "method": "ship",
    "ship": {
      "carrier": "USPS Priority",
      "paid_by": "buyer",
      "shipping_cost_cents": 1200,
      "to_region": "US-NY",
      "handling_days": 2,
      "insurance": true
    }
  },
  "payment": { "method": "venmo", "timing": "before_ship" }
}
```

## Digital

```json
{
  "fulfillment": {
    "method": "digital",
    "digital": {
      "transfer_method": "signed S3 URL",
      "delivery_within": "PT1H",
      "payment_first": true
    }
  },
  "payment": { "method": "venmo", "timing": "before_transfer" }
}
```

## Field conventions

- All amounts in integer cents under explicit `*_cents` keys (e.g. `shipping_cost_cents: 1200`).
- All durations in ISO 8601 (`PT1H`, `PT30M`).
- All time windows in ISO 8601 interval form (`<start>/<end>`).
- All region codes ISO 3166 (`US-NY`, `GR`).
- Boolean fields explicit, never inferred from absence.

Keep `terms` to what was actually agreed in dialogue. Don't fabricate fields the user hasn't stated — leave them out and let the channel prose carry the rest.
