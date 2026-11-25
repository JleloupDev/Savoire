// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques pour l'IA (epingles, surlignages) : personnelles, par note.
// Voir migrations/0005_ai_marks.sql et api/editor_context.rs.

use serde_json::Value;
use sqlx::{PgConnection, Row};

use crate::domain::Ts;
use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct AiMarkRow {
    pub id: String,
    pub user_id: String,
    pub vault_id: String,
    pub doc_id: String,
    /// 'pin' ou 'highlight'.
    pub kind: String,
    pub label: String,
    /// Chemin de la note quand la marque a ete posee (ou rafraichie).
    pub path: String,
    /// { docId, start, end, quote, prefix, suffix }.
    pub anchor: Value,
    pub created_at: Ts,
}

const COLS: &str = "id, user_id, vault_id, doc_id, kind, label, path, anchor, created_at";

fn row(r: &sqlx::postgres::PgRow) -> AiMarkRow {
    AiMarkRow {
        id: r.get("id"),
        user_id: r.get("user_id"),
        vault_id: r.get("vault_id"),
        doc_id: r.get("doc_id"),
        kind: r.get("kind"),
        label: r.get("label"),
        path: r.get("path"),
        anchor: r.get("anchor"),
        created_at: r.get("created_at"),
    }
}

pub async fn insert(c: &mut PgConnection, m: &AiMarkRow) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO ai_marks ({COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")))
        .bind(&m.id)
        .bind(&m.user_id)
        .bind(&m.vault_id)
        .bind(&m.doc_id)
        .bind(&m.kind)
        .bind(&m.label)
        .bind(&m.path)
        .bind(&m.anchor)
        .bind(m.created_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn get(c: &mut PgConnection, id: &str) -> AppResult<Option<AiMarkRow>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {COLS} FROM ai_marks WHERE id = $1"))).bind(id).fetch_optional(&mut *c).await?;
    Ok(r.as_ref().map(row))
}

/// Les marques de la personne, les plus recentes d'abord. Filtres facultatifs.
pub async fn list(c: &mut PgConnection, user_id: &str, vault_id: Option<&str>, doc_id: Option<&str>, kind: Option<&str>, limit: i64) -> AppResult<Vec<AiMarkRow>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM ai_marks
          WHERE user_id = $1 AND ($2::text IS NULL OR vault_id = $2) AND ($3::text IS NULL OR doc_id = $3) AND ($4::text IS NULL OR kind = $4)
          ORDER BY created_at DESC, id LIMIT $5"
    )))
    .bind(user_id)
    .bind(vault_id)
    .bind(doc_id)
    .bind(kind)
    .bind(limit)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(row).collect())
}

pub async fn count(c: &mut PgConnection, user_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM ai_marks WHERE user_id = $1").bind(user_id).fetch_one(&mut *c).await?)
}

/// Le texte du passage a change : l'ancre (memes positions) et le chemin suivent.
pub async fn update(c: &mut PgConnection, user_id: &str, id: &str, label: Option<&str>, path: Option<&str>, anchor: Option<&Value>) -> AppResult<bool> {
    let n = sqlx::query(
        "UPDATE ai_marks SET label = coalesce($3, label), path = coalesce($4, path), anchor = coalesce($5, anchor)
          WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .bind(label)
    .bind(path)
    .bind(anchor)
    .execute(&mut *c)
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub async fn delete(c: &mut PgConnection, user_id: &str, id: &str) -> AppResult<bool> {
    let n = sqlx::query("DELETE FROM ai_marks WHERE id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&mut *c).await?.rows_affected();
    Ok(n > 0)
}

/// Efface des marques d'un coup (« effacer les surlignages IA »). Rend leur nombre.
pub async fn clear(c: &mut PgConnection, user_id: &str, vault_id: Option<&str>, doc_id: Option<&str>, kind: Option<&str>) -> AppResult<u64> {
    Ok(sqlx::query(
        "DELETE FROM ai_marks
          WHERE user_id = $1 AND ($2::text IS NULL OR vault_id = $2) AND ($3::text IS NULL OR doc_id = $3) AND ($4::text IS NULL OR kind = $4)",
    )
    .bind(user_id)
    .bind(vault_id)
    .bind(doc_id)
    .bind(kind)
    .execute(&mut *c)
    .await?
    .rows_affected())
}
