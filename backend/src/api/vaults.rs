// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vaults et membres :
//   GET    /api/v1/users/{userId}/vaults
//   POST   /api/v1/users/{userId}/vaults               { name }
//   PATCH  /api/v1/vaults/{vaultId}                    { name }
//   DELETE /api/v1/vaults/{vaultId}
//   POST   /api/v1/vaults/{vaultId}/members            { userId, role }
//   DELETE /api/v1/vaults/{vaultId}/members/{memberId}
//   POST   /api/v1/vaults/{vaultId}/members/identity   { signPubBase64 }
//   GET    /api/v1/vaults/{vaultId}/members/identities
// Comptes :
//   GET    /api/v1/users?email=...    GET /api/v1/users/{userId}

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Body, Policy, ReqParts, bad_request, client_ip, no_content, ok, rate};
use crate::access::{self, Level};
use crate::auth::Auth;
use crate::db::{repos, users};
use crate::domain::{Ts, Vault, VaultMember, VaultRole, is_link_caller, now};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummaryDto {
    pub id: String,
    pub name: String,
    pub role: String,
    pub document_count: i32,
    pub folder_count: i32,
    pub last_modified_at: Option<Ts>,
    pub size_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub vaults: Vec<VaultSummaryDto>,
    pub shared_with_me: Vec<serde_json::Value>,
}

/// Les vaults de la personne (et leurs statistiques).
pub async fn workspace(st: &AppState, user_id: &str) -> AppResult<WorkspaceDto> {
    let mut c = st.db.acquire().await?;
    let mut list = vec![];
    for (v, role) in repos::vaults_for_user(&mut c, user_id).await? {
        // Le nombre et la taille des documents ne sont pas connus du serveur (CRDT).
        let folders = repos::folder_count(&mut c, &v.id).await?;
        list.push(VaultSummaryDto { id: v.id, name: v.name, role: role.as_str().into(), document_count: 0, folder_count: folders as i32, last_modified_at: None, size_bytes: 0 });
    }
    Ok(WorkspaceDto { vaults: list, shared_with_me: vec![] })
}

pub async fn list(State(st): State<AppState>, Auth(_): Auth, Path(user_id): Path<String>) -> AppResult<Response> {
    Ok(ok(&workspace(&st, &user_id).await?))
}

#[derive(Deserialize)]
pub struct CreateVaultRequest {
    #[serde(default)]
    name: Option<String>,
}

pub async fn create(
    State(st): State<AppState>,
    Auth(p): Auth,
    ReqParts(parts): ReqParts,
    Path(user_id): Path<String>,
    Body(req): Body<CreateVaultRequest>,
) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::VaultCreate, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let max = st.limits().vaults_per_account;
    if max > 0 && st.quota.owned_vault_count(&user_id).await? as i64 >= max {
        return Err(AppError::QuotaExceeded(format!("Un compte a {max} vaults au plus. Supprimez-en un pour en créer un autre.")));
    }
    let vault = Vault::create(req.name.as_deref().unwrap_or(""), &user_id)?;
    let mut c = st.db.acquire().await?;
    repos::vault_add(&mut c, &vault).await?;
    let dto = VaultSummaryDto { id: vault.id, name: vault.name, role: "owner".into(), document_count: 0, folder_count: 0, last_modified_at: None, size_bytes: 0 };
    let mut r = ok(&dto);
    *r.status_mut() = axum::http::StatusCode::CREATED;
    Ok(r)
}

async fn owned_vault(c: &mut sqlx::PgConnection, vault_id: &str, caller: &str) -> AppResult<Vault> {
    let v = repos::vault_get(c, vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.into()))?;
    v.require_owner(caller)?;
    Ok(v)
}

pub async fn rename(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<CreateVaultRequest>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let v = owned_vault(&mut c, &vault_id, &p.sub).await?;
    let name = req.name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err(AppError::BadArgument("Nouveau nom invalide.".into()));
    }
    repos::vault_rename(&mut c, &v.id, &name).await?;
    let folders = repos::folder_count(&mut c, &v.id).await?;
    Ok(ok(&VaultSummaryDto { id: v.id, name, role: "owner".into(), document_count: 0, folder_count: folders as i32, last_modified_at: None, size_bytes: 0 }))
}

pub async fn delete(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    owned_vault(&mut c, &vault_id, &p.sub).await?;
    repos::vault_delete(&mut c, &vault_id).await?;
    drop(c);
    // Les fichiers, une fois la base validee : un echec laisse des fichiers
    // sans vault, que la purge des restes retrouve.
    if let Err(e) = st.store.delete_vault(&vault_id).await {
        tracing::warn!(vault = %vault_id, error = %e, "Vault supprime : fichiers non effaces");
    }
    st.quota.invalidate(&vault_id);
    // Plus aucun membre : les sessions ouvertes le constatent et ferment le vault.
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberRequest {
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    role: String,
}

pub async fn add_member(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<AddMemberRequest>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let v = owned_vault(&mut c, &vault_id, &p.sub).await?;
    if !users::exists(&mut c, &req.user_id).await? {
        return Err(AppError::denied(format!("Utilisateur inconnu : {}", req.user_id)));
    }
    if v.is_owner(&req.user_id) || repos::member_get(&mut c, &vault_id, &req.user_id).await?.is_some() {
        return Err(AppError::PathConflict(format!("L'utilisateur '{}' est déjà membre de ce vault.", req.user_id)));
    }
    let role = VaultRole::parse(&req.role).ok_or_else(|| AppError::BadArgument(format!("Unknown VaultRole: '{}'", req.role)))?;
    repos::member_upsert(&mut c, &VaultMember { vault_id: vault_id.clone(), user_id: req.user_id.clone(), role, joined_at: now() }).await?;
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(ok(&json!({ "message": format!("Member '{}' added with role '{}'.", req.user_id, req.role) })))
}

pub async fn remove_member(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, member_id)): Path<(String, String)>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let v = owned_vault(&mut c, &vault_id, &p.sub).await?;
    if v.is_owner(&member_id) {
        return Err(AppError::denied("Impossible de retirer l'owner d'un vault."));
    }
    repos::member_remove(&mut c, &vault_id, &member_id).await?;
    repos::member_identities_remove_user(&mut c, &vault_id, &member_id).await?;
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequest {
    #[serde(default)]
    sign_pub_base64: String,
}

fn from_b64(s: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|_| AppError::BadArgument("Base64 invalide.".into()))
}

pub async fn register_identity(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<IdentityRequest>) -> AppResult<Response> {
    let sign_pub = from_b64(&req.sign_pub_base64)?;
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    repos::member_identity_add(&mut c, &vault_id, &p.sub, &sign_pub).await?;
    Ok(no_content())
}

pub async fn identities(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    let v = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;
    // Proprietaire et membres : le proprietaire n'a pas de ligne dans vault_members.
    let mut allowed: HashSet<String> = HashSet::from([v.owner_id.clone()]);
    for m in repos::members(&mut c, &vault_id).await? {
        allowed.insert(m.user_id);
    }
    let keys: Vec<String> = repos::member_identities(&mut c, &vault_id)
        .await?
        .into_iter()
        .filter(|(u, _)| allowed.contains(u))
        .map(|(_, k)| base64::engine::general_purpose::STANDARD.encode(k))
        .collect();
    Ok(ok(&json!({ "signPubsBase64": keys })))
}

// ── Comptes ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EmailQuery {
    email: Option<String>,
}

fn require_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne donne pas acces aux comptes."));
    }
    Ok(())
}

/// Un compte connecte retrouve UN autre compte, par son adresse exacte : son nom, rien d'autre.
pub async fn user_by_email(State(st): State<AppState>, Auth(p): Auth, ReqParts(parts): ReqParts, Query(q): Query<EmailQuery>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Lookup, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    require_account(&p.sub)?;
    let Some(email) = q.email.filter(|e| !e.trim().is_empty() && e.chars().count() <= 320) else {
        return Ok(bad_request("Adresse attendue : /api/v1/users?email=..."));
    };
    let mut c = st.db.acquire().await?;
    Ok(match users::by_email(&mut c, email.trim()).await? {
        Some(u) => ok(&json!({ "id": u.id, "displayName": u.display_name })),
        None => super::status(404),
    })
}

pub async fn user_by_id(State(st): State<AppState>, Auth(p): Auth, ReqParts(parts): ReqParts, Path(user_id): Path<String>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Lookup, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    Ok(match users::by_id(&mut c, &user_id).await? {
        Some(u) => ok(&json!({ "id": u.id, "displayName": u.display_name })),
        None => super::status(404),
    })
}
