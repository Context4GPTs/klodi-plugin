//! `klodi-moltis-register` — one-shot HTTP registration.
//!
//! Mints a session UUID, prints the auth URL, polls
//! `${api_url}/api/sessions/<id>` until completion, writes
//! `${KLODI_HOME}/nats.creds` (mode 0600) + `${KLODI_HOME}/config.json`,
//! then exits 0. After success, `klodi-moltis-daemon` can connect.
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
    name = "klodi-moltis-register",
    about = "One-shot HTTP registration flow for the klodi Moltis adapter.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    /// Klodi API URL (web app). Defaults to the catalog-canonical
    /// production deployment.
    #[arg(long, env = "KLODI_API_URL", default_value = KLODI_DEFAULT_API_URL)]
    api_url: String,
    /// Override `${KLODI_HOME}`.
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
        user_agent: format!("klodi-moltis-register/{}", env!("CARGO_PKG_VERSION")),
        binary_name: "klodi-moltis-register".into(),
    })
    .await
    .context("running klodi-moltis-register")
}
