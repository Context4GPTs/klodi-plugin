# klodi-rust-host

Host-orchestration glue for the Rust klodi adapters. Internal crate;
not published to crates.io.

`klodi-nats-client` is the wire-level NATS client. This crate sits one
layer up: it owns the daemon-shaped pieces every Rust host adapter
needs.

## Modules

| Module | Surface | What |
|--------|---------|------|
| `forwarder` | `run_forwarder(ForwarderConfig)` | Subscribes both klodi consumers; forwards each delivered event to a local host wake URL via HTTP POST; SIGINT + SIGTERM drain; optional bearer-token auth; optional `--health-port` HTTP `/healthz` probe. |
| `register` | `run_register(RegisterArgs)` | Mint a session UUID; print the auth URL; poll `${api_url}/api/sessions/<id>`; persist `nats.creds` (mode 0600) + `config.json` via `klodi_secret_write`. |
| `paths` | `klodi_home()`, `creds_path()`, `config_path()` | Cross-platform default `${KLODI_HOME}` resolution. |
| `setup_status` | `klodi_setup_status(klodi_home)` | Reports phase + missing files + JWT-decoded user id; daemon CLI subcommand on each Rust adapter. |
| `health` | `serve_health(...)` | Optional HTTP server. `GET /healthz` returns `200` if NATS connected, `503` otherwise. `GET /metrics` exposes the per-client counters in Prometheus text-format (P2-27). |

## Adapters

Three host adapters consume this crate:

- `klodi-moltis` — POSTs to Moltis's local agent-wake API.
- `klodi-ironclaw` — POSTs to IronClaw's `/event-trigger` endpoint.
- `klodi-zeroclaw` — POSTs to ZeroClaw's gateway `/webhook` endpoint (≥ 0.7.4) with a `{"message": "<json>"}` body wrap.

Each adapter's bin/ files are ~30 LOC drivers that build a
`ForwarderConfig` / `RegisterArgs` from CLI/env and call into the
shared modules here.

## Health endpoint (`--health-port`)

The forwarder optionally serves an HTTP probe on a per-deploy port so
supervisors can drive restart on a wedged daemon and operator
dashboards can scrape per-client counters.

| Path | Status | Body |
|------|--------|------|
| `GET /healthz` | `200 OK` if NATS connected, `503` otherwise | plain text `OK\n` / `NOT_CONNECTED\n` |
| `GET /metrics` | `200 OK` | Prometheus text-format (`text/plain; version=0.0.4`) |
| Anything else | `404 Not Found` | empty |

### Prometheus metrics surface (P2-27)

Counter and gauge series. All names are prefixed `klodi_client_` and
mirror the per-language counter names in `klodi_nats_client.metrics`
(Python) and `klodi_nats_client::ClientMetrics` (TS / Rust):

| Metric | Type | What |
|--------|------|------|
| `klodi_client_consumed` | counter | Wakes received from JetStream (pre-dedup, pre-handler). |
| `klodi_client_acked` | counter | Successful `msg.ack()` count. |
| `klodi_client_naked` | counter | `msg.nak()` count (handler raised). |
| `klodi_client_dedup_hit` | counter | Wakes whose `event_id` was already in the LRU window. |
| `klodi_client_redelivery_count` | counter | Sum of "this is the Nth redelivery" across delivered messages (`info.delivered - 1` per message). |
| `klodi_client_pending_count` | gauge | JetStream consumer pending count, refreshed best-effort on subscribe and per-fetch. |

Counters are monotonic within a process lifetime; daemon restart
resets them all to 0. The gauge is informational — use `delivered`
+ `pending_count` rate to diagnose backlog growth, not the gauge in
isolation.

## References

- **R § P1-15** — duplication audit (~1900 LOC of duplicated forwarder /
  register / default_paths code across the three Rust adapters before
  consolidation).
- **R § P2-27** — Prometheus exposition surface for the per-client
  counters; lands here because the Rust daemons are the operator
  scrape target.
- **D § D8** — locked option (b): separate crate for cleaner separation
  between the wire client and the host-orchestration glue.
