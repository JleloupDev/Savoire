// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Administration de l'instance (administrateurs : Auth:AdminEmails) :
//   GET    /api/v1/admin/users
//   POST   /api/v1/admin/users/{userId}/disable
//   DELETE /api/v1/admin/users/{userId}
//   POST   /api/v1/admin/orphans/purge?dryRun=true
//   GET    /api/v1/admin/feedback?archived=false
//   GET    /api/v1/admin/feedback/{id}/screenshot
//   POST   /api/v1/admin/feedback/{id}/archive      { archived }
//   DELETE /api/v1/admin/feedback/{id}

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::Connection;

use super::{Body, no_content, ok, status};
use crate::auth::AdminAuth;
use crate::db::{repos, users};
use crate::domain::now;
use crate::error::AppResult;
use crate::state::AppState;

pub async fn list_users(State(st): State<AppState>, AdminAuth(_): AdminAuth) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let list: Vec<Value> = users::all(&mut c)
        .await?
        .into_iter()
        .map(|u| {
            let locked = users::is_locked(&u);
            json!({
                "id": u.id, "email": u.email.unwrap_or_default(), "displayName": u.display_name, "isAdmin": u.is_admin,
                "createdAt": u.created_at, "lastLoginAt": u.last_login_at, "isLockedOut": locked,
            })
        })
        .collect();
    Ok(ok(&list))
}

pub async fn disable_user(State(st): State<AppState>, AdminAuth(_): AdminAuth, Path(user_id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    if !users::exists(&mut c, &user_id).await? {
        return Err(crate::error::AppError::UserNotFound(user_id));
    }
    users::lock_forever(&mut c, &user_id).await?;
    drop(c);
    // Ses jetons, encore valides chez l'IdP, sont refuses des maintenant.
    st.auth.forget(&user_id);
    // Ses connexions ouvertes ne recoivent plus rien.
    st.realtime.caller_access_changed(&st, &user_id).await;
    Ok(no_content())
}

pub async fn delete_user(State(st): State<AppState>, AdminAuth(_): AdminAuth, Path(user_id): Path<String>) -> AppResult<Response> {
    crate::services::accounts::delete_account(&st, &user_id).await?;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeQuery {
    dry_run: Option<bool>,
}

/// Restes de vaults supprimes (lignes et fichiers sans vault) : les compter ou les effacer.
pub async fn purge_orphans(State(st): State<AppState>, AdminAuth(_): AdminAuth, Query(q): Query<PurgeQuery>) -> AppResult<Response> {
    let dry_run = q.dry_run.unwrap_or(true);
    let mut c = st.db.acquire().await?;
    let mut tx = c.begin().await?;
    let counts = repos::purge_orphan_rows(&mut tx, dry_run).await?;
    let known: HashSet<String> = repos::vault_all(&mut tx).await?.into_iter().map(|v| v.id).collect();
    let folders: Vec<String> = st.store.list_vault_ids().await?.into_iter().filter(|id| !known.contains(id)).collect();
    let mut bytes = 0i64;
    for id in &folders {
        bytes += st.store.vault_bytes(id).await?;
    }
    if dry_run {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
        for id in &folders {
            st.store.delete_vault(id).await?;
        }
    }
    let mut rows = Map::new();
    for (k, v) in counts {
        rows.insert(k.to_string(), json!(v));
    }
    Ok(ok(&json!({ "dryRun": dry_run, "rows": rows, "fileFolders": folders.len(), "fileBytes": bytes })))
}

#[derive(Deserialize)]
pub struct FeedbackQuery {
    archived: Option<bool>,
}

pub async fn list_feedback(State(st): State<AppState>, AdminAuth(_): AdminAuth, Query(q): Query<FeedbackQuery>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let rows = repos::feedback_list(&mut c, q.archived.unwrap_or(false)).await?;
    let mut ids: Vec<String> = rows.iter().map(|r| r.user_id.clone()).collect();
    ids.sort();
    ids.dedup();
    let by_id: HashMap<String, crate::domain::AppUser> = users::by_ids(&mut c, &ids).await?.into_iter().map(|u| (u.id.clone(), u)).collect();
    let list: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let u = by_id.get(&r.user_id);
            json!({
                "id": r.id, "userId": r.user_id, "userName": u.map(|u| u.display_name.clone()), "userEmail": u.and_then(|u| u.email.clone()),
                "message": r.message, "context": r.context, "userAgent": r.user_agent, "hasScreenshot": r.has_screenshot,
                "createdAt": r.created_at, "archivedAt": r.archived_at,
            })
        })
        .collect();
    Ok(ok(&list))
}

pub async fn screenshot(State(st): State<AppState>, AdminAuth(_): AdminAuth, Path(id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let Some((bytes, kind)) = repos::feedback_screenshot(&mut c, &id).await? else { return Ok(status(404)) };
    let mut r = bytes.into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&kind).unwrap_or(HeaderValue::from_static("image/png")));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok(r)
}

#[derive(Deserialize)]
pub struct ArchiveRequest {
    #[serde(default)]
    archived: bool,
}

pub async fn archive_feedback(State(st): State<AppState>, AdminAuth(_): AdminAuth, Path(id): Path<String>, Body(req): Body<ArchiveRequest>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let done = repos::feedback_set_archived(&mut c, &id, req.archived.then(now)).await?;
    Ok(if done { no_content() } else { status(404) })
}

pub async fn delete_feedback(State(st): State<AppState>, AdminAuth(_): AdminAuth, Path(id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    Ok(if repos::feedback_delete(&mut c, &id).await? { no_content() } else { status(404) })
}
