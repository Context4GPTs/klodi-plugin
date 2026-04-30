# ADR-0007 — Timer cadences with parse clamps and silent auto-reject

- **Status:** Superseded. 0.2.0 (per the 0012 NATS-native plan and `docs/reviews/2026-04-25-0012-first-pass-review.md` § B.4) retired the entire per-listing / per-standing-search timer plane. `src/service/timers.ts`, `src/lib/duration.ts` (`HEARTBEAT_EVERY_CEILING_MS`), and `heartbeatIssues()` were deleted; the `check_every`, `last_checked`, and `seen_listings` fields were dropped from sell/buy frontmatter (see `adapters/openclaw/src/lib/sell-buy-files.ts:52`). Auto-reject moved server-side ([ADR-0005](./0005-client-side-floor-price-enforcement.md)); standing-search matches arrive as `search.match` wakes; heartbeat-config inspection is gone (klodi no longer policies host wake-primitive config). Historical context retained below.
- **Date:** 2026-04-22
- **Review concern addressed:** *Persistence & Privilege — the plugin runs timers that give it ongoing outbound network connectivity and the ability to wake the agent on events.*

## Context

Two cadences drive the plugin's proactive behavior:

1. **Sell-side checks** — for each active listing, periodically fetch pending offers and either auto-reject below-floor offers silently or wake the agent with the non-trivial cases.
2. **Buy-side checks** — for each standing search (buy file), periodically run the search query and wake the agent when new or price-dropped listings match.

Both paths are outbound-only NATS requests, so no new trust boundary is crossed — but both can burn agent context and server capacity if run too often. "Outbound network connectivity on a cadence" is exactly the kind of capability a security reviewer flags; the mitigation is not to hide it, but to bound it.

## Decision

- **Defaults.** Sell timers default to `2h`, buy timers default to `4h`. Defined as code constants in `src/service/timers.ts` (`createSellTimer` / `createBuyTimer`) and at the sell/buy frontmatter parse site.
- **User-editable, strictly-parsed.** `check_every` in the sell/buy frontmatter accepts `Nm | Nh | Nd`; anything else falls back to the default. No free-form parsing, no sub-minute cadences, no fractional units.
- **Tight caches.** `OFFERS_CACHE_TTL_MS = 30_000` deduplicates the offers query across multiple sell timers firing close together — one concurrent burst produces one request, not N.
- **Silent auto-reject for below-floor offers.** When the timer finds an offer below `auto_reject_below`, it calls `offers.respond action=reject` without a wake. The agent is only woken for offers that need LLM judgment (see [ADR-0005](./0005-client-side-floor-price-enforcement.md)).
- **Heartbeat ceiling enforcement at setup.** `klodi_setup_status` flags `agents.defaults.heartbeat.every > 2m` as a blocking issue (`heartbeat_interval_too_long`). This bounds the worst-case latency between a timer-driven event and the agent actually processing it.
- **Reconciliation on start.** `reconcileTimers()` rebuilds the timer set from the on-disk sell/buy files on every plugin load. A crashed or restarted gateway re-establishes the same cadence with no drift.

## Alternatives considered

1. **Fixed cadences, no user override.** Rejected: power users want to burn tokens checking every 5 minutes for a hot search; casual users want weekly buy-side polling. One size fits no one.
2. **Let users set any cadence they want.** Rejected: a user setting `check_every: 1s` would burn tokens, spam the backend, and produce a UX that looks like the plugin is broken. The parse restriction (`Nm | Nh | Nd`, minimum 1m) is the minimum-viable clamp.
3. **Event-driven only (no timers).** Rejected: standing searches are by nature a pull — the server cannot push "a new listing matched your old search" without storing the search. Moving the search server-side re-introduces the same server-holds-user-strategy concern from [ADR-0005](./0005-client-side-floor-price-enforcement.md) for buy-file content.
4. **Run timers in the agent, not the plugin.** Rejected: the agent cannot stay alive between user turns reliably; a timer that depends on the agent being awake to fire would miss events for hours at a time. The plugin process is the right owner.

## Security implications

- **Bounded outbound rate.** Minimum 1-minute cadence, 30s request cache, and one NATS connection shared across all timers caps outbound QPS to a predictable floor regardless of how many listings or searches the user has.
- **Silent auto-reject preserves floor secrecy.** The agent never sees the offer that was below the floor; the agent cannot then accidentally cite the offer amount back to the counterparty. See [ADR-0005](./0005-client-side-floor-price-enforcement.md).
- **Heartbeat check closes the wake-latency hole.** If `agents.defaults.heartbeat.every` is too long, queued wakes stall silently (OpenClaw SDK #29215/#34338/#14191). `klodi_setup_status` refuses to return `ready` when this is misconfigured — the plugin refuses to pretend it's working.
- **Reconciled state.** Timers are a function of disk state (sell/*.md and buy/*.md). There's no in-memory timer that survives the disk telling a different story — the two cannot drift.
- **Stop is honest.** `clearAllTimers()` runs at service `stop()`; no orphan `setInterval` survives an uninstall or gateway shutdown.

## References

- Code: `src/service/timers.ts` — all timer logic
- Code: `src/lib/duration.ts` `HEARTBEAT_EVERY_CEILING_MS`
- Code: `src/tools/setup.ts` `heartbeatIssues` — setup-time clamp check
- [SECURITY.md § Network behavior](../../SECURITY.md) ("Timers fire on a per-listing and per-standing-search cadence")
- Related: [ADR-0001](./0001-persistent-websocket-connection.md), [ADR-0005](./0005-client-side-floor-price-enforcement.md)
