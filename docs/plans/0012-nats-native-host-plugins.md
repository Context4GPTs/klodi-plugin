# 0012 — NATS-native host plugins

**Status:** draft
**Source:** supersedes the wake/MCP architecture in [0010](./0010-multi-host-build-plan.md) and the wake-fanout threat model in [0011](./0011-threat-model-wake-fanout.md). Origin: 2026-04-25 review of the multi-host shipping result. PR #36 (multi-host adapters) and PR #37 (openclaw webhook wake) shipped working code, but two architectural costs surfaced in use that this plan retires.
**Scope:** replaces the stdio-MCP + HTTP-webhook-wake pair across every host plugin with a single persistent NATS-WS connection per session that carries both tool calls and wakes.

## What changed our minds

0010's guiding principle was "stdio MCP for tools, HostWebhook for wakes — one architecture across every host." After shipping that to six host adapters we observed:

1. **The webhook plane forces the user to expose a public URL.** The setup flow stalls at `needs_wake_registration` until the user provides a Tailscale-funnel / ngrok / SSH-tunnelled URL pointing at the host gateway's `/klodi/wake` route. That is a category of work plugin users in the target market — non-developers running OpenClaw on a laptop behind a home router — cannot do unprompted, and a category of dependency (Tailscale account, ngrok subscription) the plugin had advertised it would never require. The "install plugin, walk away" promise in the README does not hold.

2. **The webhook plane is not actually reusable.** What 0010 called reuse was uniformity of the wire protocol (signed POST, content-free envelope). The *code* implementing that protocol is duplicated across every host: 1,682 LOC across 6 adapters in 3 languages (HMAC verify + envelope parse + HTTP listener + signature header + secret loading). Each new host re-implements the same thing in its own runtime. The genuinely host-specific part — calling the host's local wake primitive — is 10–30 lines per host. We pay duplication on the boring 90% so we can write the necessary 10% six times.

3. **The data plane has the same shape problem.** `klodi-mcp` is a Node binary that the host spawns over stdio. Hermes (Python), Moltis/IronClaw/ZeroClaw (Rust), nanobot (Python) all have to install a Node runtime they otherwise wouldn't need. The OpenClaw adapter on this branch already opted out of the binary entirely and talks NATS directly — quietly proving the binary is unnecessary. The on-main implementation in `klodi-skill/` also skipped MCP and called NATS directly. The two best existing implementations both bypass the layer 0010 made central.

The fix in both planes is the same: **the host plugin holds a persistent authenticated NATS-WS connection to the marketplace and uses it for everything.** Tool calls become NATS request/reply on that connection. Wakes become a JetStream consumer on that connection. The webhook plane and the stdio MCP plane both go away.

## Architecture

```
                  one persistent NATS-WS connection per session
                  ──────────────────────────────────────────────
                   ┌──────────────────────────────────────────┐
                   │                                          │
   marketplace ───►│  tool calls    : NATS request/reply      │◄─── host plugin
   service         │                  p2p.v1.<domain>.<verb>  │     (TS / Py / Rust)
                   │                                          │
                   │  notifications : JetStream consumer      │
                   │                  p2p.v1.notifications.   │
                   │                  <uid>                   │
                   │                                          │
                   │  channel stream: JetStream consumer      │
                   │                  p2p.v1.channels.>       │
                   │                  (filtered per user)     │
                   │                                          │
                   └──────────────────────────────────────────┘
                      auth: NKey at connection time
                      transport: WebSocket (firewall-friendly,
                                  outbound only, no public URL)
```

One transport. One connection per session. Three logical channels of traffic on it:

1. **Tool calls** — synchronous NATS request/reply for every `klodi_*` action.
2. **Notifications** — the marketplace pushes state-change events (offers, comments, transactions, listing changes, standing-search matches) via JetStream to a per-user inbox subject. Durable, replayable on reconnect.
3. **Channel streams** — peer-to-peer-shaped agent dialogue. Channel messages are published directly to a per-channel JetStream subject by participants and delivered to the other participant via a filtered durable consumer. The marketplace is *not* in the data path for these; it manages authorization (consumer filter) and runs a side-consumer for moderation and history-index.

NKey auth at connect time means no per-message HMAC. Wake semantics are JetStream's — durable consumer, explicit ack, server-side replay if the connection drops mid-message. **Any delivery on either consumer triggers the host's wake primitive, and the wake carries the full event payload.** The agent doesn't need a follow-up tool call to learn what woke it: the message body, the offer terms, the listing summary — whatever the event contains — is in the wake itself. Follow-up tool calls happen only when the agent wants *fresh* state (e.g., the current `tx_status` after a transaction event might differ from the snapshot in the wake).

This is not a wholly new design. It is the data flow that `klodi-skill/hooks/handler.ts` on `main` shipped (and that `adapters/openclaw/src/lib/nats-client.ts` on this branch shipped for tools), now extended with the channel-stream plane to remove the marketplace from the agent-to-agent message path, and corrected to deliver event content directly in the wake instead of routing the agent through a "pending events" drain step that JetStream renders unnecessary.

## Two delivery planes: streams and state

Every event in klodi today goes through one mechanism: marketplace handler does work, marketplace publishes a notification, recipient picks it up. That conflates two different shapes of event:

| Shape | Examples | Right storage | Right delivery |
|---|---|---|---|
| **Stream** | channel messages | append-only, replayable, JetStream-native | direct publish to per-channel subject |
| **State** | listing created/updated/withdrawn, offer proposed/accepted/rejected, transaction confirmed/cancelled/completed, listing comment posted, standing-search match | mutable rows in Postgres | marketplace handler + outbox notification |

Forcing both into "marketplace handler publishes a notification, recipient subscribes to `notifications.<user_id>`" gave us two real costs:

- **The marketplace becomes a chat relay** — every channel message is a synchronous handler that writes to Postgres, then publishes a notification. At any meaningful agent dialogue volume this dominates load.
- **Dual-write fragility for streamed events** — Postgres commit succeeds, NATS publish fails, the recipient never wakes. Today's `notification_publish_failed` log line is the silent miss. For the high-volume stream events this is a routine failure mode if we don't handle it; for the low-volume state events it's rare but unrecoverable per occurrence.

The fix is to use the storage and delivery that fits each shape.

### Stream plane: channels go JetStream-native

Channel messages flow over JetStream subjects with no marketplace handler in the data path:

```
   Agent A's plugin                                       Agent B's plugin
       │                                                       │
       │ publish to                                            │
       │ p2p.v1.channels.<channel_id>.<A_id>.msg               │
       │     (JWT scope: pub on p2p.v1.channels.*.<A_id>.msg)  │
       ▼                                                       │
   ┌──────────────────────────────────────────────────┐        │
   │ JetStream stream: P2P_CHANNELS                   │        │
   │ subjects: p2p.v1.channels.>                      │        │
   └────────────┬───────────────────────────┬─────────┘        │
                │                           │                  │
                │ marketplace               │ B's durable      │
                │ side-consumer             │ consumer         │
                │ (moderation +             │ klodi-channels-  │
                │  history index)           │ <B_id> with      │
                ▼                           │ filter_subjects  │
   ┌──────────────────────┐                 │ updated by       │
   │ marketplace observer │                 │ marketplace      │
   │ — verifies sender is │                 │ on channel       │
   │   a participant      │                 │ create/close     │
   │ — indexes for        │                 ▼                  │
   │   klodi_channel_     │              wake B's agent ───────┘
   │   history queries    │
   └──────────────────────┘
```

**Authorization is Option II from the design discussion** — static JWTs encode the user's own ID in the subject (`pub: p2p.v1.channels.*.<user_id>.msg`), and the marketplace verifies post-hoc via the side-consumer that every published `<channel_id>` actually has `<user_id>` as a participant. A misbehaving plugin can briefly publish to channels it shouldn't; the side-consumer catches the violation, kicks the user (revokes JWT, closes the channel), and surfaces the incident. Acceptable for a marketplace where economic and reputational disincentives discourage abuse.

**Sub authorization is server-side, not JWT-based.** B's JWT grants `sub` on a single static subject — the deliver subject for B's channel consumer (`klodi-channels-<B_id>`). The actual `filter_subjects` on that consumer is server-side state mutated by the marketplace as B's channel participation changes. On `klodi_channel_create` between A and B:

```
jsm.consumers.update("P2P_CHANNELS", "klodi-channels-<A_id>", {
  filter_subjects: [...existing, "p2p.v1.channels.<channel_id>.>"],
})
jsm.consumers.update("P2P_CHANNELS", "klodi-channels-<B_id>", {
  filter_subjects: [...existing, "p2p.v1.channels.<channel_id>.>"],
})
```

On `klodi_channel_close`, the marketplace removes the filters. JWTs are never re-issued. The plugin's NATS connection is never restarted. The plugin keeps consuming `klodi-channels-<user_id>` and just starts seeing new subjects appear in deliveries.

### State plane: notifications go through a server-side outbox

For events that mutate state in Postgres — offer proposed, transaction confirmed, listing comment posted, listing status change, standing-search match discovered — the marketplace handler writes the state change AND inserts a row in a notification outbox table, both inside the same Postgres transaction. A background worker drains the outbox to JetStream:

```
   marketplace handler
       │
       │ BEGIN
       │   INSERT/UPDATE business row
       │   INSERT INTO notification_outbox (event_type, recipients, payload)
       │ COMMIT                                ← atomic, one Postgres transaction
       │
       │ reply to caller (sync request/reply)
       ▼
   ┌──────────────────────────────────────────────────┐
   │ outbox_worker (in-process or sidecar)            │
   │ - LISTEN notification_outbox_inserted             │
   │ - SELECT unpublished rows ORDER BY id LIMIT N    │
   │ - publish to p2p.v1.notifications.<recipient_id> │
   │ - mark published                                 │
   └────────────────────────────┬─────────────────────┘
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ JetStream                │
                  │ P2P_NOTIFICATIONS stream │
                  └────────────┬─────────────┘
                               │
                               ▼
                       recipient's klodi-notifications-<user_id>
                       durable consumer wakes the agent
```

Properties:
- **Atomic** — listing-insert and outbox-insert are in the same Postgres transaction. If the listing exists, the outbox row exists.
- **At-least-once** — worker keeps retrying until JetStream confirms.
- **De-duped at the consumer** — every outbox row carries an `event_id` (UUID); plugins track last-seen `event_id` per consumer and skip duplicates. The wake path already needs this for JetStream's `max_deliver: 5` redelivery anyway.
- **Bounded blast radius** — the outbox stores only state-change events (low volume). Channel messages bypass it entirely. The table doesn't grow unbounded with agent dialogue.
- **`LISTEN/NOTIFY` for sub-100ms latency** — worker subscribes to `notification_outbox_inserted`; on signal it polls immediately. Falls back to a 5s tick if the LISTEN connection drops, so a missed wake never gets stuck.

Sites that switch from direct `notify()` / `publishNotification()` to outbox-write:
- `services/marketplace/src/handlers/listings.ts` — listing state changes, listing comments
- `services/marketplace/src/handlers/offers.ts` — offer lifecycle
- `services/marketplace/src/handlers/transactions.ts` — transaction lifecycle
- `services/marketplace/src/handlers/comments.ts` — listing comments (state on the public listing, not p2p; outbox is the right path)
- the new `searches.ts` handler — standing-search match notifications

Site that does *not* switch:
- `services/marketplace/src/handlers/channels.ts` — channel messages no longer go through the marketplace handler at all; agents publish directly to the `P2P_CHANNELS` stream subject.

### Why split, and why not just outbox everything

The outbox handles the dual-write durability problem cleanly, but it adds a hop and a database row per event. Two reasons that's wrong for channel messages:

1. **Volume.** Channel messages are agent-to-agent dialogue — potentially many turns per negotiation, many concurrent negotiations per active user. Channeling all of those through a Postgres outbox would inflate the outbox table by 1–2 orders of magnitude vs state changes.
2. **Native fit.** A channel is a stream. JetStream is a streaming substrate with durable storage, ordered delivery, server-side replay, and per-consumer filters. Putting an outbox in front of it is wrapping a stream substrate in a state substrate — the wrong impedance.

State events (low volume, mutable, atomicity matters) → outbox.
Stream events (high volume, append-only, JetStream-native) → direct publish.

## Channel lifecycle: open, message, close

The clearest place to see both planes working together is the agent-to-agent negotiation flow. A buyer agent finds a listing it likes; the buyer wants to talk to the seller. Today this routes every message through the marketplace as a request/reply with a metadata-only notification fanning out, requiring the recipient to fetch each message body. Post-0012, channel creation is state (one row, one outbox-event) and channel messages are stream (direct JetStream publish, consumer delivers full content).

Validated against `services/marketplace/src/handlers/channels.ts:24-136` and `packages/db/prisma/schema.prisma:194-229`. A channel today is per **(buyer, listing) pair** — not per-listing — so multiple buyers messaging the same seller about the same listing get independent threads. That uniqueness constraint stays.

### Open

```
buyer agent
   │
   │ client.request("p2p.v1.channels.create", { listing_id })
   ▼
marketplace handler:
   BEGIN tx
     1. validate (listing exists, active, user != seller)        ← unchanged
     2. idempotent existing-channel check for (buyer, listing)   ← unchanged
     3. INSERT Channel { listingId, buyerId, sellerId,           ← unchanged
                         buyerHandle, sellerHandle,
                         status: open, expiresAt }
     4. INSERT INTO notification_outbox {                        ← replaces today's
          type: "channel.opened",                                  direct notify()
          recipient: sellerId,
          payload: { channel_id, listing_id, buyer_handle } }
   COMMIT tx
     5. jsm.consumers.update("P2P_CHANNELS", "klodi-channels-<buyerId>",
        { filter_subjects: [...existing, `p2p.v1.channels.<channel_id>.>`] })
     6. jsm.consumers.update("P2P_CHANNELS", "klodi-channels-<sellerId>",
        { filter_subjects: [...existing, `p2p.v1.channels.<channel_id>.>`] })
     7. respond to buyer with { channel_id, listing_id, buyer_handle,
                                seller_handle, status, created_at, expires_at }
   │
   ▼
outbox worker drains → P2P_NOTIFICATIONS stream
seller's klodi-notifications-<sellerId> consumer delivers a wake WITH the full payload:
   { kind: "channel.opened", event_id, channel_id, listing_id, buyer_handle }
seller's agent wakes already knowing what happened — no klodi_channel_history call yet
```

### Message

Either side can publish first. Sequence for buyer's first message:

```
buyer agent
   │
   │ client.publish_channel_message(channel_id, { content: "Is it still available?" })
   ▼
nats publish to p2p.v1.channels.<channel_id>.<buyerId>.msg
   │  (JWT scope: pub on p2p.v1.channels.*.<buyerId>.msg — buyer's own user_id in subject)
   ▼
JetStream stores in P2P_CHANNELS stream
returns { sequence: <jetstream-seq> } to caller as durability confirmation
   │
   ▼
seller's klodi-channels-<sellerId> consumer
   (filter_subjects now includes p2p.v1.channels.<channel_id>.>)
delivers a wake WITH the full ChannelMessageEvent:
   { kind: "channel.message",
     event_id, channel_id, message_id, sequence,
     sender_user_id: buyerId,
     sender_handle: "alice",
     content: "Is it still available?",
     created_at }
seller's agent wakes with the message in hand — no fetch needed
   │
   ▼
seller agent decides response per its negotiation policy + the listing's sell/<slug>.md,
calls client.publish_channel_message(channel_id, { content: "Yes — 3pm at Blue Bottle?" })
   │
   ▼
buyer's consumer delivers the reply as a wake; buyer agent wakes with the content;
back-and-forth continues, peer-to-peer-shaped through P2P_CHANNELS, marketplace
observing only via its moderation side-consumer
```

### Close

```
either agent (or expiry / moderation kick):
   │
   │ client.request("p2p.v1.channels.close", { channel_id })   (if user-initiated)
   ▼
marketplace handler:
   BEGIN tx
     1. UPDATE Channel SET status = 'closed' WHERE id = channel_id
     2. INSERT INTO notification_outbox {
          type: "channel.closed",
          recipient: <other_party_id>,
          payload: { channel_id, closed_by, reason } }
   COMMIT tx
     3. jsm.consumers.update for both participants:
        filter_subjects = filter_subjects.filter(s => s !== `p2p.v1.channels.<channel_id>.>`)
     4. respond to caller
   │
   ▼
moderation side-consumer rejects any further publishes to this channel's subject
```

After close, both parties' consumers stop receiving wakes for the channel. Historical messages remain in the JetStream stream until `P2P_CHANNELS` retention rolls them off (90d default); `klodi_channel_history` continues to work on closed channels until that point.

### What this gives the agents

- **Real-time, content-rich wakes.** Each side wakes with the actual message content, not a metadata pointer. No `klodi_channel_history` call required for normal turn-taking.
- **Offline tolerance with content.** If the seller is offline when buyer sends, every queued message redelivers in order on reconnect — each as a wake with full content. Seller catches up by waking N times, processing each, acking. `max_ack_pending: 1` keeps it serialized.
- **Idempotent open.** Re-calling `klodi_channel_create` on an existing open channel returns the same `channel_id` — same as today. Re-runs are safe.
- **No marketplace round-trip per message.** Buyer publishes; seller receives via JetStream. The marketplace observes via the moderation side-consumer (sender-is-participant verification, history-index maintenance) but is not in the synchronous send path.

### Implementation seam: filter-update reconciliation

Between the Postgres COMMIT and the two `consumers.update` calls (steps 5–6 above), a crash leaves a channel that exists in DB but with one or both consumer filters not yet updated. Buyer could publish a message that the seller never receives because the filter wasn't installed at delivery time.

Mitigation lives in the marketplace's consumer-filter manager (Phase 2c): a reconciler that runs on marketplace startup AND on a 30s tick, reads `Channel` rows where `status = 'open'`, computes the expected `filter_subjects` for every user from their open channels, and calls `consumers.update` to converge any drift. Self-healing. Cheap — `update` only fires on diff. The same reconciler also handles cleanup if a channel is closed but the filter removal didn't propagate.

This pattern also covers the simpler `searches.create` and `searches.delete` paths if those ever need consumer-filter equivalents (they don't currently — standing-search matches go through the existing `notifications.<user_id>` subject, no per-search filter), but the reconciler shape generalizes if we add stream-shaped events later.

## Why MCP goes away entirely

We considered keeping an MCP layer — `packages/mcp-{ts,py,rs}/` — between each host's native tool registration and the NATS client. We rejected it. Reasoning:

- **The host plugins already have native tool registration APIs.** OpenClaw's `api.registerTool({...})`, Hermes's `tools.py register(ctx)`, the Rust hosts' trait, nanobot's tool decorators. Every supported host already speaks "tools" in its own first-class way.
- **An MCP layer would route every tool call through host API → MCP server → NATS instead of host API → NATS.** Two indirections where one suffices. No tool call benefits from the MCP envelope.
- **Both existing reference implementations skip MCP.** `klodi-skill/scripts/client.py` on `main` and `adapters/openclaw/` on this branch. The places we'd point at as "the right shape" already don't have MCP in them.
- **Future MCP-only hosts (Claude Desktop, Cursor, Goose) are a one-day shim, not a core layer.** If we ever target one, we publish a small `klodi-mcp-stdio` package that imports `packages/nats-client-ts` and exposes its tools over MCP. MCP becomes one optional downstream consumer of the NATS client, not the trunk every host routes through.

So: native tooling per host, on top of a shared NATS client per language. No MCP layer in the architecture. The existing `klodi-plugin/packages/klodi-mcp/` package is deleted in this plan.

## Package layout

```
klodi-plugin/
├─ packages/
│  ├─ tool-catalog/                   ← new; canonical klodi_* tool surface (TS source of truth)
│  ├─ nats-client-ts/                 ← new; seed from adapters/openclaw/src/lib/nats-client.ts
│  ├─ nats-client-py/                 ← new
│  ├─ nats-client-rs/                 ← new
│  ├─ klodi-mcp/                      ← DELETED
│  └─ ...
├─ adapters/
│  ├─ openclaw/                       ← imports nats-client-ts + tool-catalog; webhook+cron deleted
│  ├─ hermes/                         ← imports nats-client-py + tool-catalog; webhook+cron deleted
│  ├─ nanobot/                        ← imports nats-client-py + tool-catalog; webhook deleted
│  ├─ moltis/                         ← imports nats-client-rs + tool-catalog; webhook deleted
│  ├─ ironclaw/                       ← imports nats-client-rs + tool-catalog; webhook deleted
│  └─ zeroclaw/                       ← imports nats-client-rs + tool-catalog; webhook deleted
└─ services/
   └─ wake-fanout/                    ← DELETED (NATS already delivers wakes)
```

### `packages/tool-catalog/` — shared, strict-typed, single source of truth

Every host plugin exposes the same `klodi_*` tool surface. Schemas drift across host languages today (Hermes builds `function_schema` from MCP `inputSchema`; OpenClaw uses TypeBox; the Rust hosts never had a tool surface). 0012 freezes the catalog as a typed TS module that all three NATS clients re-export and all six adapters consume.

```ts
// packages/tool-catalog/src/index.ts (illustrative shape)
export const klodiTools = {
  klodi_list_create: {
    subject: "p2p.v1.listings.create",
    params: Type.Object({ /* TypeBox schema */ }),
    result: Type.Object({ /* TypeBox schema */ }),
  },
  // … every klodi_* tool
} as const

export type ToolName = keyof typeof klodiTools
```

- **TS adapters** import the catalog and the schema directly.
- **Python adapters** consume a JSON Schema export generated at build time from the TypeBox definitions.
- **Rust adapters** consume a generated `enum ToolName` + serde structs, also built from the TS source.

A catalog change ships once and breaks the build of any adapter that hasn't been updated. No more "Hermes was using the schema klodi-mcp shipped two minor versions ago." The implementation per host varies; the surface does not.

### `packages/nats-client-{ts,py,rs}/` — shared, ~200–300 LOC each

Public surface, identical across languages (idiomatic naming aside):

```
class KlodiClient:
    constructor(creds_path: str, config_path: str)

    async connect(): void
        # NKey auth via creds file, WS transport, exponential reconnect

    async request(subject: str, body: object, timeout_ms?: int): object
        # NATS request/reply for tool calls. Throws on no-responders, parses
        # `{ error, message }` envelopes into typed errors.

    async subscribe_notifications(handler: (event: NotificationEvent) => Promise<void>): void
        # JetStream durable consumer on p2p.v1.notifications.<user_id>.
        # Consumer name = klodi-notifications-<user_id>. The handler receives
        # the FULL event payload (kind + body), not just metadata. Explicit
        # ack after handler resolves. Library handles redelivery,
        # MaxAckPending, dedup-by-event_id, and reconnect transparently.

    async subscribe_channels(handler: (event: ChannelMessageEvent) => Promise<void>): void
        # JetStream durable consumer on P2P_CHANNELS. Consumer name =
        # klodi-channels-<user_id>. filter_subjects is server-managed by
        # the marketplace — the library never mutates it. The handler
        # receives the full channel message (channel_id, sender_handle,
        # content, message_id, sequence). Each delivery triggers the host
        # wake primitive with the message in hand.

    async publish_channel_message(channel_id: str, body: object): { sequence: int }
        # Publish to p2p.v1.channels.<channel_id>.<user_id>.msg.
        # Resolves with the JetStream sequence as confirmation of durability.
        # Replaces the legacy klodi_channel_send tool call.

    async close(): void
```

Everything below the surface — JetStream consumer creation, durable name, ack semantics, reconnect-with-backoff, on-disk creds load — lives in the library. Adapters never touch JetStream APIs directly. Adapters wire one host-wake handler that fires on either consumer's delivery; the library makes the two consumers look like a single "any inbound message" surface to the adapter.

### `adapters/<host>/` — per-host shim, ~150–300 LOC each

Each adapter contains exactly:

1. **Manifest** in the host's native format (unchanged from today).
2. **Tool registrations** — for each `klodi_*` tool, register with the host's API; the body is `await client.request("p2p.v1.<subject>", params)`.
3. **Wake subscriptions** — call `client.subscribe_notifications(event => host_wake_primitive(event))` and `client.subscribe_channels(event => host_wake_primitive(event))`. The host's wake primitive is whatever it always was: `wakeAgent` (OpenClaw), `POST /event-trigger` (IronClaw), `nanobot.event_bus.publish(channel, ...)` (nanobot), and so on. The handler receives the full event payload — channel message body, offer terms, listing summary, whatever the event carries — and passes it to the host wake primitive so the agent wakes with the content already in hand. This is the only host-specific code.
4. **Lifecycle wiring** — when the host says "session starting" (whatever that means in its plugin protocol), call `client.connect()`; when it says "session ending," call `client.close()`. For OpenClaw this is the existing lifecycle hook system; for the others it's the equivalent.

Tool registration looks like (TS):

```ts
api.registerTool({
  name: "klodi_list_create",
  parameters: ListCreateSchema,
  execute: async (_id, params) =>
    jsonResult(await client.request("p2p.v1.listings.create", params)),
})
```

That's the entire pattern. For ~30 tools in the surface, that's ~150 LOC of mostly mechanical wiring per adapter.

## What gets deleted

| Component | Today | Post-0012 |
|---|---|---|
| `klodi-plugin/packages/klodi-mcp/` (Node stdio binary) | ~1,500 LOC | deleted |
| `services/wake-fanout/` (NATS-to-HTTP fanout service) | full service | deleted |
| `adapters/openclaw/src/service/webhook.ts` + `webhook-route.ts` | 286 LOC | deleted |
| `adapters/openclaw/src/tools/wake-register.ts` | 165 LOC | deleted |
| `adapters/hermes/{webhook.py,envelope.py}` | 401 LOC | deleted |
| `adapters/nanobot/{webhook.py,envelope.py}` | 267 LOC | deleted |
| `adapters/moltis/src/{handler.rs,envelope.rs}` + HTTP server | 393 LOC + server | deleted |
| `adapters/zeroclaw/src/bin/webhook.rs` | 170 LOC | deleted |
| `adapters/ironclaw/src/bin/webhook.rs` | 165 LOC | deleted |
| `wake.hmac` on-disk file | per-user secret | deleted |
| `klodi_wake_register` tool + `needs_wake_registration` setup phase | exists | deleted |
| Tailscale/ngrok/SSH-tunnel sections of every adapter README | exists | deleted |
| `adapters/hermes/watch.py` cron-creation logic | ~150 LOC | reduced to thin server call + buy-file write (~30 LOC) |
| OpenClaw `Klodi: check buy search <slug>` cron jobs + reconciliation | host-cron primitives | deleted |
| `klodi-skill/HEARTBEAT.md` (cron-driven processing playbook) | full file | deleted (concept folded into `SKILL.md` notification handling) |
| `tools.cronjob_tools` dependency (Hermes) | runtime dep | deleted from this code path |
| `cron_id` field in `buy/<slug>.md` files + stale-cron recovery logic | exists | deleted |
| `services/marketplace/src/handlers/channels.ts` — `p2p.v1.channels.send` handler | full handler | deleted (channel messages publish directly to `P2P_CHANNELS` JetStream subject; marketplace observes via side-consumer for moderation only) |
| `klodi_channel_send` as a request/reply tool | exists | replaced by `client.publish_channel_message(channel_id, body)` returning JetStream sequence |
| `notify()` and `publishNotification()` direct-publish call sites in `listings.ts`, `offers.ts`, `transactions.ts` (the rating path lives at `transactions.ts:rate`), `comments.ts` | direct fire-and-forget | replaced by atomic `INSERT INTO notification_outbox` in the same Postgres transaction (later migrated to pg-boss in Phase 3B) |
| `klodi_pending` tool + `p2p.v1.notifications.pending` server-side handler + `pending.ts` adapter implementation | ~150 LOC adapter + handler | deleted (JetStream consumer delivers events with full payload; no drain step exists) |
| `inbox.jsonl` buffer concept + cron-driven inbox drain (was on `main`, partially still referenced in skill docs) | docs + handler logic | deleted |

Total deletion: ~3,500 LOC of stdio binary + wake-fanout service + webhook adapters + envelope parsers + HMAC verifiers + a setup phase + an entire user-facing concept ("register your gateway URL with klodi"), plus the host-cron-driven heartbeat machinery and the `channels.send` synchronous handler.

## What gets added

| Component | Estimate |
|---|---|
| `packages/tool-catalog/` (TS source of truth + JSON-Schema and Rust codegen) | ~600 LOC (catalog) + ~200 LOC (codegen scripts) |
| `packages/nats-client-ts/` | ~200 LOC (seed exists in `adapters/openclaw/src/lib/nats-client.ts`) |
| `packages/nats-client-py/` | ~250 LOC |
| `packages/nats-client-rs/` | ~300 LOC |
| Per-adapter rewrite of tool registration to call `client.request` (driven by catalog) | ~120 LOC × 6 = ~720 LOC |
| Per-adapter wake-subscription wiring (notifications + channels) | ~40 LOC × 6 = ~240 LOC |
| `P2P_CHANNELS` JetStream stream definition (in `services/marketplace/src/nats.ts` + `infra/nats/init-streams.ts`) | ~10 LOC × 2 sites |
| Marketplace consumer-filter management on channel create/close (`jsm.consumers.update` for `klodi-channels-<user_id>`) | ~80 LOC + tests |
| Marketplace channel-stream side-consumer (moderation: verifies sender is a participant; history index for `klodi_channel_history` queries) | ~150 LOC + tests |
| `notification_outbox` table + Prisma migration | DB migration |
| `outbox_worker` (in-process worker in `services/marketplace`, `LISTEN/NOTIFY` + 5s fallback tick) | ~200 LOC + tests |
| Outbox-write call sites replacing `notify()` / `publishNotification()` in listings/offers/transactions/comments/ratings handlers | ~40 LOC × 5 sites = ~200 LOC |
| `services/marketplace` standing-search handlers (`p2p.v1.searches.{create,delete,list}` + match-on-listing-create outbox-write) | ~250 LOC + DB migration |
| `event_id` (UUID) field on every notification envelope; per-consumer last-seen-id dedup helper in nats-client libs | ~30 LOC × 3 langs |

Total addition: ~3,500 LOC server-side + client. Net deletion remains positive (~3,500 in, ~3,500 out plus the deleted dependency surface), with the *operational* surface dramatically reduced: one HTTP service deleted, one stdio binary deleted, six per-adapter HTTP servers deleted, all host-cron primitives deleted. The added code lives in three concentrated places (the `packages/`, the marketplace outbox, the marketplace consumer-filter manager) instead of duplicated across six host-language adapters.

## Bootstrap (registration) is unchanged

Confirmed by reading `adapters/openclaw/src/tools/identity.ts:registerRegister` and `adapters/openclaw/src/tools/register-poller.ts`: `klodi_register` is HTTP-only against the web app. It generates a UUID session_id locally, returns `${api_url}/authorize?session=<id>` for the browser, and the plugin polls `${api_url}/api/sessions/<id>` until the user completes OAuth. The web app stores the session and returns NKey creds + config on a successful poll. The plugin writes `nats.creds` + `config.json` to disk and is now able to connect.

This flow:
- does **not** use NATS (the user has no creds yet at this point);
- does **not** use the stdio MCP binary;
- does **not** use the wake-fanout;
- has no dependency on anything 0012 deletes.

`klodi_register` stays exactly as it is in each adapter. After it completes, `client.connect()` succeeds for the first time and everything else works.

## Lifecycle: who owns the connection per host

The connection has to be alive when wakes need to land. This is the only place hosts genuinely diverge.

| Host | Connection owner | Trigger to open | Trigger to close |
|---|---|---|---|
| **OpenClaw** | gateway lifecycle hook (already proven on `main`) | `gateway:startup`, `agent:bootstrap`, `command:new`, `command:reset` | `command:stop` |
| **Hermes** | the Hermes daemon process (long-running) | daemon start | daemon stop |
| **Moltis** | the Moltis core service | service start | service stop |
| **IronClaw** | dedicated background subscriber inside the plugin | plugin enable | plugin disable |
| **ZeroClaw** | dedicated background subscriber inside the plugin | plugin enable | plugin disable |
| **nanobot** | nanobot plugin lifecycle | plugin load | plugin unload |

For every host except OpenClaw, the answer reduces to "whatever long-running process the host already runs to serve plugins." For OpenClaw, the existing hook mechanism on `main` is the seed — it's already the right shape.

If a host has no always-running process and only spawns plugins on demand, the wake will only be received when the plugin happens to be running. That is acceptable degraded behavior for those hosts: JetStream's `deliver_policy: all` plus the durable consumer means every queued event redelivers in order on next plugin connect, with full payloads, and the wake fires per-event as they drain. The agent doesn't need a session-start probe — JetStream IS the queue. **No host in the current target list is in this category.**

## Standing searches: server-side, no host cron

The current implementation creates a per-host cron job per standing search (OpenClaw cron, Hermes `tools.cronjob_tools`, etc.) that periodically wakes the agent with a "check buy search `<slug>`" prompt. The agent reads `buy/<slug>.md`, runs a one-shot `klodi_watch` against the marketplace, evaluates matches against private criteria, and acts.

This has the same problem the webhook plane had: it depends on a host-specific primitive (cron-with-message) that some hosts have, others don't, and reconciliation logic for "cron got lost" lives in every adapter.

0012 moves standing searches to the server, with matches delivered through the same wake path everything else uses.

### Architecture

```
klodi_watch(persist=true)
   │
   ├──► p2p.v1.searches.create  →  marketplace stores {user_id, slug, public_params}
   └──► write buy/<slug>.md     →  private criteria + action policy stay on disk

   ─ ─ ─ time passes; user listing activity continues ─ ─ ─

new listing posted
   │
   ▼
marketplace evaluates listing against active standing searches
   │  (reuses search.ts: boundingBox, computeDistance, query match —
   │   already implemented for one-shot listings.search)
   ▼
match → outbox-write inside listings.create transaction:
        { kind: "search.match", event_id, search_slug, listing_id, listing_summary }
   │
   ▼
outbox_worker drains → JetStream P2P_NOTIFICATIONS
   │
   ▼
JetStream consumer wakes the agent WITH the full match payload in the wake
   │
   ▼
agent reads buy/<slug>.md → evaluates the listing_summary against private criteria →
acts: notify user OR open channel and negotiate
```

### Privacy split is unchanged

| Data | Lives where | Why |
|---|---|---|
| Public search params (query, max_price, pickup_radius, ships_to, delivery_method) | Server | Already sent server-side on every `klodi_search` / `klodi_watch` call. Not new exposure. |
| Private evaluation criteria (brand, condition floor, seller-rating threshold, walk-away price, negotiation posture) | `buy/<slug>.md` on disk | Never leaves the user's machine. Server matches on public params; agent decides whether to act. |

### Why this is strictly better than per-host cron

| Concern | Per-host cron | Server-side |
|---|---|---|
| Works on every host | only hosts with cron-with-message primitive | every host (uses the wake path 0012 already builds) |
| Latency to match | next cron tick (minutes) | seconds after listing post |
| Server load | N agents pulling on a timer | O(M new listings × log N searches) with proper indexing |
| Per-host failure mode | host has no cron → can't ship | none |
| State drift recovery | "if file has cron_id but cron is missing, recreate" — real bug class today | none — single source of truth on server |
| Adapter LOC for watch | ~150 LOC × 6 hosts | ~30 LOC × 6 hosts |

### New server-side surface

Three NATS handlers in `services/marketplace`:

- `p2p.v1.searches.create` — register `{user_id, slug, public_params}`. Last-write-wins per `(user_id, slug)`.
- `p2p.v1.searches.delete` — by `slug`.
- `p2p.v1.searches.list` — diagnostic / reconciliation.

Plus a publisher hook on `listings.create`: after a new listing is committed, evaluate it against active standing searches that filter for the listing's category / location / price range, and publish `search.match` notifications for matches. Matching logic reuses `services/marketplace/src/search.ts` — the same code path one-shot searches already use.

Storage: a `standing_searches` table indexed on whatever predicates we filter on (location for radius, price ceiling, query terms via Postgres trigram or full-text). Cheap.

### Adapter-side change

`klodi_watch` and `klodi_unwatch` collapse to:

```
klodi_watch(query, max_price, pickup_radius, ships_to, delivery_method,
            persist=true) -> { watch_id, slug, status }
  if persist=false:
    one-shot search via client.request("p2p.v1.listings.search", params)
  if persist=true:
    server: client.request("p2p.v1.searches.create", { slug, public_params })
    local : write buy/<slug>.md template

klodi_unwatch(slug) -> { status }
  server: client.request("p2p.v1.searches.delete", { slug })
  local : delete buy/<slug>.md
```

No cron. No `cron_id`. No reconcile-on-startup loop. No `tools.cronjob_tools` import.

### What goes away as a consequence

- `klodi-skill/HEARTBEAT.md` — the entire "cron fires → process inbox / check buy / check listing" playbook. The remaining concept (drain notifications, evaluate, act) folds into `SKILL.md`'s notification handling section as one unified flow.
- The OpenClaw `Klodi: check notifications`, `Klodi: check buy search <slug>`, and `Klodi: check listing <slug>` cron jobs.
- The `cron_id` field in `buy/<slug>.md` and `sell/<slug>.md` and the stale-cron reconciliation steps.
- Hermes's lazy import of `tools.cronjob_tools` for the klodi watch path.

### One trade-off, named

Users lose the ability to throttle a search ("check every 6 hours, not real-time"). With server-side push they get a notification per match.

This is a feature: the throttle a user actually wants is "don't bother me with bad matches," which is exactly what `buy/<slug>.md` filtering accomplishes locally on the agent. If observed match volume floods, server-side per-user rate limits are an additive change — the architecture supports it without rework.

### Sell-side equivalent

The sell side ("check listing `<slug>` for new offers / unread channel messages") on `klodi-skill/HEARTBEAT.md` main is also cron-driven today. This is already redundant with the wake path: `offer.proposed`, `channel.message`, `comment.created`, `transaction.confirmed` etc. all already fire as notifications. The cron exists today as a belt-and-braces over the in-process NATS connection that sometimes missed events on OpenClaw lifecycle edges. With JetStream durable consumers (`max_deliver: 5`, `deliver_policy: all`) and explicit ack semantics, that gap closes — the sell-side cron has no remaining job.

So the deletion is total: every cron path in the current architecture goes away. The agent operates entirely off the notification stream + on-disk policy files, the same way it operates off any other wake.

## Wake payload contract

Every wake — on both consumers — carries the full event payload. The agent never has to call back to the marketplace just to learn what woke it. Per-`kind` shapes:

### Channel stream events (delivered via `subscribe_channels`)

```ts
type ChannelMessageEvent = {
  kind: "channel.message"
  event_id: string                    // UUID, used for consumer-side dedup
  channel_id: string
  message_id: string                  // server-assigned UUID
  sequence: number                    // JetStream sequence within the channel subject
  sender_user_id: string
  sender_handle: string
  content: string                     // the actual message body, up to 2000 chars per current schema
  created_at: string                  // ISO 8601
}
```

This is the JetStream message body itself — published by the sender, stored as-is, delivered as-is. No marketplace transformation in the path.

### Notification stream events (delivered via `subscribe_notifications`)

Notifications carry a discriminated `kind` plus the event-specific payload. Examples:

```ts
type OfferProposedEvent = {
  kind: "offer.proposed"
  event_id: string
  offer_id: string
  listing_id: string
  buyer_handle: string
  terms: OfferTerms                   // full structured terms snapshot
  expires_at: string
}

type OfferRespondedEvent = {
  kind: "offer.accepted" | "offer.rejected" | "offer.countered"
  event_id: string
  offer_id: string
  listing_id: string
  responder_handle: string
  terms?: OfferTerms                  // present on counter
}

type TransactionStateEvent = {
  kind: "transaction.confirmed" | "transaction.cancelled" | "transaction.completed"
  event_id: string
  transaction_id: string
  listing_id: string
  terms_snapshot: OfferTerms          // locked-in terms at the time of this state change
  counterparty_handle: string
}

type CommentPostedEvent = {
  kind: "comment.created"
  event_id: string
  comment_id: string
  listing_id: string
  commenter_handle: string
  content: string
}

type SearchMatchEvent = {
  kind: "search.match"
  event_id: string
  search_slug: string
  listing_id: string
  listing_summary: ListingSummary     // title, price, location, top photo URL
}

type ListingStateEvent = {
  kind: "listing.withdrawn" | "listing.sold" | "listing.expired"
  event_id: string
  listing_id: string
}
```

**State events carry a snapshot at emission time.** If the agent wants the *current* state (which may have changed between emission and wake-processing), it calls the appropriate `*_status` / `*_get` tool. For most decisions the snapshot is enough.

`event_id` is on every payload so the per-language NATS clients can dedupe redeliveries from `max_deliver: 5`. The catalog (`packages/tool-catalog/`) is the source of truth for these shapes; both the marketplace handlers and the per-language client libs derive from it so a contract change breaks the build, not production.

## JetStream stream and consumer config

### Stream definitions

Following the convention in `services/marketplace/src/nats.ts` and `infra/nats/init-streams.ts` (declared in both, kept in lockstep):

```ts
{
  name: 'P2P_EVENTS',
  subjects: ['p2p.v1.events.>'],
  retention: RetentionPolicy.Limits,
  max_age: 30 * 24 * 60 * 60 * 1_000_000_000, // 30 days
},
{
  name: 'P2P_NOTIFICATIONS',
  subjects: ['p2p.v1.notifications.>'],
  retention: RetentionPolicy.Interest,
  max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days
},
{
  name: 'P2P_CHANNELS',                                     // NEW
  subjects: ['p2p.v1.channels.>'],
  retention: RetentionPolicy.Limits,
  max_age: 90 * 24 * 60 * 60 * 1_000_000_000, // 90 days — channel lifetime + history window
},
```

Retention rationale:
- `P2P_NOTIFICATIONS` keeps `Interest` (auto-clean once consumers ack) — these are inbox events with no audit value beyond delivery.
- `P2P_CHANNELS` uses `Limits` because the stream IS the message history. `klodi_channel_history` queries replay from this stream (or read its derived index). 90 days covers the longest realistic channel lifetime; older messages can be archived to cold storage or simply rolled off if the negotiation is concluded.

### Per-user consumers

Each user's plugin owns two durable consumers, both with their host-wake handler attached:

```
─── notifications consumer ────────────────────────────────────────
stream:                 P2P_NOTIFICATIONS
durable_name:           klodi-notifications-<user_id>
filter_subject:         p2p.v1.notifications.<user_id>      (fixed)
ack_policy:             explicit
ack_wait:               30s
max_ack_pending:        1
max_deliver:            5
deliver_policy:         all
inactive_threshold:     7d

─── channels consumer ─────────────────────────────────────────────
stream:                 P2P_CHANNELS
durable_name:           klodi-channels-<user_id>
filter_subjects:        []                                  (mutated by marketplace
                                                             on channel create/close;
                                                             initially empty for a
                                                             newly registered user)
ack_policy:             explicit
ack_wait:               30s
max_ack_pending:        1
max_deliver:            5
deliver_policy:         all
inactive_threshold:     90d
```

`max_ack_pending: 1` on both consumers means the agent gets serialized wake invocations even if multiple messages are queued — the next one isn't delivered until the current one acks. Combined with the JetStream durable consumer behavior, a plugin reconnecting after a disconnect drains the entire backlog in order, one wake at a time.

### Consumer filter lifecycle (channels only)

The marketplace owns the `filter_subjects` of each user's `klodi-channels-<user_id>` consumer:

| Trigger | Operation |
|---|---|
| User registration completes | Create `klodi-channels-<user_id>` with `filter_subjects: []`. |
| `klodi_channel_create` between A and B succeeds | `consumers.update` on both A's and B's channel consumers, appending `p2p.v1.channels.<channel_id>.>` to `filter_subjects`. |
| `klodi_channel_close` (or expiry, or moderation kick) | `consumers.update` on both participants' consumers, removing `p2p.v1.channels.<channel_id>.>` from `filter_subjects`. |
| User account deletion | Delete the consumer. |

JWTs are not touched by any of these operations. The user's NATS connection stays alive throughout. From the plugin's perspective, channel participation changes manifest as new subjects appearing in the message stream — no reconnect, no re-auth, no client-side topology change.

## Migration plan

No backwards compatibility per `CLAUDE.md` § Philosophy. We cut a clean v0.2 of the plugin distribution.

### Phase 0 — `packages/tool-catalog/` and per-host specs

Land the canonical TS catalog of every `klodi_*` tool — subject, params (TypeBox), result. Add codegen scripts that produce JSON Schema (Python) and serde structs + enum (Rust) from the same source. Write per-host spec docs at `klodi-plugin/docs/specs/hosts/{openclaw,hermes}.md` documenting tool registration API, lifecycle, wake primitive, tool surface coverage, and local-state tools. Specs land before any per-host implementation.

### Phase 1 — `packages/nats-client-ts/` extraction

Move `adapters/openclaw/src/lib/nats-client.ts` (and `tool-result.ts`'s `requestAndHandle`) into the new package. Add `subscribe_wakes` (port `klodi-skill/hooks/handler.ts` from `main`). OpenClaw adapter switches to importing the package; functionality unchanged.

### Phase 2 — Server-side: outbox + standing searches + P2P_CHANNELS stream

Three changes in `services/marketplace`, each independently shippable but landing as a single phase since later phases depend on all three.

**2a. Notification outbox.**
- `notification_outbox` table + Prisma migration (`id`, `event_type`, `recipients[]`, `payload jsonb`, `event_id uuid`, `created_at`, `published_at`).
- `outbox_worker` in-process worker: `LISTEN notification_outbox_inserted` + 5s fallback tick + claim-and-publish loop.
- Replace every `notify()` and `publishNotification()` call site in `listings.ts`, `offers.ts`, `transactions.ts`, `comments.ts`, `ratings.ts` with an outbox-write inside the existing Postgres transaction.
- Add `event_id` to every notification envelope so consumers can dedupe.

**2b. Standing searches.**
- `p2p.v1.searches.{create,delete,list}` handlers.
- `standing_searches` table + Prisma migration.
- Match-on-`listings.create` evaluator reusing `search.ts`; matches go through the outbox (2a) as `kind: "search.match"`.

**2c. P2P_CHANNELS stream + consumer-filter manager.**
- Add `P2P_CHANNELS` stream definition to `nats.ts` and `init-streams.ts`.
- On `klodi_channel_create` and `klodi_channel_close`, call `jsm.consumers.update` to mutate participants' `klodi-channels-<user_id>` `filter_subjects`.
- **Filter-update reconciler.** Runs on marketplace startup and every 30s thereafter. Reads `Channel` rows by participant; computes expected `filter_subjects` from `status = 'open'` rows; calls `consumers.update` only when current filter diverges from expected. Self-heals the seam between Postgres COMMIT and the non-transactional `consumers.update` calls during channel create/close. Same reconciler handles consumer creation for newly-registered users who don't yet have a `klodi-channels-<user_id>` consumer.
- Marketplace channel-stream side-consumer: subscribes to `p2p.v1.channels.>`, verifies sender is a participant of the channel encoded in the subject, on violation revokes the user's JWT and closes the channel; also writes a derived index for `klodi_channel_history` queries.
- Existing `p2p.v1.channels.send` handler kept alive in this phase — clients haven't moved yet.

This phase ships independently of any client change. Existing clients keep working unchanged. Validates server-side mechanics before clients depend on them.

### Phase 3 — OpenClaw adapter goes pure NATS, no cron, channels JetStream-native

Inside the OpenClaw adapter:
- Replace the webhook route with `client.subscribe_notifications(event => wakeAgent(api, formatWakeMessage(event), event.kind))` and `client.subscribe_channels(event => wakeAgent(api, formatChannelWake(event), event.kind))`. Both handlers receive the full event payload and pass it to `wakeAgent` as the system message — the agent wakes with the content already in hand.
- Delete `service/webhook.ts`, `service/webhook-route.ts`, `tools/wake-register.ts`.
- Delete the `needs_wake_registration` setup phase and the `klodi_wake_register` tool.
- **Delete `tools/pending.ts` and the `klodi_pending` registration entirely.** No replacement; the skill's session-start guidance is rewritten in `skill/SKILL.md` to (a) call `klodi_setup_status` for the setup probe and (b) read `sell/*.md` and `buy/*.md` directly off disk for the local digest.
- Replace the `klodi_channel_send` tool with `client.publish_channel_message(channel_id, body)` — direct JetStream publish, returns sequence as confirmation.
- Update `klodi_channel_history` to query the marketplace's derived index (or replay the channel subject directly) — same tool surface, different backend.
- Rewrite `klodi_watch` / `klodi_unwatch` to call `p2p.v1.searches.{create,delete}` — no OpenClaw cron jobs created or reconciled.
- Delete the `Klodi: check notifications` / `Klodi: check buy search <slug>` / `Klodi: check listing <slug>` cron-creation paths.
- Update `skill/SETUP.md` to remove Step 3W entirely.
- Replace `klodi-skill/HEARTBEAT.md` content with a wake-handling section folded into `skill/SKILL.md` that explains the per-`kind` wake payloads and what to do with each.

OpenClaw adapter ships, end-to-end: no public URL, no cron jobs, no `klodi_pending` round-trip, channel messages go straight peer-to-peer through JetStream, agents wake with content in hand. Validates the full architecture before touching any other host.

### Phase 4 — `packages/nats-client-py/`

Write the Python NATS client. Test against the same marketplace fixtures the TS client uses. The wire is identical.

### Phase 5 — Hermes adapter (no nanobot yet)

Hermes adapter:
- Delete `webhook.py` + `envelope.py`.
- Drop the klodi-mcp subprocess; tool registration reads the catalog directly and registers with Hermes via `ctx.register_tool` per the spec at `docs/specs/hosts/hermes.md`.
- Rewrite `watch.py`: drop `tools.cronjob_tools` import, drop cron creation, replace with `client.request("p2p.v1.searches.create", ...)` + buy-file write.
- Wire `client.subscribe_wakes` to the Hermes daemon's local wake primitive.

Validates the Python client + the catalog codegen path.

### Phase 6 — `packages/nats-client-rs/`

Write the Rust NATS client (`async-nats` under the hood). Same surface as TS/Py.

### Phase 7 — Remaining hosts (nanobot, Moltis, IronClaw, ZeroClaw)

Per-host specs land first under `docs/specs/hosts/<host>.md` (research-required for the four that don't have tool registration code today). Then each adapter follows the Phase 3/5 shape against its native plugin SDK.

### Phase 8 — Server-side cleanup

Delete `services/wake-fanout/` and its database tables. Drop the `wake_channels` records. The `p2p.v1.wake_channels.register` NATS handler in the marketplace service goes away.

Also delete:
- The legacy `p2p.v1.channels.send` handler in `services/marketplace/src/handlers/channels.ts` — once every adapter has moved to direct JetStream publish, the request/reply path has no callers.
- The `p2p.v1.notifications.pending` handler — once `klodi_pending` is gone from every adapter, no caller remains.

### Phase 9 — `klodi-mcp/` deletion

After all adapters have moved, delete `klodi-plugin/packages/klodi-mcp/` and remove its references from any installer scripts or docs.

Each phase is independently shippable; Phase 7 can be split per-host for smaller PRs.

## Open questions to resolve before code

1. **NATS-WS reachability across enterprise networks.** We have no field data on NATS-WS surviving common corporate proxies / TLS-inspecting middleboxes. JetStream's at-least-once semantics tolerate brief disconnects, but a network that strips long-lived WebSockets entirely would break this design. Action: instrument connection lifetime on the OpenClaw adapter for two weeks before committing the other hosts. If we see frequent disconnects in the field, the mitigation is HTTP/2 long-poll fallback inside the NATS client — additive, doesn't change the surface.

2. **Lifecycle ownership for hosts without a long-running process.** Every host in the current Tier-A list has one, but we should confirm explicitly per host (rather than assume) before Phases 5 and 7. If a host turns out to spawn plugins on-demand only, the answer is "session-start polling tier" per 0010 — same fallback that doc already named.

3. **Per-language NATS client maturity for `consumer.update()` with `filter_subjects` array.** The consumer-filter-management approach (mutating the durable consumer's `filter_subjects` server-side as channel participation changes) requires that NATS clients support multi-filter consumer updates. `nats.js` (TS) does. `nats-py` should. `async-nats` (Rust) added it in a recent version. Action: a one-day spike in Phase 2c to confirm `consumer.update({ filter_subjects: [...] })` works against the live JetStream from each language. If any language is missing it, fallback is one consumer per channel per user (higher consumer count, JetStream handles thousands fine; identical wake semantics from the plugin perspective).

4. **Setup-flow simplification.** With `klodi_wake_register` deleted and the `needs_wake_registration` phase gone, the setup state machine collapses. A pass through `skill/SETUP.md`, `klodi_setup_status`, and the openclaw `setup-state.ts` to remove dead branches is part of Phase 3 and worth scoping explicitly.

5. **Consumer-side dedup window.** `event_id` (UUID) on the wake payload plus per-consumer last-seen-id is the simplest dedup. We should decide: per-`(consumer, event_id)` SQLite table on the plugin disk, or a bounded LRU in memory? Disk survives plugin restart but adds a write per event; memory loses dedup state on restart but the cost of a duplicate is minor (an extra wake the agent processes — the agent's idempotency handling already covers double-wakes safely, since acting on the same offer/message twice is detected by the marketplace). My lean: in-memory LRU of last 1000 event IDs per consumer; restart-induced duplicates are rare (plugin restarts are user-initiated, not high-frequency) and benign.

6. **Channel side-consumer authorization model.** The marketplace's side-consumer on `p2p.v1.channels.>` performs post-hoc authorization (verify sender is a participant of the channel encoded in the subject). What's the action on violation? Options: (a) revoke the user's JWT and close the channel (strict, may over-react to plugin bugs); (b) drop the message from the moderation index, log, alert, do nothing further (lenient, may permit ongoing abuse). My lean: (a) for repeated violations from the same user, (b) for first offense, with a clear log signal that surfaces both. Concrete threshold goes in the implementation.

## Out of scope

- **Tier-B partnership hosts** (Cowork, Nebula, Arahi, Vellum). Those still need a hosted MCP path because they don't allow client-side code. 0012 doesn't preclude that — when it ships, the hosted MCP binary imports `packages/nats-client-ts` like every other consumer. Still strictly additive to Tier-A.
- **Identity / NKey rotation.** Same flow as today. The connection holds an NKey; rotation = new creds file + reconnect. No protocol-level change.
- **Channel message encryption at rest.** JetStream stores channel messages on the marketplace's NATS server. Today's privacy posture is "marketplace can read channel content for moderation" — see the side-consumer's role. End-to-end encryption between agents (where the marketplace can't read) is a separate threat-model conversation; not in 0012's scope.
- **Per-user notification rate limiting.** If standing-search matches or other notifications flood a user's inbox, throttling is an additive feature on the outbox worker. Not in 0012's scope.

(Note: 0012 does include server-side changes — adding the `P2P_CHANNELS` stream, the notification outbox, the standing-search handlers, and the consumer-filter manager. Earlier drafts of this doc claimed "no server-side changes" — that was wrong, the architecture genuinely shifts work to the server. The wake-fanout service goes away on net, so server-side complexity decreases overall.)
