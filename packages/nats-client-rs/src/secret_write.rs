//! Atomic secret-file write — TOCTOU-free.
//!
//! Closes P1-8 from the 2026-04-26 multi-lens review. The Rust register
//! binaries today do `tokio::fs::write(path, body)` and then optionally
//! `set_permissions(path, 0o600)` — between the two calls the secret is
//! readable by the world (umask masks `O_CREAT` mode bits to 0o644 on a
//! typical workstation). This helper opens the file with the secure
//! mode set at creation time and uses temp-file + atomic rename to be
//! safe across re-registration.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

/// Default mode for klodi credential files (`nats.creds`, `config.json`).
pub const DEFAULT_MODE: u32 = 0o600;

/// Errors surfaced by [`klodi_secret_write`].
#[derive(Debug, thiserror::Error)]
pub enum SecretWriteError {
    #[error("klodi_secret_write: leftover temp at {path}; could not unlink ({source})")]
    LeftoverTemp {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("klodi_secret_write: opening {path}: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("klodi_secret_write: writing {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("klodi_secret_write: fsync {path}: {source}")]
    Sync {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("klodi_secret_write: chmod {path} → {mode:o}: {source}")]
    Chmod {
        path: PathBuf,
        mode: u32,
        #[source]
        source: std::io::Error,
    },
    #[error("klodi_secret_write: replace {tmp} → {target}: {source}")]
    Replace {
        tmp: PathBuf,
        target: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

fn temp_sibling(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    target.with_file_name(name)
}

/// Write `body` to `target` such that the file is never readable by
/// other users at any point during the write.
///
/// 1. Open `<target>.tmp` with `O_WRONLY|O_CREAT|O_EXCL` and `mode`.
/// 2. Write the body, sync, drop the file handle.
/// 3. `set_permissions` defensively (umask can't widen, but a stale
///    inode left by a previous interrupted run could still be looser).
/// 4. Atomic `rename` over the target.
///
/// Cleans up the temp on any failure so a half-written secret can't
/// linger. Re-registration (existing `target`) is safe — only the
/// rename step replaces it, and the rename is atomic.
pub fn klodi_secret_write(
    target: &Path,
    body: &[u8],
    mode: u32,
) -> Result<(), SecretWriteError> {
    let tmp = temp_sibling(target);

    // Best-effort cleanup of a stale temp from a prior failed run so
    // O_EXCL below can succeed.
    if tmp.exists() {
        std::fs::remove_file(&tmp).map_err(|err| SecretWriteError::LeftoverTemp {
            path: tmp.clone(),
            source: err,
        })?;
    }

    let result = write_inner(&tmp, body, mode);

    match result {
        Ok(()) => {
            if let Err(err) = std::fs::rename(&tmp, target) {
                let cleanup_err = std::fs::remove_file(&tmp).err();
                if let Some(cleanup_err) = cleanup_err {
                    tracing::warn!(
                        path = %tmp.display(),
                        err = %cleanup_err,
                        "klodi_secret_write_cleanup_failed",
                    );
                }
                return Err(SecretWriteError::Replace {
                    tmp,
                    target: target.to_path_buf(),
                    source: err,
                });
            }
            Ok(())
        }
        Err(err) => {
            // Scrub the temp on any failure so an attacker can't read a
            // half-written secret.
            if let Some(cleanup_err) = std::fs::remove_file(&tmp).err() {
                if cleanup_err.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        path = %tmp.display(),
                        err = %cleanup_err,
                        "klodi_secret_write_cleanup_failed",
                    );
                }
            }
            Err(err)
        }
    }
}

fn write_inner(tmp: &Path, body: &[u8], mode: u32) -> Result<(), SecretWriteError> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        opts.mode(mode);
    }

    let mut file = opts.open(tmp).map_err(|err| SecretWriteError::Open {
        path: tmp.to_path_buf(),
        source: err,
    })?;
    file.write_all(body).map_err(|err| SecretWriteError::Write {
        path: tmp.to_path_buf(),
        source: err,
    })?;
    file.sync_all().map_err(|err| SecretWriteError::Sync {
        path: tmp.to_path_buf(),
        source: err,
    })?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(mode);
        std::fs::set_permissions(tmp, perms).map_err(|err| SecretWriteError::Chmod {
            path: tmp.to_path_buf(),
            mode,
            source: err,
        })?;
    }
    let _ = mode; // silence unused-warning on non-unix targets
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "klodi-secret-write-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn first_write_lands_at_default_mode() {
        let dir = unique_dir("first");
        let target = dir.join("nats.creds");

        klodi_secret_write(&target, b"creds", DEFAULT_MODE).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"creds");
        assert_eq!(mode_of(&target), DEFAULT_MODE);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn overwrites_existing_file_atomically() {
        let dir = unique_dir("overwrite");
        let target = dir.join("nats.creds");

        // Leave a prior file at a too-permissive mode, simulating a
        // failed pre-helper register.
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        klodi_secret_write(&target, b"new", DEFAULT_MODE).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(mode_of(&target), DEFAULT_MODE);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explicit_mode_argument_is_honored() {
        let dir = unique_dir("mode");
        let target = dir.join("config.json");

        klodi_secret_write(&target, b"{}", 0o640).unwrap();

        assert_eq!(mode_of(&target), 0o640);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leftover_temp_is_replaced() {
        let dir = unique_dir("leftover");
        let target = dir.join("nats.creds");
        let tmp = temp_sibling(&target);

        // Plant a leftover .tmp from a hypothetical prior crash.
        fs::write(&tmp, b"stale").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(DEFAULT_MODE)).unwrap();

        klodi_secret_write(&target, b"fresh", DEFAULT_MODE).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"fresh");
        assert_eq!(mode_of(&target), DEFAULT_MODE);
        assert!(!tmp.exists(), "stale .tmp should be gone after success");
        fs::remove_dir_all(dir).unwrap();
    }
}
