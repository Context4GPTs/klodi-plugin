---
id: 0022-tls-nats-transport-private-ca-trust
title: Client `tls://` NATS transport with private-CA trust — verify-ON, private-CA-only, fail-closed
tags: [nats, tls, transport, ca, trust, security, guard, vendoring, adapters, parity, railway, loud-fail, starttls]
card: support-tls-nats-transport-with-private-ca-trust
commit: 7ca5b14
updated_at: 2026-07-04
updated_by_card: gate-auto-trust-on-well-formed-ca-loud-fail
---

# ADR-0022 — Client `tls://` NATS transport with private-CA trust

The plugin's NATS clients (py / ts / rs) speak `tls://` to a Railway L4 TCP proxy whose TLS is terminated at NATS by a **private** CA, trusting that CA with **certificate + hostname verification kept ON and no toggle to turn it off**. This is the client half of epic `nats-ws-ingress-flap-2026-06`; the server half (making NATS *offer* `tls://`) is the marketplace repo's own ADR-0015 (`nats-tcp-proxy-tls-external-transport`, in marketplace PR #100) — **not** this repo's local [[0015-gateway-runtime-load-vs-armed-axis]], which is an unrelated doc that happens to share the number across repos.

## Status

Accepted (2026-07-02). Client-side is complete and merge-ready; the endpoint/CA-minting remainder is **epic-gated** (see *Deferred* below). Complements [[0001-persistent-websocket-connection]] (the `ws://`/`wss://` WebSocket transport survives for local dev; `tls://` is *additive* for prod, not a replacement) and [[0009-vendored-ts-workspace-deps]] (the new TS transport dep is public-registry, so it is **not** vendored).

## Context

Railway's L7 HTTP edge mangles long-lived NATS WebSocket (`wss://`) subscriptions (the "ingress flap"). The fix moves prod off the L7 edge onto an L4 TCP proxy (`<svc>.proxy.rlwy.net:<port>`) where NATS terminates TLS itself with a private CA. Two non-obvious facts shaped the client design:

1. **The client never mints the prod URL.** `nats_url` is server-authoritative: every host persists whatever the marketplace `/register` response returns, and the *same* transport guard runs again at persist time. So "repoint the default" is a red herring — the real work is making the guard *accept* the server's `tls://` value so registration doesn't fail closed. There is no hardcoded client-side `nats_url` to change (the `KLODI_DEFAULT_NATS_URL` catalog constant is only a fallback).
2. **The transport guard is a two-family control, not one.** Beyond the three connect-time client guards (`nats-client-{py,ts,rs}`), four adapters re-check the scheme at *persist* time (hermes, nanobot, openclaw inline; rust-host via delegation). Widening only the connect guards would still make the adapters refuse to persist a server-sent `tls://` URL.

Moving TLS termination from the edge to NATS is **end-to-end better**, not a downgrade: today's edge terminates TLS then talks *plaintext* to NATS (`no_tls: true`). The single real risk is someone disabling cert verification to "make it connect" — this ADR forbids that everywhere.

## Decision

- **Widen the shared guard to a two-scheme allow-list and rename it.** `assert_wss_or_localhost` → `assert_encrypted_or_localhost` (`assertEncryptedOrLocalhost` in TS), accepting `wss://` **and** `tls://`, still rejecting plaintext `nats://`/`ws://` against non-localhost, still bypassing for localhost. Renamed rather than shimmed because the name was a lie once it accepted `tls://` (CLAUDE.md no-backcompat: no re-export of the old name). All **seven** sites route through the *single* shared guard per language — the four adapter persist paths dropped their inline `startsWith("wss://")` + local `_is_localhost` copies and now call the shared guard (connect-time and persist-time are one control, not two divergent ones).

- **Distribute the private CA via a `tool-catalog` codegen constant, with a file override.** `KLODI_NATS_CA_PEM` (empty placeholder today) is added to `packages/tool-catalog/src/index.ts` alongside `KLODI_DEFAULT_NATS_URL`, so one source flows to py (`schemas.json`), rs (`rust-types.rs`), and the TS export — no three divergent asset-loaders. The CA *certificate* is non-secret, so bundling it is safe and scales to arbitrary NAT'd laptops with zero per-host config. `KLODI_NATS_CA_FILE` (a PEM path) is a higher-priority override for local test CAs and emergency rotation without a client release. **Resolution order (identical in all three langs): `KLODI_NATS_CA_FILE` → bundled `KLODI_NATS_CA_PEM` → system trust store.** *(A level-2 persisted register-response CA step was inserted 2026-07-04 — see Addendum below for the updated four-level order.)* The override selects *which* CA to trust, **never *whether* to verify** — a set-but-unreadable `KLODI_NATS_CA_FILE` fails closed (raises `CaTrustError` py/ts, `KlodiError` rs), never a silent plaintext drop.

- **Private-CA trust is verify-ON, private-CA-*only*, and consistent across all three languages.** When a CA is configured, each client trusts *only* that CA (system roots replaced), which is the tighter posture for a proxy that presents a private chain:
  - **py** — `ssl.create_default_context(cadata=<pem>)` trusts only the supplied CA; `check_hostname=True` + `verify_mode=CERT_REQUIRED` asserted.
  - **rs** — async-nats `ConnectOptions::add_root_certificates(<path>)` skips the native root store, building a standard verifying rustls config.
  - **ts** — `@nats-io/transport-node`'s `connect({ tls: { ca } })` passes `ca` straight to Node's `tls.connect`, which **replaces** the default Mozilla bundle when `ca` is given (see *augment-vs-replace* below). `rejectUnauthorized` stays at its `true` default and is never set to `false`.

- **The `ca`-augment-vs-replace question (guardian P2), resolved: Node `ca` *replaces*.** The original TS docstring claimed `ca` trusts the private CA *in addition to* the system roots (additive), contradicting py/rs. This is factually wrong: Node's `tls.createSecureContext` documents "Mozilla's CAs are completely replaced when CAs are explicitly specified using this option", and `@nats-io/transport-node` forwards our `ca` unchanged into `tls.connect` (`node_transport.js:191-192,220`). So the TS runtime was **already private-CA-only** — only the docstring diverged. Fixed to match py/rs (a doc fix, not a behavior change). All three languages now document *and* enforce the identical private-CA-only posture.

- **TS transport swap to `@nats-io/transport-node`, un-vendored.** nats-core v3 ships only the WebSocket transport in core; a raw `tls://` TCP connect needs `@nats-io/transport-node`. `doConnect` branches by scheme: `ws://`/`wss://` → `wsconnect` (unchanged); `tls://`/`nats://` → `nodeConnect`. Per [[0009-vendored-ts-workspace-deps]] this is a **public-registry** dep, so it is **not** vendored (only `@klodi/*` are inlined into `dist/_vendor/`); it rides in `dependencies` in both `packages/nats-client-ts/package.json` and `adapters/openclaw/package.json` (the vendored client imports it at runtime, so the host manifest must declare it — exactly as `@nats-io/nats-core`, `@nats-io/jetstream`, `ws` already do). Pinned `3.3.1` to match `@nats-io/nats-core@3.3.1`.

- **The WS crutch (`_ws_transport_patch.py`) is retained, not deleted.** It is inert on `tls://` but still load-bearing on the surviving `ws://localhost`/`wss://` dev paths (its CLOSE-frame→EOF fix). Docstring updated to say so.

### Deferred (epic-gated — do not do in this repo/card)

The `tls://<svc>.proxy.rlwy.net:<port>` endpoint and the real CA don't exist until marketplace PR #100 merges and a Railway L4 TCP proxy + private CA are provisioned. Until then: `KLODI_NATS_CA_PEM` stays `""` (falls through to the system store, still verify-ON), `KLODI_DEFAULT_NATS_URL` stays `wss://…`, and the register endpoint keeps emitting `wss://`. **Cutover ordering is load-bearing:** this client (accepts `tls://`) must ship *before* the server starts emitting `tls://`, or a not-yet-updated host rejects the server's URL at persist. Flip the two catalog constants only once the endpoint/CA exist.

## Alternatives considered

1. **Widen only the three connect guards.** Rejected — the four adapter persist paths would refuse to persist the server's `tls://` URL; registration fails closed. The guard is a two-family control.
2. **Rip out the WebSocket transport entirely.** Rejected — local dev + all three integration harnesses connect over `ws://localhost`; blast radius far beyond this card. `tls://` is additive.
3. **Deliver the CA in the `/register` response.** Rejected as baseline — adds an unconfirmed server contract and only trusts the CA *after* registration; bundling works before/without registration and needs no server change. (The `KLODI_NATS_CA_FILE` override covers rotation.) **Reversed 2026-07-04** (card `auto-trust-nats-ca-from-register`, epic `nats-ws-ingress-flap-2026-06`): now the server contract *is* being confirmed (`serve-nats-ca-in-sessions-api`), the register-response CA is added as an **additive** persisted trust source ranked *above* the bundle — not the baseline this alternative warned against (the bundle stays as fallback; onboarding + rotation no longer need a client release). See *Addendum* below.
4. **Flip `KLODI_DEFAULT_NATS_URL` to the proxy endpoint now.** Rejected — the endpoint isn't provisioned, and it's a fallback constant, not the runtime source.
5. **Additive CA trust (private CA + system roots).** Rejected — private-CA-only is tighter and the proxy never presents a public chain; keeping the three languages consistent is the point.
6. **Disable cert verification to "make it connect."** Forbidden — the core invariant. No `rejectUnauthorized:false` / `ssl.CERT_NONE` / `check_hostname=False` / `danger_accept_invalid_certs`, and no env var/flag that can toggle verification off.

## Addendum (2026-07-04) — register-response CA as a persisted trust source

Card `auto-trust-nats-ca-from-register` (epic `nats-ws-ingress-flap-2026-06`, PR #49) adds the marketplace `/register` completed-session response's optional `nats_ca` field as a **new, additive** CA trust source, persisted to `${KLODI_HOME}/nats-ca.pem` and trusted at `tls://` connect — so a host onboards with just "register → done," no manual `KLODI_NATS_CA_FILE`. This **reverses Alt #3** now the server contract is being confirmed by the paired marketplace card `serve-nats-ca-in-sessions-api`, but as an *additive* source ranked above the bundle — not the wire-CA-as-baseline Alt #3 warned against.

**Updated resolution order (identical in py / ts / rs) — level 2 is new:**

1. `KLODI_NATS_CA_FILE` env — explicit operator override. **Short-circuits: when set, the persisted file is not even read.** *(unchanged)*
2. **`${KLODI_HOME}/nats-ca.pem` — the persisted register-response CA. NEW.** Present-but-unreadable/invalid → fail closed; absent → fall through.
3. bundled `KLODI_NATS_CA_PEM` catalog constant — static fallback. *(unchanged)*
4. system trust store — final fallback, verify-ON. *(unchanged)*

Ranked **above** the bundle because it is server-authoritative, endpoint-matched to the served `nats_url`, and rotatable without a client release (re-register overwrites — last-write-wins — so registration *is* the CA-rotation path; the bundle stays a static belt-and-suspenders fallback and `KLODI_NATS_CA_FILE` the emergency hatch). Ranked **below** `KLODI_NATS_CA_FILE` so explicit operator config is never silently overridden — strict short-circuit, no CA union, no divergence read (diffing two CAs purely to log would be needless I/O).

**No net trust-boundary widening.** Accepting `nats_ca` adds no new trust surface: the `/register` response is *already* trusted for `nats_url` + `nats_creds`, and `assert_encrypted_or_localhost` still confines the scheme. The CA rides the *same already-trusted HTTPS channel* as the URL + creds — a compromised `/register` can already redirect `nats_url`, so trusting its CA is strictly within the boundary the register flow already has. Still verify-ON, private-CA-only, fail-closed: a malformed/unreadable persisted CA raises at connect (`CaTrustError` py/ts, async-nats handshake error rs), never a verify-off fallback. The three `verification_never_disabled` ratchets were **extended** to the new `tls.*` / `paths.py` / persist-site surface; no env var *or wire field* can toggle verification off.

**Six-adapter symmetry.** One shared `persist_nats_ca` + `nats_ca_path` per language, and a single `klodi-rust-host::register.rs` persist site (covering moltis + ironclaw + zeroclaw), keep all six adapters byte-for-byte. `nats_ca` is OPTIONAL — never added to a required-field loop, a CA problem never fails registration, and omission on a later re-register never revokes the persisted file. One accepted seam: the TS `persistNatsCa` fs helper does not emit the `nats_ca_persist_skipped` info breadcrumb that py/rs do (no logger injected at that pure-fs helper) — an info-level diagnostic gap only, tracked as optional follow-up, not a verification or persistence divergence.

The on-disk file contract (mode `0644` non-secret, atomic write, `KLODI_HOME` derived from the creds-path parent) lives in `docs/knowledge/environment.md`. **Cross-repo:** the `nats_ca` field name/shape must be reconciled against the *merged* `serve-nats-ca-in-sessions-api` before prod trust; the plugin change is forward-compatible and inert until web emits the field (mirrors the client-before-server cutover ordering above).

## Addendum (2026-07-04) — loud-fail contract: a bad served CA is terminal, structured, and prompt

Card `gate-auto-trust-on-well-formed-ca-loud-fail` (epic `nats-ws-ingress-flap-2026-06`, PR #50) closes the blind spot that let the keyUsage-missing served CA hide. Fail-*closed* was true and still **invisible**: a bad served CA made the connect hang forever (never returned, never raised), so hermes sat pinned at `bridge_register_starting` (`adapters/hermes/src/klodi_hermes/bridge.py:452`) indefinitely — indistinguishable from a network blip. This addendum adds the operator-experience half: a malformed or untrusted served CA now fails **loud, terminal, prompt, and uniform** across all three language families. Verification is still never disabled (the invariant above is unchanged; this only changes *how the rejection surfaces*).

### Structured error contract — one type per language, shared attribution *template*

Every CA-trust failure funnels through **one structured error type per language** — `CaTrustError` (py/ts, pre-existing in `tls.*`) and the NEW `KlodiError::CaTrust { ca_source, message }` variant (rs, `error.rs:51`). The async-nats connect error is **wrapped** into `CaTrust` rather than surfaced bare, so rs is structured + attributable like py/ts.

"Uniform" is **not** byte-identical strings. It is a shared attribution *template* — *"served NATS CA `<source>` could not be trusted: `<reason>`; … verification is never disabled …"* — rendered idiomatically per language. Every surfaced error: (a) reads as a CA-trust / TLS-*verification* failure (not a bare timeout / generic network error); (b) names the CA **source** (`KLODI_NATS_CA_FILE`, the persisted `${KLODI_HOME}/nats-ca.pem`, or the bundled constant) so the operator knows the remedy (re-register, or set `KLODI_NATS_CA_FILE`); (c) carries no verify-off token — the three `verification_never_disabled` ratchets stay green. The rs field is `ca_source`, **not** `source`: `thiserror` treats a `source` field as `#[source]` and won't compile for a `String`.

### Deterministic-CA initial-connect fail-fast vs. transient retry (the actual stall fix)

The swallow was in the shared client's **reconnect policy**, not the hermes bridge. `client.rs`'s `.max_reconnects(None).retry_on_initial_connect()` and `client.py`'s `max_reconnect_attempts=-1, allow_reconnect=True` retry the *first* connect **forever** — correct for a transient flap, catastrophic for a **deterministic** CA/TLS-verify failure that never succeeds on retry (wrong-signer, keyUsage-missing). So the initial-connect failure is now **classified**:

- **Deterministic CA/TLS-verify** → **terminal**: raise the structured `CaTrust*` immediately.
- **Transient** (refused / DNS / reset / mid-handshake drop) → **still retries** per the unbounded policy — first-connect resilience must not regress.

The classifier is the risk surface, so **every negative test is paired with a transient-refused-port test** proving a transient failure is not misclassified terminal. Per language: **py** raises inside `error_cb` (`_async_error_cb`), which runs *inside* nats-py's connect loop, so the raise propagates straight out of `nc.connect()`; the classifier `_is_ca_verify_error` is `ssl.SSLCertVerificationError`-only (narrow — `SSLEOFError`/timeouts stay transient); the half-open `nc` is dropped **without** `close()` (nats-py's drain blocks on a never-completed handshake — closing would re-introduce the hang). **rs** drops `.retry_on_initial_connect()` and runs the initial connect **foreground**, classifying `ConnectErrorKind::Tls` terminal and retrying only `Io/Dns/TimedOut`; `max_reconnects(None)` still governs *post*-connect reconnects. **ts** makes `connectTcp` async and wraps a deterministic cert-verify rejection (`isCaVerifyError` excludes a transient-code set first). The fix lands once per language in `nats-client-{py,ts,rs}` and covers all six adapters; the hermes bridge's `except BaseException → bridge_register_failed` path already existed — it just never received the exception because the client hung.

### klodi `tls://` is STARTTLS, not implicit TLS (dictated the mechanism *and* a testing gotcha)

nats-py defaults `tls_handshake_first=False` and `KlodiClient` never overrides it (async-nats + transport-node behave identically); the server half is the marketplace `tls_required`-in-INFO transition. So the client connects **plaintext TCP, reads the server's `INFO {…,"tls_required":true}` line, then upgrades TLS** — a bad-CA verify failure surfaces on the client's **own post-INFO upgrade**, not a pre-connect implicit-TLS handshake. Two consequences:

1. **No pre-connect implicit-TLS probe.** An implicit ClientHello against the STARTTLS endpoint would read the plaintext INFO as its ServerHello → `wrong version number` → a *false* `CaTrust` on every connect. The fix intercepts the client's own handshake error instead — which is why the mechanisms above hook the client's connect callback (py) / classify the real connect error (rs/ts) rather than probing.
2. **Negative TLS-trust tests must model the INFO prologue.** A self-contained *implicit*-TLS test server **deadlocks** a STARTTLS client (client waits for INFO; server waits for a ClientHello) → the client times out with `kind="timeout"`, never a cert error, so the test cannot validate *any* faithful fix. Self-contained negatives must send the plaintext `INFO`/`tls_required` line **then** upgrade (`test_tls_loud_fail.py` / `tls-loud-fail.test.ts` carry an opt-in `starttls` server mode for exactly this; the Pillar-A *positive* keeps a raw-handshake implicit server). The gated klodi-stage bed tests are unaffected — the real NATS is already STARTTLS.

## Security implications

- **Verification is a hard invariant, ratcheted by tests.** Each language carries a `verification_never_disabled` unit test that greps the source for the insecure flags and asserts their absence, plus that no env var toggles verify off. `KLODI_NATS_CA_FILE` is not a backdoor — it can only change *which* CA is trusted.
- **Fail-closed everywhere.** Missing/wrong CA, unreadable override, or SAN mismatch → the handshake rejects; never a plaintext or unverified fallback. The TS `nats://` branch is plaintext but the guard confines it to localhost.
- **End-to-end TLS is a net improvement** over the edge-terminated-then-plaintext-to-NATS posture it replaces.
- **CA rotation requires a client release** (the bundled constant is versioned with the client); `KLODI_NATS_CA_FILE` is the emergency escape hatch that must never become a verify-off path.

## References

- Guard (renamed, shared): `packages/nats-client-py/src/klodi_nats_client/config.py:156`, `packages/nats-client-ts/src/client.ts:105`, `packages/nats-client-rs/src/config.rs:151`
- Persist guards routed to the shared guard: `adapters/hermes/src/klodi_hermes/register.py`, `adapters/nanobot/nanobot_local_tools.py`, `adapters/openclaw/src/tools/register-poller.ts`, `packages/klodi-rust-host/src/register.rs`
- CA trust (verify-ON, private-CA-only): `packages/nats-client-py/src/klodi_nats_client/tls.py`, `packages/nats-client-ts/src/tls.ts`, `packages/nats-client-rs/src/tls.rs`
- Loud-fail structured type: `packages/nats-client-rs/src/error.rs:51` (`KlodiError::CaTrust { ca_source, message }`); `CaTrustError` in `tls.py` / `tls.ts`
- Loud-fail initial-connect classifier: `packages/nats-client-py/src/klodi_nats_client/client.py` (`_is_ca_verify_error`, `_async_error_cb`, `_connecting_initial`), `packages/nats-client-rs/src/client.rs` (foreground `initial_connect`, drops `retry_on_initial_connect`), `packages/nats-client-ts/src/client.ts` (`connectTcp` / `isCaVerifyError`)
- Loud-fail tests (STARTTLS-modelled negatives + transient-retry pairs): `packages/nats-client-py/tests/test_tls_loud_fail.py`, `packages/nats-client-ts/tests/tls-loud-fail.test.ts`, `packages/nats-client-rs/tests/tls_loud_fail.rs` (gated on the klodi-stage bed); hermes defect-site witness `adapters/hermes/tests/test_bridge_bad_ca_surfacing.py`
- TS transport dispatch: `packages/nats-client-ts/src/client.ts:430` (`doConnect`), `:485` (`connectTcp`)
- Node `ca` replace semantics: `@nats-io/transport-node` `lib/node_transport.js:191-192,220` forwards `ca` into `tls.connect`; Node `tls.createSecureContext` `ca` option (default Mozilla CAs *replaced* when specified)
- Bundled-CA constant: `packages/tool-catalog/src/index.ts:735` (`KLODI_NATS_CA_PEM`), `:719` (`KLODI_DEFAULT_NATS_URL`)
- Related: [[0009-vendored-ts-workspace-deps]] (public dep un-vendored), [[0001-persistent-websocket-connection]] (WS transport retained for dev)
- Cross-repo (server half): marketplace repo ADR-0015 `nats-tcp-proxy-tls-external-transport` + `docs/knowledge/nats-tls-required-transition-railway-gotchas.md`, both in marketplace PR #100 (distinct from this repo's local [[0015-gateway-runtime-load-vs-armed-axis]])
- Epic: `nats-ws-ingress-flap-2026-06`
