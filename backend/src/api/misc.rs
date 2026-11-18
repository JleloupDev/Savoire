// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Routes sans compte :
//   GET  /health/live, /health/ready
//   GET  /api/v1/store/config            ou trouver le Savoire Store, et sa cle publique
//   GET  /api/v1/errors/config           ou envoyer les rapports d'erreur (vide : nulle part)
//   POST /api/v1/errors/envelope         un rapport, relaye a GlitchTip (« tunnel » Sentry)
//   GET  /openapi.yaml                   description de l'API de l'application

use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::{Policy, ReqParts, client_ip, ok, rate, status};
use crate::state::AppState;

pub async fn live() -> Response {
    ok(&json!({ "status": "live" }))
}

pub async fn ready(State(st): State<AppState>) -> Response {
    match sqlx::query("SELECT 1").execute(&st.db).await {
        Ok(_) => ok(&json!({ "status": "ready" })),
        Err(_) => {
            let mut r = ok(&json!({ "status": "database-unreachable" }));
            *r.status_mut() = axum::http::StatusCode::SERVICE_UNAVAILABLE;
            r
        }
    }
}

pub async fn store_config(State(st): State<AppState>) -> Response {
    let s = st.settings();
    ok(&json!({ "url": s.str("Store:Url").filter(|v| !v.trim().is_empty()), "publicKey": s.str("Store:PublicKey").filter(|v| !v.trim().is_empty()) }))
}

pub async fn openapi() -> Response {
    let mut r = include_str!("../../assets/openapi.yaml").into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/yaml"));
    r
}

// ── Rapports d'erreur ────────────────────────────────────────────────────────
//
// Le navigateur envoie ses rapports a l'API, qui les relaie a GlitchTip sur le
// reseau interne : GlitchTip n'est jamais expose sur Internet. Un rapport
// (enveloppe Sentry) commence par une ligne JSON qui porte le DSN de
// l'expediteur ; seul le DSN attendu (ErrorReporting:ClientDsn) passe.

pub const MAX_ENVELOPE_BYTES: usize = 256 * 1024;

/// (cle, projet) d'un DSN Sentry (https://cle@hote/projet).
pub fn parse_dsn(dsn: Option<&str>) -> Option<(String, String)> {
    let dsn = dsn?.trim();
    if dsn.is_empty() {
        return None;
    }
    let u = url::Url::parse(dsn).ok()?;
    let key = u.username().to_string();
    let project = u.path().trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    if key.is_empty() || project.is_empty() || !project.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((key, project))
}

/// Le DSN annonce en tete de l'enveloppe, s'il est celui attendu.
pub fn route(body: &[u8], allowed: Option<&str>) -> Option<(String, String)> {
    let allowed = parse_dsn(allowed)?;
    let header = match body.iter().position(|b| *b == b'\n') {
        Some(i) => &body[..i],
        None => body,
    };
    let v: Value = serde_json::from_slice(header).ok()?;
    let dsn = v.get("dsn")?.as_str()?;
    (parse_dsn(Some(dsn))? == allowed).then_some(allowed)
}

pub async fn errors_config(State(st): State<AppState>) -> Response {
    let s = st.settings();
    let dsn = s.str("ErrorReporting:ClientDsn");
    let on = parse_dsn(dsn.as_deref()).is_some() && s.str("ErrorReporting:Upstream").is_some_and(|u| !u.trim().is_empty());
    ok(&json!({
        "dsn": if on { dsn } else { None },
        "environment": s.str("ErrorReporting:Environment"),
        "release": s.str("ErrorReporting:Release"),
    }))
}

pub async fn errors_envelope(State(st): State<AppState>, ReqParts(parts): ReqParts, body: axum::body::Bytes) -> Response {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return r;
    }
    let s = st.settings();
    let Some(upstream) = s.str("ErrorReporting:Upstream").filter(|u| !u.trim().is_empty()) else { return status(404) };
    let Some((key, project)) = route(&body, s.str("ErrorReporting:ClientDsn").as_deref()) else { return status(400) };
    let url = format!("{}/api/{project}/envelope/", upstream.trim_end_matches('/'));
    let res = st
        .http
        .post(url)
        .header("Content-Type", "application/x-sentry-envelope")
        .header("X-Sentry-Auth", format!("Sentry sentry_version=7, sentry_key={key}, sentry_client=savoire-tunnel/1"))
        .body(body.to_vec())
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match res {
        Ok(r) => status(r.status().as_u16()),
        Err(e) => {
            // GlitchTip arrete : l'appli ne doit pas en souffrir.
            tracing::warn!(error = %e, "Rapport d'erreur non relaye");
            status(503)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsn_rules() {
        assert_eq!(parse_dsn(Some("https://abc@errors.example/12")), Some(("abc".into(), "12".into())));
        assert_eq!(parse_dsn(Some("https://errors.example/12")), None);
        assert_eq!(parse_dsn(Some("https://abc@errors.example/x")), None);
        let allowed = "https://abc@errors.example/12";
        let ok_body = b"{\"dsn\":\"https://abc@errors.example/12\"}\n{}";
        assert_eq!(route(ok_body, Some(allowed)), Some(("abc".into(), "12".into())));
        let other = b"{\"dsn\":\"https://zzz@errors.example/12\"}\n{}";
        assert_eq!(route(other, Some(allowed)), None);
        assert_eq!(route(ok_body, None), None);
    }
}
