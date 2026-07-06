---
id: 0015-gateway-runtime-load-vs-armed-axis
title: Load-vs-armed axis — loaded ≠ armed; each adapter detects its wake-pump host by a positive, non-inherited signal (openclaw argv subcommand; hermes BridgeCtx capability marker)
tags: [openclaw, hermes, wake-pump, gateway, runtime, detection, activation, axis, contracts, adapters, parity, ctx-marker, register, headless, structural]
commit: d543efc
updated_at: 2026-07-06
---

# ADR-0015 — Load-vs-armed axis: loaded ≠ armed; detect the wake-pump host by a positive, non-inherited signal

> Cross-adapter. The axis was first named for **openclaw** (detect the gateway via
> `argv[2]`, not `process.title`) and reconfirmed for **hermes** as the *mirror-image*
> failure with a different discriminator — see [Cross-adapter realization — hermes](#cross-adapter-realization--hermes-the-mirror-image-failure-a-ctx-marker-discriminator).

## Status

Accepted (2026-06-22; extended to hermes 2026-07-03). Affects the openclaw adapter's
wake-pump (`adapters/openclaw/src/service/wake-pump.ts`) and its runtime smoke gate
(`adapters/openclaw/scripts/smoke-gateway-load.sh`), **and** the hermes adapter's
registration path (`adapters/hermes/src/klodi_hermes/__init__.py`,
`adapters/hermes/src/klodi_hermes/bridge.py`).

Sibling to **[[0014-tool-symmetry-axes]]**. ADR-0014 names two *static* axes that
`plugins doctor` / `plugins list` validate at load time (manifest↔registered,
adapter-source↔catalog). This ADR names a third axis that those static gates
**cannot** see — a *runtime* axis that only a booted gateway daemon exhibits — and
records why the gateway-runtime predicate keys off `process.argv`, not
`process.title`.

## Context

A plugin can pass every static check — `enabled`, `linked`, `plugins doctor`
clean, manifest↔registered symmetric (ADR-0014) — and still be **silently inert**
for its core purpose. For klodi that purpose is wake delivery: an inbound
notification on the user's subject must wake the agent. The component that turns
"a message arrived" into "the agent acts" is the wake-pump, and the pump only
matters in one runtime — the long-lived `openclaw gateway` daemon. CLI
invocations (`plugins install`, `secrets`, `login`) load the plugin only to
verify/configure it and must **never** open a wake subscription.

Two bugs in sequence produced the same user-visible symptom (the agent is
unreachable, with no error, no crash — pure inbound deafness):

- **Root cause A** (merged #17): the
  plugin did not load at gateway startup at all. Fixed by the
  `activation.onStartup: true` arm in `openclaw.plugin.json:7-9`. The plugin now
  *loads*.
- **Root cause B** (this change): the plugin loads but the wake-pump never *arms*.
  `isGatewayRuntime()` gated on `process.title ∈ {"openclaw-gateway",
  "openclaw-gatewa"}`. The real gateway daemon's title is the bare `"openclaw"`
  (the kernel rewrites the long-lived daemon's argv/title; `/proc/PID/cmdline` is
  empty). The per-subcommand `openclaw-${subcommand}` title scheme is honored for
  short-lived CLI invocations but **not** for the gateway daemon — so the gate
  never matched and the pump skipped for the life of the process.

The non-obvious thing a future contributor needs to know: **"loaded" and "armed"
are different axes. A static gate (doctor/manifest/`plugins.loaded`) proves
loaded; it can never prove armed. And the gateway-runtime predicate must key off a
positive signal the real daemon actually sets — not `process.title` (rewritten),
not `/proc/cmdline` (empty).**

## Decision

**The runtime invariant: under a real `openclaw gateway`,
enabled+linked+doctor-clean+loaded MUST imply the wake-pump is armed *before any
wake arrives*.** Lazy or after-the-fact arming is unacceptable for a
wake-delivering plugin — a notification that lands before the pump arms is lost.

**Gateway-runtime detection keys off the `gateway` subcommand at the subcommand
position of `process.argv` (`argv[2] === "gateway"`) — a positive signal — never
`process.title`, never `/proc/cmdline`.** `KLODI_GATEWAY_OVERRIDE=1` stays the
first-checked test escape hatch (production never sets it).

### Why `argv[2]`, and why not the alternatives

Empirically confirmed on the latest openclaw gateway image (`argv`/`title`
dump from inside both contexts; observed on 2026.6.9, latest at time of
writing — an illustrative datapoint, not a tag the code keys on):

| Context | `process.argv` | `argv[2]` | `process.title` |
|---|---|---|---|
| **gateway daemon** (`openclaw gateway --bind lan`) | `[node, openclaw, "gateway", "--bind", "lan"]` | `"gateway"` | `"openclaw"` |
| **plugins install** (CLI) | `[node, openclaw, "plugins", "install", <tgz>]` | `"plugins"` | `"openclaw-plugins"` |

- **`process.title` (the old gate) — rejected.** The daemon's title is bare
  `"openclaw"`, which is *also* the title of other invocations, so adding it to the
  match set would fail the gate **OPEN** (arming during `plugins install` → spurious
  NATS connection + consumer churn in a short-lived verify process that may then
  fail to exit). It is not a positive gateway signal.
- **Substring match on `"gateway"` anywhere in argv — rejected.** Fails OPEN in a
  CLI context whose args merely contain the word (`plugins install gateway-tools`,
  `--note "gateway down"`). Match the **subcommand position**, not a substring.
- **`/proc/PID/cmdline` — rejected.** Empty on the gateway daemon (argv rewritten),
  and Linux-only (macOS dev hosts mis-detect). `process.argv` is Node's
  in-process, cross-platform view of the launch tokens.
- **`OPENCLAW_CLI=1` env — rejected as a discriminator.** Set unconditionally on
  *every* openclaw invocation, gateway and CLI alike (`OPENCLAW_GATEWAY_PORT` is a
  viable gateway-only env marker if argv ever stops working — see Recurrence).

### Why the skip path's halt-on-`null` is correct and must NOT be "fixed" with a retry

`startWakePumpIfPossible()` returns `null` on the non-gateway skip, and
`runRetryAttempt` **halts** the retry loop on that `null`
(`wake-pump.ts:204-212`). This is correct *given correct detection*: a genuine
`plugins install` context is permanently non-gateway, so retrying would busy-loop
forever. The original bug was **entirely** in the detection predicate, not the
retry/halt logic. Adding a retry on the gateway-skip return is a **trap** — it
makes a CLI context busy-retry and forces removal of the load-bearing halt-on-null.
The minimum viable fix is purely in the detection signal. (Contrast: the
register-time `.catch` retry that *does* exist guards a *thrown* start error — a
flaky NATS-WS handshake at boot — not the classification skip.)

## Recurrence — how this bug class reappears, and how the gate catches it

This is **image-version-sensitive**. If a future OpenClaw rewrites `process.argv`
the same way it already rewrites `process.title` (and empties `/proc/cmdline`), the
`argv[2]` signal silently fails **closed** and the pump skips again — reproducing
this exact bug on a new image with no error.

The defense is the runtime smoke gate's **axis 4** in
`smoke-gateway-load.sh`: after asserting `klodi ∈ plugins.loaded` (axis 3 =
loaded), it slices the gateway-DAEMON phase of the boot log (from
`[gateway] loading configuration` onward) and asserts `wake_pump_skip_non_gateway`
is **ABSENT** there (axis 4 = armed; new exit code `3` = loaded-but-not-armed).
Skip-marker-absence is the **creds-independent** floor — it proves the gate
flipped without staging persona credentials (the model-less smoke config has none,
so the daemon hits `wake_pump_skip_no_creds`, not `wake_pump_started`). Its
non-vacuousness was proven by reverting detection to the old `process.title` gate →
same image → exit 3. When the discriminator stops working on a bumped image, this
gate fails loud rather than the product going silently deaf.

The gate boots the floating `latest` openclaw tag by default (not a frozen
calendar pin) precisely so this defense is self-updating: it always exercises the
newest published image, so a discriminator that breaks on a fresh release surfaces
on the next gate run instead of waiting for someone to bump a hard-coded pin. A
specific tag can still be passed via `OPENCLAW_TAG` for a one-off reproduction.

This makes two opposite-intent version policies coexist on purpose, and a future
openclaw change must not collapse them: the **runtime/arming gate floats to
`latest`** (always prove the *newest* host still arms), while the **compat/install
`>=` floors and the oldest-host floor smoke stay pinned** (always prove the
*oldest-supported* host still loads). The floors are `package.json#openclaw`'s
`minGatewayVersion` / `pluginApi` / `minHostVersion` (`>=` semantic floors tied to
the `--ignore-scripts` security guarantee of [[0008-bundled-deps-host-ignore-scripts]],
verified at 2026.4.15) and `smoke-plugin-load.sh`'s deliberate `OPENCLAW_TAG:-2026.4.15`
pin, which boots the *oldest* supported host to prove load-on-floor. Floating
those would defeat their purpose; pinning this gate would defeat its purpose. A
"drop all version pins for hygiene" sweep is correct for the runtime gate and a
regression for the floors.

To re-verify the discriminator on a new image: dump `process.argv` + `process.title`
(and diff `process.env` keys) from inside `register()` across the gateway and a CLI
context; if `argv` is rewritten too, fall back to a gateway-only env marker
(`OPENCLAW_GATEWAY_PORT` was observed present on the daemon, absent on CLI).

## Consequences

- The wake-pump arms in the gateway runtime and the three CLI contexts still skip
  — no spurious wake subscription in a verify process.
- `wake_pump_started` / `wake_pump_skip_non_gateway` are the runtime markers; the
  skip log carries a `subcommand` diagnostic. These are the signals the
  klodi-stage cross-repo gate (`pnpm test:openclaw` — 16 wake-handlers + 1
  file-sync-inbound) ultimately depends on for end-to-end wake delivery.
- AC-3's end-to-end half (real NATS publish → running pump → `wake_enqueued`) is
  delegated to that cross-repo gate by design: the bug is purely detection, and
  once armed the delivery path is unchanged and already unit-locked by
  `wake.test.ts`.

## Third openclaw context — the headless register entry avoids arming *structurally*, not by detection

PR #56 added a third openclaw context beyond the gateway daemon and the
CLI-verify invocations: the headless `klodi-openclaw-register` bin
(`adapters/openclaw/src/bin/register.ts`), the TS analogue of rust `run_register`
(`packages/klodi-rust-host/src/register.rs`). It provisions creds/config/CA to
disk at boot and exits — no agent in the loop.

It does **not** rely on the `argv[2]` detection above to skip arming. The claim +
persist-to-disk logic was extracted into a **PluginAPI-free core**
(`adapters/openclaw/src/lib/register-core.ts`) that imports no plugin runtime — no
`PluginAPI`, no NATS connect, no wake pump. The bin consumes only that core, so the
fail-OPEN this ADR guards (a short-lived non-gateway process arming a JetStream
consumer) is not merely detected-and-skipped but **unreachable**: there is no
wake-pump import to fire. The plugin's post-persist NATS/wake bring-up is
re-attached by the thin `claimAndBringUp` wrapper in `register-poller.ts` — the one
caller that arms.

The type system encodes the split: the core's `CoreClaimResult.registered` carries
only disk facts, and the plugin-runtime fields (`nats_connected` / `nats_reason`)
are re-attached by the poller wrapper via an `Exclude<…>` widening — they *cannot*
originate in the core. So there are now **two strategies** for keeping a
non-gateway context from arming, and a future contributor should pick the stronger
one when the code path allows it: **detect-and-skip** (the gateway/CLI split above,
for a single `register()` that runs in both) or **structural exclusion** (a
PluginAPI-free core, for a fully separate entry point). A future headless register
entry — e.g. wiring hermes's still-unfilled `klodi-hermes-register` — should mirror
rust `run_register` and this core, not reach for runtime detection. Persist policy
(bare `assertTls`, optional `nats_ca`) is owned by
[[0022-tls-nats-transport-private-ca-trust]].

## Cross-adapter realization — hermes: the mirror-image failure, a ctx-marker discriminator

PR #45 confirmed **loaded ≠ armed is a cross-adapter axis, not an openclaw quirk** —
and that its second occurrence is the *mirror image* of the first.

**openclaw's failure** (above) was the pump arming **nowhere**: a fail-CLOSED detection
predicate skipped arming for the life of the one gateway daemon. **hermes's failure was
the opposite — the pump armed in *every* process that loaded the plugin.** `register()`
called `start_wake_pump()` unconditionally (`adapters/hermes/src/klodi_hermes/__init__.py`),
so the `hermes gateway run` daemon **and** every transient `hermes chat -q` wake-delivery
subprocess each subscribed the **one** shared durable `klodi-notifications-<userId>`
(`packages/nats-client-py/src/klodi_nats_client/consumers.py`; per-process `event_id`
dedup, no cross-process coordination). A wake went to whichever subscriber pulled it; a
non-bridge ctx cannot shell a turn, so it no-op'd the inject and the consumer **ACKed the
drop** (ack-on-return, NAK-only-on-raise) — `max_deliver` never fired, the
first-contact-after-idle wake was silently lost. Same axis, opposite polarity: *never
armed* (openclaw) vs *armed everywhere* (hermes multi-subscriber split-brain).

**The hermes discriminator is a positive, NON-inherited ctx capability marker** —
`BridgeCtx.klodi_wake_pump_host = True` (constant `WAKE_PUMP_HOST_ATTR` in `bridge.py`),
read by `register()` via `_is_wake_pump_host(ctx)`. It is the Python analogue of
openclaw's `isGatewayRuntime()`/`argv[2]`: a positive signal only the true wake-pump host
sets. `register()` now registers tools/skills **always** and arms the pump **iff** the
marker is present; the always-on `klodi-hermes-bridge` daemon is the one owner, the
gateway daemon and every chat subprocess load-only. The positive non-host marker is
`wake_pump_skip_non_host` (INFO), mirroring openclaw's `wake_pump_skip_non_gateway`.

**Why an env var fails OPEN here — the hermes-specific twist openclaw does not have.**
`BridgeCtx.inject_message` shells its `hermes chat -q` children with `{**os.environ}`
merged into their environment (`bridge.py`). An env-based discriminator would therefore
**leak into those children**, which would then arm competing pumps — the same fail-OPEN
this ADR warns of, but reached by **inheritance** rather than an over-broad match. The
defense: the marker lives on an **in-process Python object**, so a spawned child gets a
fresh host-built ctx that lacks the attribute and cannot inherit the capability. This is
why the discriminator MUST be object state, never environment. Unit guard (AC-8):
`test_merged_environ_child_does_not_arm_pump` reconstructs the real merged child env and
proves the gate ignores it.

**Why the arming gate — not NAK-on-noop — is the fix (cross-ref
[[0019-wake-inject-failure-disposition]]).** The instinctive alternative — don't-ACK a
no-op so JetStream redelivers — collides with ADR-0019's deliberate
ACK-even-on-deterministic-failure policy and is strictly worse here: the redelivered copy
lands back on the **same shared durable**, where an incapable subscriber may no-op it
again, burning `max_deliver: 5` in rapid succession then dropping anyway (no dead-letter).
The arming gate instead **removes the incapable subscriber entirely**, so the wake only
ever reaches a ctx that can run it. ADR-0019 (ACK-on-deterministic-failure) and
[[0020-operator-escalation-delivery-binding]] (marker-on-exit-0) are untouched by this
change — and the cold-start observable is that `event_id`-keyed **completion marker**, never
`sessions.source='klodi'` (v0.17.0 `hermes chat -q` drops `--source`, persisting `cli`).

**Process/supervision topology (context for "arm in exactly one process").** Prod and
stage co-supervise three daemons — `hermes gateway run`, `hermes dashboard`,
`klodi-hermes-bridge` — under one bash **`wait -n`** (NOT s6-overlay, correcting the
original framing); any death exits the container and the orchestrator restarts all
three. Keep the arming gate **inside the bridge's `BridgeCtx`**; do **not** move it into
`hermes gateway run` boot — that recouples wake delivery to gateway boot ordering and
per-chat plugin lifecycle, the exact coupling the bridge daemon exists to break.

**Recurrence / test defense (hermes).** The deterministic lock is the unit detection
matrix `adapters/hermes/tests/test_wake_arming_gate.py`: a non-host ctx
(`SimpleNamespace()` lacking the marker) → `start_wake_pump` NOT called; a real
`BridgeCtx` → armed exactly once (fail-CLOSED guard); the merged-`{**os.environ}` child →
still not armed (fail-OPEN guard). The two-place name coupling (constant string ↔
class-attr name) is locked by `test_arming_gate_keys_off_the_published_capability_attr`.
The e2e defense is the klodi-stage `integration/hosts/hermes/wake.test.ts` DELIVERED gate
at a new `WAKE_DELIVER_ATTEMPTS=1` knob (no warm-up retry, cold-since-boot persona) — a
**cross-repo, lockstep** lever this change does not build; it only makes the cold path pass
at attempts=1.

**Residual (follow-up, not this change).** `register.py::_persist_credentials` still calls
`start_wake_pump()` directly on the interactive `hermes chat` `klodi_register` success
path, bypassing the gate. It does not reintroduce the silent drop (an interactive ctx runs
the turn, so INV-1 holds) and this diff **strictly narrows** the residual — on `main`
`register()` armed unconditionally, so the interactive process was *always* a competing
subscriber; now only this one `klodi_register`-success path remains ungated. Gating it
collides with the pinned stop→close→start credential-refresh order
(`test_register.py::test_persist_calls_close_client_between_stop_and_start_pump`) → a
follow-up.

## References

- **Detection site (inline WHY):** `adapters/openclaw/src/service/wake-pump.ts`
  `isGatewayRuntime()` — the argv-vs-title rationale and the empirical
  observation (latest image) live at the function's doc-comment.
- **Runtime gate:** `adapters/openclaw/scripts/smoke-gateway-load.sh` (axis 3/4;
  exit 3 = loaded-but-inert) + its vitest wrapper
  `smoke-gateway-load.integration.test.ts`.
- **Detection matrix (unit):** `adapters/openclaw/src/__tests__/service/wake-pump-detection.test.ts`
  — runtime/CLI/override permutations + fail-OPEN/fail-CLOSED adversarial rows.
- **Skip/halt contract lock (unit):** `adapters/openclaw/src/__tests__/service/wake-pump-retry.test.ts`
  — gateway-skip via the detection seam; asserts halt-on-null, no busy-retry.
- **Structural-exclusion seam (inline WHY, PR #56):**
  `adapters/openclaw/src/lib/register-core.ts` (PluginAPI-free core) +
  `adapters/openclaw/src/bin/register.ts` (the headless bin that consumes it) —
  the `ADR-0015`/`ADR-0022` rationale and the disk-facts-only `CoreClaimResult`
  live at both sites.
- **Root cause A (merged #17):** `openclaw.plugin.json:7-9`
  (`activation.onStartup`).
- **The static axes this complements:** [[0014-tool-symmetry-axes]] (manifest /
  catalog, validated by `plugins doctor`).
- **The wake-event transport this rides on:** [[0001-persistent-websocket-connection]].

### hermes realization (PR #45)

- **Discriminator (inline WHY):** `adapters/hermes/src/klodi_hermes/bridge.py` —
  `WAKE_PUMP_HOST_ATTR` constant + `BridgeCtx.klodi_wake_pump_host` class attr; the
  "positive, non-inherited, never-an-env-var" rationale lives at both sites.
- **Arming gate (inline WHY):** `adapters/hermes/src/klodi_hermes/__init__.py` —
  `register()` → `_is_wake_pump_host()` / `_arm_wake_pump_or_skip()`; tools/skills always,
  pump iff host.
- **Detection matrix (unit):** `adapters/hermes/tests/test_wake_arming_gate.py` —
  host/non-host/merged-environ-child permutations + fail-OPEN (AC-8) / fail-CLOSED guards.
- **Cold-start integration:** `adapters/hermes/tests/test_first_wake_after_idle.py` —
  the "never both no-op'd AND ACKed" invariant + unregressed warm path.
- **The shared durable this split-brains over:**
  `packages/nats-client-py/src/klodi_nats_client/consumers.py` (`_dispatch_message`
  ack-on-return / nak-on-raise; single `klodi-notifications-<userId>`, `max_deliver: 5`).
- **Why an arming gate, not NAK-on-noop:** [[0019-wake-inject-failure-disposition]].
- **Completion-marker observable (not `sessions.source`):**
  [[0020-operator-escalation-delivery-binding]].
