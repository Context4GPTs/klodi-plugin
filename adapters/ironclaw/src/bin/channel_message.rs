//! `klodi-ironclaw-channel-message` — publish a single channel message.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_nats_client::KlodiClient;
use klodi_rust_host::paths;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-ironclaw-channel-message",
    about = "Publish a single channel message via JetStream and exit.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long)]
    channel_id: String,
    #[arg(long)]
    content: String,
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let cli = Cli::parse();
    if cli.channel_id.is_empty() {
        bail!("--channel-id must not be empty");
    }
    let content = if cli.content == "-" {
        read_stdin().await?
    } else {
        cli.content
    };
    let creds_path = cli.creds.unwrap_or_else(paths::creds_path);
    let config_path = cli.config.unwrap_or_else(paths::config_path);

    let client = KlodiClient::new(&creds_path, &config_path)
        .await
        .context("loading klodi client")?;
    client.connect().await.context("connecting to NATS")?;
    let ack = client
        .publish_channel_message(&cli.channel_id, &content)
        .await
        .context("publishing channel message")?;
    client.close().await.ok();

    let out = serde_json::json!({
        "sequence": ack.sequence,
        "event_id": ack.event_id,
        "message_id": ack.message_id,
        "created_at": ack.created_at,
    });
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

async fn read_stdin() -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut buf = String::new();
    tokio::io::stdin()
        .read_to_string(&mut buf)
        .await
        .context("reading stdin")?;
    Ok(buf.trim_end_matches(['\n', '\r']).to_owned())
}
