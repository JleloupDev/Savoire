// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecriture du flux de changements du pair indexeur (ADR-027,
// docs/Architecture/indexer-protocol.md).
//
// Appele par les ecritures, DANS leur transaction : le changement est visible
// en meme temps que l'ecriture, ou pas du tout. Le journal CRDT
// (repos::ops) est le seul a ecrire dans operations_log : tous les chemins
// (hubs du vault, des documents, des rooms, compactions) passent par ici.
//
// Une ligne par ressource : on supprime l'ancienne ligne et on en cree une
// neuve, dont la sequence (identite PostgreSQL) est plus grande que toutes
// celles jamais attribuees.
//
// L'ordre des sequences doit etre l'ordre des validations : un lecteur qui a
// vu la sequence N ne doit jamais voir apparaitre plus tard une sequence plus
// petite. PostgreSQL attribue une sequence a l'insertion, pas a la
// validation. D'ou un verrou transactionnel (pg_advisory_xact_lock) pris juste
// avant d'ecrire dans le flux et rendu a la validation : les ecritures du flux
// passent une a une. Avec plusieurs instances, le verrou vaut pour toutes.

use sqlx::PgConnection;

use crate::domain::{annex, crdt, indexer_change_kind as kind, now};
use crate::error::AppResult;

const VAULT_PREFIX: &str = "vault:";
const INDEX_PREFIX: &str = "index:";
/// « SAVOIRE1 » en ASCII.
const FEED_LOCK_KEY: i64 = 0x5341_564F_4952_4531;

async fn replace(c: &mut PgConnection, key: &str, vault_id: &str, k: &str, doc_id: Option<&str>) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(FEED_LOCK_KEY).execute(&mut *c).await?;
    sqlx::query("DELETE FROM indexer_changes WHERE resource_key = $1").bind(key).execute(&mut *c).await?;
    sqlx::query(
        "INSERT INTO indexer_changes (resource_key, vault_id, kind, doc_id, changed_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(key)
    .bind(vault_id)
    .bind(k)
    .bind(doc_id)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Une ecriture dans le journal CRDT : arborescence, document, ou reglages.
/// Toujours dans une transaction.
pub async fn record_operation(c: &mut PgConnection, resource_type: &str, resource_id: &str) -> AppResult<()> {
    match resource_type {
        crdt::VAULT => {
            if let Some(vault_id) = resource_id.strip_prefix(VAULT_PREFIX) {
                record_vault(c, vault_id).await?;
            }
            Ok(())
        }
        // Une room (document « snapshot » : tableau...) est un document comme un autre.
        crdt::DOCUMENT | crdt::ROOM => {
            // Le vault vient du registre ; un annexe jamais inscrit : celui de son document.
            let key = format!("{}:{}", kind::DOCUMENT, resource_id);
            let parent = annex::parent_of(resource_id).unwrap_or(resource_id);
            let vault: Option<String> = sqlx::query_scalar(
                "SELECT vault_id FROM vault_documents
                 WHERE doc_id = $1
                    OR (doc_id = $2 AND NOT EXISTS (SELECT 1 FROM vault_documents WHERE doc_id = $1))
                 LIMIT 1",
            )
            .bind(resource_id)
            .bind(parent)
            .fetch_optional(&mut *c)
            .await?;
            if let Some(v) = vault {
                replace(c, &key, &v, kind::DOCUMENT, Some(resource_id)).await?;
            }
            Ok(())
        }
        // Canaux d'index partages : seuls les reglages lus par le pair l'interessent.
        crdt::INDEX => {
            if let Some(vault_id) = settings_vault_of(resource_id) {
                let key = format!("{}:{}", kind::SETTINGS, vault_id);
                replace(c, &key, vault_id, kind::SETTINGS, None).await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Vault d'un canal de reglages lu par le pair (« index:{vault}:settings/{section} ») ; None sinon.
pub fn settings_vault_of(resource_id: &str) -> Option<&str> {
    let rest = resource_id.strip_prefix(INDEX_PREFIX)?;
    let sep = rest.find(':')?;
    if sep == 0 {
        return None;
    }
    let ns = &rest[sep + 1..];
    let section = ns.strip_prefix("settings/")?;
    if !kind::SETTINGS_SECTIONS.contains(&section) {
        return None;
    }
    Some(&rest[..sep])
}

/// L'arborescence du vault a change (ou le vault entre dans le pair gere).
pub async fn record_vault(c: &mut PgConnection, vault_id: &str) -> AppResult<()> {
    let key = format!("{}:{}", kind::VAULT, vault_id);
    replace(c, &key, vault_id, kind::VAULT, None).await
}

/// Le vault est supprime (purge des autres lignes) ou sort du pair gere
/// (elles restent, filtrees tant qu'il n'y revient pas).
pub async fn record_vault_gone(c: &mut PgConnection, vault_id: &str, purge_rows: bool) -> AppResult<()> {
    let key = format!("{}:{}", kind::VAULT_DELETED, vault_id);
    replace(c, &key, vault_id, kind::VAULT_DELETED, None).await?;
    if purge_rows {
        sqlx::query("DELETE FROM indexer_changes WHERE vault_id = $1 AND kind <> $2")
            .bind(vault_id)
            .bind(kind::VAULT_DELETED)
            .execute(&mut *c)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::settings_vault_of;

    #[test]
    fn settings_channel() {
        assert_eq!(settings_vault_of("index:v1:settings/properties"), Some("v1"));
        assert_eq!(settings_vault_of("index:v1:settings/other"), None);
        assert_eq!(settings_vault_of("index::settings/properties"), None);
        assert_eq!(settings_vault_of("index:v1:tags"), None);
        assert_eq!(settings_vault_of("vault:v1"), None);
    }
}
