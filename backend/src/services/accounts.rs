// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suppression d'un compte (revue du 14/11/2026, E2 : droit a l'effacement).
//
// Ordre :
//  1. chez le fournisseur d'identite : la personne ne peut plus se connecter.
//     S'il refuse ou ne repond pas, rien n'est efface (on peut recommencer) ;
//  2. dans Savoire, en une transaction : ses vaults et tout leur contenu, sa
//     place dans les vaults des autres, les droits qu'on lui avait donnes, ses
//     cles, ses jetons personnels, ses retours, son compte ;
//  3. les fichiers de ses vaults, une fois la base validee.
// Les vaults qu'elle possedait disparaissent pour tous leurs membres.
//
// Chez Zitadel (ADR-028), l'API se presente avec son compte de service (les
// memes identifiants que pour appeler le pair indexeur : Indexer:Oidc), et un
// jeton dont l'audience est Zitadel lui-meme. Non configure : rien a y faire.

use std::time::Duration;

use sqlx::{Connection, Row};

use crate::db::{indexer_feed, repos, users};
use crate::error::{AppError, AppResult};
use crate::options::{IndexerOptions, OidcOptions};
use crate::services::indexer::client_credentials;
use crate::state::AppState;

const ZITADEL_SCOPE: &str = "openid urn:zitadel:iam:org:project:id:zitadel:aud";

pub struct Erasure {
    pub deleted_vaults: Vec<String>,
    pub left_vaults: Vec<String>,
}

async fn delete_at_identity_provider(st: &AppState, subject: &str) -> AppResult<()> {
    let s = st.settings();
    let oidc = OidcOptions::from(&s);
    let idx = IndexerOptions::from(&s);
    if !(oidc.enabled() && idx.oidc.configured()) {
        return Ok(());
    }
    let unreachable = || AppError::IdentityProvider("Le fournisseur d'identité ne répond pas. Rien n'a été effacé : réessayez plus tard.".into());
    let o = &idx.oidc;
    let (token, _) = client_credentials(
        &st.http,
        o.token_endpoint.as_deref().unwrap_or(""),
        o.client_id.as_deref().unwrap_or(""),
        o.client_secret.as_deref().unwrap_or(""),
        Some(ZITADEL_SCOPE),
    )
    .await
    .map_err(|e| {
        if e.contains("refuse") {
            AppError::IdentityProvider(format!("Le fournisseur d'identité refuse le jeton de service. Rien n'a été effacé. ({e})"))
        } else {
            unreachable()
        }
    })?;
    let url = format!("{}/v2/users/{}", oidc.authority.unwrap_or_default(), urlencoding::encode(subject));
    let res = st.http.delete(url).bearer_auth(token).timeout(Duration::from_secs(15)).send().await.map_err(|_| unreachable())?;
    let code = res.status().as_u16();
    // Deja supprime chez lui : c'est ce qu'on voulait.
    if res.status().is_success() || code == 404 {
        return Ok(());
    }
    Err(AppError::IdentityProvider(if code == 403 {
        "Le fournisseur d'identité refuse la suppression : le compte de service de l'API n'en a pas le droit (relancer zitadel-bootstrap).".into()
    } else {
        format!("Le fournisseur d'identité n'a pas supprimé le compte ({code}). Rien n'a été effacé.")
    }))
}

pub async fn erase(st: &AppState, user_id: &str) -> AppResult<Erasure> {
    let mut c = st.db.acquire().await?;
    if users::by_id(&mut c, user_id).await?.is_none() {
        return Err(AppError::UserNotFound(user_id.into()));
    }
    delete_at_identity_provider(st, user_id).await?;
    // Des maintenant : un jeton encore valide ne recree pas le compte.
    st.auth.mark_deleted(user_id);
    let owned: Vec<String> = repos::vaults_owned_by(&mut c, user_id).await?.into_iter().map(|(id, _)| id).collect();
    let joined: Vec<String> = sqlx::query("SELECT vault_id FROM vault_members WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&mut *c)
        .await?
        .iter()
        .map(|r| r.get("vault_id"))
        .collect();
    {
        let mut tx = c.begin().await?;
        for v in &owned {
            indexer_feed::record_vault_gone(&mut tx, v, true).await?;
            repos::erase_vault_rows(&mut tx, v).await?;
            sqlx::query("DELETE FROM vaults WHERE id = $1").bind(v).execute(&mut *tx).await?;
        }
        for sql in [
            "DELETE FROM vault_members WHERE user_id = $1",
            "DELETE FROM resource_permissions WHERE subject_type = 'user' AND subject_id = $1",
            "DELETE FROM vault_key_wraps WHERE user_id = $1",
            "DELETE FROM vault_member_identities WHERE user_id = $1",
            "DELETE FROM access_tokens WHERE user_id = $1",
            "DELETE FROM feedback_reports WHERE user_id = $1",
        ] {
            sqlx::query(sql).bind(user_id).execute(&mut *tx).await?;
        }
        users::delete(&mut tx, user_id).await?;
        tx.commit().await?;
    }
    for v in &owned {
        st.quota.invalidate(v);
        if let Err(e) = st.store.delete_vault(v).await {
            // La purge des restes (administration) les retrouvera.
            tracing::warn!(vault = %v, error = %e, "Compte supprime : fichiers du vault non effaces");
        }
    }
    st.auth.mark_deleted(user_id);
    tracing::info!(deleted = owned.len(), left = joined.len(), "Compte supprime");
    let left = joined.into_iter().filter(|j| !owned.contains(j)).collect();
    Ok(Erasure { deleted_vaults: owned, left_vaults: left })
}

/// Supprime le compte, puis previent les sessions ouvertes.
pub async fn delete_account(st: &AppState, user_id: &str) -> AppResult<()> {
    if crate::domain::is_link_caller(user_id) {
        return Err(AppError::denied("Un lien de partage n'est pas un compte."));
    }
    let done = erase(st, user_id).await?;
    for v in done.deleted_vaults.iter().chain(done.left_vaults.iter()) {
        st.realtime.vault_membership_changed(st, v).await;
    }
    st.realtime.caller_access_changed(st, user_id).await;
    Ok(())
}

/// Droits a date de fin (revue du 14/11/2026, M7) : chaque minute, les droits
/// expires sont retires. Un membre dont le droit sur le vault a expire en
/// sort ; un droit expire sur un document disparait. Les connexions ouvertes
/// sont prevenues et sorties de leurs abonnements.
pub async fn sweep_expired_permissions(st: &AppState) -> AppResult<usize> {
    let mut c = st.db.acquire().await?;
    let expired = repos::perms_expired(&mut c, crate::domain::now()).await?;
    if expired.is_empty() {
        return Ok(0);
    }
    {
        let mut tx = c.begin().await?;
        for p in &expired {
            if p.resource_type == crate::domain::ResourceType::Vault {
                repos::member_remove(&mut tx, &p.resource_id, &p.subject_id).await?;
            }
            repos::perm_delete(&mut tx, &p.id).await?;
        }
        tx.commit().await?;
    }
    drop(c);
    let mut vaults: Vec<&str> = expired.iter().filter(|p| p.resource_type == crate::domain::ResourceType::Vault).map(|p| p.resource_id.as_str()).collect();
    vaults.sort();
    vaults.dedup();
    for v in vaults {
        st.realtime.vault_membership_changed(st, v).await;
    }
    for p in expired.iter().filter(|p| p.resource_type == crate::domain::ResourceType::Document) {
        st.realtime.access_revoked(st, &p.resource_id, &p.subject_id).await;
    }
    tracing::info!(count = expired.len(), "Droit(s) expire(s) retire(s)");
    Ok(expired.len())
}
