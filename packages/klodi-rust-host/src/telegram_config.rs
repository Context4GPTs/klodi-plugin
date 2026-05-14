//! Telegram pairing artifacts under `${KLODI_HOME}`.
//!
//! Three files, all atomic via `klodi_secret_write`:
//!
//! - `telegram.json` — `{bot_token, chat_id, bot_username, paired_at}`.
//!   The bot token is the per-operator secret. Mode 0600.
//! - `telegram.offset.json` — `{last_acked_update_id}`. Persisted offset
//!   for `getUpdates` long-poll so the daemon doesn't reprocess events
//!   after a restart.
//! - `telegram.last-send.json` — `{ts}`. Sidecar written on every
//!   successful `sendMessage`. Surfaced by `klodi_setup_status` for
//!   "did the daemon recently send anything?" debugging.

use anyhow::{Context, Result, bail};
use klodi_nats_client::klodi_secret_write;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_id: i64,
    #[serde(default)]
    pub bot_username: Option<String>,
    #[serde(default)]
    pub paired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TelegramOffset {
    pub last_acked_update_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramLastSend {
    pub ts: String,
}

pub fn config_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("telegram.json")
}

pub fn offset_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("telegram.offset.json")
}

pub fn last_send_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("telegram.last-send.json")
}

/// Read `${KLODI_HOME}/telegram.json`. Returns `Ok(None)` when absent.
pub fn read_config(klodi_home: &Path) -> Result<Option<TelegramConfig>> {
    let path = config_path(klodi_home);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    let parsed: TelegramConfig = serde_json::from_slice(&bytes)
        .with_context(|| format!("decoding {}", path.display()))?;
    Ok(Some(parsed))
}

/// Atomic write of `${KLODI_HOME}/telegram.json` at mode 0600.
pub fn write_config(klodi_home: &Path, cfg: &TelegramConfig) -> Result<()> {
    if cfg.bot_token.is_empty() {
        bail!("refusing to persist telegram.json with empty bot_token");
    }
    std::fs::create_dir_all(klodi_home)
        .with_context(|| format!("creating {}", klodi_home.display()))?;
    let body = serde_json::to_vec_pretty(cfg).context("encoding telegram.json")?;
    klodi_secret_write(&config_path(klodi_home), &body, 0o600)
        .with_context(|| format!("klodi_secret_write {}", config_path(klodi_home).display()))
}

/// Read the persisted `getUpdates` offset. Returns the default (offset
/// 0 → unread tail) when the file is absent.
pub fn read_offset(klodi_home: &Path) -> Result<TelegramOffset> {
    let path = offset_path(klodi_home);
    if !path.is_file() {
        return Ok(TelegramOffset::default());
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(TelegramOffset::default());
    }
    serde_json::from_slice(&bytes)
        .with_context(|| format!("decoding {}", path.display()))
}

/// Atomic write of the offset file. Mode 0644 — the value is not
/// sensitive; 0644 matches the openness of `config.json`.
pub fn write_offset(klodi_home: &Path, offset: &TelegramOffset) -> Result<()> {
    std::fs::create_dir_all(klodi_home)
        .with_context(|| format!("creating {}", klodi_home.display()))?;
    let body = serde_json::to_vec(offset).context("encoding telegram.offset.json")?;
    klodi_secret_write(&offset_path(klodi_home), &body, 0o644)
        .with_context(|| format!("klodi_secret_write {}", offset_path(klodi_home).display()))
}

/// Write the sidecar `telegram.last-send.json` so `setup_status` can
/// surface the most recent successful sendMessage timestamp.
pub fn write_last_send(klodi_home: &Path, ts: &str) -> Result<()> {
    std::fs::create_dir_all(klodi_home)
        .with_context(|| format!("creating {}", klodi_home.display()))?;
    let body = serde_json::to_vec(&TelegramLastSend { ts: ts.to_string() })
        .context("encoding telegram.last-send.json")?;
    klodi_secret_write(&last_send_path(klodi_home), &body, 0o644).with_context(|| {
        format!(
            "klodi_secret_write {}",
            last_send_path(klodi_home).display(),
        )
    })
}

/// Read the sidecar. Returns `Ok(None)` when absent.
pub fn read_last_send(klodi_home: &Path) -> Result<Option<TelegramLastSend>> {
    let path = last_send_path(klodi_home);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    Ok(Some(
        serde_json::from_slice(&bytes)
            .with_context(|| format!("decoding {}", path.display()))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_config_returns_none_when_absent() {
        let dir = tempdir().unwrap();
        assert!(read_config(dir.path()).unwrap().is_none());
    }

    #[test]
    fn round_trip_config() {
        let dir = tempdir().unwrap();
        let cfg = TelegramConfig {
            bot_token: "8604287470:AAH-test".into(),
            chat_id: 8343881720,
            bot_username: Some("DemoKlodiBot".into()),
            paired_at: Some("2026-05-14T07:25:00Z".into()),
        };
        write_config(dir.path(), &cfg).unwrap();
        assert_eq!(read_config(dir.path()).unwrap().as_ref(), Some(&cfg));
    }

    #[test]
    fn write_refuses_empty_token() {
        let dir = tempdir().unwrap();
        let cfg = TelegramConfig {
            bot_token: "".into(),
            chat_id: 1,
            bot_username: None,
            paired_at: None,
        };
        assert!(write_config(dir.path(), &cfg).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn config_written_at_0600() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        let cfg = TelegramConfig {
            bot_token: "tok".into(),
            chat_id: 1,
            bot_username: None,
            paired_at: None,
        };
        write_config(dir.path(), &cfg).unwrap();
        let mode = std::fs::metadata(config_path(dir.path())).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn offset_round_trip() {
        let dir = tempdir().unwrap();
        assert_eq!(read_offset(dir.path()).unwrap(), TelegramOffset::default());
        write_offset(
            dir.path(),
            &TelegramOffset { last_acked_update_id: 99 },
        )
        .unwrap();
        assert_eq!(
            read_offset(dir.path()).unwrap(),
            TelegramOffset { last_acked_update_id: 99 },
        );
    }

    #[test]
    fn last_send_round_trip() {
        let dir = tempdir().unwrap();
        assert!(read_last_send(dir.path()).unwrap().is_none());
        write_last_send(dir.path(), "2026-05-14T07:33:00Z").unwrap();
        let got = read_last_send(dir.path()).unwrap().unwrap();
        assert_eq!(got.ts, "2026-05-14T07:33:00Z");
    }
}
