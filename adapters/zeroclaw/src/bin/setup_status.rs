//! `klodi-zeroclaw-setup-status` — daemon CLI surface for `klodi_setup_status`.

use anyhow::Result;
use clap::Parser;
use klodi_rust_host::{klodi_setup_status, paths};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-setup-status",
    about = "Report klodi setup phase + missing files for the ZeroClaw daemon.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let klodi_home = cli.klodi_home.unwrap_or_else(paths::klodi_home);
    let status = klodi_setup_status(&klodi_home);
    let json = serde_json::to_string_pretty(&status)?;
    println!("{json}");
    Ok(())
}
