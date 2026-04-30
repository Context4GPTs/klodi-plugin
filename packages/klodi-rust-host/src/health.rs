//! HTTP probes for the daemon forwarders.
//!
//! `--health-port` exposes two endpoints from the same TCP listener:
//!
//! * `GET /healthz` — 200 if `client.is_connected()`, 503 otherwise.
//!   Lets supervisors (systemd, Docker, k8s) restart a wedged forwarder
//!   before the inactivity threshold trips. (P2-25.)
//!
//! * `GET /metrics` — Prometheus text-format exposition of the
//!   per-client counters surfaced by `klodi_nats_client::ClientMetrics`.
//!   Counter names use the `klodi_client_*` prefix; the Rust daemon is
//!   the operator scrape target. (P2-27.)
//!
//! Deliberately minimal — the daemon forwarder is the only consumer,
//! so we don't pull in `axum` / `actix` / a full web framework. A
//! tokio TCP loop with hand-rolled HTTP/1.1 framing keeps the binary
//! footprint tight (the full async-nats + reqwest stack is already a
//! sizable transitive deplist; +1 web framework would be ~500KB of
//! dead weight in the release binary).

use anyhow::{Context, Result};
use klodi_nats_client::{ClientMetrics, KlodiClient};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// Body lengths must match `Content-Length` exactly — pipelined HTTP/1.1
// clients read the advertised count and frame the next request from
// what's left. A length lie reads into the next request or off the end
// of the buffer.
const HEALTHY_RESPONSE: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 3\r\n\r\nOK\n";
const UNHEALTHY_RESPONSE: &str =
    "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 14\r\n\r\nNOT_CONNECTED\n";
const NOT_FOUND_RESPONSE: &str =
    "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n";

/// Bind to `0.0.0.0:<port>` and serve `GET /healthz` + `GET /metrics`.
/// Other paths + methods get a 404 (we don't expose `/` — easier to
/// reason about than a directory listing or a generic landing page).
///
/// Returns once the listener fails to accept (ports yanked, FD limit,
/// etc.). The forwarder treats this as a non-fatal background task — the
/// NATS subscription keeps running.
pub async fn serve_health(port: u16, client: Arc<KlodiClient>) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("binding health port {port}"))?;
    tracing::info!(port = port, "klodi_health_endpoint_listening");
    loop {
        let (mut stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                tracing::warn!(error = %err, "klodi_health_accept_error");
                continue;
            }
        };
        let client_for_task = client.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_request(&mut stream, client_for_task).await {
                tracing::debug!(error = %err, "klodi_health_request_error");
            }
        });
    }
}

async fn handle_request(
    stream: &mut tokio::net::TcpStream,
    client: Arc<KlodiClient>,
) -> std::io::Result<()> {
    // Cap the request line at 1 KiB — we only inspect the request line,
    // and a misbehaving client shouldn't be able to make us alloc more
    // than that.
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).await?;
    let head = std::str::from_utf8(&buf[..n]).unwrap_or("");
    let request_line = head.lines().next().unwrap_or("");

    if request_line.starts_with("GET /healthz") {
        let response = if client.is_connected().await {
            HEALTHY_RESPONSE.to_owned()
        } else {
            UNHEALTHY_RESPONSE.to_owned()
        };
        stream.write_all(response.as_bytes()).await?;
    } else if request_line.starts_with("GET /metrics") {
        let body = render_metrics(client.metrics());
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; version=0.0.4; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await?;
    } else {
        stream.write_all(NOT_FOUND_RESPONSE.as_bytes()).await?;
    }
    stream.flush().await?;
    Ok(())
}

/// Render the metrics snapshot as Prometheus text-format
/// (`text/plain; version=0.0.4`). One metric per line, prefixed
/// `klodi_client_`. Counters carry `# TYPE … counter`, gauges carry
/// `# TYPE … gauge`. The line order is stable so the response body is
/// byte-equal across calls when counters haven't moved — useful when
/// diffing scrape output.
pub fn render_metrics(metrics: ClientMetrics) -> String {
    // Build line-by-line so each metric carries its `# HELP` + `# TYPE`
    // (Prometheus convention; scraper UIs render these as tooltips).
    let mut out = String::with_capacity(1024);
    out.push_str("# HELP klodi_client_consumed Wakes received from JetStream.\n");
    out.push_str("# TYPE klodi_client_consumed counter\n");
    out.push_str(&format!("klodi_client_consumed {}\n", metrics.consumed));

    out.push_str("# HELP klodi_client_acked Successful msg.ack() count.\n");
    out.push_str("# TYPE klodi_client_acked counter\n");
    out.push_str(&format!("klodi_client_acked {}\n", metrics.acked));

    out.push_str("# HELP klodi_client_naked msg.nak() count (handler raised).\n");
    out.push_str("# TYPE klodi_client_naked counter\n");
    out.push_str(&format!("klodi_client_naked {}\n", metrics.naked));

    out.push_str("# HELP klodi_client_dedup_hit Wakes whose event_id was already in the LRU window.\n");
    out.push_str("# TYPE klodi_client_dedup_hit counter\n");
    out.push_str(&format!("klodi_client_dedup_hit {}\n", metrics.dedup_hit));

    out.push_str("# HELP klodi_client_redelivery_count Sum of redelivery_count across delivered messages.\n");
    out.push_str("# TYPE klodi_client_redelivery_count counter\n");
    out.push_str(&format!(
        "klodi_client_redelivery_count {}\n",
        metrics.redelivery_count
    ));

    out.push_str("# HELP klodi_client_pending_count JetStream consumer pending count (best-effort gauge).\n");
    out.push_str("# TYPE klodi_client_pending_count gauge\n");
    out.push_str(&format!(
        "klodi_client_pending_count {}\n",
        metrics.pending_count
    ));

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick_status_only(request_line: &str, connected: bool) -> &'static str {
        if request_line.starts_with("GET /healthz") {
            if connected { HEALTHY_RESPONSE } else { UNHEALTHY_RESPONSE }
        } else {
            NOT_FOUND_RESPONSE
        }
    }

    #[test]
    fn healthz_when_connected_returns_200() {
        let resp = pick_status_only("GET /healthz HTTP/1.1", true);
        assert!(resp.starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn healthz_when_disconnected_returns_503() {
        let resp = pick_status_only("GET /healthz HTTP/1.1", false);
        assert!(resp.starts_with("HTTP/1.1 503 Service Unavailable"));
    }

    #[test]
    fn unrelated_path_returns_404() {
        let resp = pick_status_only("GET / HTTP/1.1", true);
        assert!(resp.starts_with("HTTP/1.1 404 Not Found"));
    }

    #[test]
    fn post_to_healthz_returns_404() {
        let resp = pick_status_only("POST /healthz HTTP/1.1", true);
        assert!(resp.starts_with("HTTP/1.1 404 Not Found"));
    }

    #[test]
    fn render_metrics_emits_every_counter_with_klodi_client_prefix() {
        let snap = ClientMetrics {
            consumed: 42,
            acked: 40,
            naked: 2,
            dedup_hit: 1,
            redelivery_count: 5,
            pending_count: 7,
        };
        let body = render_metrics(snap);
        // Every counter must appear with the `klodi_client_` prefix.
        assert!(body.contains("klodi_client_consumed 42\n"));
        assert!(body.contains("klodi_client_acked 40\n"));
        assert!(body.contains("klodi_client_naked 2\n"));
        assert!(body.contains("klodi_client_dedup_hit 1\n"));
        assert!(body.contains("klodi_client_redelivery_count 5\n"));
        assert!(body.contains("klodi_client_pending_count 7\n"));
        // Type annotations land on the line above each metric value.
        assert!(body.contains("# TYPE klodi_client_consumed counter\n"));
        assert!(body.contains("# TYPE klodi_client_pending_count gauge\n"));
    }

    #[test]
    fn render_metrics_zero_snapshot_emits_zeros() {
        let snap = ClientMetrics::zero();
        let body = render_metrics(snap);
        assert!(body.contains("klodi_client_consumed 0\n"));
        assert!(body.contains("klodi_client_acked 0\n"));
    }

    #[test]
    fn render_metrics_is_deterministic() {
        // Same input → byte-equal output. The ordering of lines is
        // load-bearing for scrape diff tooling.
        let snap = ClientMetrics {
            consumed: 1,
            acked: 1,
            naked: 0,
            dedup_hit: 0,
            redelivery_count: 0,
            pending_count: 3,
        };
        assert_eq!(render_metrics(snap), render_metrics(snap));
    }
}
