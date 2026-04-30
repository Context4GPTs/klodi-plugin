# PLAN-0002 — Keychain / hardware-backed credential storage

- **Status:** Planned
- **Type:** Code + packaging change
- **Supersedes when shipped:** part of ADR-0002 alternative 1

## Gap

The `0600` file mode defends against other-UID readers on the live host. It does not defend against **offline filesystem capture** — scenarios where the creds bytes leave the host intact:

- Laptop backups (Time Machine, Arq, Backblaze) without backup encryption.
- Cloud-sync of the home directory (iCloud Drive, Dropbox, OneDrive) that reaches into `~/.openclaw/`.
- Disk imaging for forensics, legal discovery, or device transfer.
- Theft of a drive without full-disk encryption enabled.

A keychain-stored or hardware-backed key closes all of these. The user guidance in SECURITY.md (enable full-disk encryption, exclude `~/.openclaw/` from cloud sync) is a workaround, not a platform guarantee.

## Proposed approach

Phase 1 — **Opt-in keychain storage**:
- Abstraction boundary: a `CredentialStore` interface with `store(creds)`, `load()`, `revoke()` methods. Default implementation stays the `0600` file; a keychain-backed implementation is selected by config flag or platform detection.
- macOS: use Security framework via a pure-JS bridge if one exists, otherwise accept a native module *behind a build flag* so the default tarball stays native-free per [ADR-0003](../decisions/0003-vendored-runtime-dependencies.md).
- Linux: libsecret via DBus (libsecret has a pure-DBus protocol — no native binding strictly required).
- Windows: DPAPI via a native binding; optional in v1.

Phase 2 — **Hardware-backed where available**: SecureEnclave-wrapped keys on macOS, TPM on Windows. Requires the signer itself to perform sign operations inside the secure element rather than exposing a raw key. Larger change — NKey sign path has to route through an opaque signer interface.

## Why deferred

- No single cross-platform API; three distinct integrations.
- Native-module dependency conflicts with ADR-0003's no-compile-time-code posture; needs a design for how to ship a native bit without re-opening install-time code execution on user hosts.
- Phase 2 requires cooperation with the `@nats-io/*` NKey API surface to inject an opaque signer.

## Definition of done

- `CredentialStore` interface in `src/lib/creds/`.
- At least macOS Keychain implementation shipping behind an opt-in flag.
- ADR-0002 updated with a "Superseded in part by ADR-000X" note; new ADR captures the current decision.
- THREAT_MODEL T5 row updated to reflect the reduced residual risk for keychain-backed users.
- Plan file deleted or moved to a "Shipped" archive.
