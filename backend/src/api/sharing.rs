// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Partage : droits, liens, droits herites (ACL) et jetons de vue.
//   GET    /api/v1/vaults/{vaultId}/sharing
//   POST   /api/v1/vaults/{vaultId}/sharing/permissions
//   DELETE /api/v1/vaults/{vaultId}/sharing/permissions/{targetUserId}
//   POST   /api/v1/vaults/{vaultId}/sharing/links
//   GET    /api/v1/documents/{docId}/sharing (+ permissions, links)
//   DELETE /api/v1/sharing/links/{linkId}
//   GET    /api/v1/share/{token}/access                       (sans compte)
//   GET    /api/v1/vaults/{vaultId}/acl?docId=|folder=
//   PUT    /api/v1/vaults/{vaultId}/acl/inherit               { docId|folder, inherit }
//   PUT    /api/v1/vaults/{vaultId}/acl/entries               { docId|folder, subjectId, permission, expiresAt? }
//   DELETE /api/v1/vaults/{vaultId}/acl/entries?docId|folder&subjectId=
//   POST   /api/v1/vaults/{vaultId}/acl/folders/rename        { from, to }
//   PUT    /api/v1/vaults/{vaultId}/documents/folders         [{ docId, folder }]
//   POST   /api/v1/view/internal-grants  /api/v1/view/grants  /api/v1/view/grants/redeem

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;

use super::{Body, Policy, ReqParts, client_ip, no_content, ok, rate};
use crate::access::{self, AclDecision};
use crate::auth::{self, Auth, MaybeAuth, ViewGrant};
use crate::db::{repos, users};
use crate::domain::*;
use crate::error::{AppError, AppResult};
use crate::options::JwtOptions;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDto {
    id: String,
    resource_type: String,
    resource_id: String,
    subject_type: String,
    subject_id: String,
    subject_display_name: Option<String>,
    permission: String,
    granted_by: String,
    granted_at: Ts,
    expires_at: Option<Ts>,
}

fn perm_dto(p: &ResourcePermission, name: Option<String>) -> PermissionDto {
    PermissionDto {
        id: p.id.clone(),
        resource_type: p.resource_type.as_str().into(),
        resource_id: p.resource_id.clone(),
        subject_type: p.subject_type.as_str().into(),
        subject_id: p.subject_id.clone(),
        subject_display_name: name,
        permission: p.permission.as_str().into(),
        granted_by: p.granted_by.clone(),
        granted_at: p.granted_at,
        expires_at: p.expires_at,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDto {
    id: String,
    token: String,
    resource_type: String,
    resource_id: String,
    permission: String,
    created_by: String,
    created_at: Ts,
    expires_at: Option<Ts>,
    revoked_at: Option<Ts>,
    is_valid: bool,
}

fn link_dto(l: &ShareLink) -> LinkDto {
    LinkDto {
        id: l.id.clone(),
        token: l.token.clone(),
        resource_type: l.resource_type.as_str().into(),
        resource_id: l.resource_id.clone(),
        permission: l.permission.as_str().into(),
        created_by: l.created_by.clone(),
        created_at: l.created_at,
        expires_at: l.expires_at,
        revoked_at: l.revoked_at,
        is_valid: l.is_valid(),
    }
}

fn parse_rt(s: &str) -> AppResult<ResourceType> {
    ResourceType::parse(s).ok_or_else(|| AppError::BadArgument(format!("Unknown ResourceType: '{s}'")))
}

fn parse_perm(s: &str) -> AppResult<Permission> {
    Permission::parse(s).ok_or_else(|| AppError::BadArgument(format!("Unknown Permission: '{s}'")))
}

async fn display_name(c: &mut PgConnection, user_id: &str) -> AppResult<Option<String>> {
    Ok(users::by_id(c, user_id).await?.map(|u| u.display_name))
}

// ── Droits et liens ──────────────────────────────────────────────────────────

async fn sharing_of(st: &AppState, caller: &str, rt: &str, rid: &str) -> AppResult<Response> {
    let t = parse_rt(rt)?;
    let mut c = st.db.acquire().await?;
    access::require_share_right(&mut c, caller, t, rid).await?;
    let mut perms = vec![];
    for p in repos::perms_for_resource(&mut c, t, rid).await? {
        let name = display_name(&mut c, &p.subject_id).await?;
        perms.push(perm_dto(&p, name));
    }
    let links: Vec<LinkDto> = repos::links_for_resource(&mut c, t, rid).await?.iter().map(link_dto).collect();
    Ok(ok(&json!({ "resourceType": rt, "resourceId": rid, "permissions": perms, "links": links })))
}

pub async fn vault_sharing(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>) -> AppResult<Response> {
    sharing_of(&st, &p.sub, "vault", &vault_id).await
}

pub async fn document_sharing(State(st): State<AppState>, Auth(p): Auth, Path(doc_id): Path<String>) -> AppResult<Response> {
    sharing_of(&st, &p.sub, "document", &doc_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    #[serde(default)]
    subject_id: String,
    #[serde(default)]
    permission: String,
    expires_at: Option<Ts>,
}

async fn grant(st: &AppState, caller: &str, rt: &str, rid: &str, req: GrantRequest) -> AppResult<Response> {
    let t = parse_rt(rt)?;
    let permission = parse_perm(&req.permission)?;
    // « Aucun acces » surcharge un droit herite : sur un dossier ou une note, jamais sur le vault.
    if permission == Permission::None && t == ResourceType::Vault {
        return Err(AppError::BadArgument("Permission invalide : « none » s'emploie sur un dossier ou une note.".into()));
    }
    let mut c = st.db.acquire().await?;
    access::require_share_right(&mut c, caller, t, rid).await?;
    if let Some(existing) = repos::perm_get(&mut c, t, rid, &req.subject_id).await? {
        repos::perm_delete(&mut c, &existing.id).await?;
    }
    let perm = ResourcePermission::create(t, rid, &req.subject_id, permission, caller, req.expires_at);
    repos::perm_add(&mut c, &perm).await?;
    if t == ResourceType::Vault {
        let role = if permission == Permission::Read { VaultRole::Viewer } else { VaultRole::Editor };
        repos::member_upsert(&mut c, &VaultMember { vault_id: rid.into(), user_id: req.subject_id.clone(), role, joined_at: now() }).await?;
    }
    let name = display_name(&mut c, &req.subject_id).await?;
    drop(c);
    if t == ResourceType::Vault {
        st.realtime.vault_membership_changed(st, rid).await;
    }
    Ok(ok(&perm_dto(&perm, name)))
}

pub async fn grant_vault(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<GrantRequest>) -> AppResult<Response> {
    grant(&st, &p.sub, "vault", &vault_id, req).await
}

pub async fn grant_document(State(st): State<AppState>, Auth(p): Auth, Path(doc_id): Path<String>, Body(req): Body<GrantRequest>) -> AppResult<Response> {
    grant(&st, &p.sub, "document", &doc_id, req).await
}

async fn revoke(st: &AppState, caller: &str, rt: &str, rid: &str, target: &str) -> AppResult<Response> {
    let t = parse_rt(rt)?;
    let mut c = st.db.acquire().await?;
    access::require_share_right(&mut c, caller, t, rid).await?;
    let perm = repos::perm_get(&mut c, t, rid, target)
        .await?
        .ok_or_else(|| AppError::denied(format!("Aucune permission trouvee pour {target} sur {rt}/{rid}.")))?;
    repos::perm_delete(&mut c, &perm.id).await?;
    if t == ResourceType::Vault {
        repos::member_remove(&mut c, rid, target).await?;
        repos::member_identities_remove_user(&mut c, rid, target).await?;
    }
    drop(c);
    match t {
        ResourceType::Vault => st.realtime.vault_membership_changed(st, rid).await,
        ResourceType::Document => st.realtime.access_revoked(st, rid, target).await,
        ResourceType::Folder => {}
    }
    Ok(no_content())
}

pub async fn revoke_vault(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, target)): Path<(String, String)>) -> AppResult<Response> {
    revoke(&st, &p.sub, "vault", &vault_id, &target).await
}

pub async fn revoke_document(State(st): State<AppState>, Auth(p): Auth, Path((doc_id, target)): Path<(String, String)>) -> AppResult<Response> {
    revoke(&st, &p.sub, "document", &doc_id, &target).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
    #[serde(default)]
    permission: String,
    expires_at: Option<Ts>,
    path: Option<String>,
}

async fn create_link(st: &AppState, caller: &str, rt: &str, rid: &str, req: LinkRequest) -> AppResult<Response> {
    let permission = parse_perm(&req.permission)?;
    let t = parse_rt(rt)?;
    if permission == Permission::None {
        return Err(AppError::BadArgument("Permission invalide : un lien de partage donne un acces.".into()));
    }
    if permission == Permission::Admin {
        return Err(AppError::BadArgument("Permission invalide : 'admin' n'est pas autorise sur un lien de partage.".into()));
    }
    let mut c = st.db.acquire().await?;
    access::require_share_right(&mut c, caller, t, rid).await?;
    let path = if t == ResourceType::Document { req.path.as_deref() } else { None };
    let link = ShareLink::create(t, rid, permission, caller, req.expires_at, path);
    repos::link_add(&mut c, &link).await?;
    Ok(ok(&link_dto(&link)))
}

pub async fn link_vault(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<LinkRequest>) -> AppResult<Response> {
    create_link(&st, &p.sub, "vault", &vault_id, LinkRequest { path: None, ..req }).await
}

pub async fn link_document(State(st): State<AppState>, Auth(p): Auth, Path(doc_id): Path<String>, Body(req): Body<LinkRequest>) -> AppResult<Response> {
    create_link(&st, &p.sub, "document", &doc_id, req).await
}

pub async fn revoke_link(State(st): State<AppState>, Auth(p): Auth, Path(link_id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let Some(link) = repos::link_by_id(&mut c, &link_id).await? else { return Ok(no_content()) };
    access::require_share_right(&mut c, &p.sub, link.resource_type, &link.resource_id).await?;
    repos::link_set_revoked(&mut c, &link.id, Some(now())).await?;
    drop(c);
    st.realtime.caller_access_changed(&st, &format!("share:{}", link.id)).await;
    Ok(no_content())
}

/// Echange un lien de partage contre un jeton limite.
pub async fn access_link(State(st): State<AppState>, ReqParts(parts): ReqParts, Path(token): Path<String>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let mut c = st.db.acquire().await?;
    let link = match repos::link_by_token(&mut c, &token).await? {
        Some(l) if l.is_valid() => l,
        _ => return Err(AppError::denied("Lien de partage invalide ou expire.")),
    };
    let jwt = auth::share_link_token(&JwtOptions::from(&st.settings()), &link)?;
    // Le vault se lit dans le registre ; le chemin n'est que dans le repertoire CRDT.
    let vault_id = if link.resource_type == ResourceType::Vault {
        Some(link.resource_id.clone())
    } else {
        repos::doc_vault_id(&mut c, &link.resource_id).await?
    };
    Ok(ok(&json!({
        "accessToken": jwt,
        "resourceType": link.resource_type.as_str(),
        "resourceId": link.resource_id,
        "permission": link.permission.as_str(),
        "expiresAt": link.expires_at,
        "vaultId": vault_id,
        "path": link.path,
    })))
}

// ── Droits herites (ACL) ─────────────────────────────────────────────────────

struct Target {
    vault_id: String,
    doc_id: Option<String>,
    folder: Option<String>,
}

/// Un dossier ou un document du vault : exactement l'un des deux.
fn resolve(t: &Target) -> AppResult<(ResourceType, String, Option<String>)> {
    if let Some(d) = t.doc_id.as_deref().filter(|d| !d.is_empty())
        && t.folder.is_none()
    {
        return Ok((ResourceType::Document, d.to_string(), None));
    }
    if t.doc_id.is_none()
        && let Some(f) = &t.folder
    {
        let folder = folder_resource::normalize(Some(f)).filter(|f| !f.is_empty()).ok_or_else(|| AppError::validation("Dossier invalide."))?;
        return Ok((ResourceType::Folder, folder_resource::id(&t.vault_id, &folder), Some(folder)));
    }
    Err(AppError::validation("Donner docId OU folder."))
}

/// Gerer les droits : proprietaire ou administrateur du vault ; le document doit etre dans ce vault.
async fn require_manage(c: &mut PgConnection, caller: &str, t: &Target) -> AppResult<Vault> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne gere pas les droits."));
    }
    if let Some(d) = &t.doc_id
        && repos::doc_vault_id(c, d).await?.as_deref() != Some(t.vault_id.as_str())
    {
        return Err(AppError::DocumentNotInVault(t.vault_id.clone()));
    }
    access::require_share_right(c, caller, ResourceType::Vault, &t.vault_id).await?;
    repos::vault_get(c, &t.vault_id).await?.ok_or_else(|| AppError::VaultNotFound(t.vault_id.clone()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclQuery {
    doc_id: Option<String>,
    folder: Option<String>,
    subject_id: Option<String>,
}

pub async fn acl_get(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Query(q): Query<AclQuery>) -> AppResult<Response> {
    let t = Target { vault_id, doc_id: q.doc_id, folder: q.folder };
    let mut c = st.db.acquire().await?;
    let vault = require_manage(&mut c, &p.sub, &t).await?;
    let (rt, id, folder) = resolve(&t)?;
    let setting = repos::acl_get(&mut c, rt, &id).await?;
    let mut entries = vec![];
    for perm in repos::perms_for_resource(&mut c, rt, &id).await? {
        if !perm.is_expired() {
            let name = display_name(&mut c, &perm.subject_id).await?;
            entries.push(json!({ "subjectId": perm.subject_id, "displayName": name, "permission": perm.permission.as_str(), "expiresAt": perm.expires_at }));
        }
    }
    // Ce qui vient d'au-dessus : le niveau sans lui-meme.
    let parent_folder = if rt == ResourceType::Document {
        repos::doc_get(&mut c, t.doc_id.as_deref().unwrap_or_default()).await?.and_then(|d| d.folder)
    } else {
        let f = folder.clone().unwrap_or_default();
        Some(match f.rfind('/') {
            Some(i) => f[..i].to_string(),
            None => String::new(),
        })
    };
    let parents = access::levels_of_folder(&vault.id, parent_folder.as_deref().unwrap_or(""));
    let mut subjects: Vec<String> = vec![vault.owner_id.clone()];
    let mut seen: HashSet<String> = subjects.iter().cloned().collect();
    for m in repos::members(&mut c, &vault.id).await? {
        if seen.insert(m.user_id.clone()) {
            subjects.push(m.user_id);
        }
    }
    for (pt, pid, _) in &parents {
        for perm in repos::perms_for_resource(&mut c, *pt, pid).await? {
            if seen.insert(perm.subject_id.clone()) {
                subjects.push(perm.subject_id);
            }
        }
    }
    // Montre meme quand ce niveau n'herite plus : la personne voit ce qu'elle a coupe.
    let mut inherited: Vec<(Option<String>, serde_json::Value)> = vec![];
    for s in subjects {
        let d: AclDecision = access::for_levels(&mut c, &s, &vault, &parents).await?;
        if let Some(perm) = d.permission {
            let name = display_name(&mut c, &s).await?;
            inherited.push((name.clone(), json!({ "subjectId": s, "displayName": name, "permission": perm.as_str(), "source": d.source })));
        }
    }
    inherited.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ok(&json!({
        "level": if rt == ResourceType::Document { "document" } else { "folder" },
        "docId": t.doc_id,
        "folder": folder,
        "inherit": !setting.is_some_and(|s| !s.inherit),
        "entries": entries,
        "inherited": inherited.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritRequest {
    doc_id: Option<String>,
    folder: Option<String>,
    #[serde(default)]
    inherit: bool,
}

pub async fn acl_inherit(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<InheritRequest>) -> AppResult<Response> {
    let t = Target { vault_id: vault_id.clone(), doc_id: req.doc_id, folder: req.folder };
    let mut c = st.db.acquire().await?;
    require_manage(&mut c, &p.sub, &t).await?;
    let (rt, id, _) = resolve(&t)?;
    repos::acl_set(&mut c, rt, &id, &vault_id, req.inherit, &p.sub).await?;
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRequest {
    doc_id: Option<String>,
    folder: Option<String>,
    #[serde(default)]
    subject_id: String,
    #[serde(default)]
    permission: String,
    expires_at: Option<Ts>,
}

pub async fn acl_set_entry(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<EntryRequest>) -> AppResult<Response> {
    let t = Target { vault_id: vault_id.clone(), doc_id: req.doc_id, folder: req.folder };
    let mut c = st.db.acquire().await?;
    let vault = require_manage(&mut c, &p.sub, &t).await?;
    let (rt, id, _) = resolve(&t)?;
    let permission = parse_perm(&req.permission)?;
    if req.subject_id == vault.owner_id {
        return Err(AppError::validation("Le proprietaire du vault garde tous les droits."));
    }
    if !users::exists(&mut c, &req.subject_id).await? {
        return Err(AppError::UserNotFound(req.subject_id));
    }
    if let Some(existing) = repos::perm_get(&mut c, rt, &id, &req.subject_id).await? {
        repos::perm_delete(&mut c, &existing.id).await?;
    }
    repos::perm_add(&mut c, &ResourcePermission::create(rt, &id, &req.subject_id, permission, &p.sub, req.expires_at)).await?;
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

pub async fn acl_remove_entry(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Query(q): Query<AclQuery>) -> AppResult<Response> {
    let t = Target { vault_id: vault_id.clone(), doc_id: q.doc_id, folder: q.folder };
    let subject = q.subject_id.ok_or_else(|| AppError::validation("subjectId requis."))?;
    let mut c = st.db.acquire().await?;
    require_manage(&mut c, &p.sub, &t).await?;
    let (rt, id, _) = resolve(&t)?;
    if let Some(existing) = repos::perm_get(&mut c, rt, &id, &subject).await? {
        repos::perm_delete(&mut c, &existing.id).await?;
    }
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

#[derive(Deserialize)]
pub struct RenameRequest {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

/// Un dossier renomme ou deplace : ses droits et ceux de son contenu suivent. Redacteurs du vault.
pub async fn acl_rename_folder(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<RenameRequest>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, access::Level::Write).await?;
    let from = folder_resource::normalize(Some(&req.from)).filter(|f| !f.is_empty()).ok_or_else(|| AppError::validation("Dossier invalide."))?;
    let to = folder_resource::normalize(Some(&req.to)).filter(|f| !f.is_empty()).ok_or_else(|| AppError::validation("Dossier invalide."))?;
    if from == to {
        return Ok(no_content());
    }
    let vault = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;
    // Il faut pouvoir ecrire la ou il est, et la ou il va.
    for f in [&from, &to] {
        if !access::for_folder(&mut c, &p.sub, &vault, f).await?.can_write() {
            return Err(AppError::denied("Droit d'ecriture requis sur le dossier."));
        }
    }
    repos::acl_rename_folder(&mut c, &vault_id, &from, &to).await?;
    drop(c);
    st.realtime.vault_membership_changed(&st, &vault_id).await;
    Ok(no_content())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFolder {
    #[serde(default)]
    doc_id: String,
    #[serde(default)]
    folder: Option<String>,
}

const MAX_PLACED: usize = 500;

/// Le client annonce le dossier de documents. Rend les documents refuses.
pub async fn place_documents(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(docs): Body<Vec<DocumentFolder>>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, access::Level::Write).await?;
    if docs.len() > MAX_PLACED {
        return Err(AppError::validation(format!("{MAX_PLACED} documents au plus par envoi.")));
    }
    let vault = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;
    let mut rejected = vec![];
    let mut changed = false;
    for d in docs {
        let doc = repos::doc_get(&mut c, &d.doc_id).await?;
        let folder = folder_resource::normalize(d.folder.as_deref());
        let (Some(doc), Some(folder)) = (doc, folder) else {
            rejected.push(d.doc_id);
            continue;
        };
        if doc.vault_id != vault_id {
            rejected.push(d.doc_id);
            continue;
        }
        if doc.folder.as_deref() == Some(folder.as_str()) {
            continue;
        }
        let can_here = access::for_document(&mut c, &p.sub, &vault, &d.doc_id).await?.can_write();
        let can_there = if folder.is_empty() {
            access::vault_level(&mut c, &p.sub, &vault).await?.can_write()
        } else {
            access::for_folder(&mut c, &p.sub, &vault, &folder).await?.can_write()
        };
        if !can_here || !can_there {
            rejected.push(d.doc_id);
            continue;
        }
        repos::doc_set_folder(&mut c, &d.doc_id, &folder).await?;
        changed = true;
    }
    drop(c);
    if changed {
        st.realtime.vault_membership_changed(&st, &vault_id).await;
    }
    Ok(ok(&json!({ "rejected": rejected })))
}

// ── Jetons de vue (iframe) ───────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantViewRequest {
    vault_id: Option<String>,
    doc_id: Option<String>,
    path: Option<String>,
    permission: Option<String>,
    share_token: Option<String>,
}

async fn create_view_grant(st: &AppState, caller: Option<String>, share_token: Option<String>, req: &GrantViewRequest) -> AppResult<Response> {
    let permission = match req.permission.as_deref().unwrap_or("read").trim().to_lowercase().as_str() {
        "read" => "read",
        "write" => "write",
        _ => return Err(AppError::denied("Permission invalide (read|write).")),
    };
    let (Some(doc_id), Some(vault_id)) = (
        req.doc_id.clone().filter(|d| !d.trim().is_empty()),
        req.vault_id.clone().filter(|v| !v.trim().is_empty()),
    ) else {
        return Err(AppError::denied("docId et vaultId sont requis."));
    };
    let path = req.path.clone().unwrap_or_default();
    let mut c = st.db.acquire().await?;
    // Le vault ne se croit jamais sur parole : le document doit y etre inscrit.
    if repos::doc_vault_id(&mut c, &doc_id).await?.as_deref() != Some(vault_id.as_str()) {
        return Err(AppError::denied("Ce document n'appartient pas a ce vault."));
    }
    let mut user_for_presence = caller.clone();
    let write = permission == "write";
    if let Some(token) = share_token.filter(|t| !t.trim().is_empty()) {
        let link = match repos::link_by_token(&mut c, &token).await? {
            Some(l) if l.is_valid() => l,
            _ => return Err(AppError::denied("Lien de partage invalide ou expire.")),
        };
        let allowed = match link.resource_type {
            ResourceType::Vault => link.resource_id == vault_id,
            ResourceType::Document => link.resource_id == doc_id,
            ResourceType::Folder => false,
        };
        if !allowed {
            return Err(AppError::denied("Lien de partage non valide pour ce document."));
        }
        if write && !link.allows_write() {
            return Err(AppError::denied("Lien de partage sans permission d'ecriture."));
        }
        user_for_presence = Some(format!("share:{}", link.id));
    } else if let Some(cid) = caller.as_deref().filter(|c| is_link_caller(c)) {
        if write {
            access::link_document_write(&mut c, cid, &vault_id, &doc_id).await?;
        } else {
            access::link_document_read(&mut c, cid, &vault_id, &doc_id).await?;
        }
    } else {
        let Some(cid) = caller.as_deref().filter(|c| !c.trim().is_empty()) else {
            return Err(AppError::denied("Authentification requise."));
        };
        let vault = repos::vault_get(&mut c, &vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.clone()))?;
        if !vault.is_owner(cid) {
            let m = repos::member_get(&mut c, &vault_id, cid).await?.ok_or_else(|| AppError::denied("Acces refuse."))?;
            if write && m.role == VaultRole::Viewer {
                return Err(AppError::denied("Permission d'ecriture requise."));
            }
        }
    }
    let expires = now() + chrono::Duration::minutes(2);
    let g = ViewGrant { vault_id: vault_id.clone(), doc_id: doc_id.clone(), path: path.clone(), permission: permission.into(), user_id: user_for_presence, expires_at: expires };
    let token = auth::view_grant_token(&JwtOptions::from(&st.settings()), &g)?;
    tracing::info!(doc = %doc_id, "Jeton de vue cree");
    Ok(ok(&json!({ "grantToken": token, "vaultId": vault_id, "docId": doc_id, "path": path, "permission": permission, "expiresAt": expires })))
}

pub async fn internal_grant(State(st): State<AppState>, Auth(p): Auth, Body(req): Body<GrantViewRequest>) -> AppResult<Response> {
    create_view_grant(&st, Some(p.sub), None, &req).await
}

pub async fn grant_view(State(st): State<AppState>, MaybeAuth(p): MaybeAuth, ReqParts(parts): ReqParts, Body(req): Body<GrantViewRequest>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let token = req.share_token.clone();
    create_view_grant(&st, p.map(|p| p.sub), token, &req).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemRequest {
    #[serde(default)]
    grant_token: String,
}

pub async fn redeem_view(State(st): State<AppState>, ReqParts(parts): ReqParts, Body(req): Body<RedeemRequest>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let jwt = JwtOptions::from(&st.settings());
    let g = auth::read_view_grant(&jwt, &req.grant_token)?;
    let token = auth::view_access_token(&jwt, &g)?;
    Ok(ok(&json!({
        "accessToken": token,
        "vaultId": g.vault_id,
        "docId": g.doc_id,
        "path": g.path,
        "permission": g.permission,
        "expiresAt": now() + chrono::Duration::hours(8),
        "userId": g.user_id,
    })))
}
