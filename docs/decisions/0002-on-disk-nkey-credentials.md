# ADR-0002 — On-disk NKey credentials at mode 0600

- **Status:** Accepted
- **Date:** 2026-04-22
- **Review concern addressed:** *Credentials — plugin persists credentials to disk (nats.creds); sensitive.*

## Context

Authenticating to the marketplace over NATS requires holding a signer (an Ed25519 private key, delivered as nats.creds at registration). The plugin must present this credential on every request and on every server-push frame. The alternative is asking the user to re-authenticate on every session, which destroys the premise of an autonomous marketplace agent.

## Decision

Write the creds file to `$klodi_home/nats.creds` at mode `0600` during the `klodi_register` claim (TypeScript: `adapters/openclaw/src/tools/register-poller.ts`; Python: `klodi_secret_write` in the shared Hermes/nanobot installer; Rust: `klodi-rust-host` register helper). On TS the call pair is `writeFileSync(..., { mode: 0o600 })` followed by `chmodSync(path, 0o600)` — the second call closes the umask-dependent hole where the initial mode can be widened by a user's restrictive umask interaction with `writeFileSync`'s create flow. The Py / Rust adapters use an `O_WRONLY|O_CREAT|O_EXCL` + tmp-file-rename helper that avoids the same window structurally.

At read time (`loadCreds` in `adapters/openclaw/src/lib/config.ts`, and the equivalent in each language's `nats-client-*` package) re-check the mode and log a warning if it has drifted. The `klodi_setup_status` tool surfaces this as the `creds_perms` issue code so the agent can tell the user to run `chmod 600`.

The signer never leaves the host. The server only holds the public NKey; all authentication is signature verification server-side.

## Alternatives considered

1. **OS keychain / hardware-backed store (macOS Keychain + SecureEnclave, libsecret/kwallet, Windows DPAPI, TPM).** Deferred on engineering cost, not on security merit. A keychain-wrapped signer genuinely defends against threats the `0600` file does not: offline filesystem capture via laptop backups (Time Machine, iCloud Drive, Dropbox syncing `~`), cloud-sync of the home directory, disk imaging, and theft of a drive that is not fully encrypted. Hardware-backed variants (SecureEnclave, TPM) additionally resist live root-level reads, which the mode bit cannot. These are real gaps in the current design. The reasons we did not ship this in v1 are: no single cross-platform API (macOS Keychain, libsecret/kwallet on Linux, DPAPI on Windows all diverge); each platform backend is a native-module dependency with its own compile-time code-execution story that conflicts with [ADR-0003](./0003-vendored-runtime-dependencies.md); and the three-OS implementation cost was judged higher than the marginal win over the documented user responsibility to enable full-disk encryption (FileVault / LUKS / BitLocker) and exclude `$klodi_home` from cloud sync. A user who wants the stronger defense today keeps their host disk-encrypted and does not sync `~/.openclaw/` to cloud storage.
2. **Ephemeral credentials (re-register each session).** Rejected: the browser OAuth round-trip is 30+ seconds of user-attention time, totally unacceptable to impose on every agent start. Breaks the "autonomous between turns" premise.
3. **Server-held session tokens, short-lived.** Rejected: still requires on-disk refresh material, adds a token endpoint surface, and lets the server observe session boundaries that the plugin architecture does not otherwise need.
4. **Encrypt the creds file with a user passphrase.** Rejected: passphrase prompts conflict with "wake the agent between turns" (there's no human at the keyboard). The security win is small — an attacker with filesystem read on `$klodi_home` almost certainly has enough access to grab the unlocked cred at use time anyway.

## Security implications

- **Least-privilege file mode.** `0600` means only the owning UID can read the file. A co-tenant on the same host, a sibling process under a different UID, and the `other` world all get EACCES.
- **Defense against mode drift.** Read-time warning + `klodi_setup_status` surfaces any drift so the user gets told.
- **Scoped directory.** The creds file lives at `$klodi_home/nats.creds`, a single documented path. Plugin code does not read or write credentials anywhere else on the filesystem.
- **Revocability.** The server holds only the public NKey. Rotating the signer is a one-tool operation (`klodi_setup_repair` → `klodi_register`) and the old key is dead server-side.
- **Never transmitted.** The plugin never re-sends the creds anywhere; it only uses them to sign local frames. The server never receives private key material.
- **Clean uninstall path.** `klodi_setup_repair` removes the creds file without touching the user's policy/sell/buy state. Uninstalling the plugin leaves the file in place by design (see [ADR-0004](./0004-preserve-state-on-uninstall.md)), but the user can `rm -rf ~/.openclaw/workspace/.klodi/` for a full wipe and `security.md` documents that.
- **Residual risk: offline filesystem capture.** A `0600` mode protects only against other-UID readers on the live host. It does not protect the creds file once it leaves the host as bytes — inside an unencrypted laptop backup, a cloud-synced home directory, a disk image, or a stolen unencrypted drive. The user's responsibility is full-disk encryption and excluding `$klodi_home` from cloud sync; SECURITY.md § Credential handling states this.

## References

- Code: `adapters/openclaw/src/tools/register-poller.ts` `persistCompleted` — the `writeFileSync` + `chmodSync` pair
- Code: `adapters/openclaw/src/lib/config.ts` `loadCreds` — the read-time mode check
- Code: `adapters/openclaw/src/tools/setup.ts` `credPermIssues` — surfaces drift to the agent
- [SECURITY.md § Credential handling](../../SECURITY.md)
- Related: [ADR-0001](./0001-persistent-websocket-connection.md), [ADR-0004](./0004-preserve-state-on-uninstall.md)
