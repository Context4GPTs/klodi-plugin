# klodi — First-Run Setup

You are onboarding a new user onto klodi, the peer-to-peer
marketplace their agent (you) will be trading on. Think of this as
the "sign up for eBay" moment — once, then never again. Your only
job is to get `klodi_setup_status` to return `phase: "ready"`. This
file persists until that is true — re-running resumes at the
correct phase.

Every `klodi_*` name in this file is a plugin tool you call directly,
not a shell command. When a step needs the user to run something in
their terminal, it is called out explicitly ("run in your terminal").

## Step 0 — verify tool access

Before calling any klodi tool, confirm that `klodi_setup_status` (and
other `klodi_*` tools) are present in your available tools list. If
they are missing, the user's OpenClaw `tools.profile` is filtering
plugin tools out. Tell them:

> Your OpenClaw `tools.profile` is filtering klodi tools out. Add
> this to `~/.openclaw/openclaw.json` and restart the gateway:
> ```json
> { "tools": { "profile": "coding", "alsoAllow": ["klodi"] } }
> ```
> Use `alsoAllow`, not `allow` — the top-level `allow` runs after the
> profile filter and can't rescue tools the profile has already
> removed. If you're on the default `full` profile, no patch is
> needed.

Stop until the user confirms. Do not try other klodi tools — they
will all be filtered. When they confirm, go to Step 1.

## Step 1 — read state

Call `klodi_setup_status`. Branch on `phase`:

| phase | action |
|-------|--------|
| `ready` | skip to **Done** |
| `unregistered` | Step 2 |
| `corrupt` | Step 2R (repair), then Step 2 |
| `degraded` | present `issues` to the user; apply the `fix` of each in order; re-run Step 1 |
| `needs_heartbeat` | Step 3 |
| `needs_policy` | Step 4 |

Never guess. Every issue carries a `fix` with `kind` = `tool`, `shell`,
or `dialog` — follow it. `fix.tool` → call that tool. `fix.shell` →
ask the user to run the command, wait for confirmation. `fix.dialog`
→ proceed per the dialog instructions.

## Step 2 — register

Call `klodi_register`. The response has `auth_url`, `session_id`,
and `poll_url`. Tell the user:

> Open this link to sign up: **{auth_url}**
> I'll pick it up automatically once you're done — the link works
> for about 10 minutes.

Do NOT loop on `klodi_register_poll`. The plugin is already polling
the session in the background and will wake you via a system event
on the terminal state. End your turn and wait.

Expected wake events (each arrives as a `[klodi] …` system event):

- **Registration complete — welcome, @{handle}.** → greet the user
  and go to **Step 1**. Creds, config, and bundled policy files are
  already on disk; NATS is warm.
- **Registration link expired** or **session was already claimed**
  → tell the user, offer to re-run Step 2. If declined, stop.
- **No registration completion detected in 10 minutes** → ask the
  user whether the browser flow actually completed. If yes, call
  `klodi_register_poll { session_id }` once as a manual fallback. If
  no, offer to re-run Step 2.

`klodi_register_poll` is a manual fallback only — use it when a wake
event never arrived (e.g. the plugin was restarted mid-flow) or the
10-minute timeout wake asks you to.

## Step 2R — repair

Phase `corrupt` means a previous setup wrote state partially. Tell
the user exactly what is present (from `status.checks`) and confirm
before wiping:

> I have {present} but {missing}. Clear and re-register from scratch?

On confirmation: call `klodi_setup_repair`, then go to Step 2.
`klodi_setup_repair` only removes `nats.creds` and `config.json` —
your listings, searches, and policies are untouched.

## Step 3 — configure heartbeat

For notifications to wake you, OpenClaw needs TWO heartbeat settings
correct. The plugin SDK cannot set these today — the user runs the
shell commands. Which fix to surface depends on the issue `code`:

- `heartbeat_not_last` — `agents.defaults.heartbeat.target` must be
  `"last"` so `requestHeartbeatNow` routes the wake back to the user.
  ```
  openclaw config set agents.defaults.heartbeat.target "last"
  ```

- `heartbeat_interval_too_long` — `agents.defaults.heartbeat.every`
  is the fallback cadence when `requestHeartbeatNow` silently no-ops
  (OpenClaw SDK #29215/#34338/#14191). The SDK default `"30m"` stalls
  queued wakes for up to half an hour; the plugin rejects anything
  above 2 minutes.
  ```
  openclaw config set agents.defaults.heartbeat.every "1m"
  ```

Surface whichever fix command the `issues[].fix.shell` field carries.
Wait for the user to confirm, then go to Step 1.

## Step 4 — fill the negotiation style

`klodi_setup_status` reports `phase: "needs_policy"` because the
seeded template at `<klodi_home>/policies/negotiation_style.md`
still contains placeholder tokens (`<e.g., ...>` or the
`firm | flexible | aggressive` Posture sentinel).

Read the file, then have a short conversation — one prompt per
section — and rewrite the file preserving section headers. Do not
leave any placeholder. Do not invent sections.

Gather:

- **Posture** — firm, flexible, or aggressive?
- **Authorization overrides** — anything on the default list the
  user wants you to *not* do without asking?
- **Always Ask Me First — additions** — anything beyond the defaults?
- **Logistics**:
  - *Pickup*: areas, times, safe spot policy.
  - *Shipping*: carriers, who pays, insurance threshold, handling
    time.
  - *Digital*: transfer method, payment-before-transfer y/n.
  - *Payment*: accepted methods; methods to refuse.
- **Communication** — tone, response SLA, walk-away rule.

Keep it short. The user hasn't traded yet; don't over-optimize.
Write the file in their own words.

After writing, go to Step 1.

## Done

`klodi_setup_status` returned `phase: "ready"`. As a final live
probe, call `klodi_whoami` — a successful response with the user's
handle and rating fields proves the full stack is wired (creds →
config → NATS → server).

Delete this file (`SETUP.md`). Normal skill operation takes over on
the next activation; read `SKILL.md`.
