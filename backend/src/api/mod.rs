// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'API REST : memes routes, memes corps (JSON en camelCase) et memes
// reponses que le serveur .NET.

pub mod account;
pub mod agents;
pub mod admin;
pub mod attachments;
pub mod indexer;
pub mod misc;
pub mod notion;
pub mod oauth;
pub mod open;
pub mod publications;
pub mod sharing;
pub mod sync;
pub mod vaults;

use axum::extract::{FromRequest, Request};
use axum::http::{HeaderValue, StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{AppError, indexer_error_json, raw_json};
use crate::services::indexer::IndexerReply;
use crate::state::AppState;

/// Corps JSON. Illisible : 400 (Problem Details), comme [FromBody] en .NET.
/// Le type de contenu n'est pas exige.
pub struct Body<T>(pub T);

impl<S, T> FromRequest<S> for Body<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;
    async fn from_request(req: Request, state: &S) -> Result<Self, Response> {
        let bytes = axum::body::Bytes::from_request(req, state).await.map_err(|e| {
            if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                StatusCode::PAYLOAD_TOO_LARGE.into_response()
            } else {
                AppError::validation("Corps de requete illisible.").into_response()
            }
        })?;
        serde_json::from_slice::<T>(&bytes)
            .map(Body)
            .map_err(|e| AppError::validation(format!("Corps JSON invalide : {e}")).into_response())
    }
}

/// 200 + JSON.
pub fn ok<T: Serialize>(v: &T) -> Response {
    axum::Json(v).into_response()
}

pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

pub fn status(code: u16) -> Response {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR).into_response()
}

/// 400 avec un texte simple (BadRequest("...") cote .NET).
pub fn bad_request(text: &str) -> Response {
    let mut r = (StatusCode::BAD_REQUEST, text.to_string()).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

/// Problem Details avec titre et detail (Problem(...) cote .NET).
pub fn problem(code: u16, title: &str, detail: &str) -> Response {
    let body = serde_json::json!({
        "type": "https://tools.ietf.org/html/rfc9110",
        "title": title,
        "status": code,
        "detail": detail,
    });
    let mut r = (StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), axum::Json(body)).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/problem+json"));
    r
}

/// Reponse d'une route du pair indexeur (statut, JSON, Retry-After).
pub fn reply(r: IndexerReply) -> Response {
    let mut res = raw_json(r.status, r.json);
    if let Some(s) = r.retry_after
        && let Ok(v) = HeaderValue::from_str(&s.to_string())
    {
        res.headers_mut().insert(header::RETRY_AFTER, v);
    }
    res
}

// ── Limitation de debit ──────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    Upload,
    Publish,
    Lookup,
    VaultCreate,
    /// Routes sans compte : compte par adresse.
    Anonymous,
}

fn too_many(seconds: u64, message: &str) -> Response {
    let mut r = raw_json(429, indexer_error_json("rate_limited", message).to_string());
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    r
}

/// Adresse du visiteur ; derriere les relais (ForwardedHeaders:Enabled), celle de X-Forwarded-For.
pub fn client_ip(st: &AppState, parts: &Parts) -> String {
    let s = st.settings();
    if s.bool_or("ForwardedHeaders:Enabled", false)
        && let Some(xff) = parts.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
    {
        let hops: Vec<&str> = xff.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
        let limit = s.i64_or("ForwardedHeaders:ForwardLimit", 2).max(1) as usize;
        // Le plus a gauche des relais de confiance (ForwardLimit au plus).
        let idx = hops.len().saturating_sub(limit);
        if let Some(ip) = hops.get(idx) {
            return ip.to_string();
        }
    }
    parts
        .extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "inconnue".into())
}

/// Un jeton du seau de la route (par compte, ou par adresse).
pub fn rate(st: &AppState, policy: Policy, who: Option<&str>, ip: &str) -> Result<(), Response> {
    let l = st.limits();
    let (name, per_minute) = match policy {
        Policy::Upload => ("upload", l.uploads_per_minute),
        Policy::Publish => ("publish", l.publish_per_minute),
        Policy::Lookup => ("lookup", l.lookups_per_minute),
        Policy::VaultCreate => ("vault-create", l.vault_creations_per_minute),
        Policy::Anonymous => ("anonymous", l.anonymous_per_minute),
    };
    let key = match (policy, who) {
        (Policy::Anonymous, _) | (_, None) => format!("{name}:ip:{ip}"),
        (_, Some(u)) => format!("{name}:u:{u}"),
    };
    st.limiter.try_acquire(&key, per_minute).map_err(|s| too_many(s, "Trop de requetes en peu de temps, reessayer plus tard."))
}

/// Seaux du pair indexeur : par personne, puis par vault de la route.
pub fn indexer_rate(st: &AppState, user: &str, vault_id: Option<&str>) -> Result<(), Response> {
    let o = crate::options::IndexerOptions::from(&st.settings());
    let msg = "Trop de requetes vers le pair indexeur, reessayer plus tard.";
    st.limiter.try_acquire(&format!("idx:u:{user}"), o.per_user_per_minute.max(1)).map_err(|s| too_many(s, msg))?;
    if let Some(v) = vault_id {
        st.limiter.try_acquire(&format!("idx:v:{v}"), o.per_vault_per_minute.max(1)).map_err(|s| too_many(s, msg))?;
    }
    Ok(())
}

/// Extracteur des en-tetes de la requete (adresse, hote, agent).
pub struct ReqParts(pub Parts);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for ReqParts {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(ReqParts(parts.clone()))
    }
}

/// « https://hote » de la requete (X-Forwarded-* derriere les relais).
pub fn public_base(st: &AppState, parts: &Parts) -> String {
    let fwd = st.settings().bool_or("ForwardedHeaders:Enabled", false);
    let h = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok()).map(|v| v.split(',').next().unwrap_or("").trim().to_string());
    let scheme = if fwd { h("x-forwarded-proto") } else { None }.unwrap_or_else(|| "http".into());
    let host = if fwd { h("x-forwarded-host") } else { None }.or_else(|| h("host")).unwrap_or_else(|| "localhost".into());
    format!("{scheme}://{host}")
}

/// 200 + JSON deja forme.
pub fn raw_json_ok(v: serde_json::Value) -> Response {
    raw_json(200, v.to_string())
}
