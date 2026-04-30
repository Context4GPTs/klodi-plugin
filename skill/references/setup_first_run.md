# klodi — first-run setup

Onboard a new user onto klodi, the peer-to-peer marketplace their agent will be trading on. Think of this as the "sign up for eBay" moment — once, then never again. The only goal here is to get `klodi_setup_status` to return `phase: "ready"`. Re-loading this file resumes at the correct phase.

Every `klodi_*` name in this file is a plugin tool to call directly, not a shell command. When a step needs the user to run something in their terminal, it is called out explicitly ("run in your terminal").

## Step 0 — verify tool access

Before calling any klodi tool, confirm `klodi_setup_status` appears in the available tools list. If it does not, the host runtime is filtering klodi tools out — refer the user to the adapter's README for the host-specific fix.

Stop until tools are loaded. Do not try other klodi tools — they will all be filtered. When the user confirms, go to Step 1.

## Step 1 — read state

Call `klodi_setup_status`. Branch on `phase`:

| phase | action |
|-------|--------|
| `ready` | skip to **Done** |
| `unregistered` | Step 2 |
| `corrupt` | Step 2R (repair), then Step 2 |
| `degraded` | present `issues` to the user; apply each `fix` in order; re-run Step 1 |
| `needs_policy` | Step 3 |

Never guess. Every issue carries a `fix` with `kind` = `tool`, `shell`, or `dialog` — follow it. `fix.tool` → call that tool. `fix.shell` → ask the user to run the command, wait for confirmation. `fix.dialog` → proceed per the dialog instructions.

## Step 2 — register

Call `klodi_register`. The response has `auth_url`, `session_id`, and `poll_url`. Tell the user:

> Open this link to sign up: **{auth_url}**
> I'll pick it up automatically once you're done — the link works for about 10 minutes.

Do NOT loop on `klodi_register_poll`. The plugin polls the session in the background and will wake the agent via a system event on the terminal state. End the turn and wait.

Expected wake events (each arrives as a `[klodi] …` system event):

- **Registration complete — welcome, @{handle}.** → greet the user and go to **Step 1**. Creds, config, and bundled policy files are already on disk; NATS is warm.
- **Registration link expired** or **session was already claimed** → tell the user, offer to re-run Step 2. If declined, stop.
- **No registration completion detected in 10 minutes** → ask whether the browser flow actually completed. If yes, call `klodi_register_poll { session_id }` once as a manual fallback. If no, offer to re-run Step 2.

`klodi_register_poll` is a manual fallback only — use it when a wake event never arrived (e.g. the plugin was restarted mid-flow) or the 10-minute timeout wake asks for it.

## Step 2R — repair

Phase `corrupt` means a previous setup wrote state partially. Tell the user exactly what is present (from `status.checks`) and confirm before wiping:

> I have {present} but {missing}. Clear and re-register from scratch?

On confirmation: call `klodi_setup_repair`, then go to Step 2. `klodi_setup_repair` removes `nats.creds` and `config.json` — listings, searches, and policies are untouched.

## Step 3 — fill the negotiation style

`klodi_setup_status` reports `phase: "needs_policy"` because the seeded template at `${klodi_home}/policies/negotiation_style.md` still contains placeholder tokens (`<e.g., ...>` or the `firm | flexible | aggressive` Posture sentinel).

Read the file, then have a short conversation — one prompt per section — and rewrite the file preserving section headers. Do not leave any placeholder. Do not invent sections.

Gather:

- **Posture** — firm, flexible, or aggressive?
- **Authorization overrides** — anything on the default list to *not* do without asking?
- **Always Ask Me First — additions** — anything beyond the defaults?
- **Logistics**:
  - *Pickup*: areas, times, safe spot policy.
  - *Shipping*: carriers, who pays, insurance threshold, handling time.
  - *Digital*: transfer method, payment-before-transfer y/n.
  - *Payment*: accepted methods; methods to refuse.
- **Communication** — tone, response SLA, walk-away rule.

Keep it short. The user hasn't traded yet; don't over-optimize. Write the file in their own words.

After writing, go to Step 1.

## Done

`klodi_setup_status` returned `phase: "ready"`. As a final live probe, call `klodi_whoami` — a successful response with the user's handle and rating fields proves the full stack is wired (creds → config → NATS → server).

Subsequent sessions don't need this file. SKILL.md §2 handles steady-state session start; this reference loads only when `phase !== "ready"`.
