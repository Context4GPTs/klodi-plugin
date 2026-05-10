//! Loopback HTTP server that mints fresh ZeroClaw browser pairing
//! codes on demand and renders an HTML page that pre-populates the
//! operator's clipboard, then redirects to the dashboard.
//!
//! Implements the operator-facing half of plan I-9. The minter
//! ([`crate::zeroclaw_browser_pairing`]) is the data-side half; this
//! module is the loopback HTTP wrapper around it.
//!
//! Hand-rolled HTTP/1.1 mirrors the [`crate::health`] pattern for two
//! reasons: (a) keeps the daemon's release-binary footprint tight (no
//! axum / hyper / warp), and (b) the response set is fixed (one HTML
//! page, one plaintext, healthz, 404) so a full web framework would be
//! dead weight.
//!
//! ## Security model
//!
//! - **Loopback bind only.** [`ShimConfig::loopback`] hardcodes
//!   `127.0.0.1`; non-loopback callers cannot reach the listener.
//! - **DNS-rebinding defense.** The `Host:` header is validated against
//!   `127.0.0.1:<port>` / `localhost:<port>` literals only; anything
//!   else (e.g. a malicious site whose A-record was rebound to
//!   127.0.0.1) gets a 421 with no mint side-effect.
//! - **No PIN / CSRF token.** Per the workstation-trust-anchor model
//!   (`docs/SECURITY.md`, `docs/THREAT_MODEL.md`), local processes
//!   running as the operator are inside the trust boundary. Pairing
//!   codes are short-lived (≈60s) and single-use; leakage is bounded.
//!
//! ## What the rendered page does
//!
//! 1. Calls `navigator.clipboard.writeText(code)` on load.
//! 2. On success: shows "copied" status and redirects to the dashboard
//!    URL after 800ms.
//! 3. On failure (clipboard permission denied, e.g. some Safari paths):
//!    surfaces a "Copy code" button as a fallback.
//! 4. Either way, the dashboard URL is also a regular `<a href="…">`
//!    link the operator can click manually.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::zeroclaw_browser_pairing::{BrowserPairError, MinterImpl};

#[derive(Debug, Clone)]
pub struct ShimConfig {
    pub bind_ip: IpAddr,
    pub port: u16,
    /// URL the rendered HTML's "Open dashboard" link points to and the
    /// JS auto-redirects to. The daemon derives this by stripping the
    /// trailing `/webhook` segment off `ZEROCLAW_WEBHOOK_URL` (a
    /// base-URL hint, not a data destination — wake delivery itself
    /// goes through `/ws/chat` since 0.2.6).
    pub dashboard_url: String,
    /// Shown in the page footer + included in the daemon-version
    /// suffix of stdout/heartbeat surfaces.
    pub daemon_version: String,
}

impl ShimConfig {
    /// Construct a config that binds on the IPv4 loopback. The bind
    /// address is hardcoded — the caller cannot widen it via this
    /// constructor.
    pub fn loopback(
        port: u16,
        dashboard_url: String,
        daemon_version: String,
    ) -> Self {
        Self {
            bind_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
            dashboard_url,
            daemon_version,
        }
    }
}

pub struct ShimHandle {
    /// Loopback URL the daemon embeds in stdout + heartbeat surfaces.
    /// Matches the listener's actual bound port (relevant when the
    /// caller passes `port: 0` to let the OS pick).
    pub url: String,
    listener: TcpListener,
    cfg: Arc<ShimConfig>,
}

impl ShimHandle {
    pub async fn bind(cfg: ShimConfig) -> Result<Self> {
        let addr = SocketAddr::new(cfg.bind_ip, cfg.port);
        let listener = TcpListener::bind(&addr)
            .await
            .with_context(|| format!("binding browser-pair shim {addr}"))?;
        let bound = listener
            .local_addr()
            .context("reading bound shim local_addr")?;
        let url = format!("http://{}:{}", bound.ip(), bound.port());
        Ok(Self {
            url,
            listener,
            cfg: Arc::new(cfg),
        })
    }

    /// Bound port. Useful in tests where the caller binds with `port: 0`
    /// and needs to know what the OS picked.
    pub fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or_default()
    }

    /// Run the accept loop. Returns only on an unrecoverable listener
    /// failure (FD exhaustion, port yanked) — callers spawn this on a
    /// background task and treat its exit as non-fatal.
    pub async fn serve(self, minter: Arc<MinterImpl>) -> Result<()> {
        tracing::info!(
            url = %self.url,
            "klodi_zeroclaw_shim_listening"
        );
        loop {
            let (mut stream, _peer) = match self.listener.accept().await {
                Ok(p) => p,
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        "klodi_zeroclaw_shim_accept_error"
                    );
                    continue;
                }
            };
            let minter = minter.clone();
            let cfg = self.cfg.clone();
            tokio::spawn(async move {
                if let Err(err) =
                    handle_request(&mut stream, cfg, minter).await
                {
                    tracing::debug!(
                        error = %err,
                        "klodi_zeroclaw_shim_request_error"
                    );
                }
            });
        }
    }
}

async fn handle_request(
    stream: &mut tokio::net::TcpStream,
    cfg: Arc<ShimConfig>,
    minter: Arc<MinterImpl>,
) -> std::io::Result<()> {
    // Cap the request head at 2 KiB. We only inspect the request line
    // and Host header; nothing larger should be needed and a misbehaving
    // client shouldn't be able to make us alloc more.
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).await?;
    let head = std::str::from_utf8(&buf[..n]).unwrap_or("");
    let parsed = parse_request(head);

    let local_port = stream.local_addr()?.port();

    let response = if !host_is_loopback(&parsed.host, local_port) {
        misdirected_response()
    } else {
        match parsed.route {
            Route::PairPage => {
                let result = minter.mint().await;
                render_pair_page_response(
                    result.as_deref(),
                    &cfg.dashboard_url,
                    &cfg.daemon_version,
                )
            }
            Route::CodePlain => {
                let result = minter.mint().await;
                render_code_plain_response(result.as_deref())
            }
            Route::Healthz => HEALTHZ_RESPONSE.to_string(),
            Route::NotFound => NOT_FOUND_RESPONSE.to_string(),
        }
    };
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ParsedRequest {
    pub route: Route,
    pub host: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    PairPage,
    CodePlain,
    Healthz,
    NotFound,
}

pub(crate) fn parse_request(head: &str) -> ParsedRequest {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut host = String::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        // Header names are case-insensitive per RFC 7230 §3.2.
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = value.trim().to_string();
            }
        }
    }
    ParsedRequest {
        route: parse_route(request_line),
        host,
    }
}

fn parse_route(request_line: &str) -> Route {
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    if method != "GET" {
        return Route::NotFound;
    }
    // Drop query string + fragment.
    let path = path.split_once('?').map(|(p, _)| p).unwrap_or(path);
    let path = path.split_once('#').map(|(p, _)| p).unwrap_or(path);
    match path {
        "/" => Route::PairPage,
        "/code" => Route::CodePlain,
        "/healthz" => Route::Healthz,
        _ => Route::NotFound,
    }
}

pub(crate) fn host_is_loopback(host: &str, listen_port: u16) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    // Accept the canonical "loopback:listen_port" forms a real local
    // browser would send when hitting the shim's URL. Bare host (no
    // port) matches only when the listener happens to be on port 80.
    let with_port_127 = format!("127.0.0.1:{listen_port}");
    let with_port_local = format!("localhost:{listen_port}");
    h == with_port_127
        || h == with_port_local
        || (listen_port == 80 && (h == "127.0.0.1" || h == "localhost"))
}

const HEALTHZ_RESPONSE: &str = "HTTP/1.1 200 OK\r\n\
                               Content-Type: text/plain; charset=utf-8\r\n\
                               Content-Length: 3\r\n\
                               Cache-Control: no-store\r\n\
                               \r\n\
                               OK\n";

const NOT_FOUND_RESPONSE: &str = "HTTP/1.1 404 Not Found\r\n\
                                 Content-Type: text/plain; charset=utf-8\r\n\
                                 Content-Length: 9\r\n\
                                 Cache-Control: no-store\r\n\
                                 \r\n\
                                 Not Found";

fn misdirected_response() -> String {
    let body = "Misdirected Request - only loopback Host headers (127.0.0.1, localhost) are accepted.\n";
    format!(
        "HTTP/1.1 421 Misdirected Request\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         \r\n\
         {body}",
        body.len(),
    )
}

pub(crate) fn render_pair_page_response(
    result: Result<&str, &BrowserPairError>,
    dashboard_url: &str,
    daemon_version: &str,
) -> String {
    let (status_line, body) = match result {
        Ok(code) => (
            "200 OK",
            success_html(code, dashboard_url, daemon_version),
        ),
        Err(err) => (
            "503 Service Unavailable",
            error_html(&err.to_string(), daemon_version),
        ),
    };
    format!(
        "HTTP/1.1 {status_line}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store, no-cache, must-revalidate\r\n\
         Pragma: no-cache\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         \r\n\
         {body}",
        len = body.len(),
    )
}

pub(crate) fn render_code_plain_response(
    result: Result<&str, &BrowserPairError>,
) -> String {
    match result {
        Ok(code) => {
            let body = format!("{code}\n");
            format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Cache-Control: no-store\r\n\
                 \r\n\
                 {body}",
                body.len(),
            )
        }
        Err(_) => {
            let body = "ERROR: could not mint a pairing code\n";
            format!(
                "HTTP/1.1 503 Service Unavailable\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Cache-Control: no-store\r\n\
                 \r\n\
                 {body}",
                body.len(),
            )
        }
    }
}

const SUCCESS_HTML_TEMPLATE: &str = r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>klodi · pair your browser</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 440px; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }
    @media (prefers-color-scheme: dark) { body { color: #eee; background: #1a1a1a; } }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 1.5rem 1.75rem; background: white; }
    @media (prefers-color-scheme: dark) { .card { background: #2a2a2a; border-color: #3a3a3a; } }
    h1 { font-size: 0.875rem; margin: 0 0 1.25rem; color: #888; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .code { font: 600 2.25rem/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.15em; padding: 1rem; background: #f3f3f3; border-radius: 6px; text-align: center; user-select: all; }
    @media (prefers-color-scheme: dark) { .code { background: #111; } }
    .status { margin-top: 0.75rem; font-size: 0.875rem; color: #888; text-align: center; }
    .copied { color: #0a8050; }
    .err { color: #c44; }
    .actions { margin-top: 1.25rem; display: flex; gap: 0.5rem; }
    button, a.button { flex: 1; padding: 0.625rem 1rem; font-size: 0.9375rem; border: 1px solid #1a1a1a; border-radius: 6px; background: #1a1a1a; color: white; cursor: pointer; text-decoration: none; text-align: center; display: inline-block; box-sizing: border-box; }
    button.secondary { background: transparent; color: #1a1a1a; }
    @media (prefers-color-scheme: dark) {
      button, a.button { border-color: #eee; background: #eee; color: #1a1a1a; }
      button.secondary { background: transparent; color: #eee; border-color: #eee; }
    }
    .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #aaa; text-align: center; }
    .footer code { font-size: inherit; background: transparent; padding: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>klodi · pair your ZeroClaw browser</h1>
    <div class="code" id="code">%%CODE_HTML%%</div>
    <div class="status" id="status">copying to clipboard…</div>
    <div class="actions">
      <button id="copy-btn" class="secondary" hidden>Copy code</button>
      <a class="button" href="%%DASH_HTML%%">Open dashboard →</a>
    </div>
    <div class="status" style="margin-top:1rem">When prompted, paste with ⌘V (or Ctrl+V) and submit.</div>
  </div>
  <div class="footer">klodi-zeroclaw v%%VERSION_HTML%% · code expires in ≈60s · reload for a fresh one</div>
  <script>
    const code = %%CODE_JSON%%;
    const dash = %%DASH_JSON%%;
    const status = document.getElementById('status');
    const copyBtn = document.getElementById('copy-btn');
    function showCopied() {
      status.textContent = '✓ copied to clipboard — opening dashboard…';
      status.className = 'status copied';
    }
    function showFallback() {
      status.textContent = 'click to copy, then open the dashboard';
      status.className = 'status';
      copyBtn.hidden = false;
    }
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(showCopied).catch(() => {
        status.textContent = 'copy not permitted — select the code above and copy manually';
        status.className = 'status err';
      });
    });
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(() => {
        showCopied();
        setTimeout(() => { window.location = dash; }, 800);
      }).catch(showFallback);
    } else {
      showFallback();
    }
  </script>
  <noscript>
    <div class="status">JavaScript is disabled. Copy the code above, then open <a href="%%DASH_HTML%%">%%DASH_HTML%%</a> manually.</div>
  </noscript>
</body>
</html>
"###;

const ERROR_HTML_TEMPLATE: &str = r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>klodi · pairing error</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 440px; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    .card { border: 1px solid #f5a; border-radius: 10px; padding: 1.5rem 1.75rem; background: #fff5f8; }
    h1 { font-size: 1rem; margin: 0 0 1rem; color: #c00; font-weight: 600; }
    pre { background: white; border-radius: 4px; padding: 0.75rem; font-size: 0.8125rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #aaa; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <h1>could not mint a pairing code</h1>
    <pre>%%ERROR_HTML%%</pre>
    <p>Reload to retry, or fall back to running this in the gateway container:</p>
    <pre>zeroclaw gateway get-paircode --new</pre>
  </div>
  <div class="footer">klodi-zeroclaw v%%VERSION_HTML%%</div>
</body>
</html>
"###;

fn success_html(code: &str, dashboard_url: &str, daemon_version: &str) -> String {
    SUCCESS_HTML_TEMPLATE
        .replace("%%CODE_HTML%%", &html_escape(code))
        .replace("%%DASH_HTML%%", &html_escape(dashboard_url))
        .replace("%%VERSION_HTML%%", &html_escape(daemon_version))
        .replace("%%CODE_JSON%%", &json_str(code))
        .replace("%%DASH_JSON%%", &json_str(dashboard_url))
}

fn error_html(err_msg: &str, daemon_version: &str) -> String {
    ERROR_HTML_TEMPLATE
        .replace("%%ERROR_HTML%%", &html_escape(err_msg))
        .replace("%%VERSION_HTML%%", &html_escape(daemon_version))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn json_str(s: &str) -> String {
    let raw = serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    // HTML-safe JSON: replace bytes that could prematurely close the
    // enclosing <script> tag or otherwise confuse the HTML parser /
    // JS engine. Standard hardening when embedding JSON inline in HTML.
    // U+2028 / U+2029 are line terminators in ECMAScript pre-ES2019;
    // they would split a JS string literal across lines on older JS
    // engines and are conventionally escaped here.
    raw.replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpStream;

    // -- Pure function tests (no TCP listener) --------------------------

    #[test]
    fn parse_route_root_is_pair_page() {
        assert_eq!(parse_route("GET / HTTP/1.1"), Route::PairPage);
    }

    #[test]
    fn parse_route_root_with_query_string_is_pair_page() {
        assert_eq!(parse_route("GET /?ts=123 HTTP/1.1"), Route::PairPage);
    }

    #[test]
    fn parse_route_code_returns_code_plain() {
        assert_eq!(parse_route("GET /code HTTP/1.1"), Route::CodePlain);
    }

    #[test]
    fn parse_route_healthz_returns_healthz() {
        assert_eq!(parse_route("GET /healthz HTTP/1.1"), Route::Healthz);
    }

    #[test]
    fn parse_route_unknown_path_is_not_found() {
        assert_eq!(parse_route("GET /admin HTTP/1.1"), Route::NotFound);
    }

    #[test]
    fn parse_route_post_to_root_is_not_found() {
        // POST never gets a real response — we only serve GETs.
        assert_eq!(parse_route("POST / HTTP/1.1"), Route::NotFound);
    }

    #[test]
    fn parse_request_extracts_host() {
        let head = "GET / HTTP/1.1\r\nHost: 127.0.0.1:53219\r\nUser-Agent: x\r\n\r\n";
        let parsed = parse_request(head);
        assert_eq!(parsed.route, Route::PairPage);
        assert_eq!(parsed.host, "127.0.0.1:53219");
    }

    #[test]
    fn parse_request_handles_lowercase_host_header() {
        let head = "GET / HTTP/1.1\r\nhost: localhost:53219\r\n\r\n";
        let parsed = parse_request(head);
        assert_eq!(parsed.host, "localhost:53219");
    }

    #[test]
    fn parse_request_returns_empty_host_when_missing() {
        let head = "GET / HTTP/1.1\r\nUser-Agent: x\r\n\r\n";
        let parsed = parse_request(head);
        assert_eq!(parsed.host, "");
    }

    #[test]
    fn host_is_loopback_accepts_canonical_127() {
        assert!(host_is_loopback("127.0.0.1:53219", 53219));
    }

    #[test]
    fn host_is_loopback_accepts_localhost() {
        assert!(host_is_loopback("localhost:53219", 53219));
    }

    #[test]
    fn host_is_loopback_case_insensitive() {
        assert!(host_is_loopback("LOCALHOST:53219", 53219));
    }

    #[test]
    fn host_is_loopback_rejects_non_loopback_domain() {
        // The DNS-rebinding case: a hostile site whose A record was
        // rebound to 127.0.0.1.
        assert!(!host_is_loopback("evil.com:53219", 53219));
    }

    #[test]
    fn host_is_loopback_rejects_loopback_with_wrong_port() {
        assert!(!host_is_loopback("127.0.0.1:9999", 53219));
    }

    #[test]
    fn host_is_loopback_rejects_empty() {
        assert!(!host_is_loopback("", 53219));
    }

    #[test]
    fn host_is_loopback_accepts_bare_host_when_listener_on_port_80() {
        assert!(host_is_loopback("127.0.0.1", 80));
        assert!(host_is_loopback("localhost", 80));
    }

    #[test]
    fn host_is_loopback_rejects_bare_host_on_non_default_port() {
        assert!(!host_is_loopback("127.0.0.1", 53219));
    }

    #[test]
    fn html_escape_handles_all_unsafe_chars() {
        assert_eq!(
            html_escape("<a href=\"x\">'&\"</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&quot;&lt;/a&gt;"
        );
    }

    #[test]
    fn render_pair_page_success_includes_code_and_dashboard() {
        let body =
            success_html("123456", "http://127.0.0.1:7070", "0.2.8");
        assert!(body.contains("123456"));
        assert!(body.contains("http://127.0.0.1:7070"));
        assert!(body.contains("klodi-zeroclaw v0.2.8"));
        // Clipboard JS is the load-bearing UX element — guard against
        // regression.
        assert!(body.contains("navigator.clipboard"));
    }

    #[test]
    fn render_pair_page_response_success_has_no_store_headers() {
        let response = render_pair_page_response(
            Ok("123456"),
            "http://127.0.0.1:7070",
            "0.2.8",
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Referrer-Policy: no-referrer"));
        assert!(response.contains("X-Content-Type-Options: nosniff"));
    }

    #[test]
    fn render_pair_page_response_error_returns_503() {
        let err = BrowserPairError::CliMissing("/tmp/zeroclaw".into());
        let response = render_pair_page_response(
            Err(&err),
            "http://127.0.0.1:7070",
            "0.2.8",
        );
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(response.contains("could not mint a pairing code"));
        // Recovery hint must be present so a stuck operator has a path
        // forward without reading the source.
        assert!(response.contains("zeroclaw gateway get-paircode --new"));
    }

    #[test]
    fn render_pair_page_escapes_dashboard_url_in_html_attribute_and_script() {
        let body = success_html(
            "123456",
            "http://127.0.0.1:7070?evil=\"</script><script>alert(1)</script>",
            "0.2.8",
        );
        // Neither side may leak the raw payload:
        // - HTML-attribute / text side: `html_escape` covers <, >, ", '.
        // - Inline-JS side: `json_str` rewrites < / > / & as \uXXXX so
        //   no </script> can close the surrounding script element.
        assert!(!body.contains("</script><script>"));
        assert!(!body.contains("<script>alert"));
        // HTML-attribute side: `<` / `"` become entities.
        assert!(body.contains("&quot;&lt;/script&gt;&lt;script&gt;"));
        // JS-literal side: `<` becomes `<`, `>` becomes `>`.
        assert!(body.contains("\\u003c"));
        assert!(body.contains("\\u003e"));
    }

    #[test]
    fn json_str_escapes_html_breakout_chars() {
        let out = json_str("a<b>c&d");
        assert!(!out.contains('<'));
        assert!(!out.contains('>'));
        // Ampersand inside JSON is fine for JS but unsafe inside HTML —
        // escape for parity with the < / > rules.
        assert!(!out.contains('&'));
        assert!(out.contains("\\u003c"));
        assert!(out.contains("\\u003e"));
        assert!(out.contains("\\u0026"));
    }

    #[test]
    fn render_code_plain_success_returns_just_code_with_newline() {
        let response = render_code_plain_response(Ok("123456"));
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.ends_with("\r\n\r\n123456\n"));
    }

    #[test]
    fn render_code_plain_error_returns_503() {
        let err = BrowserPairError::CliMissing("/tmp/zeroclaw".into());
        let response = render_code_plain_response(Err(&err));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
    }

    // -- Listener round-trip tests (using StubMinter) -------------------

    async fn spawn_test_shim(code: &str) -> (String, u16, tokio::task::JoinHandle<()>) {
        let cfg = ShimConfig::loopback(
            0,
            "http://127.0.0.1:7070".to_string(),
            "0.2.8".to_string(),
        );
        let handle = ShimHandle::bind(cfg).await.expect("shim bind");
        let url = handle.url.clone();
        let port = handle.port();
        let minter = Arc::new(MinterImpl::Stub {
            fixed_code: code.to_string(),
        });
        let join = tokio::spawn(async move {
            let _ = handle.serve(minter).await;
        });
        (url, port, join)
    }

    async fn http_get(
        port: u16,
        path: &str,
        host_header: &str,
    ) -> (String, String) {
        let mut sock = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .expect("connect");
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n"
        );
        sock.write_all(req.as_bytes()).await.expect("write");
        let mut response = String::new();
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            sock.read_to_string(&mut response),
        )
        .await;
        let (head, body) = response
            .split_once("\r\n\r\n")
            .map(|(h, b)| (h.to_string(), b.to_string()))
            .unwrap_or((response, String::new()));
        (head, body)
    }

    #[tokio::test]
    async fn root_with_loopback_host_returns_html_with_code() {
        let (_url, port, join) = spawn_test_shim("987654").await;
        let host = format!("127.0.0.1:{port}");
        let (head, body) = http_get(port, "/", &host).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "head: {head}");
        assert!(body.contains("987654"), "body: {body}");
        join.abort();
    }

    #[tokio::test]
    async fn root_with_evil_host_returns_421() {
        let (_url, port, join) = spawn_test_shim("987654").await;
        let (head, body) = http_get(port, "/", "evil.com:8080").await;
        assert!(
            head.starts_with("HTTP/1.1 421 Misdirected Request"),
            "head: {head}"
        );
        // No code is leaked to the body even though we minted nothing
        // (the rejection happens before mint).
        assert!(!body.contains("987654"));
        join.abort();
    }

    #[tokio::test]
    async fn unknown_path_returns_404() {
        let (_url, port, join) = spawn_test_shim("987654").await;
        let host = format!("127.0.0.1:{port}");
        let (head, _) = http_get(port, "/admin", &host).await;
        assert!(head.starts_with("HTTP/1.1 404 Not Found"), "head: {head}");
        join.abort();
    }

    #[tokio::test]
    async fn healthz_returns_ok_text() {
        let (_url, port, join) = spawn_test_shim("987654").await;
        let host = format!("127.0.0.1:{port}");
        let (head, body) = http_get(port, "/healthz", &host).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "head: {head}");
        assert_eq!(body, "OK\n");
        join.abort();
    }

    #[tokio::test]
    async fn code_endpoint_returns_plaintext() {
        let (_url, port, join) = spawn_test_shim("424242").await;
        let host = format!("127.0.0.1:{port}");
        let (head, body) = http_get(port, "/code", &host).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "head: {head}");
        assert!(head.contains("text/plain"));
        assert_eq!(body, "424242\n");
        join.abort();
    }

    #[tokio::test]
    async fn shim_handle_url_uses_actual_bound_port() {
        let cfg = ShimConfig::loopback(
            0,
            "http://127.0.0.1:7070".to_string(),
            "0.2.8".to_string(),
        );
        let handle = ShimHandle::bind(cfg).await.expect("bind");
        let port = handle.port();
        assert_ne!(port, 0, "OS should assign a non-zero port");
        assert_eq!(handle.url, format!("http://127.0.0.1:{port}"));
    }
}
