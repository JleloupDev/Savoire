// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le domaine : types, enumerations et regles pures (sans base, sans reseau).

use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub type Ts = DateTime<Utc>;

pub fn now() -> Ts {
    Utc::now()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Identifiant sans tirets (Guid.ToString("N")).
pub fn new_id_n() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 32 octets aleatoires en base64url, sans remplissage.
pub fn random_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ── Ressources CRDT ──────────────────────────────────────────────────────────

pub mod crdt {
    pub const DOCUMENT: &str = "document";
    pub const VAULT: &str = "vault";
    pub const ROOM: &str = "room";
    pub const INDEX: &str = "index";
}

// ── Enumerations (valeurs texte en base et dans l'API) ───────────────────────

macro_rules! api_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($text => Some($name::$variant),)+ _ => None }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.as_str()) }
        }
        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> { s.serialize_str(self.as_str()) }
        }
    };
}

api_enum!(Permission { Read => "read", Write => "write", Admin => "admin", None => "none" });
api_enum!(ResourceType { Vault => "vault", Document => "document", Folder => "folder" });
api_enum!(SubjectType { User => "user" });
api_enum!(VaultRole { Owner => "owner", Editor => "editor", Viewer => "viewer" });
// Ce qu'un lien vers une page ouvre en plus d'elle : ses sous-pages (le
// dossier de la page, images comprises), rien, ou les pages qu'elle lie (liste
// fixee a la creation du lien).
api_enum!(ShareScope { Subpages => "subpages", Page => "page", Linked => "linked" });
api_enum!(IndexerMode { Managed => "managed", Organization => "organization", None => "none" });

// ── Agregats ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub created_at: Ts,
}

impl Vault {
    pub fn create(name: &str, owner_id: &str) -> Result<Vault, AppError> {
        if name.trim().is_empty() {
            return Err(AppError::BadArgument("Le nom du vault ne peut pas être vide.".into()));
        }
        Ok(Vault { id: new_id(), name: name.to_string(), owner_id: owner_id.to_string(), created_at: now() })
    }
    pub fn is_owner(&self, user_id: &str) -> bool {
        self.owner_id == user_id
    }
    pub fn require_owner(&self, caller: &str) -> Result<(), AppError> {
        if self.is_owner(caller) {
            Ok(())
        } else {
            Err(AppError::AccessDenied("Cette opération est réservée à l'owner du vault.".into()))
        }
    }
}

#[derive(Debug, Clone)]
pub struct VaultMember {
    pub vault_id: String,
    pub user_id: String,
    pub role: VaultRole,
    pub joined_at: Ts,
}

#[derive(Debug, Clone)]
pub struct Folder {
    pub id: String,
    pub vault_id: String,
    pub path: String,
    pub created_at: Ts,
}

impl Folder {
    pub fn create(vault_id: &str, path: &str) -> Folder {
        Folder { id: new_id(), vault_id: vault_id.into(), path: path.into(), created_at: now() }
    }
}

#[derive(Debug, Clone)]
pub struct Operation {
    pub id: String,
    pub resource_type: String,
    pub resource_id: String,
    pub client_id: String,
    pub produced_at: Ts,
    pub received_at: Ts,
    pub op_bytes: Vec<u8>,
    /// Qui l'a produite : une personne, ou un agent pour elle (ADR-033). Absent : inconnu (operations anciennes, compactions).
    pub author: Option<serde_json::Value>,
}

impl Operation {
    /// La meme operation, avec son auteur.
    pub fn by(mut self, author: serde_json::Value) -> Operation {
        self.author = Some(author);
        self
    }

    pub fn create(resource_type: &str, resource_id: &str, client_id: &str, produced_at: Ts, op_bytes: Vec<u8>) -> Operation {
        Operation {
            id: new_id(),
            resource_type: resource_type.into(),
            resource_id: resource_id.into(),
            client_id: client_id.into(),
            produced_at,
            received_at: now(),
            op_bytes,
            author: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResourcePermission {
    pub id: String,
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub subject_type: SubjectType,
    pub subject_id: String,
    pub permission: Permission,
    pub granted_by: String,
    pub granted_at: Ts,
    pub expires_at: Option<Ts>,
}

impl ResourcePermission {
    pub fn create(
        resource_type: ResourceType,
        resource_id: &str,
        subject_id: &str,
        permission: Permission,
        granted_by: &str,
        expires_at: Option<Ts>,
    ) -> Self {
        ResourcePermission {
            id: new_id(),
            resource_type,
            resource_id: resource_id.into(),
            subject_type: SubjectType::User,
            subject_id: subject_id.into(),
            permission,
            granted_by: granted_by.into(),
            granted_at: now(),
            expires_at,
        }
    }
    pub fn is_expired(&self) -> bool {
        matches!(self.expires_at, Some(e) if e < now())
    }
    pub fn allows_write(&self) -> bool {
        matches!(self.permission, Permission::Write | Permission::Admin)
    }
}

#[derive(Debug, Clone)]
pub struct ShareLink {
    pub id: String,
    pub token: String,
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub permission: Permission,
    pub created_by: String,
    pub created_at: Ts,
    pub expires_at: Option<Ts>,
    pub revoked_at: Option<Ts>,
    pub path: Option<String>,
    pub scope: ShareScope,
}

impl ShareLink {
    pub fn create(
        resource_type: ResourceType,
        resource_id: &str,
        permission: Permission,
        created_by: &str,
        expires_at: Option<Ts>,
        path: Option<&str>,
    ) -> Self {
        ShareLink {
            id: new_id(),
            // see ADR-003
            token: random_token(),
            resource_type,
            resource_id: resource_id.into(),
            permission,
            created_by: created_by.into(),
            created_at: now(),
            expires_at,
            revoked_at: None,
            path: ShareLink::clean_path(path),
            scope: ShareScope::Subpages,
        }
    }
    pub fn is_valid(&self) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|e| e > now())
    }
    pub fn allows_write(&self) -> bool {
        self.permission == Permission::Write && self.is_valid()
    }
    pub fn clean_path(path: Option<&str>) -> Option<String> {
        let path = path?;
        if path.trim().is_empty() {
            return None;
        }
        let p = path.trim().replace('\\', "/");
        let p = p.trim_start_matches('/');
        if p.chars().count() > 512 || p.split('/').any(|s| s == ".." || s.is_empty()) || p.chars().any(char::is_control) {
            return None;
        }
        Some(p.to_string())
    }
}

// ── Dossiers (droits herites) ────────────────────────────────────────────────

pub mod folder_resource {
    /// Identifiant de ressource d'un dossier : « {vaultId}:{dossier normalise} ».
    pub fn id(vault_id: &str, folder: &str) -> String {
        format!("{}:{}", vault_id, normalize(Some(folder)).unwrap_or_default())
    }

    pub fn normalize(folder: Option<&str>) -> Option<String> {
        let folder = folder?;
        let replaced = folder.replace('\\', "/");
        let parts: Vec<&str> = replaced.split('/').filter(|p| !p.is_empty()).collect();
        if parts.iter().any(|p| *p == "." || *p == ".." || p.chars().any(char::is_control)) {
            return None;
        }
        let joined = parts.join("/");
        if joined.encode_utf16().count() > 1024 { None } else { Some(joined) }
    }

    /// Le dossier et ses parents, du plus profond a la racine (exclue).
    pub fn ancestors(folder: Option<&str>) -> Vec<String> {
        let mut out = Vec::new();
        let mut f = normalize(folder).unwrap_or_default();
        while !f.is_empty() {
            out.push(f.clone());
            f = match f.rfind('/') {
                Some(i) => f[..i].to_string(),
                None => String::new(),
            };
        }
        out
    }
}

/// Documents annexes (« {document}~{suffixe} ») : ils suivent leur document.
pub mod annex {
    pub const SEPARATOR: char = '~';
    pub fn parent_of(doc_id: &str) -> Option<&str> {
        let i = doc_id.find(SEPARATOR)?;
        if i > 0 && i < doc_id.len() - 1 { Some(&doc_id[..i]) } else { None }
    }
}

// ── Modeles de lecture ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AccessToken {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub prefix: String,
    pub token_hash: String,
    pub scope: String,
    pub vault_ids: Option<Vec<String>>,
    pub created_at: Ts,
    pub expires_at: Option<Ts>,
    pub last_used_at: Option<Ts>,
    pub revoked_at: Option<Ts>,
    /// L'agent que porte ce jeton (ADR-033). Absent : lecture seule.
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AclSetting {
    pub resource_id: String,
    pub vault_id: String,
    pub inherit: bool,
}

#[derive(Debug, Clone)]
pub struct VaultDocumentRecord {
    pub doc_id: String,
    pub vault_id: String,
    pub parent_doc_id: Option<String>,
    pub name: Option<String>,
    pub folder: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VaultIndexerSetting {
    pub vault_id: String,
    pub mode: IndexerMode,
    pub url: Option<String>,
}

impl VaultIndexerSetting {
    pub fn default_for(vault_id: &str) -> Self {
        VaultIndexerSetting { vault_id: vault_id.into(), mode: IndexerMode::Managed, url: None }
    }
}

#[derive(Debug, Clone)]
pub struct Publication {
    pub slug: String,
    pub vault_id: String,
    pub document_id: String,
    pub title: String,
    pub description: String,
    pub html: String,
    pub indexable: bool,
    pub created_by: String,
    pub created_at: Ts,
    pub updated_at: Ts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexerChange {
    pub seq: i64,
    pub vault_id: String,
    pub kind: String,
    pub doc_id: Option<String>,
}

pub mod indexer_change_kind {
    pub const VAULT: &str = "vault";
    pub const DOCUMENT: &str = "document";
    pub const VAULT_DELETED: &str = "vault-deleted";
    pub const SETTINGS: &str = "settings";
    pub const SETTINGS_SECTIONS: &[&str] = &["properties"];
}

/// Comptes Savoire (table AspNetUsers, gardee telle quelle).
#[derive(Debug, Clone)]
pub struct AppUser {
    pub id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub email_confirmed: bool,
    pub is_admin: bool,
    pub created_at: Ts,
    pub last_login_at: Option<Ts>,
    pub lockout_end: Option<Ts>,
    pub private_key_hex: Option<String>,
}

impl AppUser {
    pub fn is_locked_out(&self) -> bool {
        matches!(self.lockout_end, Some(end) if end > now())
    }
}

// ── Appelants ────────────────────────────────────────────────────────────────

/// Liens de partage (« share:{id} ») et vues integrees (« view:{vault}:{doc}:{perm} »).
pub fn is_share_link_caller(caller: &str) -> bool {
    caller.starts_with("share:")
}

pub fn is_view_caller(caller: &str) -> bool {
    caller.starts_with("view:")
}

pub fn is_link_caller(caller: &str) -> bool {
    is_share_link_caller(caller) || is_view_caller(caller)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_normalize_and_ancestors() {
        assert_eq!(folder_resource::normalize(Some("/A//B/")).as_deref(), Some("A/B"));
        assert_eq!(folder_resource::normalize(Some("A/../B")), None);
        assert_eq!(folder_resource::normalize(Some("A\\B")).as_deref(), Some("A/B"));
        assert_eq!(folder_resource::ancestors(Some("A/B/C")), vec!["A/B/C", "A/B", "A"]);
        assert!(folder_resource::ancestors(Some("")).is_empty());
        assert_eq!(folder_resource::id("v", "/A/B"), "v:A/B");
    }

    #[test]
    fn annex_parent() {
        assert_eq!(annex::parent_of("doc~text"), Some("doc"));
        assert_eq!(annex::parent_of("~text"), None);
        assert_eq!(annex::parent_of("doc~"), None);
        assert_eq!(annex::parent_of("doc"), None);
    }

    #[test]
    fn share_link_clean_path() {
        assert_eq!(ShareLink::clean_path(Some(" /notes/a.md ")).as_deref(), Some("notes/a.md"));
        assert_eq!(ShareLink::clean_path(Some("a/../b")), None);
        assert_eq!(ShareLink::clean_path(Some("a//b")), None);
        assert_eq!(ShareLink::clean_path(Some("   ")), None);
        assert_eq!(ShareLink::clean_path(None), None);
    }

    #[test]
    fn share_link_validity() {
        let mut l = ShareLink::create(ResourceType::Document, "d", Permission::Write, "u", None, None);
        assert!(l.is_valid() && l.allows_write());
        l.expires_at = Some(now() - chrono::Duration::seconds(1));
        assert!(!l.is_valid() && !l.allows_write());
        l.expires_at = None;
        l.revoked_at = Some(now());
        assert!(!l.is_valid());
    }

    #[test]
    fn enums_round_trip() {
        for p in ["read", "write", "admin", "none"] {
            assert_eq!(Permission::parse(p).unwrap().as_str(), p);
        }
        assert!(Permission::parse("READ").is_none());
        assert_eq!(VaultRole::parse("viewer"), Some(VaultRole::Viewer));
        assert_eq!(IndexerMode::parse("organization"), Some(IndexerMode::Organization));
    }

    #[test]
    fn vault_create_requires_name() {
        assert!(Vault::create("  ", "u").is_err());
        let v = Vault::create("Notes", "u").unwrap();
        assert!(v.is_owner("u") && !v.is_owner("x"));
        assert!(v.require_owner("x").is_err());
    }
}
