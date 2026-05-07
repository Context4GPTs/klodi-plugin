//! Sell- and buy-file I/O.
//!
//! Sell files (`${KLODI_HOME}/sell/<slug>.md`) are the seller-local
//! policy + dialogue digest for an active listing. They carry the floor
//! price (`min_acceptable_price`), an optional auto-reject threshold,
//! the linked transaction id once an offer has been accepted, and a
//! freeform body the agent appends to during negotiation.
//!
//! Buy files (`${KLODI_HOME}/buy/<slug>.md`) mirror standing-search
//! configuration. Created by `klodi_watch persist=true`, removed by
//! `klodi_unwatch`. Pure on-disk policy + dialogue digest — no cron
//! state, no client-side dedup.
//!
//! Both file types use a flat YAML frontmatter — every value is a scalar
//! (string, integer, or `null`) except `delivery`, which is stored as a
//! JSON-encoded object on a single line so nested shapes round-trip
//! losslessly without a full YAML parser.
//!
//! Mirrors `klodi-plugin/adapters/openclaw/src/lib/sell-buy-files.ts`.
//! Both hosts read and write the same on-disk format so a user moving
//! between Claude Code (openclaw) and a Rust host (ironclaw / moltis /
//! zeroclaw) sees identical policy state.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

use crate::paths;

/// Per-listing strategy file shape. Floor price MUST stay on disk only —
/// see ADR-0005 / SECURITY.md guarantee that the floor never tracks
/// the public `asking_price`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SellFile {
    pub listing_id: String,
    pub min_acceptable_price: Option<i64>,
    pub auto_reject_below: Option<i64>,
    pub transaction_id: Option<String>,
    pub slug: String,
    /// Freeform markdown content below frontmatter.
    pub body: String,
}

/// `notify` surfaces the match to the user; `negotiate` lets the agent
/// open a channel and engage per `negotiation_style.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOnMatch {
    Notify,
    Negotiate,
}

impl ActionOnMatch {
    fn as_str(self) -> &'static str {
        match self {
            ActionOnMatch::Notify => "notify",
            ActionOnMatch::Negotiate => "negotiate",
        }
    }

    fn parse(raw: &str, slug: &str) -> Result<Self> {
        match raw {
            "notify" => Ok(Self::Notify),
            "negotiate" => Ok(Self::Negotiate),
            other => anyhow::bail!(
                r#"invalid action_on_match in buy/{slug}.md: "{other}". Must be "notify" or "negotiate"."#,
            ),
        }
    }
}

/// Per-standing-search strategy file shape. Mirrors openclaw's `BuyFile`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuyFile {
    pub query: String,
    pub max_price: Option<i64>,
    pub target_price: Option<i64>,
    /// Stored on disk as a JSON object on a single frontmatter line.
    /// Kept opaque here — the marketplace owns the validation contract.
    pub delivery: Value,
    pub action_on_match: ActionOnMatch,
    pub slug: String,
    pub body: String,
}

// ─── Frontmatter primitives ───────────────────────────────────────────

struct Frontmatter {
    meta: Vec<(String, String)>,
    body: String,
}

/// Parse `--- ... ---` flat scalar frontmatter. Tolerates absent
/// frontmatter (returns empty meta + the whole content as body), CRLF
/// line endings, and whitespace around the `:` separator.
fn parse_frontmatter(content: &str) -> Frontmatter {
    let normalized = content.replace("\r\n", "\n");
    let trimmed = normalized.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---\n") else {
        return Frontmatter {
            meta: Vec::new(),
            body: trimmed.trim().to_string(),
        };
    };
    let Some(end_idx) = rest.find("\n---") else {
        return Frontmatter {
            meta: Vec::new(),
            body: trimmed.trim().to_string(),
        };
    };
    let header = &rest[..end_idx];
    let body_start = end_idx + "\n---".len();
    let body = rest[body_start..]
        .trim_start_matches('\n')
        .trim()
        .to_string();

    let mut meta: Vec<(String, String)> = Vec::new();
    for line in header.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            meta.push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    Frontmatter { meta, body }
}

fn build_frontmatter(meta: &[(&str, FmValue<'_>)], body: &str) -> String {
    let mut out = String::from("---\n");
    for (key, value) in meta {
        match value {
            FmValue::Str(s) => out.push_str(&format!("{key}: {s}\n")),
            FmValue::IntOrNull(None) => out.push_str(&format!("{key}: null\n")),
            FmValue::IntOrNull(Some(n)) => out.push_str(&format!("{key}: {n}\n")),
            FmValue::OptStr(None) => out.push_str(&format!("{key}: null\n")),
            FmValue::OptStr(Some(s)) => out.push_str(&format!("{key}: {s}\n")),
            FmValue::Json(v) => {
                let encoded = serde_json::to_string(v).unwrap_or_else(|_| "null".to_string());
                out.push_str(&format!("{key}: {encoded}\n"));
            }
        }
    }
    out.push_str("---");
    if !body.is_empty() {
        out.push_str("\n\n");
        out.push_str(body);
    }
    out.push('\n');
    out
}

enum FmValue<'a> {
    Str(&'a str),
    IntOrNull(Option<i64>),
    OptStr(Option<&'a str>),
    Json(&'a Value),
}

fn meta_get<'a>(meta: &'a [(String, String)], key: &str) -> Option<&'a str> {
    meta.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn parse_int_or_null(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    if raw == "null" || raw.is_empty() {
        return None;
    }
    raw.parse::<i64>().ok()
}

fn parse_opt_string(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw == "null" || raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

// ─── Sell files ───────────────────────────────────────────────────────

pub fn read_sell_file(slug: &str) -> Result<Option<SellFile>> {
    read_sell_file_at(&paths::sell_file_path(slug), slug)
}

pub fn read_sell_file_at(path: &Path, slug: &str) -> Result<Option<SellFile>> {
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let fm = parse_frontmatter(&content);
    Ok(Some(SellFile {
        listing_id: meta_get(&fm.meta, "listing_id")
            .unwrap_or("")
            .to_string(),
        min_acceptable_price: parse_int_or_null(meta_get(&fm.meta, "min_acceptable_price")),
        auto_reject_below: parse_int_or_null(meta_get(&fm.meta, "auto_reject_below")),
        transaction_id: parse_opt_string(meta_get(&fm.meta, "transaction_id")),
        slug: slug.to_string(),
        body: fm.body,
    }))
}

pub fn write_sell_file(file: &SellFile) -> Result<()> {
    write_sell_file_at(&paths::sell_dir(), file)
}

pub fn write_sell_file_at(sell_dir: &Path, file: &SellFile) -> Result<()> {
    std::fs::create_dir_all(sell_dir)
        .with_context(|| format!("creating {}", sell_dir.display()))?;
    let content = build_frontmatter(
        &[
            ("listing_id", FmValue::Str(&file.listing_id)),
            ("min_acceptable_price", FmValue::IntOrNull(file.min_acceptable_price)),
            ("auto_reject_below", FmValue::IntOrNull(file.auto_reject_below)),
            ("transaction_id", FmValue::OptStr(file.transaction_id.as_deref())),
        ],
        &file.body,
    );
    let target = sell_dir.join(format!("{}.md", file.slug));
    std::fs::write(&target, content)
        .with_context(|| format!("writing {}", target.display()))?;
    Ok(())
}

pub fn delete_sell_file(slug: &str) -> Result<bool> {
    delete_sell_file_at(&paths::sell_file_path(slug))
}

pub fn delete_sell_file_at(path: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(path)
        .with_context(|| format!("removing {}", path.display()))?;
    Ok(true)
}

// ─── Buy files ────────────────────────────────────────────────────────

pub fn read_buy_file(slug: &str) -> Result<Option<BuyFile>> {
    read_buy_file_at(&paths::buy_file_path(slug), slug)
}

pub fn read_buy_file_at(path: &Path, slug: &str) -> Result<Option<BuyFile>> {
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let fm = parse_frontmatter(&content);
    let delivery = match meta_get(&fm.meta, "delivery") {
        None | Some("") | Some("null") => serde_json::json!({ "method": "any" }),
        Some(raw) => serde_json::from_str::<Value>(raw).with_context(|| {
            format!(
                r#"invalid delivery in buy/{slug}.md: "{raw}". Must be a JSON object."#,
            )
        })?,
    };
    let action_on_match = match meta_get(&fm.meta, "action_on_match") {
        None => ActionOnMatch::Notify,
        Some(raw) => ActionOnMatch::parse(raw, slug)?,
    };
    Ok(Some(BuyFile {
        query: meta_get(&fm.meta, "query").unwrap_or("").to_string(),
        max_price: parse_int_or_null(meta_get(&fm.meta, "max_price")),
        target_price: parse_int_or_null(meta_get(&fm.meta, "target_price")),
        delivery,
        action_on_match,
        slug: slug.to_string(),
        body: fm.body,
    }))
}

pub fn write_buy_file(file: &BuyFile) -> Result<()> {
    write_buy_file_at(&paths::buy_dir(), file)
}

pub fn write_buy_file_at(buy_dir: &Path, file: &BuyFile) -> Result<()> {
    std::fs::create_dir_all(buy_dir)
        .with_context(|| format!("creating {}", buy_dir.display()))?;
    let action = file.action_on_match.as_str();
    let content = build_frontmatter(
        &[
            ("query", FmValue::Str(&file.query)),
            ("max_price", FmValue::IntOrNull(file.max_price)),
            ("target_price", FmValue::IntOrNull(file.target_price)),
            ("delivery", FmValue::Json(&file.delivery)),
            ("action_on_match", FmValue::Str(action)),
        ],
        &file.body,
    );
    let target = buy_dir.join(format!("{}.md", file.slug));
    std::fs::write(&target, content)
        .with_context(|| format!("writing {}", target.display()))?;
    Ok(())
}

pub fn delete_buy_file(slug: &str) -> Result<bool> {
    delete_buy_file_at(&paths::buy_file_path(slug))
}

pub fn delete_buy_file_at(path: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(path)
        .with_context(|| format!("removing {}", path.display()))?;
    Ok(true)
}

// ─── Slugify ──────────────────────────────────────────────────────────

/// Generate a URL-safe slug from a title + an opaque id suffix.
/// Mirrors openclaw's `slugify`: lowercase, ASCII alnum only, collapse
/// runs of non-alnum to a single `-`, trim leading/trailing dashes,
/// cap base at 53 chars, append a 6-char id suffix.
pub fn slugify(title: &str, id_suffix: &str) -> String {
    let mut base = String::with_capacity(title.len());
    let mut last_was_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            for c in ch.to_lowercase() {
                base.push(c);
            }
            last_was_dash = false;
        } else if !last_was_dash {
            base.push('-');
            last_was_dash = true;
        }
    }
    while base.ends_with('-') {
        base.pop();
    }
    if base.len() > 53 {
        base.truncate(53);
        while base.ends_with('-') {
            base.pop();
        }
    }
    let suffix: String = id_suffix.chars().take(6).collect();
    if base.is_empty() {
        suffix
    } else {
        format!("{base}-{suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sell_round_trip_preserves_fields_and_body() {
        let dir = tempdir().unwrap();
        let original = SellFile {
            listing_id: "9c5f12-…".to_string(),
            min_acceptable_price: Some(6000),
            auto_reject_below: Some(5500),
            transaction_id: None,
            slug: "kindle-paperwhite-9c5f12".to_string(),
            body: "## Open Questions\n- [ ] @mike (2026-05-06): pickup time?".to_string(),
        };
        write_sell_file_at(dir.path(), &original).unwrap();
        let path = dir.path().join("kindle-paperwhite-9c5f12.md");
        let parsed = read_sell_file_at(&path, &original.slug).unwrap().unwrap();
        assert_eq!(parsed.listing_id, original.listing_id);
        assert_eq!(parsed.min_acceptable_price, original.min_acceptable_price);
        assert_eq!(parsed.auto_reject_below, original.auto_reject_below);
        assert_eq!(parsed.transaction_id, original.transaction_id);
        assert_eq!(parsed.body, original.body);
    }

    #[test]
    fn buy_round_trip_preserves_delivery_object() {
        let dir = tempdir().unwrap();
        let original = BuyFile {
            query: "gaming laptop".to_string(),
            max_price: Some(80000),
            target_price: Some(60000),
            delivery: serde_json::json!({ "method": "pickup", "radiusKm": 25 }),
            action_on_match: ActionOnMatch::Negotiate,
            slug: "gaming-laptop-abc123".to_string(),
            body: String::new(),
        };
        write_buy_file_at(dir.path(), &original).unwrap();
        let path = dir.path().join("gaming-laptop-abc123.md");
        let parsed = read_buy_file_at(&path, &original.slug).unwrap().unwrap();
        assert_eq!(parsed.query, original.query);
        assert_eq!(parsed.max_price, original.max_price);
        assert_eq!(parsed.target_price, original.target_price);
        assert_eq!(parsed.delivery, original.delivery);
        assert_eq!(parsed.action_on_match, original.action_on_match);
    }

    #[test]
    fn buy_default_delivery_is_any() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("plain.md"),
            "---\nquery: test\nmax_price: null\ntarget_price: null\naction_on_match: notify\n---\n",
        )
        .unwrap();
        let parsed = read_buy_file_at(&dir.path().join("plain.md"), "plain")
            .unwrap()
            .unwrap();
        assert_eq!(parsed.delivery, serde_json::json!({ "method": "any" }));
        assert_eq!(parsed.action_on_match, ActionOnMatch::Notify);
    }

    #[test]
    fn buy_invalid_action_on_match_errors() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("bad.md"),
            "---\nquery: x\nmax_price: null\ntarget_price: null\ndelivery: {\"method\":\"any\"}\naction_on_match: shrug\n---\n",
        )
        .unwrap();
        let err = read_buy_file_at(&dir.path().join("bad.md"), "bad").unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("action_on_match"), "got: {msg}");
    }

    #[test]
    fn delete_returns_false_when_file_absent() {
        let dir = tempdir().unwrap();
        let removed =
            delete_buy_file_at(&dir.path().join("nope.md")).unwrap();
        assert!(!removed);
    }

    #[test]
    fn slugify_collapses_punctuation_and_caps_length() {
        let slug = slugify("Vintage Lamp!! 1920", "abc123-deadbeef");
        assert_eq!(slug, "vintage-lamp-1920-abc123");

        assert_eq!(slugify("---hello---", "ffffff"), "hello-ffffff");

        let long = "a".repeat(80);
        let slug = slugify(&long, "abcdef");
        assert!(slug.len() <= 53 + 1 + 6);
        assert!(slug.starts_with(&"a".repeat(53)));
        assert!(slug.ends_with("-abcdef"));

        assert_eq!(
            slugify("Hello!!!  World???", "zzzzzz"),
            "hello-world-zzzzzz",
        );
    }

    #[test]
    fn slugify_empty_title_falls_back_to_suffix_only() {
        assert_eq!(slugify("---", "ffffff"), "ffffff");
        assert_eq!(slugify("", "abc123"), "abc123");
    }
}
