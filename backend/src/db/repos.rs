// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Acces aux tables (une section par table ou groupe de tables).

use std::collections::{HashMap, HashSet};

use sqlx::{Connection, PgConnection, Row};

use crate::db::indexer_feed;
use crate::domain::*;
use crate::error::{AppError, AppResult};

fn parse_perm(s: &str) -> Permission {
    Permission::parse(s).unwrap_or(Permission::None)
}
fn parse_rt(s: &str) -> ResourceType {
    ResourceType::parse(s).unwrap_or(ResourceType::Document)
}

// ── Vaults ───────────────────────────────────────────────────────────────────

fn vault_row(r: &sqlx::postgres::PgRow) -> Vault {
    Vault { id: r.get("id"), name: r.get("name"), owner_id: r.get("owner_id"), created_at: r.get("created_at") }
}

pub async fn vault_get(c: &mut PgConnection, id: &str) -> AppResult<Option<Vault>> {
    let r = sqlx::query("SELECT id, name, owner_id, created_at FROM vaults WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(vault_row))
}

pub async fn vault_all(c: &mut PgConnection) -> AppResult<Vec<Vault>> {
    let rows = sqlx::query("SELECT id, name, owner_id, created_at FROM vaults ORDER BY id").fetch_all(&mut *c).await?;
    Ok(rows.iter().map(vault_row).collect())
}

/// Les vaults de la personne (proprietaire ou membre), avec son role, par date de creation.
pub async fn vaults_for_user(c: &mut PgConnection, user_id: &str) -> AppResult<Vec<(Vault, VaultRole)>> {
    let rows = sqlx::query(
        "SELECT v.id, v.name, v.owner_id, v.created_at, 'owner' AS role FROM vaults v WHERE v.owner_id = $1
         UNION ALL
         SELECT v.id, v.name, v.owner_id, v.created_at, m.role FROM vault_members m
           JOIN vaults v ON v.id = m.vault_id
          WHERE m.user_id = $1 AND v.owner_id <> $1
         ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows
        .iter()
        .map(|r| (vault_row(r), VaultRole::parse(r.get::<&str, _>("role")).unwrap_or(VaultRole::Viewer)))
        .collect())
}

pub async fn vaults_owned_by(c: &mut PgConnection, owner_id: &str) -> AppResult<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT id, name FROM vaults WHERE owner_id = $1").bind(owner_id).fetch_all(&mut *c).await?;
    Ok(rows.iter().map(|r| (r.get("id"), r.get("name"))).collect())
}

pub async fn vault_add(c: &mut PgConnection, v: &Vault) -> AppResult<()> {
    sqlx::query("INSERT INTO vaults (id, name, owner_id, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&v.id)
        .bind(&v.name)
        .bind(&v.owner_id)
        .bind(v.created_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn vault_rename(c: &mut PgConnection, id: &str, name: &str) -> AppResult<()> {
    sqlx::query("UPDATE vaults SET name = $2 WHERE id = $1").bind(id).bind(name).execute(&mut *c).await?;
    Ok(())
}

pub async fn folder_count(c: &mut PgConnection, vault_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM folders WHERE vault_id = $1").bind(vault_id).fetch_one(&mut *c).await?)
}

// ── Membres ──────────────────────────────────────────────────────────────────

fn member_row(r: &sqlx::postgres::PgRow) -> VaultMember {
    VaultMember {
        vault_id: r.get("vault_id"),
        user_id: r.get("user_id"),
        role: VaultRole::parse(r.get::<&str, _>("role")).unwrap_or(VaultRole::Viewer),
        joined_at: r.get("joined_at"),
    }
}

pub async fn members(c: &mut PgConnection, vault_id: &str) -> AppResult<Vec<VaultMember>> {
    let rows = sqlx::query("SELECT vault_id, user_id, role, joined_at FROM vault_members WHERE vault_id = $1")
        .bind(vault_id)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows.iter().map(member_row).collect())
}

pub async fn member_get(c: &mut PgConnection, vault_id: &str, user_id: &str) -> AppResult<Option<VaultMember>> {
    let r = sqlx::query("SELECT vault_id, user_id, role, joined_at FROM vault_members WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(member_row))
}

pub async fn member_upsert(c: &mut PgConnection, m: &VaultMember) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO vault_members (vault_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_id, user_id) DO UPDATE SET role = EXCLUDED.role, joined_at = EXCLUDED.joined_at",
    )
    .bind(&m.vault_id)
    .bind(&m.user_id)
    .bind(m.role.as_str())
    .bind(m.joined_at)
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn member_remove(c: &mut PgConnection, vault_id: &str, user_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *c)
        .await?;
    Ok(())
}

// ── Dossiers ─────────────────────────────────────────────────────────────────

fn folder_row(r: &sqlx::postgres::PgRow) -> Folder {
    Folder { id: r.get("id"), vault_id: r.get("vault_id"), path: r.get("path"), created_at: r.get("created_at") }
}

pub async fn folder_get(c: &mut PgConnection, id: &str) -> AppResult<Option<Folder>> {
    let r = sqlx::query("SELECT id, vault_id, path, created_at FROM folders WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(folder_row))
}

pub async fn folder_by_path(c: &mut PgConnection, vault_id: &str, path: &str) -> AppResult<Option<Folder>> {
    let r = sqlx::query("SELECT id, vault_id, path, created_at FROM folders WHERE vault_id = $1 AND path = $2")
        .bind(vault_id)
        .bind(path)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(folder_row))
}

pub async fn folder_list(c: &mut PgConnection, vault_id: &str) -> AppResult<Vec<Folder>> {
    let rows = sqlx::query("SELECT id, vault_id, path, created_at FROM folders WHERE vault_id = $1 ORDER BY path")
        .bind(vault_id)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows.iter().map(folder_row).collect())
}

/// Ajoute le dossier ; sans effet s'il existe deja (meme id ou meme chemin).
pub async fn folder_add(c: &mut PgConnection, f: &Folder) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO folders (id, vault_id, path, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(&f.id)
    .bind(&f.vault_id)
    .bind(&f.path)
    .bind(f.created_at)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Le dossier et ses sous-dossiers. Les documents, eux, sont dans le CRDT.
pub async fn folder_delete_recursive(c: &mut PgConnection, f: &Folder) -> AppResult<()> {
    let prefix = format!("{}/", f.path);
    sqlx::query("DELETE FROM folders WHERE vault_id = $1 AND (id = $2 OR starts_with(path, $3))")
        .bind(&f.vault_id)
        .bind(&f.id)
        .bind(prefix)
        .execute(&mut *c)
        .await?;
    Ok(())
}

// ── Journal CRDT ─────────────────────────────────────────────────────────────

fn op_row(r: &sqlx::postgres::PgRow) -> Operation {
    Operation {
        id: r.get("id"),
        resource_type: r.get("resource_type"),
        resource_id: r.get("resource_id"),
        client_id: r.get("client_id"),
        produced_at: r.get("produced_at"),
        received_at: r.get("received_at"),
        op_bytes: r.get("op_bytes"),
        author: None,
    }
}

/// Ajoute l'op (sans effet si son id existe deja), et sa ligne du flux du pair indexeur, ensemble.
pub async fn op_append(c: &mut PgConnection, op: &Operation) -> AppResult<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM operations_log WHERE id = $1)")
        .bind(&op.id)
        .fetch_one(&mut *c)
        .await?;
    if exists {
        return Ok(());
    }
    let mut tx = c.begin().await?;
    insert_op(&mut tx, op).await?;
    indexer_feed::record_operation(&mut tx, &op.resource_type, &op.resource_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn insert_op(c: &mut PgConnection, op: &Operation) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO operations_log (id, resource_type, resource_id, client_id, produced_at, received_at, op_bytes, author)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&op.id)
    .bind(&op.resource_type)
    .bind(&op.resource_id)
    .bind(&op.client_id)
    .bind(op.produced_at)
    .bind(op.received_at)
    .bind(&op.op_bytes)
    .bind(&op.author)
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn ops_all(c: &mut PgConnection, resource_type: &str, resource_id: &str) -> AppResult<Vec<Operation>> {
    let rows = sqlx::query(
        "SELECT id, resource_type, resource_id, client_id, produced_at, received_at, op_bytes
           FROM operations_log WHERE resource_type = $1 AND resource_id = $2 ORDER BY received_at",
    )
    .bind(resource_type)
    .bind(resource_id)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(op_row).collect())
}

pub async fn sync_vector_get(c: &mut PgConnection, resource_id: &str, client_id: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(sqlx::query_scalar("SELECT vector FROM sync_vectors WHERE resource_id = $1 AND client_id = $2")
        .bind(resource_id)
        .bind(client_id)
        .fetch_optional(&mut *c)
        .await?)
}

pub async fn sync_vector_set(c: &mut PgConnection, resource_id: &str, client_id: &str, vector: &[u8]) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO sync_vectors (resource_id, client_id, vector, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (resource_id, client_id) DO UPDATE SET vector = EXCLUDED.vector, updated_at = EXCLUDED.updated_at",
    )
    .bind(resource_id)
    .bind(client_id)
    .bind(vector)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

fn snapshot_op(resource_type: &str, resource_id: &str, bytes: Vec<u8>) -> Operation {
    let t = now();
    Operation {
        id: new_id(),
        resource_type: resource_type.into(),
        resource_id: resource_id.into(),
        client_id: "snapshot".into(),
        produced_at: t,
        received_at: t,
        op_bytes: bytes,
        author: None,
    }
}

/// Remplace tout le journal par un etat. Sans `force`, seulement au-dela de 50 ops.
pub async fn ops_compact(c: &mut PgConnection, rt: &str, rid: &str, snapshot: Vec<u8>, force: bool) -> AppResult<()> {
    if !force {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM operations_log WHERE resource_type = $1 AND resource_id = $2")
                .bind(rt)
                .bind(rid)
                .fetch_one(&mut *c)
                .await?;
        if count <= 50 {
            return Ok(());
        }
    }
    let mut tx = c.begin().await?;
    sqlx::query("DELETE FROM operations_log WHERE resource_type = $1 AND resource_id = $2")
        .bind(rt)
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    insert_op(&mut tx, &snapshot_op(rt, rid, snapshot)).await?;
    indexer_feed::record_operation(&mut tx, rt, rid).await?;
    tx.commit().await?;
    Ok(())
}

/// Remplace ces ops par un etat qui les contient. Rend le nombre d'ops remplacees ;
/// 0 : une autre compaction les a deja remplacees, l'etat n'est pas ajoute.
pub async fn ops_replace(c: &mut PgConnection, rt: &str, rid: &str, ids: &[String], snapshot: Vec<u8>) -> AppResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = ids.iter().cloned().collect::<HashSet<_>>().into_iter().collect();
    let mut tx = c.begin().await?;
    let replaced = sqlx::query("DELETE FROM operations_log WHERE resource_type = $1 AND resource_id = $2 AND id = ANY($3)")
        .bind(rt)
        .bind(rid)
        .bind(&ids)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if replaced > 0 {
        insert_op(&mut tx, &snapshot_op(rt, rid, snapshot)).await?;
        indexer_feed::record_operation(&mut tx, rt, rid).await?;
    }
    tx.commit().await?;
    Ok(replaced)
}

// ── Droits ───────────────────────────────────────────────────────────────────

fn perm_row(r: &sqlx::postgres::PgRow) -> ResourcePermission {
    ResourcePermission {
        id: r.get("id"),
        resource_type: parse_rt(r.get("resource_type")),
        resource_id: r.get("resource_id"),
        subject_type: SubjectType::User,
        subject_id: r.get("subject_id"),
        permission: parse_perm(r.get("permission")),
        granted_by: r.get("granted_by"),
        granted_at: r.get("granted_at"),
        expires_at: r.get("expires_at"),
    }
}

const PERM_COLS: &str =
    "id, resource_type, resource_id, subject_type, subject_id, permission, granted_by, granted_at, expires_at";

pub async fn perms_for_resource(c: &mut PgConnection, rt: ResourceType, rid: &str) -> AppResult<Vec<ResourcePermission>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PERM_COLS} FROM resource_permissions WHERE resource_type = $1 AND resource_id = $2"
    )))
    .bind(rt.as_str())
    .bind(rid)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(perm_row).collect())
}

pub async fn perms_for_subject(c: &mut PgConnection, subject_id: &str) -> AppResult<Vec<ResourcePermission>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PERM_COLS} FROM resource_permissions WHERE subject_type = 'user' AND subject_id = $1"
    )))
    .bind(subject_id)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(perm_row).collect())
}

pub async fn perm_get(c: &mut PgConnection, rt: ResourceType, rid: &str, subject_id: &str) -> AppResult<Option<ResourcePermission>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PERM_COLS} FROM resource_permissions
          WHERE resource_type = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3"
    )))
    .bind(rt.as_str())
    .bind(rid)
    .bind(subject_id)
    .fetch_optional(&mut *c)
    .await?;
    Ok(r.as_ref().map(perm_row))
}

pub async fn perm_add(c: &mut PgConnection, p: &ResourcePermission) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO resource_permissions ({PERM_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")))
        .bind(&p.id)
        .bind(p.resource_type.as_str())
        .bind(&p.resource_id)
        .bind(p.subject_type.as_str())
        .bind(&p.subject_id)
        .bind(p.permission.as_str())
        .bind(&p.granted_by)
        .bind(p.granted_at)
        .bind(p.expires_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn perm_delete(c: &mut PgConnection, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM resource_permissions WHERE id = $1").bind(id).execute(&mut *c).await?;
    Ok(())
}

/// Droits expires (balayage periodique).
pub async fn perms_expired(c: &mut PgConnection, at: Ts) -> AppResult<Vec<ResourcePermission>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PERM_COLS} FROM resource_permissions WHERE expires_at IS NOT NULL AND expires_at < $1"
    )))
    .bind(at)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(perm_row).collect())
}

// ── Liens de partage ─────────────────────────────────────────────────────────

const LINK_COLS: &str = "id, token, resource_type, resource_id, permission, created_by, created_at, expires_at, revoked_at, path";

fn link_row(r: &sqlx::postgres::PgRow) -> ShareLink {
    ShareLink {
        id: r.get("id"),
        token: r.get("token"),
        resource_type: parse_rt(r.get("resource_type")),
        resource_id: r.get("resource_id"),
        permission: parse_perm(r.get("permission")),
        created_by: r.get("created_by"),
        created_at: r.get("created_at"),
        expires_at: r.get("expires_at"),
        revoked_at: r.get("revoked_at"),
        path: r.get("path"),
    }
}

pub async fn link_by_token(c: &mut PgConnection, token: &str) -> AppResult<Option<ShareLink>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {LINK_COLS} FROM share_links WHERE token = $1")))
        .bind(token)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(link_row))
}

pub async fn link_by_id(c: &mut PgConnection, id: &str) -> AppResult<Option<ShareLink>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {LINK_COLS} FROM share_links WHERE id = $1")))
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(link_row))
}

pub async fn links_for_resource(c: &mut PgConnection, rt: ResourceType, rid: &str) -> AppResult<Vec<ShareLink>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {LINK_COLS} FROM share_links WHERE resource_type = $1 AND resource_id = $2 ORDER BY created_at DESC"
    )))
    .bind(rt.as_str())
    .bind(rid)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(link_row).collect())
}

pub async fn link_add(c: &mut PgConnection, l: &ShareLink) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO share_links ({LINK_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")))
        .bind(&l.id)
        .bind(&l.token)
        .bind(l.resource_type.as_str())
        .bind(&l.resource_id)
        .bind(l.permission.as_str())
        .bind(&l.created_by)
        .bind(l.created_at)
        .bind(l.expires_at)
        .bind(l.revoked_at)
        .bind(&l.path)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn link_set_revoked(c: &mut PgConnection, id: &str, at: Option<Ts>) -> AppResult<()> {
    sqlx::query("UPDATE share_links SET revoked_at = $2 WHERE id = $1").bind(id).bind(at).execute(&mut *c).await?;
    Ok(())
}

// ── Heritage des droits (acl_settings) ───────────────────────────────────────

pub async fn acl_get(c: &mut PgConnection, rt: ResourceType, rid: &str) -> AppResult<Option<AclSetting>> {
    let r = sqlx::query("SELECT resource_id, vault_id, inherit FROM acl_settings WHERE resource_type = $1 AND resource_id = $2")
        .bind(rt.as_str())
        .bind(rid)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.map(|r| AclSetting { resource_id: r.get("resource_id"), vault_id: r.get("vault_id"), inherit: r.get("inherit") }))
}

/// Heriter : la ligne disparait. Ne plus heriter : une ligne inherit = false.
pub async fn acl_set(c: &mut PgConnection, rt: ResourceType, rid: &str, vault_id: &str, inherit: bool, by: &str) -> AppResult<()> {
    if inherit {
        sqlx::query("DELETE FROM acl_settings WHERE resource_type = $1 AND resource_id = $2")
            .bind(rt.as_str())
            .bind(rid)
            .execute(&mut *c)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO acl_settings (resource_type, resource_id, vault_id, inherit, updated_by, updated_at)
         VALUES ($1, $2, $3, false, $4, $5)
         ON CONFLICT (resource_type, resource_id) DO UPDATE SET inherit = false, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
    )
    .bind(rt.as_str())
    .bind(rid)
    .bind(vault_id)
    .bind(by)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Un dossier renomme : ses reglages, ses droits et ceux de ses sous-dossiers
/// le suivent, et les documents qu'il contient aussi.
pub async fn acl_rename_folder(c: &mut PgConnection, vault_id: &str, from: &str, to: &str) -> AppResult<()> {
    let old_id = folder_resource::id(vault_id, from);
    let new_id = folder_resource::id(vault_id, to);
    let old_prefix = format!("{old_id}/");
    let keep = (old_id.chars().count() + 1) as i32;
    let old_folder = folder_resource::normalize(Some(from)).unwrap_or_default();
    let new_folder = folder_resource::normalize(Some(to)).unwrap_or_default();
    let old_folder_prefix = format!("{old_folder}/");
    let keep_folder = (old_folder.chars().count() + 1) as i32;
    let mut tx = c.begin().await?;
    for table in ["acl_settings", "resource_permissions"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE {table} SET resource_id = $1 || substr(resource_id, $2)
              WHERE resource_type = 'folder' AND (resource_id = $3 OR starts_with(resource_id, $4))"
        )))
        .bind(&new_id)
        .bind(keep)
        .bind(&old_id)
        .bind(&old_prefix)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE vault_documents SET folder = $1 || substr(folder, $2)
          WHERE vault_id = $3 AND (folder = $4 OR starts_with(folder, $5))",
    )
    .bind(&new_folder)
    .bind(keep_folder)
    .bind(vault_id)
    .bind(&old_folder)
    .bind(&old_folder_prefix)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

// ── Registre « document -> vault » ───────────────────────────────────────────

fn doc_row(r: &sqlx::postgres::PgRow) -> VaultDocumentRecord {
    VaultDocumentRecord {
        doc_id: r.get("doc_id"),
        vault_id: r.get("vault_id"),
        parent_doc_id: r.get("parent_doc_id"),
        name: r.get("name"),
        folder: r.get("folder"),
    }
}

/// Le vault du document ; pour un annexe jamais inscrit, celui de son document.
pub async fn doc_vault_id(c: &mut PgConnection, doc_id: &str) -> AppResult<Option<String>> {
    let v: Option<String> = sqlx::query_scalar("SELECT vault_id FROM vault_documents WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_optional(&mut *c)
        .await?;
    if v.is_some() {
        return Ok(v);
    }
    match annex::parent_of(doc_id) {
        Some(parent) => Ok(sqlx::query_scalar("SELECT vault_id FROM vault_documents WHERE doc_id = $1")
            .bind(parent)
            .fetch_optional(&mut *c)
            .await?),
        None => Ok(None),
    }
}

/// Inscrit les documents dans le vault. Rend ceux refuses (deja inscrits ailleurs,
/// ou annexe d'un document d'un autre vault).
pub async fn docs_register(c: &mut PgConnection, vault_id: &str, doc_ids: &[String], by: &str) -> AppResult<Vec<String>> {
    let mut seen = HashSet::new();
    let ids: Vec<String> =
        doc_ids.iter().filter(|id| !id.trim().is_empty()).filter(|id| seen.insert((*id).clone())).cloned().collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut lookup: Vec<String> = ids.clone();
    lookup.extend(ids.iter().filter_map(|id| annex::parent_of(id).map(str::to_string)));
    let rows = sqlx::query("SELECT doc_id, vault_id FROM vault_documents WHERE doc_id = ANY($1)")
        .bind(&lookup)
        .fetch_all(&mut *c)
        .await?;
    let existing: HashMap<String, String> = rows.iter().map(|r| (r.get("doc_id"), r.get("vault_id"))).collect();
    let mut rejected = Vec::new();
    let t = now();
    let mut tx = c.begin().await?;
    for id in &ids {
        if let Some(owner) = existing.get(id) {
            if owner != vault_id {
                rejected.push(id.clone());
            }
            continue;
        }
        if let Some(parent) = annex::parent_of(id)
            && let Some(parent_owner) = existing.get(parent)
            && parent_owner != vault_id
        {
            rejected.push(id.clone());
            continue;
        }
        sqlx::query(
            "INSERT INTO vault_documents (doc_id, vault_id, registered_by, registered_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (doc_id) DO NOTHING",
        )
        .bind(id)
        .bind(vault_id)
        .bind(by)
        .bind(t)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(rejected)
}

pub async fn doc_get(c: &mut PgConnection, doc_id: &str) -> AppResult<Option<VaultDocumentRecord>> {
    let r = sqlx::query("SELECT doc_id, vault_id, parent_doc_id, name, folder FROM vault_documents WHERE doc_id = $1")
        .bind(doc_id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(doc_row))
}

pub async fn doc_set_placement(c: &mut PgConnection, doc_id: &str, parent: Option<&str>, name: Option<&str>) -> AppResult<()> {
    sqlx::query("UPDATE vault_documents SET parent_doc_id = $2, name = $3 WHERE doc_id = $1")
        .bind(doc_id)
        .bind(parent)
        .bind(name)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn doc_set_folder(c: &mut PgConnection, doc_id: &str, folder: &str) -> AppResult<()> {
    sqlx::query("UPDATE vault_documents SET folder = $2 WHERE doc_id = $1").bind(doc_id).bind(folder).execute(&mut *c).await?;
    Ok(())
}

pub async fn doc_children(c: &mut PgConnection, vault_id: &str, parent: &str) -> AppResult<Vec<VaultDocumentRecord>> {
    let rows = sqlx::query(
        "SELECT doc_id, vault_id, parent_doc_id, name, folder FROM vault_documents WHERE vault_id = $1 AND parent_doc_id = $2",
    )
    .bind(vault_id)
    .bind(parent)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(doc_row).collect())
}

// ── Reglage du pair indexeur par vault ───────────────────────────────────────

fn setting_of(vault_id: &str, mode: &str, url: Option<String>) -> VaultIndexerSetting {
    VaultIndexerSetting { vault_id: vault_id.into(), mode: IndexerMode::parse(mode).unwrap_or(IndexerMode::Managed), url }
}

pub async fn indexer_setting(c: &mut PgConnection, vault_id: &str) -> AppResult<VaultIndexerSetting> {
    let r = sqlx::query("SELECT mode, url FROM vault_indexer_settings WHERE vault_id = $1")
        .bind(vault_id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(match r {
        Some(r) => setting_of(vault_id, r.get("mode"), r.get("url")),
        None => VaultIndexerSetting::default_for(vault_id),
    })
}

pub async fn indexer_settings_many(c: &mut PgConnection, vault_ids: &[String]) -> AppResult<HashMap<String, VaultIndexerSetting>> {
    let rows = sqlx::query("SELECT vault_id, mode, url FROM vault_indexer_settings WHERE vault_id = ANY($1)")
        .bind(vault_ids)
        .fetch_all(&mut *c)
        .await?;
    let mut out: HashMap<String, VaultIndexerSetting> = rows
        .iter()
        .map(|r| {
            let id: String = r.get("vault_id");
            let s = setting_of(&id, r.get("mode"), r.get("url"));
            (id, s)
        })
        .collect();
    for id in vault_ids {
        out.entry(id.clone()).or_insert_with(|| VaultIndexerSetting::default_for(id));
    }
    Ok(out)
}

/// Le pair gere apprend par son flux qu'un vault entre ou sort de son perimetre.
pub async fn indexer_setting_set(c: &mut PgConnection, s: &VaultIndexerSetting, by: &str) -> AppResult<()> {
    let mut tx = c.begin().await?;
    let previous: Option<String> = sqlx::query_scalar("SELECT mode FROM vault_indexer_settings WHERE vault_id = $1")
        .bind(&s.vault_id)
        .fetch_optional(&mut *tx)
        .await?;
    let was_managed = previous.as_deref().is_none_or(|m| m == "managed");
    sqlx::query(
        "INSERT INTO vault_indexer_settings (vault_id, mode, url, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault_id) DO UPDATE SET mode = EXCLUDED.mode, url = EXCLUDED.url,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
    )
    .bind(&s.vault_id)
    .bind(s.mode.as_str())
    .bind(&s.url)
    .bind(by)
    .bind(now())
    .execute(&mut *tx)
    .await?;
    let is_managed = s.mode == IndexerMode::Managed;
    if was_managed && !is_managed {
        indexer_feed::record_vault_gone(&mut tx, &s.vault_id, false).await?;
    } else if !was_managed && is_managed {
        indexer_feed::record_vault(&mut tx, &s.vault_id).await?;
    }
    tx.commit().await?;
    Ok(())
}

// ── Flux du pair indexeur ────────────────────────────────────────────────────

pub async fn indexer_changes_since(c: &mut PgConnection, since: i64, max: i64) -> AppResult<Vec<IndexerChange>> {
    let rows = sqlx::query("SELECT seq, vault_id, kind, doc_id FROM indexer_changes WHERE seq > $1 ORDER BY seq LIMIT $2")
        .bind(since)
        .bind(max)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows
        .iter()
        .map(|r| IndexerChange { seq: r.get("seq"), vault_id: r.get("vault_id"), kind: r.get("kind"), doc_id: r.get("doc_id") })
        .collect())
}

/// Identifiant de la base pour le pair (s'il change, il repart de zero).
pub async fn indexer_epoch(c: &mut PgConnection) -> AppResult<String> {
    const READ: &str = "SELECT value FROM indexer_feed_state WHERE key = 'epoch'";
    if let Some(e) = sqlx::query_scalar::<_, String>(READ).fetch_optional(&mut *c).await? {
        return Ok(e);
    }
    sqlx::query(
        "INSERT INTO indexer_feed_state (key, value) VALUES ('epoch', replace(gen_random_uuid()::text, '-', ''))
         ON CONFLICT (key) DO NOTHING",
    )
    .execute(&mut *c)
    .await?;
    sqlx::query_scalar::<_, String>(READ).fetch_optional(&mut *c).await?.ok_or_else(|| AppError::internal("indexer_feed_state : epoch absent."))
}

/// Un fichier du vault a change : le pair le relira.
pub async fn indexer_record_file(c: &mut PgConnection, file_id: &str) -> AppResult<()> {
    let mut tx = c.begin().await?;
    indexer_feed::record_operation(&mut tx, crdt::DOCUMENT, file_id).await?;
    tx.commit().await?;
    Ok(())
}

// ── Cles et identites (EdgeSync) ─────────────────────────────────────────────

pub async fn key_wrap_get(c: &mut PgConnection, user_id: &str, vault_id: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(sqlx::query_scalar("SELECT wrapped_key_bytes FROM vault_key_wraps WHERE user_id = $1 AND vault_id = $2")
        .bind(user_id)
        .bind(vault_id)
        .fetch_optional(&mut *c)
        .await?)
}

pub async fn key_wrap_set(c: &mut PgConnection, user_id: &str, vault_id: &str, bytes: &[u8]) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO vault_key_wraps (user_id, vault_id, wrapped_key_bytes, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, vault_id) DO UPDATE SET wrapped_key_bytes = EXCLUDED.wrapped_key_bytes, updated_at = EXCLUDED.updated_at",
    )
    .bind(user_id)
    .bind(vault_id)
    .bind(bytes)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn member_identity_add(c: &mut PgConnection, vault_id: &str, user_id: &str, sign_pub: &[u8]) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO vault_member_identities (vault_id, sign_pub, user_id, registered_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_id, sign_pub) DO NOTHING",
    )
    .bind(vault_id)
    .bind(sign_pub)
    .bind(user_id)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn member_identities(c: &mut PgConnection, vault_id: &str) -> AppResult<Vec<(String, Vec<u8>)>> {
    let rows = sqlx::query("SELECT user_id, sign_pub FROM vault_member_identities WHERE vault_id = $1")
        .bind(vault_id)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows.iter().map(|r| (r.get("user_id"), r.get("sign_pub"))).collect())
}

pub async fn member_identities_remove_user(c: &mut PgConnection, vault_id: &str, user_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM vault_member_identities WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user_id)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn edgesync_blob_get(c: &mut PgConnection, vault_id: &str, key: &str) -> AppResult<Option<Vec<u8>>> {
    Ok(sqlx::query_scalar("SELECT bytes FROM edgesync_blobs WHERE vault_id = $1 AND key = $2")
        .bind(vault_id)
        .bind(key)
        .fetch_optional(&mut *c)
        .await?)
}

pub async fn edgesync_blob_set(c: &mut PgConnection, vault_id: &str, key: &str, bytes: &[u8]) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO edgesync_blobs (vault_id, key, bytes, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_id, key) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = EXCLUDED.updated_at",
    )
    .bind(vault_id)
    .bind(key)
    .bind(bytes)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

// ── Publications ─────────────────────────────────────────────────────────────

const PUB_COLS: &str = "slug, vault_id, document_id, title, description, html, indexable, created_by, created_at, updated_at";

fn pub_row(r: &sqlx::postgres::PgRow) -> Publication {
    Publication {
        slug: r.get("slug"),
        vault_id: r.get("vault_id"),
        document_id: r.get("document_id"),
        title: r.get("title"),
        description: r.get("description"),
        html: r.get("html"),
        indexable: r.get("indexable"),
        created_by: r.get("created_by"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

pub async fn publication_by_slug(c: &mut PgConnection, slug: &str) -> AppResult<Option<Publication>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {PUB_COLS} FROM publications WHERE slug = $1"))).bind(slug).fetch_optional(&mut *c).await?;
    Ok(r.as_ref().map(pub_row))
}

pub async fn publication_by_document(c: &mut PgConnection, doc_id: &str) -> AppResult<Option<Publication>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {PUB_COLS} FROM publications WHERE document_id = $1")))
        .bind(doc_id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(pub_row))
}

pub async fn publication_slug_exists(c: &mut PgConnection, slug: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM publications WHERE slug = $1)").bind(slug).fetch_one(&mut *c).await?)
}

pub async fn publication_add(c: &mut PgConnection, p: &Publication) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO publications ({PUB_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")))
        .bind(&p.slug)
        .bind(&p.vault_id)
        .bind(&p.document_id)
        .bind(&p.title)
        .bind(&p.description)
        .bind(&p.html)
        .bind(p.indexable)
        .bind(&p.created_by)
        .bind(p.created_at)
        .bind(p.updated_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn publication_update(
    c: &mut PgConnection,
    doc_id: &str,
    title: &str,
    description: &str,
    html: &str,
    indexable: bool,
    at: Ts,
) -> AppResult<()> {
    sqlx::query("UPDATE publications SET title = $2, description = $3, html = $4, indexable = $5, updated_at = $6 WHERE document_id = $1")
        .bind(doc_id)
        .bind(title)
        .bind(description)
        .bind(html)
        .bind(indexable)
        .bind(at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn publication_delete(c: &mut PgConnection, doc_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM publications WHERE document_id = $1").bind(doc_id).execute(&mut *c).await?;
    Ok(())
}

// ── Jetons personnels ────────────────────────────────────────────────────────

const TOKEN_COLS: &str = "id, user_id, name, prefix, token_hash, scope, vault_ids, created_at, expires_at, last_used_at, revoked_at, agent_id";

fn token_row(r: &sqlx::postgres::PgRow) -> AccessToken {
    let vaults: Option<String> = r.get("vault_ids");
    AccessToken {
        id: r.get("id"),
        user_id: r.get("user_id"),
        name: r.get("name"),
        prefix: r.get("prefix"),
        token_hash: r.get("token_hash"),
        scope: r.get("scope"),
        vault_ids: vaults
            .filter(|v| !v.is_empty())
            .map(|v| v.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect()),
        created_at: r.get("created_at"),
        expires_at: r.get("expires_at"),
        last_used_at: r.get("last_used_at"),
        revoked_at: r.get("revoked_at"),
        agent_id: r.get("agent_id"),
    }
}

pub async fn token_add(c: &mut PgConnection, t: &AccessToken) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO access_tokens ({TOKEN_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")))
        .bind(&t.id)
        .bind(&t.user_id)
        .bind(&t.name)
        .bind(&t.prefix)
        .bind(&t.token_hash)
        .bind(&t.scope)
        .bind(t.vault_ids.as_ref().map(|v| v.join(",")))
        .bind(t.created_at)
        .bind(t.expires_at)
        .bind(t.last_used_at)
        .bind(t.revoked_at)
        .bind(&t.agent_id)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn token_by_hash(c: &mut PgConnection, hash: &str) -> AppResult<Option<AccessToken>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {TOKEN_COLS} FROM access_tokens WHERE token_hash = $1")))
        .bind(hash)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.as_ref().map(token_row))
}

pub async fn tokens_for_user(c: &mut PgConnection, user_id: &str) -> AppResult<Vec<AccessToken>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {TOKEN_COLS} FROM access_tokens WHERE user_id = $1 ORDER BY created_at DESC")))
        .bind(user_id)
        .fetch_all(&mut *c)
        .await?;
    Ok(rows.iter().map(token_row).collect())
}

pub async fn tokens_active_count(c: &mut PgConnection, user_id: &str, at: Ts) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM access_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)",
    )
    .bind(user_id)
    .bind(at)
    .fetch_one(&mut *c)
    .await?)
}

/// Faux : jeton inconnu (ou pas a cette personne).
pub async fn token_revoke(c: &mut PgConnection, id: &str, user_id: &str, at: Ts) -> AppResult<bool> {
    let n = sqlx::query("UPDATE access_tokens SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(id)
        .bind(user_id)
        .bind(at)
        .execute(&mut *c)
        .await?
        .rows_affected();
    if n > 0 {
        return Ok(true);
    }
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM access_tokens WHERE id = $1 AND user_id = $2)")
        .bind(id)
        .bind(user_id)
        .fetch_one(&mut *c)
        .await?)
}

pub async fn token_touch(c: &mut PgConnection, id: &str, at: Ts) -> AppResult<()> {
    sqlx::query("UPDATE access_tokens SET last_used_at = $2 WHERE id = $1").bind(id).bind(at).execute(&mut *c).await?;
    Ok(())
}

// ── Retours des testeurs ─────────────────────────────────────────────────────

pub struct FeedbackRow {
    pub id: String,
    pub user_id: String,
    pub message: String,
    pub context: String,
    pub user_agent: Option<String>,
    pub has_screenshot: bool,
    pub created_at: Ts,
    pub archived_at: Option<Ts>,
}

#[allow(clippy::too_many_arguments)]
pub async fn feedback_add(
    c: &mut PgConnection,
    id: &str,
    user_id: &str,
    message: &str,
    context: &str,
    user_agent: Option<&str>,
    screenshot: Option<&[u8]>,
    screenshot_type: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO feedback_reports (id, user_id, message, context, user_agent, screenshot, screenshot_type, created_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)",
    )
    .bind(id)
    .bind(user_id)
    .bind(message)
    .bind(context)
    .bind(user_agent)
    .bind(screenshot)
    .bind(screenshot_type)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn feedback_list(c: &mut PgConnection, include_archived: bool) -> AppResult<Vec<FeedbackRow>> {
    let rows = sqlx::query(
        "SELECT id, user_id, message, context, user_agent, screenshot IS NOT NULL AS has_screenshot, created_at, archived_at
           FROM feedback_reports WHERE ($1 OR archived_at IS NULL) ORDER BY created_at DESC",
    )
    .bind(include_archived)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows
        .iter()
        .map(|r| FeedbackRow {
            id: r.get("id"),
            user_id: r.get("user_id"),
            message: r.get("message"),
            context: r.get("context"),
            user_agent: r.get("user_agent"),
            has_screenshot: r.get("has_screenshot"),
            created_at: r.get("created_at"),
            archived_at: r.get("archived_at"),
        })
        .collect())
}

pub async fn feedback_screenshot(c: &mut PgConnection, id: &str) -> AppResult<Option<(Vec<u8>, String)>> {
    let r = sqlx::query("SELECT screenshot, screenshot_type FROM feedback_reports WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    Ok(r.and_then(|r| {
        let bytes: Option<Vec<u8>> = r.get("screenshot");
        let kind: Option<String> = r.get("screenshot_type");
        bytes.map(|b| (b, kind.unwrap_or_else(|| "image/png".into())))
    }))
}

pub async fn feedback_open_count(c: &mut PgConnection, user_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM feedback_reports WHERE user_id = $1 AND archived_at IS NULL")
        .bind(user_id)
        .fetch_one(&mut *c)
        .await?)
}

pub async fn feedback_set_archived(c: &mut PgConnection, id: &str, at: Option<Ts>) -> AppResult<bool> {
    Ok(sqlx::query("UPDATE feedback_reports SET archived_at = $2 WHERE id = $1")
        .bind(id)
        .bind(at)
        .execute(&mut *c)
        .await?
        .rows_affected()
        > 0)
}

pub async fn feedback_delete(c: &mut PgConnection, id: &str) -> AppResult<bool> {
    Ok(sqlx::query("DELETE FROM feedback_reports WHERE id = $1").bind(id).execute(&mut *c).await?.rows_affected() > 0)
}

// ── Effacement d'un vault (revue du 14/11/2026, E2) ──────────────────────────
//
// Effacer un vault, c'est effacer TOUT ce qui lui appartient : journal CRDT
// (repertoire, canaux d'index, documents et rooms, retrouves par le registre
// AVANT que la cascade ne l'emporte), vecteurs de synchronisation, liens et
// droits, pages publiees, blobs EdgeSync, cles et identites, et le vault dans
// les jetons personnels qui s'y limitaient. Les membres, dossiers, registre et
// reglage du pair partent en cascade. Les fichiers sont effaces apres, par le
// magasin de fichiers.

/// Les lignes du vault, hors celle du vault lui-meme. Dans une transaction.
pub async fn erase_vault_rows(c: &mut PgConnection, vault_id: &str) -> AppResult<()> {
    let vault_resource = format!("vault:{vault_id}");
    let index_prefix = format!("index:{vault_id}:");
    sqlx::query(
        "DELETE FROM operations_log
          WHERE (resource_type IN ('document', 'room') AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = $1))
             OR (resource_type = 'vault' AND resource_id = $2)
             OR (resource_type = 'index' AND starts_with(resource_id, $3))",
    )
    .bind(vault_id)
    .bind(&vault_resource)
    .bind(&index_prefix)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        "DELETE FROM sync_vectors
          WHERE resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = $1)
             OR resource_id = $2 OR starts_with(resource_id, $3)",
    )
    .bind(vault_id)
    .bind(&vault_resource)
    .bind(&index_prefix)
    .execute(&mut *c)
    .await?;
    for table in ["share_links", "resource_permissions"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table}
              WHERE (resource_type = 'vault' AND resource_id = $1)
                 OR (resource_type = 'document' AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = $1))"
        )))
        .bind(vault_id)
        .execute(&mut *c)
        .await?;
    }
    sqlx::query("DELETE FROM resource_permissions WHERE resource_type = 'folder' AND starts_with(resource_id, $1)")
        .bind(format!("{vault_id}:"))
        .execute(&mut *c)
        .await?;
    for table in ["publications", "edgesync_blobs", "vault_key_wraps", "vault_member_identities"] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE vault_id = $1"))).bind(vault_id).execute(&mut *c).await?;
    }
    // Jetons limites a des vaults : celui-ci en sort ; un jeton qui ne visait
    // que lui est revoque (une liste vide voudrait dire « tous les vaults »).
    let rows = sqlx::query("SELECT id, vault_ids, revoked_at FROM access_tokens WHERE vault_ids IS NOT NULL AND strpos(vault_ids, $1) > 0")
        .bind(vault_id)
        .fetch_all(&mut *c)
        .await?;
    for r in rows {
        let id: String = r.get("id");
        let ids: String = r.get("vault_ids");
        let revoked: Option<Ts> = r.get("revoked_at");
        let mut list: Vec<&str> = ids.split(',').filter(|s| !s.is_empty()).collect();
        let before = list.len();
        list.retain(|v| *v != vault_id);
        if list.len() == before {
            continue;
        }
        if list.is_empty() {
            sqlx::query("UPDATE access_tokens SET revoked_at = $2 WHERE id = $1")
                .bind(&id)
                .bind(revoked.unwrap_or_else(now))
                .execute(&mut *c)
                .await?;
        } else {
            sqlx::query("UPDATE access_tokens SET vault_ids = $2 WHERE id = $1").bind(&id).bind(list.join(",")).execute(&mut *c).await?;
        }
    }
    Ok(())
}

/// Supprime le vault et tout ce qui lui appartient, en une transaction (hors fichiers).
pub async fn vault_delete(c: &mut PgConnection, vault_id: &str) -> AppResult<()> {
    let mut tx = c.begin().await?;
    indexer_feed::record_vault_gone(&mut tx, vault_id, true).await?;
    erase_vault_rows(&mut tx, vault_id).await?;
    sqlx::query("DELETE FROM vaults WHERE id = $1").bind(vault_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Restes de vaults supprimes, par table : compter (dry_run) ou effacer.
pub async fn purge_orphan_rows(c: &mut PgConnection, dry_run: bool) -> AppResult<Vec<(&'static str, i64)>> {
    const ORPHAN_DOCS: &str = "resource_id NOT IN (SELECT doc_id FROM vault_documents)";
    let no_resource = "(resource_type = 'vault' AND resource_id NOT IN (SELECT id FROM vaults))
        OR (resource_type = 'document' AND resource_id NOT IN (SELECT doc_id FROM vault_documents))";
    let no_vault = "vault_id NOT IN (SELECT id FROM vaults)";
    let ops_docs = format!("resource_type IN ('document', 'room') AND {ORPHAN_DOCS}");
    let steps: Vec<(&'static str, &str, &'static str)> = vec![
        ("operations", ops_docs.as_str(), "operations_log"),
        ("operations", "resource_type = 'vault' AND substr(resource_id, 7) NOT IN (SELECT id FROM vaults)", "operations_log"),
        ("operations", "resource_type = 'index' AND split_part(resource_id, ':', 2) NOT IN (SELECT id FROM vaults)", "operations_log"),
        (
            "syncVectors",
            "resource_id NOT IN (SELECT doc_id FROM vault_documents)
             AND NOT (resource_id LIKE 'vault:%' AND substr(resource_id, 7) IN (SELECT id FROM vaults))
             AND NOT (resource_id LIKE 'index:%' AND split_part(resource_id, ':', 2) IN (SELECT id FROM vaults))",
            "sync_vectors",
        ),
        ("shareLinks", no_resource, "share_links"),
        ("permissions", no_resource, "resource_permissions"),
        ("permissions", "resource_type = 'folder' AND split_part(resource_id, ':', 1) NOT IN (SELECT id FROM vaults)", "resource_permissions"),
        ("publications", no_vault, "publications"),
        ("edgesyncBlobs", no_vault, "edgesync_blobs"),
        ("keyWraps", no_vault, "vault_key_wraps"),
        ("memberIdentities", no_vault, "vault_member_identities"),
    ];
    let mut counts: Vec<(&'static str, i64)> = Vec::new();
    for (name, filter, table) in steps {
        // `filter` et `table` sont des constantes de ce fichier, jamais une entree.
        let n: i64 = if dry_run {
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*)::bigint FROM {table} WHERE {filter}"))).fetch_one(&mut *c).await?
        } else {
            sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE {filter}"))).execute(&mut *c).await?.rows_affected() as i64
        };
        match counts.iter_mut().find(|(k, _)| *k == name) {
            Some(entry) => entry.1 += n,
            None => counts.push((name, n)),
        }
    }
    Ok(counts)
}

/// Octets du vault dans la base : journal CRDT, pages publiees, blobs EdgeSync.
pub async fn vault_row_bytes(c: &mut PgConnection, vault_id: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT (
            COALESCE((SELECT sum(octet_length(op_bytes)) FROM operations_log
                      WHERE (resource_type IN ('document', 'room') AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = $1))
                         OR (resource_type = 'vault' AND resource_id = $2)
                         OR (resource_type = 'index' AND starts_with(resource_id, $3))), 0)
          + COALESCE((SELECT sum(octet_length(html)) FROM publications WHERE vault_id = $1), 0)
          + COALESCE((SELECT sum(octet_length(bytes)) FROM edgesync_blobs WHERE vault_id = $1), 0)
        )::bigint",
    )
    .bind(vault_id)
    .bind(format!("vault:{vault_id}"))
    .bind(format!("index:{vault_id}:"))
    .fetch_one(&mut *c)
    .await?)
}
