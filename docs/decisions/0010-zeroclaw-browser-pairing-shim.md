# ADR-0010 — Browser-pairing helper for klodi-zeroclaw

- **Status:** Accepted
- **Date:** 2026-05-10
- **Implements:** I-9 of [`docs/plans/2026-05-10-klodi-zeroclaw-wake-routing-redesign.md`](../plans/2026-05-10-klodi-zeroclaw-wake-routing-redesign.md)
- **Affects:** `klodi-zeroclaw` 0.2.8

## Context

ZeroClaw's gateway prints a single one-time pairing code at boot. Through 0.2.7, the klodi daemon consumed that code (`POST /pair` with `X-Pairing-Code:`) to mint its own `zc_<hex>` bearer — used since 0.2.6 as `Authorization: Bearer` on the canonical `WS /ws/chat` data path (and on the legacy `/webhook` POST for operators who opt back into it). That single boot-time code went to the daemon, leaving the operator's browser without a code to enter at the dashboard's "PAIRING REQUIRED" prompt.

The expected workaround was for operators to know that `zeroclaw gateway get-paircode --new` exists and run it inside the gateway container. Verified during plan authoring: even a power user familiar with ZeroClaw stalls at this step on first install. The marketplace demo's `up-zeroclaw.sh` script papers over the friction by `docker exec`ing the CLI from outside and printing the result, but only for the demo containers — operators who `cargo install klodi-zeroclaw` and run the daemon directly get nothing.

The friction has two sources:

1. **Daemon side.** First-boot requires the operator to find the gateway's startup pairing code (printed only to its stdout) and write it to `${KLODI_HOME}/zeroclaw.pairing-code`. On a containerised gateway this means `docker logs` + redirect-into-file-mounted-by-host. Avoidable on canonical deployments where the daemon and gateway run colocated and the `zeroclaw` CLI is on `PATH`.

2. **Browser side.** The dashboard wants its own pairing code. Codes are short-lived (≈60s) and single-use, so a code minted at daemon-start and stashed somewhere stale by the time the operator opens the browser is useless. The freshness constraint forces an on-demand surface.

## Decision

Land two cooperating mechanisms, gated behind one opt-out:

### 1. Auto-mint daemon bearer (eliminates the daemon-side friction)

`pair::resolve_bearer` in `klodi-zeroclaw-daemon` gains a fourth fallback step. The resolution order becomes:

1. `ZEROCLAW_AGENT_TOKEN` env (explicit override) — unchanged.
2. Sidecar `${KLODI_HOME}/zeroclaw.pairing-code` (operator-supplied, triggers re-pair) — unchanged. Always wins over both cache and auto-mint so refreshing the file rotates the bearer.
3. Cached `${KLODI_HOME}/zeroclaw.token` (happy path on every restart after the first) — unchanged.
4. **NEW.** Auto-mint via the gateway CLI: shell out to `zeroclaw gateway get-paircode --new`, parse its `X-Pairing-Code: <digits>` line, POST to `/pair`, persist the resulting `zc_<hex>` bearer at `${KLODI_HOME}/zeroclaw.token`.
5. Bail with a helpful error message — unchanged, augmented with a hint about the new auto-mint path.

The cached-token branch (3) wins over auto-mint (4) so subsequent restarts reuse the existing bearer rather than minting and accumulating tokens in the gateway's `paired_tokens` table.

### 2. Loopback browser-pairing helper (eliminates the browser-side friction)

`klodi-zeroclaw-daemon` binds a tiny HTTP/1.1 server on `127.0.0.1:<port>` (default port 0 = OS-picked ephemeral). The server has four routes:

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/` | Mints a fresh code via the same gateway CLI (every page hit), returns an HTML page that pre-copies the code via `navigator.clipboard.writeText` and redirects to the dashboard URL after 800ms. |
| `GET` | `/code` | Mints a fresh code, returns it as `text/plain` (`NNNNNN\n`). For scripted operators. |
| `GET` | `/healthz` | `200 OK / OK\n`. No mint. Used by supervisors. |
| anything else | — | `404 Not Found`. |

Codes are minted on every `/` and `/code` hit because they expire ≈60s server-side. Caching would defeat the freshness goal.

The shim's URL is surfaced through three channels:

- **Plugin-authored heartbeat** in the operator's ZeroClaw chat session — the existing one-line `🟢 klodi daemon connected as @…` heartbeat now carries `Browser pairing: http://127.0.0.1:<port>` when the helper is running.
- **Boxed stdout block** at daemon startup with the URL and a freshly-minted code (visible in `journalctl`, `docker logs`, foreground runs).
- **OS-native browser auto-launch** when stdout is a tty (override via `--open-browser={auto,always,never}`).

### 3. Single opt-out

Both mechanisms are gated behind one flag: `--no-browser-pair-shim` / `ZEROCLAW_BROWSER_PAIR_DISABLE=1`. When set:
- Auto-mint is skipped — `pair::resolve_bearer` falls back to step 1+2+3 only, identical to 0.2.7.
- The shim is not bound, so no port is opened.
- The browser is not auto-opened.

When unset (default), the daemon detects whether `zeroclaw` is callable via `<cli-path> --version`. If yes, both mechanisms activate. If no, both auto-disable with a single info-log line and the daemon falls back to 0.2.7 behaviour. This makes the feature safe to default-on for all operators — non-canonical deployments where the gateway CLI isn't reachable simply continue to behave as before.

## Alternatives considered

1. **Daemon-side stdout block only (no shim).** Code expires in ≈60s. An operator who restarts the daemon then walks away for 90 seconds returns to a stale block — they'd need another restart to mint another code. Stdout snapshots that go stale are worse UX than no snapshot at all because they invite the operator to type a code that's already invalid.

2. **Embed the code in the chat heartbeat.** Same staleness problem amplified: the heartbeat is persisted in the operator's session forever; a stale code sitting in chat history confuses returning operators. The shim's URL is durable while the codes it produces are fresh — exactly the property we want.

3. **Auto-pair the dashboard programmatically (no operator interaction).** Requires either (a) the dashboard to expose a query-string pairing parameter (`?paircode=…`), or (b) cross-origin localStorage sharing (impossible — different origin), or (c) the shim hosting a full proxy of the dashboard (huge build, swaps the trust model). All require upstream gateway changes or swap a small UX problem for a large engineering one. The "click + ⌘V + Enter" floor without upstream changes is acceptable.

4. **Inline the helper as part of `klodi-zeroclaw-register`.** Mixes two failure modes (OAuth-completion failure, gateway-pairing failure) into one CLI invocation. Easier to debug when they're separate. Register is a one-shot OAuth bootstrap; the daemon owns the long-running gateway connection. Keeping the helper inside the daemon's lifetime matches its scope (helper ≈ daemon lifetime, code mint ≈ request lifetime).

5. **Add a CSRF token / PIN to the shim.** Per `docs/SECURITY.md` § Trust model, the workstation owner is the trust anchor. Adding a token gate against local processes treats the host user as adversarial, which contradicts the documented threat model. Pairing codes are themselves short-lived single-use tokens; a leaked code lets an attacker re-pair the dashboard once before being noticed. The cost of the defence (UX friction, additional state to manage) outweighs the benefit when the threat is already excluded by the trust boundary.

## Security implications

The shim's threat surface is intentionally narrow:

- **Loopback bind only.** `ShimConfig::loopback` hardcodes `127.0.0.1`; the public constructor does not accept a non-loopback IP. The CLI flag controls only port, never address. Browsers honour `127.0.0.1` as same-origin/same-host so non-local peers cannot reach the listener at the network layer.

- **DNS-rebinding defense.** The `Host:` header is validated against `127.0.0.1:<port>` and `localhost:<port>` literals only. A hostile site whose A-record was rebound to 127.0.0.1 (the standard rebinding attack) sends `Host: evil.com:<port>` and gets a `421 Misdirected Request` with no mint side-effect.

- **HTML-safe JSON encoding.** The dashboard URL and the minted code are passed into the rendered page's inline `<script>` block as JSON literals. The encoder rewrites `<`, `>`, `&` as `<`, `>`, `&` (and U+2028/U+2029 as their `\uXXXX` forms) so a hostile dashboard URL containing `</script>` cannot break out of the script element. Tested in `zeroclaw_pairing_shim::tests::render_pair_page_escapes_dashboard_url_in_html_attribute_and_script`.

- **Cache-control + sniff-prevention headers.** Every shim response carries `Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. A back-button never re-displays a stale code; the `Referer` header is suppressed when navigating to the dashboard.

- **Bearer never leaves the daemon.** The shim mints pairing codes; it does not handle, log, or render the daemon's `zc_<hex>` bearer. The mint endpoint is the gateway CLI, which uses the gateway's own admin path — not the daemon's bearer.

- **Workstation owner is the trust anchor.** Per the documented [trust model](../../SECURITY.md#trust-model), local processes running as the operator are inside the trust boundary. The shim deliberately does not add a PIN or CSRF token against same-host attackers.

## Compatibility

Drop-in replacement for 0.2.7. No env or config changes are required for existing operators:

- Operators with `ZEROCLAW_AGENT_TOKEN` set continue on the explicit-token path.
- Operators relying on `${KLODI_HOME}/zeroclaw.pairing-code` keep that path — sidecar codes always win over the new auto-mint.
- Operators with a cached `${KLODI_HOME}/zeroclaw.token` keep using it — cache always wins over auto-mint.
- Operators on a deployment without the `zeroclaw` CLI on PATH see one info-log line at startup and continue identically to 0.2.7.
- Operators who want the 0.2.7 behaviour exactly: set `ZEROCLAW_BROWSER_PAIR_DISABLE=1`.

## References

- `packages/klodi-rust-host/src/zeroclaw_browser_pairing.rs` — the minter (CLI invocation + parser).
- `packages/klodi-rust-host/src/zeroclaw_pairing_shim.rs` — the loopback HTTP/1.1 helper.
- `packages/klodi-rust-host/src/zeroclaw_bootstrap_note.rs` — heartbeat extension carrying the shim URL.
- `adapters/zeroclaw/src/bin/daemon.rs` — CLI flags + wiring.
- `4gpts-p2p-marketplace/demo/scripts/up-zeroclaw.sh:200-233` — the interim demo workaround this ADR makes redundant.
