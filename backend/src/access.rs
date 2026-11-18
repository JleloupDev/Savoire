// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Controle d'acces : comptes (membres, droits herites) et liens de partage.
//
// Droits herites (ACL) : par defaut, un document a les droits de son dossier,
// un dossier ceux de son dossier parent, et tout le vault ceux de ses membres.
// Chaque niveau peut les surcharger :
//  - un droit donne a une personne sur un dossier ou une note l'emporte sur
//    ce qu'elle herite (le plus precis gagne), dans les deux sens : plus de
//    droit ou moins (« none » : aucun acces a une note, pour un membre) ;
//  - un niveau qui n'herite plus (acl_settings.inherit = false) ne garde que
//    les droits donnes a son niveau ou plus bas.
// Le proprietaire et les administrateurs du vault gardent toujours tout.
//
// Les dossiers sont ceux que le client annonce pour chaque document
// (vault_documents.folder) : le serveur ne lit pas l'arborescence CRDT. Un
// document dont le dossier n'est pas encore connu est traite comme a la racine.
//
// Les appelants « share:{id} » (lien de partage) et « view:{vault}:{doc}:{perm} »
// (vue integree) sont verifies contre la portee de leur lien.

use sqlx::PgConnection;

use crate::db::repos;
use crate::domain::*;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Read,
    Write,
    Admin,
}

/// Un droit et d'ou il vient (« owner », « vault », « folder:A/B », « document »).
#[derive(Debug, Clone)]
pub struct AclDecision {
    pub permission: Option<Permission>,
    pub source: String,
}

impl AclDecision {
    fn new(permission: Option<Permission>, source: &str) -> Self {
        AclDecision { permission, source: source.into() }
    }
    pub fn can_write(&self) -> bool {
        matches!(self.permission, Some(Permission::Write | Permission::Admin))
    }
}

pub type AclLevel = (ResourceType, String, String);

// ── Resolution des droits herites ────────────────────────────────────────────

/// Droit de base dans le vault : proprietaire, administrateur, membre (role), ou rien.
pub async fn vault_level(c: &mut PgConnection, caller: &str, vault: &Vault) -> AppResult<AclDecision> {
    if vault.is_owner(caller) {
        return Ok(AclDecision::new(Some(Permission::Admin), "owner"));
    }
    let grant = repos::perm_get(c, ResourceType::Vault, &vault.id, caller).await?;
    if grant.as_ref().is_some_and(|g| g.is_expired()) {
        return Ok(AclDecision::new(None, "vault"));
    }
    if grant.as_ref().is_some_and(|g| g.permission == Permission::Admin) {
        return Ok(AclDecision::new(Some(Permission::Admin), "vault"));
    }
    Ok(match repos::member_get(c, &vault.id, caller).await? {
        None => AclDecision::new(None, "vault"),
        Some(m) => AclDecision::new(
            Some(if m.role == VaultRole::Viewer { Permission::Read } else { Permission::Write }),
            "vault",
        ),
    })
}

/// Les niveaux d'un document, du plus precis au plus large (hors vault).
pub fn levels_of(vault_id: &str, doc_id: &str, folder: Option<&str>) -> Vec<AclLevel> {
    let mut out = vec![(ResourceType::Document, doc_id.to_string(), "document".to_string())];
    out.extend(levels_of_folder(vault_id, folder.unwrap_or("")));
    out
}

/// Les niveaux d'un dossier, de lui-meme a la racine.
pub fn levels_of_folder(vault_id: &str, folder: &str) -> Vec<AclLevel> {
    folder_resource::ancestors(Some(folder))
        .into_iter()
        .map(|f| (ResourceType::Folder, folder_resource::id(vault_id, &f), format!("folder:{f}")))
        .collect()
}

/// Droit effectif sur un document du vault (permission None : aucun acces).
pub async fn for_document(c: &mut PgConnection, caller: &str, vault: &Vault, doc_id: &str) -> AppResult<AclDecision> {
    // Un annexe (texte extrait, commentaires...) suit son document.
    let target = annex::parent_of(doc_id).unwrap_or(doc_id).to_string();
    let doc = repos::doc_get(c, &target).await?;
    let levels = levels_of(&vault.id, &target, doc.as_ref().and_then(|d| d.folder.as_deref()));
    for_levels(c, caller, vault, &levels).await
}

/// Droit effectif sur un dossier du vault.
pub async fn for_folder(c: &mut PgConnection, caller: &str, vault: &Vault, folder: &str) -> AppResult<AclDecision> {
    let levels = levels_of_folder(&vault.id, folder);
    for_levels(c, caller, vault, &levels).await
}

/// Droit effectif en parcourant ces niveaux (du plus precis au plus large), puis le vault.
pub async fn for_levels(c: &mut PgConnection, caller: &str, vault: &Vault, levels: &[AclLevel]) -> AppResult<AclDecision> {
    let base = vault_level(c, caller, vault).await?;
    if base.permission == Some(Permission::Admin) {
        return Ok(base);
    }
    for (rt, id, source) in levels {
        if let Some(entry) = repos::perm_get(c, *rt, id, caller).await?
            && !entry.is_expired()
        {
            let p = if entry.permission == Permission::None { None } else { Some(entry.permission) };
            return Ok(AclDecision::new(p, source));
        }
        if let Some(setting) = repos::acl_get(c, *rt, id).await?
            && !setting.inherit
        {
            return Ok(AclDecision::new(None, source));
        }
    }
    Ok(base)
}

/// Les regles d'acces d'une personne dans un vault, pour le pair indexeur
/// (ADR-033) : il filtre ses resultats avec elles, comme for_levels.
///   { base: "admin" | "write" | "read" | "none",
///     rules: [{ folder | doc, permission }],   droits donnes a la personne
///     closed: [{ folder | doc }] }             niveaux qui n'heritent plus
/// Proprietaire ou administrateur : { base: "admin" } seul (aucun filtre).
pub async fn peer_rules(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<serde_json::Value> {
    use serde_json::json;
    use sqlx::Row;
    let Some(vault) = repos::vault_get(c, vault_id).await? else { return Ok(json!({ "base": "none" })) };
    let base = vault_level(c, caller, &vault).await?;
    let base_text = base.permission.map(|p| p.as_str()).unwrap_or("none");
    if base.permission == Some(Permission::Admin) {
        return Ok(json!({ "base": "admin" }));
    }
    let prefix = format!("{vault_id}:");
    let rows = sqlx::query(
        "SELECT resource_type, resource_id, permission FROM resource_permissions
          WHERE subject_id = $1 AND (expires_at IS NULL OR expires_at > now())
            AND ((resource_type = 'folder' AND starts_with(resource_id, $2))
              OR (resource_type = 'document' AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = $3)))",
    )
    .bind(caller)
    .bind(&prefix)
    .bind(vault_id)
    .fetch_all(&mut *c)
    .await?;
    let mut rules = vec![];
    for r in rows {
        let rt: String = r.get("resource_type");
        let id: String = r.get("resource_id");
        let perm: String = r.get("permission");
        if rt == "folder" {
            rules.push(json!({ "folder": id[prefix.len()..], "permission": perm }));
        } else {
            rules.push(json!({ "doc": id, "permission": perm }));
        }
    }
    let closed_rows = sqlx::query("SELECT resource_type, resource_id FROM acl_settings WHERE vault_id = $1 AND inherit = false")
        .bind(vault_id)
        .fetch_all(&mut *c)
        .await?;
    let mut closed = vec![];
    for r in closed_rows {
        let rt: String = r.get("resource_type");
        let id: String = r.get("resource_id");
        if rt == "folder" {
            if let Some(f) = id.strip_prefix(&prefix) {
                closed.push(json!({ "folder": f }));
            }
        } else if rt == "document" {
            closed.push(json!({ "doc": id }));
        }
    }
    Ok(json!({ "base": base_text, "rules": rules, "closed": closed }))
}

// ── Comptes ──────────────────────────────────────────────────────────────────

/// Le document doit etre inscrit dans le vault annonce.
pub async fn require_document_in_vault(c: &mut PgConnection, vault_id: &str, doc_id: &str) -> AppResult<()> {
    match repos::doc_vault_id(c, doc_id).await? {
        Some(owner) if owner == vault_id => Ok(()),
        _ => Err(AppError::DocumentNotInVault(vault_id.into())),
    }
}

/// Le membre, sauf si le droit qui l'a fait entrer a expire (M7).
async fn active_member(c: &mut PgConnection, vault_id: &str, caller: &str) -> AppResult<Option<VaultMember>> {
    let Some(m) = repos::member_get(c, vault_id, caller).await? else { return Ok(None) };
    let grant = repos::perm_get(c, ResourceType::Vault, vault_id, caller).await?;
    Ok(if grant.is_some_and(|g| g.is_expired()) { None } else { Some(m) })
}

async fn vault_or_404(c: &mut PgConnection, vault_id: &str) -> AppResult<Vault> {
    repos::vault_get(c, vault_id).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.into()))
}

pub async fn require_read(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<()> {
    let vault = vault_or_404(c, vault_id).await?;
    if vault.is_owner(caller) {
        return Ok(());
    }
    active_member(c, vault_id, caller).await?.map(|_| ()).ok_or_else(|| AppError::VaultNotFound(vault_id.into()))
}

pub async fn require_write(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<()> {
    let vault = vault_or_404(c, vault_id).await?;
    if vault.is_owner(caller) {
        return Ok(());
    }
    let m = active_member(c, vault_id, caller).await?.ok_or_else(|| AppError::VaultNotFound(vault_id.into()))?;
    if m.role == VaultRole::Viewer {
        return Err(AppError::denied("Vault viewers cannot modify this vault."));
    }
    Ok(())
}

pub async fn require_admin(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<()> {
    let vault = vault_or_404(c, vault_id).await?;
    if vault.is_owner(caller) {
        return Ok(());
    }
    match repos::perm_get(c, ResourceType::Vault, vault_id, caller).await? {
        Some(p) if !p.is_expired() && p.permission == Permission::Admin => Ok(()),
        _ => Err(AppError::denied("Admin permission is required.")),
    }
}

pub async fn require_document_read(c: &mut PgConnection, caller: &str, vault_id: &str, doc_id: &str) -> AppResult<()> {
    require_document_in_vault(c, vault_id, doc_id).await?;
    let vault = vault_or_404(c, vault_id).await?;
    let d = for_document(c, caller, &vault, doc_id).await?;
    if d.permission.is_none() {
        return Err(AppError::VaultNotFound(vault_id.into()));
    }
    Ok(())
}

pub async fn require_document_write(c: &mut PgConnection, caller: &str, vault_id: &str, doc_id: &str) -> AppResult<()> {
    require_document_in_vault(c, vault_id, doc_id).await?;
    let vault = vault_or_404(c, vault_id).await?;
    let d = for_document(c, caller, &vault, doc_id).await?;
    match d.permission {
        None => Err(AppError::VaultNotFound(vault_id.into())),
        Some(Permission::Read) => Err(AppError::denied("Lecture seule sur ce document.")),
        _ => Ok(()),
    }
}

// ── Liens de partage et vues ─────────────────────────────────────────────────

struct ViewCaller {
    vault_id: String,
    doc_id: String,
    permission: String,
}

/// « view:{vaultId}:{docId}:{permission} ».
fn parse_view_caller(caller: &str) -> AppResult<ViewCaller> {
    let parts: Vec<&str> = caller.splitn(4, ':').collect();
    if parts.len() != 4 || parts[0] != "view" {
        return Err(AppError::denied("Token view invalide."));
    }
    Ok(ViewCaller { vault_id: parts[1].into(), doc_id: parts[2].into(), permission: parts[3].to_lowercase() })
}

async fn valid_link(c: &mut PgConnection, caller: &str) -> AppResult<ShareLink> {
    let id = caller.strip_prefix("share:").unwrap_or(caller);
    match repos::link_by_id(c, id).await? {
        Some(l) if l.is_valid() => Ok(l),
        _ => Err(AppError::denied("Lien de partage invalide ou expiré.")),
    }
}

pub async fn link_vault_read(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<()> {
    // Un jeton de vue n'ouvre qu'UN document : jamais le repertoire du vault.
    if is_view_caller(caller) {
        return Err(AppError::denied("Un jeton de vue n'ouvre qu'un document, pas le vault."));
    }
    let l = valid_link(c, caller).await?;
    if l.resource_type == ResourceType::Vault && l.resource_id == vault_id {
        return Ok(());
    }
    Err(AppError::denied("Lien de partage non valide pour ce vault."))
}

pub async fn link_vault_write(c: &mut PgConnection, caller: &str, vault_id: &str) -> AppResult<()> {
    if is_view_caller(caller) {
        return Err(AppError::denied("Un jeton de vue n'ouvre qu'un document, pas le vault."));
    }
    let l = valid_link(c, caller).await?;
    if l.resource_type == ResourceType::Vault && l.resource_id == vault_id && l.allows_write() {
        return Ok(());
    }
    Err(AppError::denied("Lien de partage sans permission d'écriture sur ce vault."))
}

/// Un lien vers une note lit aussi les pieces jointes rangees dans son dossier ; rien d'autre.
pub async fn link_attachment_read(c: &mut PgConnection, caller: &str, vault_id: &str, attachment_id: &str) -> AppResult<()> {
    if is_view_caller(caller) {
        let view = parse_view_caller(caller)?;
        let attached = repos::doc_get(c, attachment_id).await?;
        if view.vault_id == vault_id
            && attached.is_some_and(|a| a.vault_id == vault_id && a.parent_doc_id.as_deref() == Some(view.doc_id.as_str()))
        {
            return Ok(());
        }
        return Err(AppError::denied("Jeton de vue non valide pour cette piece jointe."));
    }
    let l = valid_link(c, caller).await?;
    if l.resource_type == ResourceType::Vault && l.resource_id == vault_id {
        return Ok(());
    }
    if l.resource_type == ResourceType::Document
        && let Some(file) = repos::doc_get(c, attachment_id).await?
        && file.vault_id == vault_id
        && file.parent_doc_id.as_deref() == Some(l.resource_id.as_str())
    {
        return Ok(());
    }
    Err(AppError::denied("Lien de partage non valide pour cette piece jointe."))
}

pub async fn link_document_read(c: &mut PgConnection, caller: &str, vault_id: &str, doc_id: &str) -> AppResult<()> {
    require_document_in_vault(c, vault_id, doc_id).await?;
    if is_view_caller(caller) {
        let view = parse_view_caller(caller)?;
        if view.vault_id == vault_id && view.doc_id == doc_id {
            return Ok(());
        }
        return Err(AppError::denied("Token view non valide pour ce document."));
    }
    let l = valid_link(c, caller).await?;
    if (l.resource_type == ResourceType::Vault && l.resource_id == vault_id)
        || (l.resource_type == ResourceType::Document && l.resource_id == doc_id)
    {
        return Ok(());
    }
    Err(AppError::denied("Lien de partage non valide pour ce document."))
}

pub async fn link_document_write(c: &mut PgConnection, caller: &str, vault_id: &str, doc_id: &str) -> AppResult<()> {
    require_document_in_vault(c, vault_id, doc_id).await?;
    if is_view_caller(caller) {
        let view = parse_view_caller(caller)?;
        if view.vault_id == vault_id && view.doc_id == doc_id && view.permission == "write" {
            return Ok(());
        }
        return Err(AppError::denied("Token view sans permission d'écriture sur ce document."));
    }
    let l = valid_link(c, caller).await?;
    if ((l.resource_type == ResourceType::Vault && l.resource_id == vault_id)
        || (l.resource_type == ResourceType::Document && l.resource_id == doc_id))
        && l.allows_write()
    {
        return Ok(());
    }
    Err(AppError::denied("Lien de partage sans permission d'écriture sur ce document."))
}

// ── Points d'entree (ex-VaultAccessBehavior) ─────────────────────────────────

/// Droit sur un vault, pour un compte ou un lien.
pub async fn check_vault(c: &mut PgConnection, caller: &str, vault_id: &str, level: Level) -> AppResult<()> {
    if is_link_caller(caller) {
        return match level {
            Level::Write => link_vault_write(c, caller, vault_id).await,
            Level::Admin => Err(AppError::denied("Un lien de partage ne donne jamais l'administration d'un vault.")),
            Level::Read => link_vault_read(c, caller, vault_id).await,
        };
    }
    match level {
        Level::Write => require_write(c, caller, vault_id).await,
        Level::Admin => require_admin(c, caller, vault_id).await,
        Level::Read => require_read(c, caller, vault_id).await,
    }
}

/// Droit sur une piece jointe : comme sur le vault, et pour un lien vers une
/// note, lecture des pieces jointes de son dossier.
pub async fn check_attachment(c: &mut PgConnection, caller: &str, vault_id: &str, attachment_id: &str, level: Level) -> AppResult<()> {
    if is_link_caller(caller) && level == Level::Read {
        return link_attachment_read(c, caller, vault_id, attachment_id).await;
    }
    check_vault(c, caller, vault_id, level).await
}

/// Droit sur un document, pour un compte ou un lien.
pub async fn check_document(c: &mut PgConnection, caller: &str, vault_id: &str, doc_id: &str, level: Level) -> AppResult<()> {
    if is_link_caller(caller) {
        return if level == Level::Write {
            link_document_write(c, caller, vault_id, doc_id).await
        } else {
            link_document_read(c, caller, vault_id, doc_id).await
        };
    }
    if level == Level::Write {
        require_document_write(c, caller, vault_id, doc_id).await
    } else {
        require_document_read(c, caller, vault_id, doc_id).await
    }
}

/// Partager une ressource : proprietaire ou administrateur de SON vault.
pub async fn require_share_right(c: &mut PgConnection, caller: &str, rt: ResourceType, resource_id: &str) -> AppResult<()> {
    let vault_id = if rt == ResourceType::Document {
        repos::doc_vault_id(c, resource_id)
            .await?
            .ok_or_else(|| AppError::denied("Document inconnu : il n'appartient a aucun vault."))?
    } else {
        resource_id.to_string()
    };
    let vault = vault_or_404(c, &vault_id).await?;
    if vault.is_owner(caller) {
        return Ok(());
    }
    if let Some(p) = repos::perm_get(c, ResourceType::Vault, &vault_id, caller).await?
        && p.permission == Permission::Admin
        && !p.is_expired()
    {
        return Ok(());
    }
    Err(AppError::denied("Seul l'owner ou un admin peut partager cette ressource."))
}

/// Refuse les liens de partage et les vues (routes reservees aux comptes).
pub fn require_account(caller: &str, message: &str) -> AppResult<()> {
    if is_link_caller(caller) { Err(AppError::denied(message)) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_levels() {
        let l = levels_of("v", "d", Some("A/B"));
        let ids: Vec<&str> = l.iter().map(|x| x.1.as_str()).collect();
        assert_eq!(ids, vec!["d", "v:A/B", "v:A"]);
        assert_eq!(l[1].2, "folder:A/B");
        assert_eq!(levels_of("v", "d", None).len(), 1);
    }

    #[test]
    fn view_caller_parsing() {
        let v = parse_view_caller("view:v1:d1:WRITE").unwrap();
        assert_eq!((v.vault_id.as_str(), v.doc_id.as_str(), v.permission.as_str()), ("v1", "d1", "write"));
        assert!(parse_view_caller("view:v1:d1").is_err());
    }
}
