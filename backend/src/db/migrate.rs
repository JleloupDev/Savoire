// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Migrations du schema : fichiers SQL de migrations/, appliques dans l'ordre,
// chacun une fois (table savoire_migrations).
//
// La premiere (0001_baseline) est le schema laisse par la derniere migration
// EF Core du serveur .NET. Une base deja creee par lui (table vaults presente)
// la marque comme appliquee sans la rejouer : rien n'est perdu a la bascule.

use sqlx::{Connection, PgPool};

use crate::error::AppError;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "baseline",
    sql: include_str!("../../migrations/0001_baseline.sql"),
}];

/// Cle du verrou des migrations (pg_advisory_lock) : deux instances qui
/// demarrent ensemble ne migrent pas en meme temps.
const MIGRATION_LOCK: i64 = 0x5341_564F_4952_4D31;

pub async fn run(pool: &PgPool) -> Result<(), AppError> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)").bind(MIGRATION_LOCK).execute(&mut *conn).await?;
    let result = apply(&mut conn).await;
    sqlx::query("SELECT pg_advisory_unlock($1)").bind(MIGRATION_LOCK).execute(&mut *conn).await?;
    result
}

async fn apply(conn: &mut sqlx::PgConnection) -> Result<(), AppError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS savoire_migrations (
            version bigint PRIMARY KEY,
            name text NOT NULL,
            applied_at timestamp with time zone NOT NULL DEFAULT now()
        )",
    )
    .execute(&mut *conn)
    .await?;

    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM savoire_migrations").fetch_all(&mut *conn).await?;
    let legacy: bool = sqlx::query_scalar("SELECT to_regclass('public.vaults') IS NOT NULL").fetch_one(&mut *conn).await?;

    for m in MIGRATIONS {
        if applied.contains(&m.version) {
            continue;
        }
        let mut tx = conn.begin().await?;
        if m.version == 1 && legacy {
            tracing::info!("Base creee par le serveur .NET : schema de depart deja en place.");
        } else {
            tracing::info!(version = m.version, name = m.name, "Migration du schema");
            sqlx::raw_sql(m.sql).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO savoire_migrations (version, name) VALUES ($1, $2)")
            .bind(m.version)
            .bind(m.name)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(())
}
