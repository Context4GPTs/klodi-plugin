//! Cross-language ack-ordering example (Rust half).
//!
//! Per design Section 6 / P-ACK axis (P1-4 regression guard): under
//! `max_ack_pending: 1` redelivery pressure, the per-language consume
//! loop MUST honor handler-completion-happens-before-ack and
//! next-dispatch-happens-after-ack.
//!
//! Test pattern:
//!   1. Create a unique stream + durable consumer with
//!      `ack_policy: Explicit, max_ack_pending: 1`.
//!   2. Publish 3 messages with body `{"seq": 0|1|2}`.
//!   3. Consume one at a time, awaiting each `msg.ack()` before
//!      pulling the next message — same shape as `src/consumers.rs`.
//!   4. Capture nanosecond timestamps via `std::time::Instant` (monotonic).
//!   5. Cleanup (delete stream).
//!   6. Print `{"events": [...]}` to stdout.
//!
//! The orchestrator at
//! `tests/integration/nats-infra/cross-language-wire/orchestrator-ack.py`
//! asserts per-language `ack[i].t_ns < received[i+1].t_ns`. A no-await
//! regression flips that ordering and surfaces as exit 2.

use async_nats::ConnectOptions;
use async_nats::jetstream::consumer::pull::Config as PullConfig;
use async_nats::jetstream::consumer::{AckPolicy, DeliverPolicy, ReplayPolicy};
use async_nats::jetstream::stream::{Config as StreamConfig, RetentionPolicy};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};
use uuid::Uuid;

const NUM_MESSAGES: usize = 3;
const ACK_WAIT: Duration = Duration::from_secs(30);
const STREAM_MAX_AGE: Duration = Duration::from_secs(5 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
struct EventRecord<'a> {
    event: &'a str,
    seq: u64,
    t_ns: u128,
}

struct Args {
    nats_url: String,
    creds_path: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut argv: Vec<String> = env::args().skip(1).collect();
    if argv.len() % 2 != 0 {
        return Err(format!("uneven argv pairs: {} args", argv.len()));
    }
    let mut map: HashMap<String, String> = HashMap::new();
    while let Some(key) = argv.first().cloned() {
        argv.remove(0);
        let val = argv.remove(0);
        let stripped = key
            .strip_prefix("--")
            .ok_or_else(|| format!("expected --flag, got {key}"))?;
        map.insert(stripped.to_owned(), val);
    }
    let nats_url = map
        .remove("nats-url")
        .ok_or_else(|| "missing --nats-url".to_owned())?;
    let creds_path = map
        .remove("creds-path")
        .ok_or_else(|| "missing --creds-path".to_owned())?;
    Ok(Args {
        nats_url,
        creds_path: PathBuf::from(creds_path),
    })
}

async fn run(args: Args) -> Result<(), String> {
    let creds = fs::read_to_string(&args.creds_path)
        .map_err(|err| format!("creds read failed: {err}"))?;

    let client = ConnectOptions::with_credentials(&creds)
        .map_err(|err| format!("creds parse failed: {err}"))?
        .connect(args.nats_url.as_str())
        .await
        .map_err(|err| format!("nats connect failed: {err}"))?;

    let test_id = Uuid::new_v4().simple().to_string();
    let test_id_short = &test_id[..8];
    let stream_name = format!("ACK_TEST_RS_{}", test_id_short.to_uppercase());
    let subject = format!("cross.lang.ack.rs.{test_id_short}");
    let consumer_name = format!("ack-test-rs-{test_id_short}");

    let ctx = async_nats::jetstream::new(client.clone());

    // Set up a per-test stream so the cleanup (delete_stream) is safe
    // and repeated runs don't accumulate state.
    let stream_config = StreamConfig {
        name: stream_name.clone(),
        subjects: vec![subject.clone()],
        retention: RetentionPolicy::Limits,
        max_age: STREAM_MAX_AGE,
        ..Default::default()
    };
    let stream = ctx
        .create_stream(stream_config)
        .await
        .map_err(|err| format!("create_stream failed: {err}"))?;

    let consumer_config = PullConfig {
        durable_name: Some(consumer_name.clone()),
        ack_policy: AckPolicy::Explicit,
        ack_wait: ACK_WAIT,
        max_deliver: 5,
        max_ack_pending: 1,
        deliver_policy: DeliverPolicy::All,
        replay_policy: ReplayPolicy::Instant,
        ..Default::default()
    };
    let consumer = stream
        .create_consumer(consumer_config)
        .await
        .map_err(|err| format!("create_consumer failed: {err}"))?;

    // Publish 3 messages in order. JetStream preserves stream order so
    // the consumer sees them as seq 0, 1, 2.
    for i in 0..NUM_MESSAGES {
        let body = json!({ "seq": i as u64 }).to_string();
        let ack_future = ctx
            .publish(subject.clone(), body.into())
            .await
            .map_err(|err| format!("publish[{i}] failed: {err}"))?;
        ack_future
            .await
            .map_err(|err| format!("publish[{i}] ack failed: {err}"))?;
    }

    let base = Instant::now();
    let mut events: Vec<serde_json::Value> = Vec::with_capacity(NUM_MESSAGES * 2);
    let mut messages = consumer
        .messages()
        .await
        .map_err(|err| format!("consumer.messages failed: {err}"))?;

    for _ in 0..NUM_MESSAGES {
        let next = tokio::time::timeout(FETCH_TIMEOUT, messages.next())
            .await
            .map_err(|_| "consumer.next timed out".to_owned())?;
        let msg = match next {
            Some(Ok(msg)) => msg,
            Some(Err(err)) => {
                return Err(format!("consumer stream error: {err}"));
            }
            None => return Err("consumer stream ended early".to_owned()),
        };

        let t_recv = base.elapsed().as_nanos();
        let body: serde_json::Value = serde_json::from_slice(&msg.payload)
            .map_err(|err| format!("body parse failed: {err}"))?;
        let seq = body
            .get("seq")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "missing seq in body".to_owned())?;
        events.push(serde_json::to_value(EventRecord {
            event: "received",
            seq,
            t_ns: t_recv,
        }).expect("serialize received"));

        // Mirror the production loop's discipline: await the ack so the
        // next dispatch happens-after the prior ack lands on the wire.
        msg.ack()
            .await
            .map_err(|err| format!("ack failed: {err}"))?;
        let t_ack = base.elapsed().as_nanos();
        events.push(serde_json::to_value(EventRecord {
            event: "ack_returned",
            seq,
            t_ns: t_ack,
        }).expect("serialize ack_returned"));
    }

    // Cleanup so repeated runs don't accumulate streams.
    ctx.delete_stream(&stream_name)
        .await
        .map_err(|err| format!("delete_stream failed: {err}"))?;

    client
        .drain()
        .await
        .map_err(|err| format!("drain failed: {err}"))?;

    let out = json!({ "events": events });
    println!("{}", serde_json::to_string(&out).expect("serialize"));
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
