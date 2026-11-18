// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Stockages aveugles du profil chiffre (opaques pour le serveur) :
//   GET/PUT /api/v1/vaults/{vaultId}/edgesync-blobs/{*key}   { bytesBase64 }
//   GET/PUT /api/v1/vaults/{vaultId}/key-wrap                { bytesBase64 }
//   GET     /api/v1/identity/key

use axum::extract::{Path, State};
use axum::response::Response;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;

use super::{Body, no_content, ok, status};
use crate::access::{self, Level};
use crate::auth::Auth;
use crate::db::{repos, users};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobDto {
    #[serde(default)]
    bytes_base64: String,
}

fn decode(s: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|_| AppError::BadArgument("Base64 invalide.".into()))
}

fn blob(bytes: Option<Vec<u8>>) -> Response {
    match bytes {
        Some(b) => ok(&json!({ "bytesBase64": base64::engine::general_purpose::STANDARD.encode(b) })),
        None => status(404),
    }
}

pub async fn get_blob(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, key)): Path<(String, String)>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    Ok(blob(repos::edgesync_blob_get(&mut c, &vault_id, &key).await?))
}

pub async fn put_blob(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, key)): Path<(String, String)>, Body(req): Body<BlobDto>) -> AppResult<Response> {
    let bytes = decode(&req.bytes_base64)?;
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Write).await?;
    // Remplace une donnee existante : la place est verifiee, rien n'est ajoute au compteur.
    st.quota.ensure_room(&st.limits(), &vault_id, bytes.len() as i64).await?;
    repos::edgesync_blob_set(&mut c, &vault_id, &key, &bytes).await?;
    Ok(no_content())
}

pub async fn get_key_wrap(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Read).await?;
    Ok(blob(repos::key_wrap_get(&mut c, &p.sub, &vault_id).await?))
}

pub async fn put_key_wrap(State(st): State<AppState>, Auth(p): Auth, Path(vault_id): Path<String>, Body(req): Body<BlobDto>) -> AppResult<Response> {
    let bytes = decode(&req.bytes_base64)?;
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Write).await?;
    repos::key_wrap_set(&mut c, &p.sub, &vault_id, &bytes).await?;
    Ok(no_content())
}

/// Cle privee d'identite du compte, creee au premier appel (dette connue : en clair en base).
pub async fn identity_key(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    let user = users::by_id(&mut c, &p.sub).await?.ok_or_else(|| AppError::internal(format!("User {} not found.", p.sub)))?;
    let key = match user.private_key_hex.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let k = hex::encode(bytes);
            users::set_private_key(&mut c, &p.sub, &k).await?;
            k
        }
    };
    Ok(ok(&json!({ "privateKey": key })))
}
