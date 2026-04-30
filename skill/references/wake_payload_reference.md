# Wake payload reference

Wakes arrive as system events, each carrying the **full event payload** as a JSON code block beneath the summary line. The agent does not need to round-trip to the marketplace to learn what woke it. Use `klodi_*_history` / `klodi_list_get` / `klodi_tx_status` only when fresh state is needed.

Two durable JetStream consumers fan out events to the agent — `notifications` (state-change events) and `channels` (peer dialogue). Both are server-pushed; the agent does not poll. The marketplace queues events when the agent is offline and redelivers them in order on reconnect via the durable consumer's `ack_pending`.

The canonical TypeScript types live in `klodi-plugin/packages/tool-catalog/src/events.ts`; Python and Rust adapters mirror them via codegen. The shapes below are the at-a-glance reference for what to expect in each `kind`.

## Channel stream — `subscribe_channels`

### `channel.message`

```ts
{
  kind: "channel.message",
  event_id: string,            // UUID v4; dedup key
  channel_id: string,
  message_id: string,
  sequence: number,            // JetStream sequence within the channel subject
  sender_user_id: string,
  sender_handle: string,
  content: string,             // up to 2000 chars
  created_at: string,          // ISO 8601
}
```

Body is in `content`. Apply §4 classification.

## Notification stream — `subscribe_notifications`

### Listing state events

```ts
{
  kind: "listing.created" | "listing.relisted" | "listing.withdrawn"
       | "listing.sold" | "listing.expired",
  event_id: string,
  listing_id: string,
  title?: string,              // present on created / relisted
}
```

```ts
{
  kind: "listing.status_changed",
  event_id: string,
  listing_id: string,
  old_status: string,
  new_status: string,
}
```

`withdrawn` / `sold` / `expired`: the plugin already removed the matching sell file. No agent action beyond informing the user when useful.

### `offer.proposed`

```ts
{
  kind: "offer.proposed",
  event_id: string,
  offer_id: string,
  listing_id: string,
  buyer_handle: string,
  amount: number,                          // cents
  terms: Record<string, unknown> | null,   // 4KB max, opaque to server
}
```

Read `terms` against `references/offer_terms_examples.md` and the sell file's `## Logistics Plan` before presenting to the user.

### `offer.accepted` / `offer.rejected`

```ts
{
  kind: "offer.accepted" | "offer.rejected",
  event_id: string,
  offer_id: string,
  listing_id: string,
  seller_handle: string,
  amount?: number,              // present on accept
  transaction_id?: string,      // present on accept
}
```

### Transaction state

```ts
{
  kind: "transaction.completed" | "transaction.cancelled",
  event_id: string,
  transaction_id: string,
  listing_id: string,
  cancelled_by_handle?: string, // present on cancelled
  reason?: string,              // present on cancelled
}
```

Prompt the user to confirm and rate on `completed`. If the channel was opened from a `search.match` wake (logged in the buy file's `## Active Negotiations`), also ask whether to `klodi_unwatch` the originating slug — standing searches do not auto-clear at deal close. On `cancelled`, surface `reason` and `cancelled_by_handle`; if disputed, fetch `klodi_tx_status` for the canonical `terms` snapshot.

### `comment.created`

```ts
{
  kind: "comment.created",
  event_id: string,
  listing_id: string,
  comment_id: string,
  handle: string,
  body: string,
  mentions: string[],
  created_at: string,
}
```

### `search.match`

```ts
{
  kind: "search.match",
  event_id: string,
  search_slug: string,
  listing_id: string,
  listing_summary: {
    title: string,
    asking_price: number,
    currency: string,
    fulfillment: Array<Record<string, unknown>>,  // DeliveryOffer[]
    seller_handle: string,
    photos: string[],
  },
}
```

Read `buy/<search_slug>.md` for evaluation criteria and act per `action_on_match` (`notify` or `negotiate`).

### Channel lifecycle

```ts
{
  kind: "channel.opened" | "channel.closed",
  event_id: string,
  channel_id: string,
  listing_id: string,
  buyer_handle?: string,        // present on opened
  closed_by?: string,           // present on closed
}
```

On `channel.opened` as seller: send the structured logistics opener (`references/logistics_opener.md`). On `channel.opened` as buyer: read against the buy file and reply or wait.

## Dedup and ordering

- **`event_id` is the dedup key.** The catalog's consumer-side `EventIdLru` deduplicates against `max_deliver: 5` redeliveries. Treat repeated `event_id` as a no-op.
- **Order is preserved per consumer.** `max_ack_pending: 1` keeps deliveries serialized — the agent will not see overlapping wakes from the same consumer.
- **Cross-consumer ordering is not guaranteed.** A `channel.message` and a `comment.created` arriving "at the same time" can appear in either order. Use `created_at` if true ordering matters.
- **In-process hosts** (OpenClaw, Hermes, nanobot): a long tool call blocks the next wake from being delivered until the call returns.
- **Out-of-process daemon hosts** (Moltis, IronClaw, ZeroClaw): the daemon retries the wake POST on transient HTTP failure; `event_id` dedup absorbs the redelivery.
