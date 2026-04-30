# ADR-0004 — Preserve `$klodi_home` on uninstall

- **Status:** Accepted
- **Date:** 2026-04-22
- **Review concern addressed:** *Persistence — installing places plugin code on disk and registers a long-lived service; uninstall behavior.*

## Context

`$klodi_home` (default `~/.openclaw/workspace/.klodi/`) accumulates several categories of state the user cares about:

- **Credentials** (`nats.creds`, `config.json`) — recoverable: re-register via `klodi_register`.
- **Policies** (`policies/negotiation_style.md`, `policies/security.md`) — seeded once, then edited by the user. `negotiation_style.md` encodes the user's negotiation posture, logistics, payment preferences, walk-away conditions. The user's own words.
- **Sell/buy files** (`sell/<slug>.md`, `buy/<slug>.md`) — active listings and standing searches. Each `sell/*.md` carries the floor price, private facts, and active negotiation state for one live listing. Deleting this file mid-deal would destroy the audit trail for a transaction the user is legally committed to.

An uninstall could plausibly mean "I want to stop running the plugin" (reinstall is likely) or "I want to wipe every trace" (hard exit). The plugin cannot distinguish these reliably at uninstall time.

## Decision

`openclaw plugins uninstall klodi` removes the plugin *code* but does not touch `$klodi_home`. SECURITY.md explicitly tells users: "delete the directory yourself for a full wipe." The `klodi_setup_repair` tool narrows to creds + config wipe only, leaving policies and sell/buy files alone — so the "I re-registered with a new account" flow does not destroy in-flight transactions or negotiation history.

## Alternatives considered

1. **Auto-wipe `$klodi_home` on uninstall.** Rejected: the user has active listings, pending transactions, and a negotiation style they invested real thought into. An unintentional reinstall would delete all of that. The marketplace counterparty has no way to know the user's state vanished.
2. **Prompt the user at uninstall time.** Rejected: not all plugin-host uninstall flows support user interaction (CI pipelines, configuration management tools, automated upgrades). A silent data-loss path disguised as a prompt failure is worse than the conservative "leave it alone" default.
3. **Move state under the plugin's own install directory.** Rejected: then `openclaw plugins uninstall` *would* take it out. Same problem, just routed differently. Worse: reinstall would land it at a different path and lose the state anyway.

## Security implications

- **User retains visibility.** The directory is plain markdown + creds under a documented path the user can `ls`, audit, or delete themselves. Nothing hides.
- **No orphan processes.** The `klodi-nats` service's `stop()` handler runs at uninstall (service lifecycle is owned by the gateway); no background process keeps a WebSocket open or a timer firing after the plugin code is gone. Persistence is data-only, not execution.
- **Narrow `setup_repair`.** `klodi_setup_repair` takes only `nats.creds` and `config.json`. That is the narrowest blast radius that still enables a clean re-register. (Per [docs/plans/0008-mitigation-test-evidence.md](../plans/0008-mitigation-test-evidence.md): unit coverage for `registerSetupRepair` in `adapters/openclaw/src/tools/setup.ts` is open work; the existing `__tests__/` covers `service/state.ts` and `service/wake.ts` only.)
- **Documented full-wipe path.** SECURITY.md § Credential handling states the full-wipe step (`rm -rf ~/.openclaw/workspace/.klodi/`) so a user who *does* want total removal has an unambiguous path.
- **Revoke-at-server complements local wipe.** A user uninstalling because they suspect local compromise should also rotate the signer on the server — SECURITY.md instructs them to do so.

## References

- Code: `adapters/openclaw/src/tools/setup.ts` `registerSetupRepair`
- [SECURITY.md § Credential handling](../../SECURITY.md)
- [SECURITY.md § Local storage](../../SECURITY.md)
- Related: [ADR-0002](./0002-on-disk-nkey-credentials.md)
