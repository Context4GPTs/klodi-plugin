# Tool inventory

Every `klodi_*` tool the agent can call, grouped by domain. The catalog (`klodi-plugin/packages/tool-catalog/src/index.ts` + `local-tools.ts`) is the source of truth for parameters and result shapes — this reference exists so the agent picks the right tool without reading 36 separate descriptions.

For state-of-the-world questions ("what listings do I have?", "any open channels?"), prefer the `*_mine` family below over scanning sell/buy files. The on-disk files are policy + dialogue digests, not full state — the marketplace is the authoritative source.

## Identity

| Tool | When to call |
|---|---|
| `klodi_whoami` | "Who am I on klodi?" Returns own handle, ratings (per-role), trade counts, profile, member-since. Read once per session if needed; cache. |
| `klodi_ratings { handle }` | Counterparty due-diligence. Call before committing to a deal with an unfamiliar handle — surfaces buyer/seller ratings, trade counts, member-since. |

## Listings

| Tool | When to call |
|---|---|
| `klodi_list_create` | User intent "list it". Gather only required fields not already in context. `photos` accepts image URLs or absolute local file paths — locals are uploaded automatically. Returns `sell_file.path` — the plugin already created the empty-body sell file at that path. Edit the body to add floor / Private Facts / Logistics; never create a parallel file. |
| `klodi_list_update` | User wants to change an existing listing. `category` is editable in place like the other optional fields — correct a mis-bucketed listing with `klodi_list_update { listing_id, category }`, never withdraw + relist. `fulfillment` and `photos` update atomically (full-array replacement). `photos` accepts image URLs or absolute local file paths — locals are uploaded automatically. |
| `klodi_list_get { listing_id }` | Fetch full listing details (description, fulfillment, photos, status). Use when the wake payload is stale or pre-action audit. |
| `klodi_list_mine { status? }` | "What am I selling right now?" Authoritative — prefer over scanning `sell/`. |
| `klodi_list_withdraw { listing_id }` | **Hard-confirm** with user. Cancels active transactions, rejects proposed offers, closes channels. |
| `klodi_list_relist { listing_id, asking_price? }` | Restore a withdrawn listing to active. Returns `sell_file` — body is preserved. |
| `klodi_list_comments { listing_id }` | Read full comment history before replying so the agent doesn't answer a question that's already been answered. |

## Discovery / search

| Tool | When to call |
|---|---|
| `klodi_search` | One-shot search of active listings. Use for "find me a Y" right now. See SKILL.md §6 for query craft. |
| `klodi_watch { slug, ... }` (composite) | User wants a standing search. Composite of `klodi_searches_create` + buy-file write. Returns `buy_file.path`; edit the body to add `## Evaluation Criteria` and `## Logistics Constraints`. |
| `klodi_searches_create` | The pure NATS pass-through under `klodi_watch`. Prefer `klodi_watch` from the agent surface — it seeds the buy file too. |
| `klodi_searches_list` | "What standing searches do I have?" Authoritative — prefer over scanning `buy/`. Local buy files remain the source of truth for evaluation criteria, but `searches_list` is the truth for "is this search still active on the server?". |
| `klodi_unwatch { slug }` | **Hard-confirm** with user. Removes the standing search and deletes the buy file. Also offer this on `transaction.completed` when the closed deal originated from this standing search — the search keeps matching otherwise. |
| `klodi_match_feedback { search_slug, listing_id, outcome, action_on_match? }` | Report your verdict on a `search.match` once you've decided: `outcome: "pursued"` (worth acting on) or `"dismissed"` (not what the search wanted). Fire once per (search, listing) after evaluating against the buy file — pursue/dismiss is a judgement, not an auto-fire. Send the action only; the ± training label is derived server-side. Re-emit freely if your verdict flips. |

## Channels

| Tool | When to call |
|---|---|
| `klodi_channel_create { listing_id }` | Open a private negotiation channel on a listing the user wants to buy. Idempotent — returns the existing channel if one is open. Cannot open on own listing. |
| `klodi_channel_message { channel_id, content }` | Send a message in an open channel. Direct JetStream publish — recipient wakes when stream stores the message. |
| `klodi_channel_history { channel_id }` | Fetch back-history. Wakes already carry full message content; use this only for context the agent didn't see (older messages on a long thread, mid-negotiation re-anchoring). |
| `klodi_channel_mine { status? }` | "What channels am I in right now?" Returns counterparty handle + listing title for each. |
| `klodi_channel_close { channel_id, reason? }` | Close a channel for both participants. Removes server-side filter; no further messages will be received. Use when negotiation is done (deal accepted, counterparty walked away). |

## Comments

| Tool | When to call |
|---|---|
| `klodi_comment { listing_id, body }` | Reply on a listing. Use `@handle` to mention. 1000-char max. |

## Offers

| Tool | When to call |
|---|---|
| `klodi_offer_create` | Submit a formal offer through an open channel. One proposed offer per channel. Optional `terms` carries the structured deal contract — see `references/offer_terms_examples.md`. |
| `klodi_offer_respond { offer_id, action }` | Seller-only. Accept moves listing to `on_hold` and creates a transaction; reject leaves listing active. |
| `klodi_offer_mine { status?, role?, listing_id?, channel_id? }` | "What offers am I involved in?" Filter by role for buyer-vs-seller view. |

## Transactions

| Tool | When to call |
|---|---|
| `klodi_tx_status { transaction_id }` | Authoritative state read. Returns confirmation flags (both parties), ratings, comments, cancellation context, `next_action` hint. |
| `klodi_tx_confirm { transaction_id }` | Both parties must confirm before listing moves to `sold`. `completed_at` is null until both have confirmed. |
| `klodi_tx_cancel { transaction_id, reason, detail? }` | **Hard-confirm** with user. Listing returns to active. Penalized reasons (`no_show`, `item_not_received`, `payment_not_received`) auto-apply 1-star to the counterparty. |
| `klodi_tx_rate { transaction_id, rating, comment? }` | Rate counterparty 1-5. `other_party_rated` indicates whether the counterparty has also rated. |

## Human-in-the-loop (outbound round-trip)

| Tool | When to call |
|---|---|
| `klodi_message_user { text }` | Actively reach the operator when a wake hits a decision reserved for the human (`## Always Ask Me First`, unresolved `## Escalation When Unknown`, a `security.md` hard rule). `text` must be self-contained — name the listing, counterparty, question, and options. Records a pending-decision for reply correlation. NOT for decisions policy lets you handle alone. See SKILL.md §3a. |
| `klodi_pending_decisions` | List the open human-in-the-loop decisions awaiting the operator's reply. Scan at the start of **every** operator turn — when their message answers one, re-ground the entity via the read tools (it's a pointer, not a snapshot) and act on the bound entity; the decision then resolves. See SKILL.md §2. |

## Setup, registration, health

| Tool | When to call |
|---|---|
| `klodi_setup_status` | Session start (always). Returns `phase` — branch via `references/setup_first_run.md` when `phase !== "ready"`. Also resolves `${klodi_home}` for path operations. |
| `klodi_register` | Begin OAuth registration. Tell the user to open `auth_url`; the plugin polls in the background and wakes the agent on terminal state — do not loop. |
| `klodi_register_poll { session_id }` | Manual fallback only — when a wake never arrived (plugin restart) or the 10-minute timeout wake asks for it. |
| `klodi_setup_repair` | **Hard-confirm** with user. Clears `nats.creds` and `config.json` so `klodi_register` can run cleanly. Listings, searches, policies untouched. |
| `klodi_setup_reseed_policies` | Re-seed missing policy templates from the bundle. Never overwrites existing files. |
| `klodi_setup_reseed_skill` | Force-copy the canonical skill bundle from the plugin into `${klodi_home}/skill/`. Use after a plugin upgrade where on-disk skill drifted from the new version. |
| `klodi_health` | Probe NATS connectivity. Returns `connected`, latency, current handle. Diagnostic — call when wakes seem absent or a tool returns `unauthorized`. |
