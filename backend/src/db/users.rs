// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Comptes Savoire : table AspNetUsers, gardee telle que l'avait ASP.NET
// Identity (sans mot de passe : la connexion se fait chez le fournisseur
// d'identite, ADR-028). Les colonnes normalisees (NormalizedEmail,
// NormalizedUserName) sont en majuscules, comme le faisait Identity.

use chrono::TimeZone;
use sqlx::{PgConnection, Row};

use crate::domain::{AppUser, Ts, now};
use crate::error::AppResult;

const COLS: &str = r#""Id", "DisplayName", "Email", "EmailConfirmed", "IsAdmin", "CreatedAt", "LastLoginAt", "LockoutEnabled", "LockoutEnd", "PrivateKeyHex""#;

fn row(r: &sqlx::postgres::PgRow) -> AppUser {
    let lockout_enabled: bool = r.get("LockoutEnabled");
    let lockout_end: Option<Ts> = r.get("LockoutEnd");
    AppUser {
        id: r.get("Id"),
        display_name: r.get("DisplayName"),
        email: r.get("Email"),
        email_confirmed: r.get("EmailConfirmed"),
        is_admin: r.get("IsAdmin"),
        created_at: r.get("CreatedAt"),
        last_login_at: r.get("LastLoginAt"),
        // Identity : verrouille seulement si le verrouillage est active.
        lockout_end: if lockout_enabled { lockout_end } else { None },
        private_key_hex: r.get("PrivateKeyHex"),
    }
}

pub fn normalize(s: &str) -> String {
    s.to_uppercase()
}

pub async fn by_id(c: &mut PgConnection, id: &str) -> AppResult<Option<AppUser>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(r#"SELECT {COLS} FROM "AspNetUsers" WHERE "Id" = $1"#)))
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(row))
}

pub async fn by_email(c: &mut PgConnection, email: &str) -> AppResult<Option<AppUser>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(r#"SELECT {COLS} FROM "AspNetUsers" WHERE "NormalizedEmail" = $1 LIMIT 1"#)))
        .bind(normalize(email.trim()))
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(row))
}

pub async fn exists(c: &mut PgConnection, id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar(r#"SELECT EXISTS (SELECT 1 FROM "AspNetUsers" WHERE "Id" = $1)"#).bind(id).fetch_one(&mut *c).await?)
}

pub async fn all(c: &mut PgConnection) -> AppResult<Vec<AppUser>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(r#"SELECT {COLS} FROM "AspNetUsers" ORDER BY "CreatedAt""#))).fetch_all(&mut *c).await?;
    Ok(rows.iter().map(row).collect())
}

pub async fn by_ids(c: &mut PgConnection, ids: &[String]) -> AppResult<Vec<AppUser>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(r#"SELECT {COLS} FROM "AspNetUsers" WHERE "Id" = ANY($1)"#)))
        .bind(ids)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows.iter().map(row).collect())
}

/// Cree le compte. Faux si un compte de meme id (ou meme nom) existe deja.
pub async fn create(c: &mut PgConnection, u: &AppUser) -> AppResult<bool> {
    let stamp = uuid::Uuid::new_v4().simple().to_string().to_uppercase();
    let res = sqlx::query(
        r#"INSERT INTO "AspNetUsers" ("Id", "DisplayName", "CreatedAt", "LastLoginAt", "IsAdmin", "PrivateKeyHex",
              "UserName", "NormalizedUserName", "Email", "NormalizedEmail", "EmailConfirmed", "PasswordHash",
              "SecurityStamp", "ConcurrencyStamp", "PhoneNumber", "PhoneNumberConfirmed", "TwoFactorEnabled",
              "LockoutEnd", "LockoutEnabled", "AccessFailedCount")
           VALUES ($1, $2, $3, $4, $5, NULL, $1, $6, $7, $8, $9, NULL, $10, $11, NULL, false, false, NULL, true, 0)
           ON CONFLICT DO NOTHING"#,
    )
    .bind(&u.id)
    .bind(&u.display_name)
    .bind(u.created_at)
    .bind(u.last_login_at)
    .bind(u.is_admin)
    .bind(normalize(&u.id))
    .bind(&u.email)
    .bind(u.email.as_deref().map(normalize))
    .bind(u.email_confirmed)
    .bind(stamp)
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(&mut *c)
    .await;
    match res {
        Ok(r) => Ok(r.rows_affected() > 0),
        Err(e) if crate::db::is_unique_violation(&e) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub async fn update_profile(c: &mut PgConnection, u: &AppUser) -> AppResult<()> {
    sqlx::query(
        r#"UPDATE "AspNetUsers" SET "Email" = $2, "NormalizedEmail" = $3, "EmailConfirmed" = $4, "IsAdmin" = $5,
              "LastLoginAt" = $6, "ConcurrencyStamp" = $7 WHERE "Id" = $1"#,
    )
    .bind(&u.id)
    .bind(&u.email)
    .bind(u.email.as_deref().map(normalize))
    .bind(u.email_confirmed)
    .bind(u.is_admin)
    .bind(u.last_login_at)
    .bind(uuid::Uuid::new_v4().to_string())
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Bloque le compte pour toujours (DateTimeOffset.MaxValue cote Identity).
pub async fn lock_forever(c: &mut PgConnection, id: &str) -> AppResult<()> {
    let forever = chrono::Utc.with_ymd_and_hms(9999, 12, 31, 23, 59, 59).unwrap();
    sqlx::query(r#"UPDATE "AspNetUsers" SET "LockoutEnabled" = true, "LockoutEnd" = $2, "ConcurrencyStamp" = $3 WHERE "Id" = $1"#)
        .bind(id)
        .bind(forever)
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn delete(c: &mut PgConnection, id: &str) -> AppResult<()> {
    sqlx::query(r#"DELETE FROM "AspNetUsers" WHERE "Id" = $1"#).bind(id).execute(&mut *c).await?;
    Ok(())
}

pub async fn set_private_key(c: &mut PgConnection, id: &str, hex: &str) -> AppResult<()> {
    sqlx::query(r#"UPDATE "AspNetUsers" SET "PrivateKeyHex" = $2 WHERE "Id" = $1"#).bind(id).bind(hex).execute(&mut *c).await?;
    Ok(())
}

pub fn is_locked(u: &AppUser) -> bool {
    matches!(u.lockout_end, Some(end) if end > now())
}
