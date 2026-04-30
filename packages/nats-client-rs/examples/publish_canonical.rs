//! Cross-language wire test publisher (Rust half).
//!
//! Per **R § P2-9**: TS / Py / Rust `publish_channel_message` MUST emit
//! byte-equivalent wire output for the same logical event. This binary
//! is the Rust publisher half — it builds the production
//! channel-message body with externally-supplied (deterministic)
//! inputs and publishes once to a designated subject. The orchestrator
//! at `tests/integration/cross-language-wire/orchestrator.py` drives
//! all three publishers with the same inputs and asserts byte-equivalence
//! after subscription capture.
//!
//! Why bypass `publish_channel_message`'s built-in event_id /
//! message_id minting: the contract under test is "given the same
//! inputs, all three serializers produce the same JSON bytes". The
//! randomness inside the production helper is correct for production
//! but defeats a wire-equivalence test. The body assembly + serializer
//! choice is what's under test here — and this binary mirrors the
//! production layout in `src/publish.rs` field-for-field.
//!
//! Usage (driven by orchestrator.py):
//!   cargo run --example publish_canonical -- \
//!     --nats-url <url> --creds-path <path> \
//!     --subject <subject> --channel-id <id> --sender-user-id <id> \
//!     --sender-handle <handle> --content <content> \
//!     --event-id <id> --message-id <id> --created-at <iso8601>

use async_nats::ConnectOptions;
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Serialize)]
struct ChannelMessagePayload<'a> {
    kind: &'static str,
    event_id: &'a str,
    channel_id: &'a str,
    message_id: &'a str,
    sender_user_id: &'a str,
    sender_handle: &'a str,
    content: &'a str,
    created_at: &'a str,
}

#[derive(Debug)]
struct CanonicalArgs {
    nats_url: String,
    creds_path: PathBuf,
    subject: String,
    channel_id: String,
    sender_user_id: String,
    sender_handle: String,
    content: String,
    event_id: String,
    message_id: String,
    created_at: String,
}

fn parse_args() -> Result<CanonicalArgs, String> {
    let mut argv: Vec<String> = env::args().skip(1).collect();
    if argv.len() % 2 != 0 {
        return Err(format!("uneven argv pairs: {} args", argv.len()));
    }
    let mut map: HashMap<String, String> = HashMap::new();
    while let Some(key) = argv.first().cloned() {
        argv.remove(0);
        let val = argv.remove(0);
        let stripped = key.strip_prefix("--").ok_or_else(|| {
            format!("expected --flag, got {key}")
        })?;
        map.insert(stripped.to_owned(), val);
    }
    let mut take = |k: &str| -> Result<String, String> {
        map.remove(k).ok_or_else(|| format!("missing --{k}"))
    };
    Ok(CanonicalArgs {
        nats_url: take("nats-url")?,
        creds_path: PathBuf::from(take("creds-path")?),
        subject: take("subject")?,
        channel_id: take("channel-id")?,
        sender_user_id: take("sender-user-id")?,
        sender_handle: take("sender-handle")?,
        content: take("content")?,
        event_id: take("event-id")?,
        message_id: take("message-id")?,
        created_at: take("created-at")?,
    })
}

async fn run(args: CanonicalArgs) -> Result<(), String> {
    let creds = fs::read_to_string(&args.creds_path)
        .map_err(|err| format!("creds read failed: {err}"))?;

    let client = ConnectOptions::with_credentials(&creds)
        .map_err(|err| format!("creds parse failed: {err}"))?
        .connect(args.nats_url.as_str())
        .await
        .map_err(|err| format!("nats connect failed: {err}"))?;

    let payload = ChannelMessagePayload {
        kind: "channel.message",
        event_id: &args.event_id,
        channel_id: &args.channel_id,
        message_id: &args.message_id,
        sender_user_id: &args.sender_user_id,
        sender_handle: &args.sender_handle,
        content: &args.content,
        created_at: &args.created_at,
    };
    let body = serde_json::to_vec(&payload)
        .map_err(|err| format!("serialize failed: {err}"))?;

    // Use core publish (not JetStream) so the orchestrator's plain
    // subscription captures the body verbatim. The wire bytes that
    // matter are the JSON body — JetStream would add an ack envelope
    // around the same payload, confusing byte-equivalence.
    client
        .publish(args.subject, body.into())
        .await
        .map_err(|err| format!("publish failed: {err}"))?;
    client
        .flush()
        .await
        .map_err(|err| format!("flush failed: {err}"))?;
    println!("rs:published");
    client
        .drain()
        .await
        .map_err(|err| format!("drain failed: {err}"))?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(err) => {
            eprintln!("rs:error {err}");
            return ExitCode::FAILURE;
        }
    };
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("rs:error {err}");
            ExitCode::FAILURE
        }
    }
}
