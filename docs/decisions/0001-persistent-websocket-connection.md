---
id: 0001-persistent-websocket-connection
title: Persistent WebSocket connection (not polling)
tags: [nats, websocket, wake-events]
card: pre-harness
commit: d365332
updated_at: 2026-04-30
updated_by_card: pre-harness
---

# ADR-0001 — Persistent WebSocket connection to klodi.4gpts.com

## Status

Accepted (2026-04-22). Addresses *Persistence & Privilege* — the plugin registers a persistent service that maintains a WebSocket/NATS connection and runs timers.

## Context

A marketplace agent is useful only if it reacts to the outside world without the human babysitting a terminal. A buyer comments at 3am; an offer lands while the user is on a call; a counterparty accepts pickup logistics while the user is commuting. The plugin must be able to wake its agent on these events.

The plugin runs inside OpenClaw, which lives on the user's laptop or workstation — behind NAT, behind sleep/wake cycles, with no inbound reachability. The marketplace backend (klodi.4gpts.com) is a public service that *can* be reached. This asymmetry is the forcing function.

## Decision

Open and maintain **exactly one** outbound WebSocket from the plugin to the configured klodi backend. Authenticate every frame with the user's NKey signer (see [ADR-0002](./0002-on-disk-nkey-credentials.md)). Carry both request-reply marketplace traffic and server-push wake events over the same connection.

The connection is owned by an OpenClaw service (`klodi-nats`) with explicit `start()` / `stop()` lifecycle. When the gateway shuts down, `drain()` closes the socket cleanly.

## Alternatives considered

1. **Agent-driven short-polling.** The agent would call `klodi_pending` / `klodi_offer_mine` every N seconds to discover events. Rejected: it burns the agent context window on empty responses, costs tokens whether anything is happening or not, and the polling cadence is bounded below by whatever the user pays to sustain. An agent asleep between turns cannot poll.
2. **Plugin-driven HTTP short-polling.** The plugin would poll klodi from inside the plugin process. Rejected: still requires a chosen interval that's always too long or too short, and doubles outbound traffic versus one long-lived connection.
3. **Webhook callbacks.** klodi posts to a URL the plugin exposes. Rejected: requires inbound reachability that laptops and corporate networks do not provide.
4. **Per-request WebSocket.** Open a fresh WS for each request-reply, close after the response. Rejected: defeats the point — server-push wakes require a sustained connection, and the TLS+auth handshake per call is expensive.

## Security implications

- **Single known host.** The plugin talks to exactly one endpoint — `klodi.4gpts.com` (API) / `klodi-net.4gpts.com` (NATS-WS) by default, overridable for self-hosting via the documented `klodi_api_url` / `KLODI_API_URL` knobs. Network observers see one destination, not a fanout. Auditors grep for one hostname.
- **Authenticated transport.** Every request carries the user's NKey signature; the server validates against the public key it registered at signup. There is no unauthenticated path.
- **TLS end-to-end.** Production uses `wss://`; messages and headers are encrypted on the wire. See `packages/nats-client-ts/src/` for the `wsFactory` that ensures the Node `ws` package handles the TLS upgrade correctly behind Fastly's edge (ordinary `globalThis.WebSocket` fails there on Node 24 — see the module header for the full failure mode).
- **Bounded blast radius.** The WS delivers marketplace events, not arbitrary code or commands. Wire-event parsing is in one place (the consumer loop inside `packages/nats-client-ts/`), and malformed frames are logged-and-dropped, never executed.
- **Revocable.** Since the server only holds the public NKey, a compromised signer is revoked by rotating at the server; the user runs `klodi_setup_repair` + `klodi_register` and the old key is dead.

## References

- Code: `packages/nats-client-ts/src/` (shared NATS-WS client: `wsconnect`, ping/connect timeouts, JetStream consumer loop). Python and Rust mirrors live in `packages/nats-client-py/` and `packages/nats-client-rs/`.
- Code: `adapters/openclaw/src/lib/client.ts` (per-adapter cached connection lifecycle).
- [SECURITY.md § Network behavior](../../SECURITY.md)
- Related: [ADR-0002](./0002-on-disk-nkey-credentials.md), [ADR-0007](./0007-timer-cadence-clamp.md) (Superseded)
