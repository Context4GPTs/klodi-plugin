//! `klodi-ironclaw-register` — one-shot HTTP registration.
//!
//! Per **D § D8** the registration body lives in
//! `klodi_rust_host::register`; this binary only binds CLI / env.

use anyhow::{Context, Result};
use clap::Parser;
use klodi_nats_client::KLODI_DEFAULT_API_URL;
use klodi_rust_host::{RegisterArgs, paths, run_register};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-ironclaw-register",
    about = "One-shot HTTP registration flow for the klodi IronClaw adapter.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_API_URL", default_value = KLODI_DEFAULT_API_URL)]
    api_url: String,
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cli = Cli::parse();
    let klodi_home = cli.klodi_home.unwrap_or_else(paths::klodi_home);
    run_register(RegisterArgs {
        api_url: cli.api_url,
        klodi_home,
        user_agent: format!(
            "klodi-ironclaw-register/{}",
            env!("CARGO_PKG_VERSION")
        ),
        binary_name: "klodi-ironclaw-register".into(),
    })
    .await
    .context("running klodi-ironclaw-register")
}
