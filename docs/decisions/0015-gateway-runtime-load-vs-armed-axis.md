---
id: 0015-gateway-runtime-load-vs-armed-axis
title: Gateway runtime-load axis — loaded ≠ armed; detect the gateway by argv subcommand, not process.title
tags: [openclaw, wake-pump, gateway, runtime, detection, activation, axis, contracts]
card: openclaw-wake-pump-never-arms-in-real-gateway
commit: 9c3f570
updated_at: 2026-06-22
updated_by_card: openclaw-wake-pump-never-arms-in-real-gateway
---

# ADR-0015 — Gateway runtime-load axis: loaded ≠ armed; detect the gateway via `argv[2]`, not `process.title`

## Status

Accepted (2026-06-22). Affects the openclaw adapter's wake-pump
(`adapters/openclaw/src/service/wake-pump.ts`) and the runtime smoke gate
(`adapters/openclaw/scripts/smoke-gateway-load.sh`).

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

- **Root cause A** (merged #17, [`load-openclaw-plugin-at-gateway-startup`]): the
  plugin did not load at gateway startup at all. Fixed by the
  `activation.onStartup: true` arm in `openclaw.plugin.json:7-9`. The plugin now
  *loads*.
- **Root cause B** (this card): the plugin loads but the wake-pump never *arms*.
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
openclaw card must not collapse them: the **runtime/arming gate floats to
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
- **Root cause A (sibling, merged #17):** `openclaw.plugin.json:7-9`
  (`activation.onStartup`); card `load-openclaw-plugin-at-gateway-startup`.
- **The static axes this complements:** [[0014-tool-symmetry-axes]] (manifest /
  catalog, validated by `plugins doctor`).
- **The wake-event transport this rides on:** [[0001-persistent-websocket-connection]].
