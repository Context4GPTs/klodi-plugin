//! Photo-resolution pipeline shared by klodi_list_create and
//! klodi_list_update for the Rust host crate.
//!
//! Mirror of `adapters/openclaw/src/tools/photos.ts` (TypeScript) and
//! `adapters/hermes/src/klodi_hermes/photos.py` (Python). Same
//! magic-number table, same stage tags, same canonical error envelope
//! shape. Cross-language parity is enforced by fixture parity (see the
//! per-adapter `tests/fixtures/photos/` directory).
//!
//! Each element of `args["photos"]` can be either:
//!
//!   * an `http(s)://` URL passed through verbatim at the same index, or
//!   * an absolute local filesystem path that the helper validates,
//!     content-sniffs, uploads via the existing `p2p.v1.assets.upload-url`
//!     NATS subject + R2 PUT, and substitutes with the returned
//!     `asset_url`.
//!
//! Order is preserved across substitutions. Mint is one NATS call per
//! listing call — if mint fails, no PUTs occur. PUTs run concurrently
//! via `tokio::join_all`; the resulting array is reassembled by index,
//! never by completion.
//!
//! Atomicity: any validation, sniff, mint, or PUT failure rejects the
//! entire batch with a `PhotoResolutionError` tagged with the stage
//! and the offending path. The listing call is never dispatched on
//! partial success. See ADR-0006.

use klodi_nats_client::KlodiClient;
use rmcp::ErrorData as McpError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::OnceLock;
use tokio::fs;

const UPLOAD_URL_SUBJECT: &str = "p2p.v1.assets.upload-url";
const MAX_PHOTOS_PER_LISTING: usize = 10;
const MAX_BYTES_PER_FILE: u64 = 10 * 1024 * 1024;

/// Static sensitive-directory prefixes (POSIX). The `$KLODI_HOME` and
/// `~/.ssh` prefixes are layered in dynamically at call time so
/// environment overrides propagate.
const STATIC_SENSITIVE_PREFIXES: &[&str] = &[
    "/etc/",
    "/var/run/",
    "/var/log/",
    "/proc/",
    "/sys/",
    "/root/",
];

/// Shared `reqwest::Client` used for the R2 PUTs. Built lazily on
/// first use; the host already pulls `reqwest` for the registration
/// HTTP poll so no new build cost.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Allowlisted content type. Source of truth lives in ADR-0006; the
/// magic-number table below is the cross-language parity contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AllowedContentType {
    Jpeg,
    Png,
    Webp,
}

impl AllowedContentType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
        }
    }

    /// Sniff the first bytes against the magic-number table. Returns
    /// `None` if no allowlisted type matches.
    fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
            return Some(Self::Jpeg);
        }
        if bytes.len() >= 8
            && bytes[0] == 0x89 && bytes[1] == 0x50
            && bytes[2] == 0x4E && bytes[3] == 0x47
            && bytes[4] == 0x0D && bytes[5] == 0x0A
            && bytes[6] == 0x1A && bytes[7] == 0x0A
        {
            return Some(Self::Png);
        }
        if bytes.len() >= 12
            && bytes[0] == 0x52 && bytes[1] == 0x49
            && bytes[2] == 0x46 && bytes[3] == 0x46
            && bytes[8] == 0x57 && bytes[9] == 0x45
            && bytes[10] == 0x42 && bytes[11] == 0x50
        {
            return Some(Self::Webp);
        }
        None
    }
}

/// Resolution / validation / upload failure. Stage values mirror the
/// TS + Python helpers: `absolute_path`, `missing`, `sensitive_dir`,
/// `size`, `content_type`, `mint`, `put`, `count`, `type`.
#[derive(Debug, Clone)]
pub struct PhotoResolutionError {
    pub message: String,
    pub stage: String,
    pub path: Option<String>,
}

impl PhotoResolutionError {
    fn new(message: impl Into<String>, stage: &str, path: Option<String>) -> Self {
        Self {
            message: message.into(),
            stage: stage.to_string(),
            path,
        }
    }

    /// Render as an `McpError` so the dispatcher can return one
    /// envelope shape regardless of the failure category.
    pub fn into_mcp_error(self) -> McpError {
        let details = json!({
            "error": self.stage,
            "message": self.message,
            "path": self.path,
        });
        McpError::invalid_request(self.message, Some(details))
    }
}

#[derive(Debug, Serialize)]
struct MintFile<'a> {
    filename: &'a str,
    content_type: &'a str,
    size: u64,
}

#[derive(Debug, Serialize)]
struct MintRequest<'a> {
    files: Vec<MintFile<'a>>,
}

#[derive(Debug, Deserialize)]
struct UploadPair {
    upload_url: String,
    asset_url: String,
}

#[derive(Debug, Deserialize)]
struct MintReply {
    uploads: Vec<UploadPair>,
}

/// Per-input element. Locals carry their resolved path, bytes, and
/// sniffed content type so the mint payload and the PUT both reuse
/// the same single read.
#[derive(Debug)]
enum Element {
    Url { index: usize, url: String },
    Local {
        index: usize,
        raw_path: String,
        real_path: String,
        data: Vec<u8>,
        content_type: AllowedContentType,
    },
}

impl Element {
    fn index(&self) -> usize {
        match self {
            Self::Url { index, .. } => *index,
            Self::Local { index, .. } => *index,
        }
    }
}

/// Resolve every local path in `photos` to an `asset_url`. Returns
/// the rewritten photos array, or `None` if the input was `None`
/// (no `photos` field on the listing call) so the caller can leave
/// the payload unchanged.
///
/// Idempotent on URL-only inputs: no NATS call, no PUT, no I/O of
/// any kind beyond the count check.
pub async fn resolve_photos(
    client: &KlodiClient,
    photos: Option<&Value>,
) -> Result<Option<Vec<String>>, PhotoResolutionError> {
    let Some(photos_value) = photos else {
        return Ok(None);
    };
    let Some(photos_arr) = photos_value.as_array() else {
        return Err(PhotoResolutionError::new(
            format!(
                "photos must be an array, got {}",
                value_type_name(photos_value)
            ),
            "type",
            None,
        ));
    };
    if photos_arr.is_empty() {
        return Ok(Some(Vec::new()));
    }

    if photos_arr.len() > MAX_PHOTOS_PER_LISTING {
        return Err(PhotoResolutionError::new(
            format!(
                "Too many photos: {} entries (max 10 per listing).",
                photos_arr.len(),
            ),
            "count",
            None,
        ));
    }

    let mut elements: Vec<Element> = Vec::with_capacity(photos_arr.len());
    for (i, raw) in photos_arr.iter().enumerate() {
        let Some(raw_str) = raw.as_str() else {
            return Err(PhotoResolutionError::new(
                format!(
                    "photos[{i}] must be a string (URL or absolute path), got {}",
                    value_type_name(raw),
                ),
                "type",
                None,
            ));
        };
        if raw_str.starts_with("http://") || raw_str.starts_with("https://") {
            elements.push(Element::Url {
                index: i,
                url: raw_str.to_string(),
            });
            continue;
        }
        elements.push(resolve_local(raw_str, i).await?);
    }

    let local_indices: Vec<usize> = elements
        .iter()
        .enumerate()
        .filter_map(|(slot, el)| matches!(el, Element::Local { .. }).then_some(slot))
        .collect();

    if local_indices.is_empty() {
        let urls: Vec<String> = elements
            .into_iter()
            .map(|e| match e {
                Element::Url { url, .. } => url,
                Element::Local { .. } => String::new(),
            })
            .collect();
        return Ok(Some(urls));
    }

    // Mint the entire batch in ONE NATS call.
    let mint_files: Vec<MintFile<'_>> = local_indices
        .iter()
        .map(|slot| match &elements[*slot] {
            Element::Local {
                real_path,
                data,
                content_type,
                ..
            } => MintFile {
                filename: file_name(real_path),
                content_type: content_type.as_str(),
                size: data.len() as u64,
            },
            Element::Url { .. } => unreachable!("filtered to locals"),
        })
        .collect();

    let mint_payload = MintRequest { files: mint_files };
    let mint_value = serde_json::to_value(&mint_payload).map_err(|err| {
        PhotoResolutionError::new(
            format!("Mint payload serialization failed: {err}"),
            "mint",
            None,
        )
    })?;

    let mint_reply_value: Value = client
        .request(UPLOAD_URL_SUBJECT, &mint_value, None)
        .await
        .map_err(|err| {
            PhotoResolutionError::new(
                format!(
                    "Mint failed for {} photo(s): {err}",
                    local_indices.len(),
                ),
                "mint",
                None,
            )
        })?;

    let mint_reply: MintReply = serde_json::from_value(mint_reply_value).map_err(|err| {
        PhotoResolutionError::new(
            format!("Mint reply decode failed: {err}"),
            "mint",
            None,
        )
    })?;

    if mint_reply.uploads.len() != local_indices.len() {
        return Err(PhotoResolutionError::new(
            format!(
                "Mint returned {} upload pair(s) for {} local(s).",
                mint_reply.uploads.len(),
                local_indices.len(),
            ),
            "mint",
            None,
        ));
    }

    // Concurrent PUTs preserving the index-to-pair mapping. PUTs are
    // spawned via `tokio::join` style with futures::join_all so the
    // event loop stays free for other work.
    let mut put_futures = Vec::with_capacity(local_indices.len());
    for (mint_idx, elements_slot) in local_indices.iter().enumerate() {
        let pair = &mint_reply.uploads[mint_idx];
        let upload_url = pair.upload_url.clone();
        let (raw_path, content_type, data) = match &elements[*elements_slot] {
            Element::Local {
                raw_path,
                content_type,
                data,
                ..
            } => (raw_path.clone(), *content_type, data.clone()),
            Element::Url { .. } => unreachable!("filtered to locals"),
        };
        put_futures.push(async move {
            put_one(upload_url, content_type, data, raw_path).await
        });
    }
    futures_util::future::try_join_all(put_futures).await?;

    let mut index_to_asset: std::collections::HashMap<usize, String> =
        std::collections::HashMap::new();
    for (mint_idx, elements_slot) in local_indices.iter().enumerate() {
        let original_index = elements[*elements_slot].index();
        index_to_asset.insert(
            original_index,
            mint_reply.uploads[mint_idx].asset_url.clone(),
        );
    }

    let mut out: Vec<String> = vec![String::new(); photos_arr.len()];
    for element in elements {
        match element {
            Element::Url { index, url } => out[index] = url,
            Element::Local { index, .. } => {
                let asset_url = index_to_asset.remove(&index).ok_or_else(|| {
                    PhotoResolutionError::new(
                        format!("Internal: missing asset_url for index {index}."),
                        "internal",
                        None,
                    )
                })?;
                out[index] = asset_url;
            }
        }
    }
    Ok(Some(out))
}

async fn put_one(
    upload_url: String,
    content_type: AllowedContentType,
    data: Vec<u8>,
    raw_path: String,
) -> Result<(), PhotoResolutionError> {
    let response = http_client()
        .put(&upload_url)
        .header("Content-Type", content_type.as_str())
        .body(data)
        .send()
        .await
        .map_err(|err| {
            PhotoResolutionError::new(
                format!("PUT failed for {raw_path}: {err}"),
                "put",
                Some(raw_path.clone()),
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(PhotoResolutionError::new(
            format!("PUT failed for {raw_path}: status {status}"),
            "put",
            Some(raw_path),
        ));
    }
    Ok(())
}

async fn resolve_local(raw: &str, index: usize) -> Result<Element, PhotoResolutionError> {
    if !is_absolute_path(raw) {
        return Err(PhotoResolutionError::new(
            format!("photos[{index}] must be an absolute path: {raw}"),
            "absolute_path",
            Some(raw.to_string()),
        ));
    }

    let canonical = match fs::canonicalize(raw).await {
        Ok(p) => p,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(PhotoResolutionError::new(
                format!(
                    "photos[{index}] does not exist or is not readable: {raw} (ENOENT)."
                ),
                "missing",
                Some(raw.to_string()),
            ));
        }
        Err(err) => {
            return Err(PhotoResolutionError::new(
                format!("photos[{index}] is not readable: {raw} ({err})."),
                "missing",
                Some(raw.to_string()),
            ));
        }
    };

    let canonical_str = canonical.to_string_lossy().into_owned();
    for prefix in sensitive_prefixes() {
        let bare = prefix.trim_end_matches('/');
        if canonical_str == bare || canonical_str.starts_with(&prefix) {
            return Err(PhotoResolutionError::new(
                format!(
                    "photos[{index}] resolves outside permitted roots: {raw} → {canonical_str} (sensitive directory)."
                ),
                "sensitive_dir",
                Some(raw.to_string()),
            ));
        }
    }

    let metadata = fs::metadata(&canonical).await.map_err(|err| {
        PhotoResolutionError::new(
            format!("photos[{index}] is not readable: {raw} ({err})."),
            "missing",
            Some(raw.to_string()),
        )
    })?;

    if !metadata.is_file() {
        return Err(PhotoResolutionError::new(
            format!("photos[{index}] is not a regular file: {raw}."),
            "missing",
            Some(raw.to_string()),
        ));
    }

    if metadata.len() > MAX_BYTES_PER_FILE {
        return Err(PhotoResolutionError::new(
            format!(
                "photos[{index}] exceeds the 10 MB ceiling: {raw} ({} bytes, 10485760 max).",
                metadata.len(),
            ),
            "size",
            Some(raw.to_string()),
        ));
    }

    let data = fs::read(&canonical).await.map_err(|err| {
        PhotoResolutionError::new(
            format!("photos[{index}] read failed: {raw} ({err})."),
            "missing",
            Some(raw.to_string()),
        )
    })?;

    let sniffed = AllowedContentType::sniff(&data).ok_or_else(|| {
        PhotoResolutionError::new(
            format!(
                "photos[{index}] content-type rejected: {raw} — sniffed bytes do not match the image/jpeg, image/png, or image/webp allowlist."
            ),
            "content_type",
            Some(raw.to_string()),
        )
    })?;

    Ok(Element::Local {
        index,
        raw_path: raw.to_string(),
        real_path: canonical_str,
        data,
        content_type: sniffed,
    })
}

fn is_absolute_path(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if s.starts_with('~') {
        return false;
    }
    if s.starts_with("file://") {
        return false;
    }
    if s.starts_with('/') {
        return true;
    }
    // Windows: C:\..., C:/..., \\server\share\...
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    if s.starts_with("\\\\") {
        return true;
    }
    false
}

fn sensitive_prefixes() -> Vec<String> {
    let mut out: Vec<String> = STATIC_SENSITIVE_PREFIXES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if let Ok(klodi_home) = std::env::var("KLODI_HOME") {
        if !klodi_home.is_empty() {
            out.push(ensure_trailing_slash(&klodi_home));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home_str = home.to_string_lossy().into_owned();
        if !home_str.is_empty() {
            out.push(format!("{}/.ssh/", ensure_trailing_slash(&home_str).trim_end_matches('/')));
        }
    }
    out
}

fn ensure_trailing_slash(path: &str) -> String {
    if path.ends_with('/') {
        path.to_string()
    } else {
        format!("{path}/")
    }
}

fn file_name(path: &str) -> &str {
    Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or(path)
}

fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Apply the photo-resolution pipeline to `args["photos"]` and return
/// the substituted args. A no-op when `photos` is absent.
///
/// Called by `dispatch_passthrough` for `KlodiListCreate` and
/// `KlodiListUpdate` only.
pub async fn apply_photos(
    client: &KlodiClient,
    mut args: Map<String, Value>,
) -> Result<Map<String, Value>, McpError> {
    let photos_ref = args.get("photos");
    match resolve_photos(client, photos_ref).await {
        Ok(None) => Ok(args),
        Ok(Some(resolved)) => {
            let array: Vec<Value> = resolved.into_iter().map(Value::String).collect();
            args.insert("photos".to_string(), Value::Array(array));
            Ok(args)
        }
        Err(err) => Err(err.into_mcp_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_jpeg_magic() {
        assert_eq!(
            AllowedContentType::sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]),
            Some(AllowedContentType::Jpeg),
        );
    }

    #[test]
    fn sniff_png_magic() {
        assert_eq!(
            AllowedContentType::sniff(&[
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
            ]),
            Some(AllowedContentType::Png),
        );
    }

    #[test]
    fn sniff_webp_magic() {
        assert_eq!(
            AllowedContentType::sniff(&[
                0x52, 0x49, 0x46, 0x46, // RIFF
                0x24, 0x00, 0x00, 0x00, // size
                0x57, 0x45, 0x42, 0x50, // WEBP
            ]),
            Some(AllowedContentType::Webp),
        );
    }

    #[test]
    fn sniff_pdf_rejected() {
        assert_eq!(
            AllowedContentType::sniff(&[0x25, 0x50, 0x44, 0x46]),
            None,
        );
    }

    #[test]
    fn absolute_path_predicate() {
        assert!(is_absolute_path("/tmp/x.jpg"));
        assert!(!is_absolute_path("./x.jpg"));
        assert!(!is_absolute_path("~/x.jpg"));
        assert!(!is_absolute_path("file:///tmp/x.jpg"));
        assert!(!is_absolute_path(""));
        assert!(is_absolute_path("C:\\Users\\me\\x.jpg"));
        assert!(is_absolute_path("\\\\server\\share\\x.jpg"));
    }
}
