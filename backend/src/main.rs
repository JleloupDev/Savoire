// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("SAVOIRE_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=warn,sqlx=warn")),
        )
        .init();
    savoire_server::run().await
}
