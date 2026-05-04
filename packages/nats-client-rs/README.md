# klodi-nats-client (Rust)

Single persistent NATS-WS connection per klodi session. Tool calls, durable
notifications, and channel-stream wakes — all on one connection.

Public surface mirrors the TS client at
`klodi-plugin/packages/nats-client-ts/`. Adapters (Moltis, IronClaw,
ZeroClaw) depend on this crate; they don't touch `async-nats` directly.

## Quick start

```rust
use klodi_nats_client::{KlodiClient, KlodiError};
use std::path::Path;

async fn run() -> Result<(), KlodiError> {
    let client = KlodiClient::new(
        Path::new("/path/to/nats.creds"),
        Path::new("/path/to/config.json"),
    )
    .await?;
    client.connect().await?;

    let identity: serde_json::Value = client
        .request("p2p.v1.users.whoami", &serde_json::json!({}), None)
        .await?;
    println!("identity: {identity}");

    client.close().await?;
    Ok(())
}
```

## Tool surface

The catalog (subject + ToolName) is generated from the TS source of truth at
`klodi-plugin/packages/tool-catalog/dist/rust-types.rs` and embedded into
this crate via `include!`. Adapters call `client.request(ToolName::*.subject(), body, None)`.
