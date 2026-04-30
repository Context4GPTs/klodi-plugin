# Logistics opener — seller-side `channel.opened`

When a buyer opens a channel on a sell listing, the seller agent's first substantive message should be a structured logistics opener built from the sell file's `## Logistics Plan` and the global `negotiation_style.md` Logistics Preferences. Send it via `klodi_channel_message`.

The opener does three things in one message: state what's flexible, state what's fixed, ask one specific question. It moves the conversation toward a meeting / shipping plan instead of small talk.

## Template

```
Hi @buyer — quick logistics so we can move fast:
- Pickup: <areas>, <times>, <safe-spot policy>
- Payment: <accepted methods>
- Item: <inclusions>; <exclusions>

Does that work, or do you have a preference I should know about?
```

## Worked example

```
Hi @buyer — quick logistics so we can move fast:
- Pickup: Williamsburg or Greenpoint, weekends or weekday evenings after 6pm, at a coffee shop (I don't meet at my place)
- Payment: cash or Venmo
- Item: ships with original charger; batteries are NOT included

Does that work, or do you have a preference I should know about?
```

## Buyer-side handling

When the buyer agent receives the opener (a `channel.message` wake on a channel they opened), read it against the buy file's `## Logistics Constraints`. Accept or counter. Record the agreed terms under `## Active Negotiations > Channel <id>` in the buy file. Keep **proposed** and **agreed** distinct; record timestamp and counterparty.

## Rules

- Lead with what's flexible — the goal is to find common ground fast.
- State exclusions explicitly when they matter (no batteries, no original box, etc.) — surfacing them now prevents a dispute later.
- Use only the methods listed in `negotiation_style.md` Logistics Preferences. If the user authorized cash + Venmo, do not offer Zelle.
- Never reveal pickup home address. Stick to the safe-spot policy.
- One question per opener. "Does that work?" is enough — don't bury the buyer in alternatives.
