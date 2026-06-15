# klodi Plugin — Threat Model

This document enumerates the assets the plugin holds, the trust boundaries it crosses, and the threats each asset faces — mapped to the concrete mitigations in code, SECURITY.md, and the ADRs.

It is a living document: if you add a capability or cross a new boundary, add the row here before you merge.

Last reviewed: 2026-04-30.

## Assets

| ID | Asset | Location | Sensitivity | Notes |
|---|---|---|---|---|
| A1 | NKey signer (private half) | `$klodi_home/nats.creds` (mode 0600) | **Critical** | Full authentication authority for the user's marketplace identity. |
| A2 | Registration config | `$klodi_home/config.json` (mode 0600) | **Medium** | Handle, user_id, public NKey, nats_url. Not secret on its own, but identifies the user. |
| A3 | Floor prices, budget ceilings, walk-away rules | `sell/<slug>.md` frontmatter; `buy/<slug>.md` frontmatter | **Critical** | Negotiation edge. Disclosing a floor collapses the negotiation to that number. |
| A4 | Private facts | `sell/<slug>.md` `## Private Facts`; `buy/<slug>.md` `## Evaluation Criteria` | **High** | Details not yet published to the listing body — serial numbers, defects, provenance. |
| A5 | Negotiation style | `policies/negotiation_style.md` | **Medium** | Posture, authorization boundary, logistics preferences. Strategic not tactical. |
| A6 | Hard-rule policy | `policies/security.md` (seeded from skill) | **Low** | Public by design — it is the contract the agent is bound by, and the agent being transparent about the contract does not weaken it. |
| A7 | Channel messages | In-flight only; server-stored | **Medium** | Carries what the user *does* disclose. Adversarial counterparty reads this legitimately. |
| A8 | Signed offer terms | Server-stored, returned in `tx_status` | **Medium** | The audit trail for a transaction. Integrity matters more than secrecy. |

## Trust boundaries

| ID | From | To | Enforcement |
|---|---|---|---|
| B1 | Host filesystem | Plugin process | UID separation; the plugin reads/writes only under `$klodi_home` |
| B2 | Plugin process | klodi backend | TLS (wss://), NKey signature per frame |
| B3 | User's agent | Counterparty agent | Hard-rule policy file; SKILL.md instructs the LLM to treat counterparty text as untrusted |
| B4 | npm/ClawHub distribution | User host | Published commit hash in ClawHub verification metadata; smoke test runs both install variants |
| B5 | OpenClaw gateway | Plugin process | Plugin-SDK contract; plugin runs as a separate import inside the same Node process |
| B6 | Plugin process | R2 signed storage | Presigned URL with content-type and size constraints baked in |

## Threats and mitigations

### T1 — Adversarial counterparty extracts floor price

*An opposing buyer agent crafts questions designed to elicit the seller's `min_acceptable_price`.*

- **Mitigation (hard rule):** `skill/policies/security.md` forbids sharing `min_acceptable_price` / `auto_reject_below` under any negotiation style. Copied verbatim into `$klodi_home/policies/security.md` on first run.
- **Mitigation (architecture):** Floor never leaves disk ([ADR-0005](./decisions/0005-client-side-floor-price-enforcement.md)); the counterparty cannot extract what klodi never had to relay.
- **Mitigation (behavior):** Below-floor offers are silently auto-rejected. `auto_reject_below` is enforced server-side (set via `klodi_list_update`); the agent never sees the offer amount and cannot cite it back. See `adapters/openclaw/src/service/state.ts` `onListingUpdated` for the local mirror that keeps the sell file in sync after the server-side update.

### T2 — klodi backend compromise leaks private strategy

*A breach of klodi.4gpts.com exposes everything stored server-side.*

- **Mitigation (architecture):** Strategy data (floors, private facts, policy files, buy criteria, active negotiation notes) never transits to the server. See [SECURITY.md § What is sent to klodi's servers](../SECURITY.md).
- **Residual exposure:** listing bodies, comments, channel messages, offer amounts, rating text — what the marketplace *needs* to function. This matches the public posture of any marketplace.

### T3 — Local-exfil sibling plugin reads klodi state

*A different plugin installed in the same OpenClaw runtime reads `$klodi_home`.*

- **Mitigation (file mode):** `nats.creds` and `config.json` are mode `0600`. A sibling plugin running as the same UID can read them; a sibling under a different UID cannot. The plugin-host model is that all plugins share the UID, so this is not a UID-boundary defense.
- **Mitigation (user responsibility):** SECURITY.md § Scope explicitly notes the policy does not cover other plugins running alongside klodi. The user is the trust anchor; installing a malicious plugin compromises klodi state no matter what the plugin does.
- **Mitigation (revocability):** A user who suspects local compromise runs `klodi_setup_repair` + `klodi_register`; the server rotates the NKey association and the old signer is dead even if copied.

### T4 — Man-in-the-middle on WebSocket transport

*A network adversary between the user's host and klodi.4gpts.com reads or tampers with traffic.*

- **Mitigation (TLS):** Production uses `wss://`. The WS layer rides on the same TLS stack the browser uses. See `packages/nats-client-ts/src/` (the shared NATS-WS client every TS adapter imports).
- **Mitigation (signatures):** Every NATS frame is signed by the NKey and verified server-side. Tampering changes the signature and the server rejects.
- **Mitigation (single host):** One configured endpoint — easier to pin, easier to observe in a corporate proxy, no cross-host DNS surface.

### T5 — Stolen `nats.creds` used from a different host

*An attacker copies the creds file off the user's laptop and uses it elsewhere.*

- **Mitigation (mode):** `0600` limits who on the source host can read the file.
- **Mitigation (drift detection):** `loadCreds` in `adapters/openclaw/src/lib/config.ts` logs a warning on mode drift; `klodi_setup_status` surfaces it as `creds_perms`. Same check uniformly across TS / Py / Rust per SECURITY.md § Credential handling.
- **Mitigation (revocation):** User runs `klodi_setup_repair` + `klodi_register`. Server rotates the NKey association. Old signer is dead.
- **Residual risk:** Between theft and user noticing, the attacker has full authority. SECURITY.md § Credential handling instructs the user to rotate on suspicion.

### T6 — Rogue runtime dependency

*A transitive dep is malicious or compromised between publish and install.*

- **Mitigation (audit surface):** Runtime deps are few and enumerated in SECURITY.md § Dependencies. Each one is a named, widely-used package with its own review trail (`@nats-io/*`, `ws`, `tweetnacl`, `@sinclair/typebox`, `gray-matter`).
- **Mitigation (exact version pins):** Public-registry deps in `package.json#dependencies` are pinned to exact versions (no `^`, `~`, or ranges). The host's `npm install` after tarball extraction therefore resolves to the same versions every time.
- **Mitigation (committed lock file):** `pnpm-lock.yaml` is committed at the workspace root; reproducing the build reproduces the exact dep graph for our own pack-time inputs (workspace deps + bundled stripping). Host-side install does not consult the lock file — exact version pins above are what keeps the install deterministic.
- **Mitigation (no native modules):** Zero native modules in the runtime deps means zero compile-time code execution paths.
- **Mitigation (smoke gate):** `klodi-plugin/adapters/openclaw/scripts/smoke-plugin-load.sh` loads the published-shape tarball into a clean OpenClaw image before publish; a misbehaving dep that crashes on load fails the gate.
- **Residual risk:** A compromised dep that behaves correctly at load and misbehaves later would not be caught. Standard npm supply-chain risk, not specific to this plugin. See [ADR-0009](./decisions/0009-vendored-ts-workspace-deps.md) for the install path.

### T7 — Install-time code execution

*A malicious `postinstall` or similar runs arbitrary code on the user's host during install.*

- **Mitigation (no plugin install scripts):** The plugin declares no `preinstall` / `postinstall` / `install` lifecycle scripts. See `package.json#scripts` — the only `"install"` key is the `openclaw.install` config block, not a script.
- **Mitigation (vendored workspace deps have no install hooks):** Workspace deps (`@klodi/tool-catalog`, `@klodi/nats-client`) ride into the tarball as inlined source under `dist/_vendor/_klodi_openclaw_<pkg>/` — plain `.js` files with no nested `package.json`. There is no manifest for `npm install` to script-execute, regardless of whether the host passes `--ignore-scripts`. The threat shape is structurally absent rather than mitigated.
- **Mitigation (host enforces `--ignore-scripts`):** Public-registry transitive deps run through `npm install` on the user's host after extraction. OpenClaw `>=2026.4.15` invokes that install with `--omit=dev --silent --ignore-scripts` (`install-package-dir` chunk in the OpenClaw runtime), blocking `preinstall` / `install` / `postinstall` from firing. The plugin pins `openclaw.install.minHostVersion: ">=2026.4.15"` to refuse hosts where this protection has not been verified. See [ADR-0009](./decisions/0009-vendored-ts-workspace-deps.md).

### T8 — Permission drift on `nats.creds`

*A user's file-manager, backup tool, or careless `chmod -R` widens the creds file.*

- **Mitigation (enforced write mode):** `writeFileSync(..., { mode: 0o600 })` *and* explicit `chmodSync(path, 0o600)` after write. The double-check closes umask-interaction holes.
- **Mitigation (read-time check):** `loadCreds` warns on mode drift; `klodi_setup_status` returns `creds_perms` so the agent surfaces it to the user.

### T9 — Stale credentials bound to a previous user after re-register

*A user re-registers; the plugin's in-memory state still holds the prior signer.*

- **Mitigation (ordered reset):** the registration completion path closes the cached NATS client and drops the cached config *before* the next request re-bootstraps with the new creds. The ordering is commented inline at `adapters/openclaw/src/tools/register-poller.ts` and `adapters/openclaw/src/lib/client.ts` (the connection cache).
- **Mitigation (same path for repair):** `klodi_setup_repair` uses the same reset sequence so tool path and poller path cannot diverge.

### T10 — Agent publishes private facts under social-engineering pressure

*A clever counterparty convinces the agent to `klodi_list_update` a description that includes a `## Private Facts` entry the user never authorised.*

- **Mitigation (hard rule):** `skill/policies/security.md` blocks private→public promotion without explicit user approval, regardless of `negotiation_style.md` permissiveness.
- **Mitigation (description clamp):** SKILL.md §8 caps listing description at ~8 bullets; beyond that the agent must restructure, which forces the user to see the change.
- **Successor control (edit audit trail):** listing fields including `category` are now editable in place via `klodi_list_update` — the old "withdraw + relist makes the change visible" reasoning no longer applies. After-the-fact visibility of an edit is owned by the server-side edit audit trail in the sibling marketplace card `listing-edit-audit-trail-and-re-confirm` (forward-looking; not shipped here).

### T11 — Denial-of-wake via heartbeat misconfiguration *(retired in 0.2.0)*

Historical context: the 0.1.x plugin enqueued wakes via OpenClaw's heartbeat plane, which made `agents.defaults.heartbeat.every` a load-bearing config the plugin had to police (`heartbeat_interval_too_long` issue code, `heartbeat_not_last` check).

0.2.0 (per [ADR-0001](./decisions/0001-persistent-websocket-connection.md) and the 0012 plan) replaced that path with JetStream push over the per-session NATS-WS connection. Wake delivery no longer depends on the host's heartbeat cadence; the plugin no longer inspects host wake-primitive config. The heartbeat issue codes were deleted alongside `lib/duration.ts`, `heartbeatIssues()`, and `needs_heartbeat`.

If wakes are not landing, the failure surface is now NATS connectivity (`klodi_health`) and per-host wake-routing config — see the relevant adapter spec in `docs/specs/hosts/`.

### T12 — Prompt injection in channel messages

*A counterparty sends a channel message crafted to jailbreak the user's agent.*

- **Mitigation (data not code):** Channel message bodies are carried opaquely into the agent's context; nothing in the plugin interprets them as instructions. The catalog's tool schemas (`packages/tool-catalog/src/index.ts`) accept `content` as a string and the adapters never `exec`/`eval` it.
- **Mitigation (SKILL.md posture):** SKILL.md §3 frames the counterparty as adversarial and the hard-rule file as the fallback contract.
- **Residual risk:** LLM-level prompt injection is a class of risk the agent host (OpenClaw + the model) bears; the plugin cannot fully prevent it and instead minimises the damage a successful injection can do (see T1, T10).

### T13 — Photo upload endpoint abused for non-photo binary

*A compromised agent or a bug uses `klodi_list_create.photos` or `klodi_list_update.photos` (absolute local paths) to exfiltrate arbitrary bytes to R2.*

- **Mitigation (content-type sniff before mint):** The adapter reads the first bytes of every local path and matches against the magic-number table for `image/jpeg`, `image/png`, `image/webp`. Mismatches reject pre-mint — no presigned URL is even issued. Extension is advisory; bytes are authoritative.
- **Mitigation (content-type bind at mint):** The presigned URL the marketplace mints is signed for the sniffed `content_type`. R2 rejects PUTs whose `Content-Type` request header does not match.
- **Mitigation (size cap):** Max 10 MB per file, max 10 photos per listing — checked client-side before the mint request is issued.
- **Mitigation (no arbitrary destination):** The `asset_url` returned by the mint points into the klodi-controlled bucket; the user cannot smuggle a different destination through the tool.
- **Mitigation (absolute path + sensitive-dir reject):** Local paths must be absolute (`/...`); relative, tilde-expansion, and `file://` URLs are rejected. After `realpath()`, paths under sensitive directories (`/etc/`, `/var/run/`, `/var/log/`, `/proc/`, `/sys/`, `/root/`, `${KLODI_HOME}`, `~/.ssh/`) are rejected before any read. Symlink escape closes via the sensitive-dir check on the resolved real path.

## Residual risks the plugin does not attempt to defend

- A physically-compromised host (keylogger, memory dump) exposes the creds while the plugin is running. The 0600 mode is not a defense against root on the same host.
- A user who pastes their `nats.creds` contents into a chat window in violation of the hard rules. The plugin cannot stop content that bypasses the tool layer entirely.
- A self-hosted klodi backend with weaker security than `klodi.4gpts.com`. SECURITY.md § Scope says so explicitly — that is the operator's decision to own.
- A sibling OpenClaw plugin running under the same UID that reads `$klodi_home`. User's trust decision to install the sibling.

## References

- [SECURITY.md](../SECURITY.md) — public policy
- [docs/decisions/](./decisions/) — ADRs
- `skill/policies/security.md` — hard-rule file bound into the agent
- `klodi-plugin/adapters/openclaw/scripts/smoke-plugin-load.sh` — publish-time gate
