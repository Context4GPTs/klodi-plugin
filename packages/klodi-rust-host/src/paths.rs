//! Default `${KLODI_HOME}` resolution.
//!
//! Honors `$KLODI_HOME` first, then falls back to the platform-canonical
//! per-user app-config directory. Caller decides whether to create the
//! directory and whether to chmod 0700.
//!
//! Hoisted from the per-adapter `default_paths.rs` files — there were
//! three identical copies across Moltis / IronClaw / ZeroClaw with no
//! genuine code differences (only doc comments). Closes P2-14 (Rust).

use std::path::PathBuf;

/// Resolve the active `${KLODI_HOME}`. Honors `$KLODI_HOME` first, then
/// platform conventions:
///
/// | Platform | Default |
/// |----------|---------|
/// | macOS    | `$HOME/Library/Application Support/klodi` |
/// | Linux    | `${XDG_CONFIG_HOME:-$HOME/.config}/klodi` |
/// | Windows  | `${APPDATA:-$HOME/AppData/Roaming}/klodi` |
///
/// Caller decides whether to create the directory.
pub fn klodi_home() -> PathBuf {
    if let Ok(env) = std::env::var("KLODI_HOME") {
        return PathBuf::from(env);
    }
    #[cfg(target_os = "macos")]
    {
        home()
            .join("Library")
            .join("Application Support")
            .join("klodi")
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("klodi");
        }
        return home().join("AppData").join("Roaming").join("klodi");
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return PathBuf::from(xdg).join("klodi");
        }
        home().join(".config").join("klodi")
    }
}

/// `${KLODI_HOME}/config.json` — written by the registration flow.
pub fn config_path() -> PathBuf {
    klodi_home().join("config.json")
}

/// `${KLODI_HOME}/nats.creds` — written by the registration flow.
pub fn creds_path() -> PathBuf {
    klodi_home().join("nats.creds")
}

fn home() -> PathBuf {
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h);
    }
    #[cfg(target_os = "windows")]
    if let Ok(h) = std::env::var("USERPROFILE") {
        return PathBuf::from(h);
    }
    PathBuf::from("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn klodi_home_honors_env_override() {
        // SAFETY: tests are run sequentially per-process by cargo test; the
        // env-var swap-and-restore pattern is the standard way to test
        // env-driven path resolution and matches `nats-client-rs` and the
        // adapters' previous test files.
        let prior = std::env::var("KLODI_HOME").ok();
        // SAFETY: see test comment above.
        unsafe {
            std::env::set_var("KLODI_HOME", "/tmp/klodi-home-override-test");
        }
        let home = klodi_home();
        assert_eq!(home, PathBuf::from("/tmp/klodi-home-override-test"));
        // SAFETY: see test comment above.
        unsafe {
            match prior {
                Some(value) => std::env::set_var("KLODI_HOME", value),
                None => std::env::remove_var("KLODI_HOME"),
            }
        }
    }

    #[test]
    fn config_path_appends_filename() {
        let prior = std::env::var("KLODI_HOME").ok();
        // SAFETY: see klodi_home_honors_env_override().
        unsafe {
            std::env::set_var("KLODI_HOME", "/tmp/klodi-home-config-test");
        }
        assert_eq!(
            config_path(),
            PathBuf::from("/tmp/klodi-home-config-test/config.json")
        );
        assert_eq!(
            creds_path(),
            PathBuf::from("/tmp/klodi-home-config-test/nats.creds")
        );
        // SAFETY: see klodi_home_honors_env_override().
        unsafe {
            match prior {
                Some(value) => std::env::set_var("KLODI_HOME", value),
                None => std::env::remove_var("KLODI_HOME"),
            }
        }
    }
}
