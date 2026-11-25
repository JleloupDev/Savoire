// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le compte de la personne connectee :
//   GET    /api/v1/auth/config          (sans compte) ou se connecter
//   GET    /api/v1/auth/me
//   GET    /api/v1/auth/me/usage
//   DELETE /api/v1/auth/me              { confirm: "SUPPRIMER" }
//   GET    /api/v1/me/access-tokens
//   POST   /api/v1/me/access-tokens     { name, vaultIds?, expiresInDays? }  -> le jeton, une fois
//   DELETE /api/v1/me/access-tokens/{id}
//   POST   /api/v1/feedback             { message, context?, screenshot? (data URL) }

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::Response;
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Body, Policy, ReqParts, client_ip, no_content, ok, problem, rate};
use crate::auth::{Auth, access_token};
use crate::db::{repos, users};
use crate::domain::{AccessToken, is_link_caller, new_id_n, now};
use crate::error::{AppError, AppResult};
use crate::options::OidcOptions;
use crate::state::AppState;

pub async fn auth_config(State(st): State<AppState>) -> Response {
    let o = OidcOptions::from(&st.settings());
    match (o.authority.filter(|a| !a.trim().is_empty()), o.web_client_id.filter(|w| !w.trim().is_empty())) {
        (Some(issuer), Some(web)) => ok(&json!({
            "issuer": issuer,
            "webClientId": web,
            "desktopClientId": o.desktop_client_id.filter(|d| !d.trim().is_empty()),
            "scopes": o.scopes,
        })),
        _ => problem(503, "Connexion non configuree", "Auth:Oidc (fournisseur d'identite) manque sur ce serveur."),
    }
}

pub async fn me(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    Ok(match users::by_id(&mut c, &p.sub).await? {
        Some(u) => ok(&json!({
            "id": u.id, "displayName": u.display_name, "email": u.email.unwrap_or_default(), "isAdmin": u.is_admin,
            // Reglage de l'instance (applique par zitadel-bootstrap), montre dans les Parametres.
            "signupClosed": st.settings().bool_or("Auth:SignupClosed", false),
            // Page du fournisseur d'identite pour ajouter une cle d'acces (ecrite par zitadel-bootstrap).
            "passkeyUrl": st.settings().str("Auth:Oidc:PasskeyUrl").filter(|u| !u.trim().is_empty()),
        })),
        None => super::status(401),
    })
}

pub async fn usage(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    Ok(ok(&st.quota.usage_of_account(&st.limits(), &p.sub).await?))
}

#[derive(Deserialize, Default)]
pub struct DeleteMe {
    confirm: Option<String>,
}

pub const DELETE_CONFIRMATION: &str = "SUPPRIMER";

pub async fn delete_me(State(st): State<AppState>, Auth(p): Auth, body: axum::body::Bytes) -> AppResult<Response> {
    let req: DeleteMe = serde_json::from_slice(&body).unwrap_or_default();
    if req.confirm.as_deref() != Some(DELETE_CONFIRMATION) {
        return Ok(problem(400, "Confirmation manquante", &format!("Envoyer {{ \"confirm\": \"{DELETE_CONFIRMATION}\" }} pour supprimer le compte.")));
    }
    crate::services::accounts::delete_account(&st, &p.sub).await?;
    Ok(no_content())
}

// ── Jetons personnels ────────────────────────────────────────────────────────
//
// Un jeton agit au nom de la personne qui l'a cree, avec ses droits, et
// seulement sur les vaults choisis (tous, s'il n'y en a pas). Il ne sert que
// sur l'API ouverte. Le serveur n'en garde que l'empreinte.

fn token_dto(t: &AccessToken) -> Value {
    json!({
        "id": t.id, "name": t.name, "prefix": t.prefix, "scope": t.scope, "vaultIds": t.vault_ids,
        "createdAt": t.created_at, "expiresAt": t.expires_at, "lastUsedAt": t.last_used_at, "revoked": t.revoked_at.is_some(),
        "agentId": t.agent_id,
    })
}

fn require_token_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne peut pas creer de jeton."));
    }
    Ok(())
}

pub async fn list_tokens(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    require_token_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    Ok(ok(&repos::tokens_for_user(&mut c, &p.sub).await?.iter().map(token_dto).collect::<Vec<_>>()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTokenRequest {
    name: Option<String>,
    vault_ids: Option<Vec<String>>,
    expires_in_days: Option<i64>,
    /// L'agent que portera l'IA externe (ADR-033). Absent : lecture seule.
    agent_id: Option<String>,
}

pub async fn create_token(State(st): State<AppState>, Auth(p): Auth, Body(req): Body<CreateTokenRequest>) -> AppResult<Response> {
    let name = req.name.unwrap_or_default();
    if name.is_empty() {
        return Err(AppError::validation("Donnez un nom au jeton."));
    }
    if name.encode_utf16().count() > access_token::MAX_NAME_CHARS {
        return Err(AppError::validation(format!("Le nom fait {} caracteres au plus.", access_token::MAX_NAME_CHARS)));
    }
    if let Some(d) = req.expires_in_days
        && !(1..=access_token::MAX_DAYS).contains(&d)
    {
        return Err(AppError::validation(format!("La duree va de 1 a {} jours.", access_token::MAX_DAYS)));
    }
    if let Some(v) = &req.vault_ids
        && (v.is_empty() || v.len() > access_token::MAX_VAULTS)
    {
        return Err(AppError::validation("Choisissez au moins un vault (ou tous)."));
    }
    require_token_account(&p.sub)?;
    let at = now();
    let mut c = st.db.acquire().await?;
    if repos::tokens_active_count(&mut c, &p.sub, at).await? >= access_token::MAX_ACTIVE_PER_USER {
        return Err(AppError::validation("Trop de jetons actifs : revoquez-en un d'abord."));
    }
    let vault_ids = match req.vault_ids {
        None => None,
        Some(ids) => {
            // Seulement des vaults de la personne : un jeton ne donne jamais plus que ses droits.
            let mine: HashSet<String> = repos::vaults_for_user(&mut c, &p.sub).await?.into_iter().map(|(v, _)| v.id).collect();
            let mut seen = HashSet::new();
            let ids: Vec<String> = ids.into_iter().filter(|i| seen.insert(i.clone())).collect();
            if ids.iter().any(|i| !mine.contains(i)) {
                return Err(AppError::validation("Un des vaults choisis ne vous est pas accessible."));
            }
            Some(ids)
        }
    };
    // Un agent que la personne peut utiliser : le sien, ou un agent d'un de ses vaults.
    let agent_id = match req.agent_id.filter(|a| !a.is_empty()) {
        None => None,
        Some(id) => {
            let agent = crate::db::agents::get(&mut c, &id).await?.ok_or_else(|| AppError::validation("Agent inconnu."))?;
            if !crate::api::agents::can_use(&mut c, &p.sub, &agent).await? {
                return Err(AppError::validation("Cet agent ne vous est pas accessible."));
            }
            Some(id)
        }
    };
    let token = access_token::generate();
    let record = AccessToken {
        id: new_id_n(),
        user_id: p.sub.clone(),
        name: name.trim().to_string(),
        prefix: access_token::display(&token),
        token_hash: access_token::hash(&token),
        scope: access_token::READ_SCOPE.into(),
        vault_ids,
        created_at: at,
        expires_at: req.expires_in_days.map(|d| at + chrono::Duration::days(d)),
        last_used_at: None,
        revoked_at: None,
        agent_id,
    };
    repos::token_add(&mut c, &record).await?;
    Ok(ok(&json!({ "token": token, "info": token_dto(&record) })))
}

pub async fn revoke_token(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>) -> AppResult<Response> {
    require_token_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    if !repos::token_revoke(&mut c, &id, &p.sub, now()).await? {
        return Err(AppError::DocumentNotFound(id));
    }
    Ok(no_content())
}

// ── Retours des testeurs ─────────────────────────────────────────────────────

pub const MAX_MESSAGE_CHARS: usize = 5000;
pub const MAX_CONTEXT_CHARS: usize = 8 * 1024;
pub const MAX_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OPEN_PER_USER: i64 = 200;
pub const MAX_FEEDBACK_REQUEST: usize = 6 * 1024 * 1024;

/// Type d'une capture d'apres ses premiers octets ; None : ni PNG ni JPEG.
pub fn image_type(b: &[u8]) -> Option<&'static str> {
    if b.len() > 8 && b[..4] == [0x89, 0x50, 0x4E, 0x47] {
        return Some("image/png");
    }
    if b.len() > 3 && b[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    None
}

#[derive(Deserialize)]
pub struct FeedbackRequest {
    message: Option<String>,
    context: Option<Value>,
    screenshot: Option<String>,
}

pub async fn submit_feedback(
    State(st): State<AppState>,
    Auth(p): Auth,
    ReqParts(parts): ReqParts,
    Body(req): Body<FeedbackRequest>,
) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Upload, Some(&p.sub), &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let context = match req.context {
        Some(Value::Object(m)) => Some(Value::Object(m).to_string()),
        _ => None,
    };
    let screenshot = match req.screenshot.filter(|s| !s.trim().is_empty()) {
        None => None,
        Some(v) => {
            let data = if v.starts_with("data:") { v.split_once(',').map(|x| x.1).unwrap_or("") } else { v.as_str() };
            Some(base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| AppError::validation("Capture illisible."))?)
        }
    };
    let message = req.message.unwrap_or_default();
    if message.is_empty() {
        return Err(AppError::validation("Écrivez quelques mots."));
    }
    if message.encode_utf16().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::validation(format!("Le message fait {MAX_MESSAGE_CHARS} caracteres au plus.")));
    }
    if context.as_ref().is_some_and(|c| c.encode_utf16().count() > MAX_CONTEXT_CHARS) {
        return Err(AppError::validation("Contexte trop long."));
    }
    if let Some(s) = &screenshot {
        if s.len() > MAX_SCREENSHOT_BYTES {
            return Err(AppError::validation("Capture trop lourde."));
        }
        if image_type(s).is_none() {
            return Err(AppError::validation("La capture doit être une image PNG ou JPEG."));
        }
    }
    if is_link_caller(&p.sub) {
        return Err(AppError::denied("Un lien de partage ne peut pas envoyer de retour."));
    }
    let mut c = st.db.acquire().await?;
    if repos::feedback_open_count(&mut c, &p.sub).await? >= MAX_OPEN_PER_USER {
        return Err(AppError::validation("Trop de retours en attente : réessayez plus tard."));
    }
    let ua = parts.headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|u| u.chars().take(512).collect::<String>());
    let id = new_id_n();
    let ctx = context.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "{}".into());
    repos::feedback_add(
        &mut c,
        &id,
        &p.sub,
        message.trim(),
        &ctx,
        ua.as_deref().filter(|u| !u.is_empty()),
        screenshot.as_deref(),
        screenshot.as_deref().and_then(image_type),
    )
    .await?;
    Ok(ok(&json!({ "id": id })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn screenshot_types() {
        assert_eq!(super::image_type(&[0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0]), Some("image/png"));
        assert_eq!(super::image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(super::image_type(b"GIF89a"), None);
    }
}
