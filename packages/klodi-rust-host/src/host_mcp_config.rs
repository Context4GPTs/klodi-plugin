//! Idempotent host `config.toml` writer for the klodi MCP server entry.
//!
//! ZeroClaw, Moltis, and IronClaw all share the same `[[mcp.servers]]`
//! shape: each table tells the host to spawn the named subprocess as an
//! MCP server, list its tools, and surface those tools to the agent
//! under `<name>__<tool>` (so klodi tools surface as `klodi__klodi_list_create`,
//! etc.). Only the file path and the binary name vary per host —
//! everything else is shared, which is why this writer is host-agnostic.
//!
//! The registration flow calls [`apply_host_mcp_entry`] once at the end,
//! after `nats.creds` + `config.json` are persisted. The function is
//! idempotent: re-running registration after an upgrade either no-ops
//! (block already present and matches) or replaces only the `klodi`
//! entry without touching unrelated `[[mcp.servers]]` blocks.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, Value, value};

const SERVER_NAME: &str = "klodi";
const TRANSPORT_STDIO: &str = "stdio";

/// Inputs the writer needs from the registration flow.
pub struct HostMcpEntry {
    /// Path to the host config — typically `~/.<host>/config.toml`.
    pub config_path: PathBuf,
    /// `command` field — the binary the host spawns. Per-adapter:
    /// `klodi-zeroclaw-mcp`, `klodi-moltis-mcp`, `klodi-ironclaw-mcp`.
    pub command: String,
    /// `${KLODI_HOME}` to pass through as an env var so the spawned MCP
    /// server reads creds + config from the right place.
    pub klodi_home: PathBuf,
}

/// Insert (or replace) the `[[mcp.servers]]` entry whose `name = "klodi"`
/// in `config.toml`. Creates the file and parent dir if missing. Leaves
/// every other section untouched.
pub fn apply_host_mcp_entry(entry: &HostMcpEntry) -> Result<()> {
    if let Some(parent) = entry.config_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    let body = if entry.config_path.exists() {
        std::fs::read_to_string(&entry.config_path)
            .with_context(|| format!("reading {}", entry.config_path.display()))?
    } else {
        String::new()
    };

    let mut doc: DocumentMut = body
        .parse()
        .with_context(|| format!("{} is not valid TOML", entry.config_path.display()))?;

    upsert_klodi_server(&mut doc, entry)?;

    std::fs::write(&entry.config_path, doc.to_string())
        .with_context(|| format!("writing {}", entry.config_path.display()))?;

    Ok(())
}

fn upsert_klodi_server(doc: &mut DocumentMut, entry: &HostMcpEntry) -> Result<()> {
    let mcp = doc
        .entry("mcp")
        .or_insert_with(|| Item::Table(Table::new()));
    if !mcp.is_table() {
        bail!("[mcp] exists in config.toml but isn't a table");
    }
    let mcp_tbl = mcp.as_table_mut().expect("checked by is_table above");
    if mcp_tbl.get("enabled").is_none() {
        mcp_tbl.insert("enabled", value(true));
    }

    let servers_item = mcp_tbl
        .entry("servers")
        .or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new()));

    let target = build_klodi_server_table(entry);

    let arr = servers_item.as_array_of_tables_mut().ok_or_else(|| {
        anyhow::anyhow!(
            "[[mcp.servers]] exists but isn't an array-of-tables — refusing to overwrite"
        )
    })?;

    let existing_idx = arr
        .iter()
        .position(|t| t.get("name").and_then(Item::as_str) == Some(SERVER_NAME));
    match existing_idx {
        Some(idx) => *arr.get_mut(idx).expect("idx in bounds") = target,
        None => arr.push(target),
    }
    Ok(())
}

fn build_klodi_server_table(entry: &HostMcpEntry) -> Table {
    let mut table = Table::new();
    table.insert("name", value(SERVER_NAME));
    table.insert("transport", value(TRANSPORT_STDIO));
    table.insert("command", value(entry.command.clone()));

    let mut env = toml_edit::InlineTable::new();
    let home_str = entry.klodi_home.display().to_string();
    env.insert("KLODI_HOME", Value::from(home_str));
    table.insert("env", Item::Value(Value::InlineTable(env)));
    table
}

/// Resolve the host's default `config.toml` path.
///
/// The lookup is `${HOST}_CONFIG` env var first, then
/// `$HOME/.${host_lower}/config.toml`. `host_lower` is what shows up in
/// the home-directory name (e.g. `zeroclaw`, `moltis`, `ironclaw`); the
/// env var is the same string upper-cased.
pub fn default_host_config_path(host_lower: &str) -> PathBuf {
    let env_key = format!("{}_CONFIG", host_lower.to_ascii_uppercase());
    if let Ok(p) = std::env::var(&env_key) {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    home.join(format!(".{host_lower}")).join("config.toml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    fn fresh_entry(dir: &Path, klodi_home: &Path) -> HostMcpEntry {
        HostMcpEntry {
            config_path: dir.join("config.toml"),
            command: "klodi-zeroclaw-mcp".into(),
            klodi_home: klodi_home.to_path_buf(),
        }
    }

    #[test]
    fn applies_to_empty_config() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("klodi-home");
        let entry = fresh_entry(dir.path(), &home);

        apply_host_mcp_entry(&entry).expect("apply");

        let body = std::fs::read_to_string(&entry.config_path).unwrap();
        assert!(body.contains("[mcp]"));
        assert!(body.contains("enabled = true"));
        assert!(body.contains("[[mcp.servers]]"));
        assert!(body.contains("name = \"klodi\""));
        assert!(body.contains("command = \"klodi-zeroclaw-mcp\""));
        assert!(body.contains("KLODI_HOME"));
    }

    #[test]
    fn is_idempotent_when_re_applied() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("klodi-home");
        let entry = fresh_entry(dir.path(), &home);

        apply_host_mcp_entry(&entry).unwrap();
        let first = std::fs::read_to_string(&entry.config_path).unwrap();

        apply_host_mcp_entry(&entry).unwrap();
        let second = std::fs::read_to_string(&entry.config_path).unwrap();

        assert_eq!(first, second, "second apply must be a no-op");
    }

    #[test]
    fn replaces_only_klodi_block_when_other_servers_exist() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("klodi-home");
        let cfg = dir.path().join("config.toml");
        std::fs::write(
            &cfg,
            r#"
[autonomy]
auto_approve = ["read_*"]

[mcp]
enabled = true

[[mcp.servers]]
name = "weather"
transport = "stdio"
command = "weather-mcp"

[[mcp.servers]]
name = "klodi"
transport = "stdio"
command = "old-klodi-binary"
"#,
        )
        .unwrap();

        let entry = HostMcpEntry {
            config_path: cfg.clone(),
            command: "klodi-zeroclaw-mcp".into(),
            klodi_home: home.clone(),
        };
        apply_host_mcp_entry(&entry).unwrap();

        let body = std::fs::read_to_string(&cfg).unwrap();
        assert!(body.contains("name = \"weather\""), "weather block preserved");
        assert!(
            body.contains("command = \"klodi-zeroclaw-mcp\""),
            "klodi block updated to new command",
        );
        assert!(
            !body.contains("old-klodi-binary"),
            "old klodi command must be replaced",
        );
        assert!(
            body.contains("auto_approve = [\"read_*\"]"),
            "[autonomy] section preserved",
        );
    }

    #[test]
    fn rejects_invalid_existing_toml() {
        let dir = tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        std::fs::write(&cfg, "[mcp\nenabled = true\n").unwrap();
        let entry = HostMcpEntry {
            config_path: cfg,
            command: "klodi-zeroclaw-mcp".into(),
            klodi_home: dir.path().to_path_buf(),
        };
        assert!(apply_host_mcp_entry(&entry).is_err());
    }

    #[test]
    fn default_path_honors_env_var() {
        let prior = std::env::var("MOLTIS_CONFIG").ok();
        // SAFETY: tests run sequentially per-process; the swap-and-restore
        // pattern matches the existing tests in `paths.rs`.
        unsafe {
            std::env::set_var("MOLTIS_CONFIG", "/tmp/custom-moltis.toml");
        }
        assert_eq!(
            default_host_config_path("moltis"),
            PathBuf::from("/tmp/custom-moltis.toml"),
        );
        unsafe {
            match prior {
                Some(v) => std::env::set_var("MOLTIS_CONFIG", v),
                None => std::env::remove_var("MOLTIS_CONFIG"),
            }
        }
    }

    #[test]
    fn default_path_falls_back_to_home_dotdir() {
        let prior_cfg = std::env::var("IRONCLAW_CONFIG").ok();
        let prior_home = std::env::var("HOME").ok();
        // SAFETY: see default_path_honors_env_var.
        unsafe {
            std::env::remove_var("IRONCLAW_CONFIG");
            std::env::set_var("HOME", "/tmp/fake-home");
        }
        assert_eq!(
            default_host_config_path("ironclaw"),
            PathBuf::from("/tmp/fake-home/.ironclaw/config.toml"),
        );
        unsafe {
            match prior_cfg {
                Some(v) => std::env::set_var("IRONCLAW_CONFIG", v),
                None => std::env::remove_var("IRONCLAW_CONFIG"),
            }
            match prior_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}
