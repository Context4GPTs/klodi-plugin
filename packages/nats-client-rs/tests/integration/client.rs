//! P1-22 — D.1.rs: per-language client cycle (Rust).
//!
//! Real NATS via `pnpm setup:dev`. Gated by the `integration` cargo
//! feature. Mirrors the TS suite at
//! `klodi-plugin/packages/nats-client-ts/tests/integration/client.integration.test.ts`
//! and the Python suite at
//! `klodi-plugin/packages/nats-client-py/tests/integration/test_client_integration.py`.
//!
//! Acceptance criteria (Decision 13 row D.1.{ts,py,rs}):
//!   - Connect with NKey + WebSocket
//!   - Subscribe; synthetic publisher fires N events; handler invoked N×
//!     in order with full payloads
//!   - Disconnect → reconnect → 3-event backlog drains in order
//!
//! Run with:
//!   cargo test -p klodi-nats-client --features integration -- --test-threads=1
//!
//! Per-test isolation: each test mints a fresh user_id via
//! `Uuid::new_v4()`. The notifications consumer name
//! (`klodi-notifications-<user_id>`) and the filter subject
//! (`p2p.v1.notifications.<user_id>`) namespace automatically.

#![cfg(feature = "integration")]

use async_nats::ConnectOptions;
use async_nats::jetstream::{self, Context as JetStreamContext};
use futures_util::FutureExt;
use klodi_nats_client::KlodiClient;
use serde_json::json;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::fs;
use tokio::sync::{Mutex, Notify};
use tokio::time::timeout;
use uuid::Uuid;

fn repo_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut cur: &Path = &here;
        loop {
            if cur.join("pnpm-workspace.yaml").exists() {
                return cur.to_path_buf();
            }
            cur = cur.parent().expect("hit filesystem root without finding pnpm-workspace.yaml");
        }
    })
}

fn service_creds_path() -> PathBuf {
    repo_root().join("infra/nats/dev-keys/service.creds")
}

fn nats_ws_url() -> String {
    env::var("TEST_NATS_WS_URL").unwrap_or_else(|_| "ws://localhost:8080".to_owned())
}

fn integration_enabled() -> bool {
    env::var("INTEGRATION").as_deref() == Ok("1") && service_creds_path().is_file()
}

struct TestUser {
    user_id: String,
    home_dir: PathBuf,
    config_path: PathBuf,
    creds_path: PathBuf,
}

async fn make_test_user() -> TestUser {
    let user_id = Uuid::new_v4().to_string();
    let handle = format!("rstest_{}", &user_id[..8]);
    let home_dir = env::temp_dir().join(format!(
        "klodi-rs-int-{handle}-{}",
        Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&home_dir).await.expect("create home dir");
    let creds_path = home_dir.join("nats.creds");
    let config_path = home_dir.join("config.json");

    let creds = fs::read(service_creds_path())
        .await
        .expect("read dev service.creds");
    fs::write(&creds_path, &creds).await.expect("write nats.creds");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&creds_path, std::fs::Permissions::from_mode(0o600))
            .await
            .expect("chmod 0o600");
    }
    let config = json!({
        "handle": handle,
        "user_id": user_id,
        "nkey_public": "test-placeholder-nkey",
        "nats_url": nats_ws_url(),
    });
    fs::write(&config_path, serde_json::to_string(&config).unwrap())
        .await
        .expect("write config.json");

    TestUser {
        user_id,
        home_dir,
        config_path,
        creds_path,
    }
}

async fn delete_consumer(durable: &str) {
    let creds = service_creds_path();
    let nc = match ConnectOptions::with_credentials_file(&creds)
        .await
        .expect("creds file")
        .connect(nats_ws_url())
        .await
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let ctx = jetstream::new(nc.clone());
    let _ = ctx.delete_consumer_from_stream(durable, "P2P_NOTIFICATIONS").await;
    let _ = nc.drain().await;
}

async fn publish_notification(
    ctx: &JetStreamContext,
    user_id: &str,
    kind: &str,
    payload: serde_json::Value,
) -> String {
    let event_id = Uuid::new_v4().to_string();
    let mut body = json!({
        "event_id": event_id,
        "kind": kind,
    });
    if let serde_json::Value::Object(map) = &mut body {
        if let serde_json::Value::Object(extra) = payload {
            for (k, v) in extra {
                map.insert(k, v);
            }
        }
    }
    let mut headers = async_nats::HeaderMap::new();
    headers.insert("Nats-Msg-Id", event_id.as_str());
    let ack_future = ctx
        .publish_with_headers(
            format!("p2p.v1.notifications.{user_id}"),
            headers,
            serde_json::to_vec(&body).unwrap().into(),
        )
        .await
        .expect("publish");
    ack_future.await.expect("publish ack");
    event_id
}

async fn make_publisher_ctx() -> (async_nats::Client, JetStreamContext) {
    let nc = ConnectOptions::with_credentials_file(service_creds_path())
        .await
        .expect("creds file")
        .connect(nats_ws_url())
        .await
        .expect("publisher connect");
    let ctx = jetstream::new(nc.clone());
    (nc, ctx)
}

async fn cleanup_user(user: &TestUser) {
    delete_consumer(&format!("klodi-notifications-{}", user.user_id)).await;
    let _ = fs::remove_dir_all(&user.home_dir).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connects_via_websocket_with_nkey_credentials() {
    if !integration_enabled() {
        eprintln!("INTEGRATION=1 + dev keys required — skipping");
        return;
    }
    let user = make_test_user().await;
    let client = KlodiClient::new(&user.creds_path, &user.config_path)
        .await
        .expect("client::new");
    client.connect().await.expect("connect");
    assert!(client.is_connected().await);
    let _ = client.close().await;
    cleanup_user(&user).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn delivers_5_published_events_to_handler_in_order() {
    if !integration_enabled() {
        eprintln!("INTEGRATION=1 + dev keys required — skipping");
        return;
    }
    let user = make_test_user().await;
    let client = KlodiClient::new(&user.creds_path, &user.config_path)
        .await
        .expect("client::new");
    client.connect().await.expect("connect");

    let received = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let all_received = Arc::new(Notify::new());
    let received_for_handler = Arc::clone(&received);
    let notify_for_handler = Arc::clone(&all_received);

    client
        .subscribe_notifications(Arc::new(move |event| {
            let received = Arc::clone(&received_for_handler);
            let notify = Arc::clone(&notify_for_handler);
            async move {
                let mut buf = received.lock().await;
                buf.push(serde_json::to_value(&event).expect("serialize"));
                if buf.len() == 5 {
                    notify.notify_one();
                }
                Ok(())
            }
            .boxed()
        }))
        .await
        .expect("subscribe");

    // Give the consume loop a moment to attach.
    tokio::time::sleep(Duration::from_millis(250)).await;

    let (publisher_nc, publisher_ctx) = make_publisher_ctx().await;
    let expected_kinds = [
        "channel.opened",
        "channel.message",
        "offer.proposed",
        "offer.accepted",
        "transaction.confirmed",
    ];
    let mut published_ids = Vec::new();
    for (i, kind) in expected_kinds.iter().enumerate() {
        let event_id = publish_notification(
            &publisher_ctx,
            &user.user_id,
            kind,
            json!({"marker": kind, "sequenceTag": i}),
        )
        .await;
        published_ids.push(event_id);
    }

    timeout(Duration::from_secs(10), all_received.notified())
        .await
        .expect("only received < 5 events within timeout");
    let buf = received.lock().await;
    let kinds: Vec<&str> = buf.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, expected_kinds);
    let event_ids: Vec<&str> = buf
        .iter()
        .map(|e| e["event_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        event_ids,
        published_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );
    drop(buf);

    let _ = publisher_nc.drain().await;
    let _ = client.close().await;
    cleanup_user(&user).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn drains_3_event_backlog_after_reconnect_in_order() {
    if !integration_enabled() {
        eprintln!("INTEGRATION=1 + dev keys required — skipping");
        return;
    }
    let user = make_test_user().await;

    // 1. Connect + subscribe so the durable consumer is created.
    let client = KlodiClient::new(&user.creds_path, &user.config_path)
        .await
        .expect("client::new");
    client.connect().await.expect("connect");
    let received = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let received_first = Arc::clone(&received);
    client
        .subscribe_notifications(Arc::new(move |event| {
            let received = Arc::clone(&received_first);
            async move {
                received
                    .lock()
                    .await
                    .push(serde_json::to_value(&event).expect("serialize"));
                Ok(())
            }
            .boxed()
        }))
        .await
        .expect("subscribe (first)");
    tokio::time::sleep(Duration::from_millis(250)).await;

    // 2. Disconnect — durable consumer remains on the server.
    client.close().await.expect("close (first)");
    received.lock().await.clear();

    // 3. Publish 3 events while the client is offline. Interest
    //    retention keeps them queued because the durable consumer
    //    hasn't acked them.
    let backlog_kinds = ["search.match", "comment.posted", "rating.received"];
    let (publisher_nc, publisher_ctx) = make_publisher_ctx().await;
    let mut published_ids = Vec::new();
    for kind in &backlog_kinds {
        let event_id = publish_notification(
            &publisher_ctx,
            &user.user_id,
            kind,
            json!({"backlogTag": kind}),
        )
        .await;
        published_ids.push(event_id);
    }

    // 4. Reconnect + subscribe again; backlog drains in order.
    let client = KlodiClient::new(&user.creds_path, &user.config_path)
        .await
        .expect("client::new (reconnect)");
    client.connect().await.expect("reconnect");
    let all_received = Arc::new(Notify::new());
    let notify_for_handler = Arc::clone(&all_received);
    let received_again = Arc::clone(&received);
    client
        .subscribe_notifications(Arc::new(move |event| {
            let received = Arc::clone(&received_again);
            let notify = Arc::clone(&notify_for_handler);
            async move {
                let mut buf = received.lock().await;
                buf.push(serde_json::to_value(&event).expect("serialize"));
                if buf.len() == 3 {
                    notify.notify_one();
                }
                Ok(())
            }
            .boxed()
        }))
        .await
        .expect("subscribe (reconnect)");

    timeout(Duration::from_secs(10), all_received.notified())
        .await
        .expect("backlog did not drain within timeout");
    let buf = received.lock().await;
    let kinds: Vec<&str> = buf.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, backlog_kinds);
    let event_ids: Vec<&str> = buf
        .iter()
        .map(|e| e["event_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        event_ids,
        published_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );
    drop(buf);

    let _ = publisher_nc.drain().await;
    let _ = client.close().await;
    cleanup_user(&user).await;
}

