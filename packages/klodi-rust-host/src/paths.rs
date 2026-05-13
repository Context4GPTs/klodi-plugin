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

/// `${KLODI_HOME}/negotiation_style.md` — operator-authored pricing,
/// posture, and counter-offer ladder. The plugin no longer seeds this
/// file; the operator writes it themselves and the wake prompt points
/// the spawned agent at it.
pub fn negotiation_style_path() -> PathBuf {
    klodi_home().join("negotiation_style.md")
}

/// `${KLODI_HOME}/buy/` — per-standing-search strategy files written by
/// `klodi_watch` and removed by `klodi_unwatch`.
pub fn buy_dir() -> PathBuf {
    klodi_home().join("buy")
}

/// `${KLODI_HOME}/sell/` — per-listing strategy files (floor price,
/// auto-reject threshold, dialogue digest). Written as side-effects of
/// listing-lifecycle tools.
pub fn sell_dir() -> PathBuf {
    klodi_home().join("sell")
}

/// `${KLODI_HOME}/buy/<slug>.md` for a given standing-search slug.
pub fn buy_file_path(slug: &str) -> PathBuf {
    buy_dir().join(format!("{slug}.md"))
}

/// `${KLODI_HOME}/sell/<slug>.md` for a given listing slug.
pub fn sell_file_path(slug: &str) -> PathBuf {
    sell_dir().join(format!("{slug}.md"))
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
    use std::sync::Mutex;

    // KLODI_HOME is process-global. Cargo runs tests in parallel by
    // default, so two tests that both swap-and-restore the env var
    // racily clobber each other's writes. Serialize them by acquiring
    // this mutex for the whole swap → assert → restore window.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_klodi_home<F: FnOnce()>(value: &str, body: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let prior = std::env::var("KLODI_HOME").ok();
        // SAFETY: mutex above serializes every test that touches
        // KLODI_HOME within this process, and no production code in
        // klodi-rust-host spawns threads that read env during tests.
        unsafe {
            std::env::set_var("KLODI_HOME", value);
        }
        body();
        // SAFETY: see set_var above.
        unsafe {
            match prior {
                Some(v) => std::env::set_var("KLODI_HOME", v),
                None => std::env::remove_var("KLODI_HOME"),
            }
        }
    }

    #[test]
    fn klodi_home_honors_env_override() {
        with_klodi_home("/tmp/klodi-home-override-test", || {
            assert_eq!(klodi_home(), PathBuf::from("/tmp/klodi-home-override-test"));
        });
    }

    #[test]
    fn config_path_appends_filename() {
        with_klodi_home("/tmp/klodi-home-config-test", || {
            assert_eq!(
                config_path(),
                PathBuf::from("/tmp/klodi-home-config-test/config.json")
            );
            assert_eq!(
                creds_path(),
                PathBuf::from("/tmp/klodi-home-config-test/nats.creds")
            );
            assert_eq!(
                negotiation_style_path(),
                PathBuf::from("/tmp/klodi-home-config-test/negotiation_style.md")
            );
            assert_eq!(
                buy_dir(),
                PathBuf::from("/tmp/klodi-home-config-test/buy")
            );
            assert_eq!(
                sell_dir(),
                PathBuf::from("/tmp/klodi-home-config-test/sell")
            );
            assert_eq!(
                buy_file_path("gaming-laptop-abc123"),
                PathBuf::from(
                    "/tmp/klodi-home-config-test/buy/gaming-laptop-abc123.md",
                )
            );
            assert_eq!(
                sell_file_path("kindle-paperwhite-9c5f12"),
                PathBuf::from(
                    "/tmp/klodi-home-config-test/sell/kindle-paperwhite-9c5f12.md",
                )
            );
        });
    }
}
