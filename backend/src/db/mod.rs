// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// PostgreSQL (ADR-028) : une seule base pour tout l'etat du serveur. Le schema
// est celui qu'avait laisse le serveur .NET (EF Core) : une base existante est
// reprise telle quelle.
//
// Chaque fonction prend une connexion (`&mut PgConnection`) : une connexion du
// pool, ou une transaction ouverte par l'appelant. Celles qui doivent ecrire
// plusieurs lignes ensemble ouvrent leur propre transaction avec
// `Connection::begin`, qui devient un point de sauvegarde si l'appelant en a
// deja une (comme BeginIfNone cote .NET).

pub mod agents;
pub mod ai_marks;
pub mod indexer_feed;
pub mod migrate;
pub mod repos;
pub mod users;

pub use sqlx::PgConnection;
pub use sqlx::PgPool;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

use crate::error::AppError;

/// Pool de connexions depuis une chaine de connexion, au format Npgsql
/// (« Host=...;Port=...;Database=...;Username=...;Password=... ») ou URL.
pub async fn connect(conn: &str) -> Result<PgPool, AppError> {
    let opts = parse_connection_string(conn)?;
    PgPoolOptions::new()
        .max_connections(32)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect_with(opts)
        .await
        .map_err(AppError::from)
}

pub fn parse_connection_string(conn: &str) -> Result<PgConnectOptions, AppError> {
    let conn = conn.trim();
    if conn.starts_with("postgres://") || conn.starts_with("postgresql://") {
        return conn.parse::<PgConnectOptions>().map_err(AppError::from);
    }
    let mut opts = PgConnectOptions::new();
    for part in conn.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().replace(' ', "").as_str() {
            "host" | "server" => opts = opts.host(v),
            "port" => opts = opts.port(v.parse().map_err(|_| AppError::internal("Port invalide"))?),
            "database" | "db" => opts = opts.database(v),
            "username" | "userid" | "user" | "uid" => opts = opts.username(v),
            "password" | "pwd" => opts = opts.password(v),
            "sslmode" => {
                let mode = match v.to_ascii_lowercase().as_str() {
                    "disable" => sqlx::postgres::PgSslMode::Disable,
                    "require" => sqlx::postgres::PgSslMode::Require,
                    "verifyca" | "verify-ca" => sqlx::postgres::PgSslMode::VerifyCa,
                    "verifyfull" | "verify-full" => sqlx::postgres::PgSslMode::VerifyFull,
                    "allow" => sqlx::postgres::PgSslMode::Allow,
                    _ => sqlx::postgres::PgSslMode::Prefer,
                };
                opts = opts.ssl_mode(mode);
            }
            _ => {}
        }
    }
    Ok(opts)
}

/// Violation d'unicite (23505).
pub fn is_unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("23505"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_npgsql_strings() {
        let o = super::parse_connection_string("Host=127.0.0.1;Port=5433;Database=s;Username=u;Password=p").unwrap();
        assert_eq!(o.get_host(), "127.0.0.1");
        assert_eq!(o.get_port(), 5433);
        assert_eq!(o.get_database(), Some("s"));
        assert_eq!(o.get_username(), "u");
    }
}
