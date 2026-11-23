// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion a Notion pour l'import (ADR-035) : le serveur garde le secret de
// l'integration publique Notion et fait l'echange du code. Il ne garde aucun
// jeton : il le remet une fois a l'application bureau, qui l'utilise seule.
//
//   GET  /api/v1/notion/config     { available } : l'integration est-elle configuree ?
//   GET  /api/v1/notion/authorize  ?port&state&challenge -> page d'autorisation de Notion
//   GET  /api/v1/notion/callback   retour de Notion : echange du code, puis
//                                  http://127.0.0.1:<port>/callback?ticket&state
//   POST /api/v1/notion/ticket     { ticket, state, verifier } -> le jeton, une seule fois
//   POST /api/v1/notion/refresh    { refreshToken } -> un jeton neuf
//
// Le ticket ne vaut rien sans le « verifier » (PKCE S256) que seule
// l'application connait : lire l'adresse de retour ne suffit pas. Routes sans
// compte : la version bureau n'en a pas forcement. Comptees par adresse.
//
// Configuration : Notion:ClientId, Notion:ClientSecret, Notion:RedirectUri
// (facultatif : <adresse publique>/api/v1/notion/callback). C'est l'adresse
// declaree chez Notion pour l'integration.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect, Response};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Body, Policy, ReqParts, client_ip, ok, public_base, rate, status};
use crate::state::AppState;

const AUTHORIZE_URL: &str = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL: &str = "https://api.notion.com/v1/oauth/token";
const CALLBACK_PATH: &str = "/api/v1/notion/callback";
/// Duree de vie d'un ticket : le temps que l'application le reprenne.
const TICKET_TTL: Duration = Duration::from_secs(120);
/// Tickets en attente au plus (le reste est refuse).
const MAX_TICKETS: usize = 1000;

/// Un jeton Notion en attente, remis une fois.
pub struct NotionTicket {
    state: String,
    challenge: String,
    token: Value,
    created: Instant,
}

struct Integration {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}

fn integration(st: &AppState, parts: &axum::http::request::Parts) -> Option<Integration> {
    let s = st.settings();
    let id = s.str("Notion:ClientId").filter(|v| !v.trim().is_empty())?;
    let secret = s.str("Notion:ClientSecret").filter(|v| !v.trim().is_empty())?;
    let redirect_uri = s
        .str("Notion:RedirectUri")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("{}{CALLBACK_PATH}", public_base(st, parts)));
    Some(Integration { client_id: id.trim().into(), client_secret: secret.trim().into(), redirect_uri })
}

/// Port de l'ecoute locale de l'application (jamais un port reserve).
pub fn valid_port(v: &str) -> Option<u16> {
    let p: u16 = v.parse().ok()?;
    (p >= 1024).then_some(p)
}

/// Etat et defi : des caracteres d'URL sans echappement, longueur bornee.
pub fn valid_token(v: &str, min: usize) -> bool {
    (min..=128).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Defi PKCE S256 d'un verifier.
pub fn challenge_of(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// « port.etat.defi » : ce que Notion nous rend tel quel.
pub fn split_state(v: &str) -> Option<(u16, String, String)> {
    let mut it = v.splitn(3, '.');
    let port = valid_port(it.next()?)?;
    let state = it.next()?.to_string();
    let challenge = it.next()?.to_string();
    (valid_token(&state, 16) && valid_token(&challenge, 43)).then_some((port, state, challenge))
}

fn loopback(port: u16, pairs: &[(&str, &str)]) -> Response {
    let query: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect();
    Redirect::to(&format!("http://127.0.0.1:{port}/callback?{}", query.join("&"))).into_response()
}

fn random_ticket() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn purge(st: &AppState) {
    st.notion_tickets.retain(|_, t| t.created.elapsed() < TICKET_TTL);
}

/// Ce qu'on garde de la reponse de Notion (jamais le reste).
pub fn token_fields(v: &Value) -> Option<Value> {
    let access = v.get("access_token")?.as_str()?;
    Some(json!({
        "accessToken": access,
        "refreshToken": v.get("refresh_token").and_then(Value::as_str),
        "expiresIn": v.get("expires_in").and_then(Value::as_i64),
        "workspaceId": v.get("workspace_id").and_then(Value::as_str),
        "workspaceName": v.get("workspace_name").and_then(Value::as_str),
        "workspaceIcon": v.get("workspace_icon").and_then(Value::as_str),
        "botId": v.get("bot_id").and_then(Value::as_str),
    }))
}

async fn token_request(st: &AppState, it: &Integration, body: Value) -> Result<Value, (u16, String)> {
    let res = st
        .http
        .post(TOKEN_URL)
        .basic_auth(&it.client_id, Some(&it.client_secret))
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| (502, format!("Notion injoignable : {e}")))?;
    let code = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if code != 200 {
        let msg = v.get("error_description").or_else(|| v.get("message")).and_then(Value::as_str).unwrap_or("refus de Notion");
        return Err((if code == 400 || code == 401 { 400 } else { 502 }, msg.to_string()));
    }
    token_fields(&v).ok_or((502, "Reponse de Notion sans jeton.".into()))
}

pub async fn config(State(st): State<AppState>, ReqParts(parts): ReqParts) -> Response {
    ok(&json!({ "available": integration(&st, &parts).is_some() }))
}

pub async fn authorize(State(st): State<AppState>, ReqParts(parts): ReqParts, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return r;
    }
    let Some(it) = integration(&st, &parts) else { return status(404) };
    let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
    let Some(port) = valid_port(get("port")) else { return super::bad_request("port invalide.") };
    if !valid_token(get("state"), 16) || !valid_token(get("challenge"), 43) {
        return super::bad_request("state ou challenge invalide.");
    }
    let state = format!("{port}.{}.{}", get("state"), get("challenge"));
    let url = format!(
        "{AUTHORIZE_URL}?client_id={}&response_type=code&owner=user&redirect_uri={}&state={}",
        urlencoding::encode(&it.client_id),
        urlencoding::encode(&it.redirect_uri),
        urlencoding::encode(&state),
    );
    Redirect::to(&url).into_response()
}

pub async fn callback(State(st): State<AppState>, ReqParts(parts): ReqParts, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return r;
    }
    let Some(it) = integration(&st, &parts) else { return status(404) };
    let Some((port, state, challenge)) = q.get("state").and_then(|s| split_state(s)) else {
        return super::bad_request("Retour de Notion sans etat valable.");
    };
    if let Some(err) = q.get("error") {
        return loopback(port, &[("error", err), ("state", &state)]);
    }
    let Some(code) = q.get("code").filter(|c| !c.is_empty() && c.len() <= 512) else {
        return loopback(port, &[("error", "invalid_request"), ("state", &state)]);
    };
    let token = match token_request(&st, &it, json!({ "grant_type": "authorization_code", "code": code, "redirect_uri": it.redirect_uri })).await {
        Ok(t) => t,
        Err((_, msg)) => {
            tracing::warn!(error = %msg, "Echange du code Notion refuse");
            return loopback(port, &[("error", "exchange_failed"), ("error_description", &msg), ("state", &state)]);
        }
    };
    purge(&st);
    if st.notion_tickets.len() >= MAX_TICKETS {
        return loopback(port, &[("error", "busy"), ("state", &state)]);
    }
    let ticket = random_ticket();
    st.notion_tickets.insert(ticket.clone(), NotionTicket { state: state.clone(), challenge, token, created: Instant::now() });
    loopback(port, &[("ticket", &ticket), ("state", &state)])
}

#[derive(Deserialize)]
pub struct TicketBody {
    ticket: String,
    state: String,
    verifier: String,
}

pub async fn ticket(State(st): State<AppState>, ReqParts(parts): ReqParts, Body(b): Body<TicketBody>) -> Response {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return r;
    }
    purge(&st);
    // Retire d'abord : un ticket ne sert qu'une fois, meme mal presente.
    let Some((_, t)) = st.notion_tickets.remove(&b.ticket) else { return status(404) };
    if t.state != b.state || t.challenge != challenge_of(&b.verifier) {
        return status(403);
    }
    ok(&t.token)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshBody {
    refresh_token: String,
}

pub async fn refresh(State(st): State<AppState>, ReqParts(parts): ReqParts, Body(b): Body<RefreshBody>) -> Response {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return r;
    }
    let Some(it) = integration(&st, &parts) else { return status(404) };
    if b.refresh_token.is_empty() || b.refresh_token.len() > 2048 {
        return super::bad_request("refreshToken invalide.");
    }
    match token_request(&st, &it, json!({ "grant_type": "refresh_token", "refresh_token": b.refresh_token })).await {
        Ok(t) => ok(&t),
        Err((code, msg)) => super::problem(code, "Notion", &msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_round_trip() {
        let ch = challenge_of("un-verifier-assez-long-pour-pkce-0123456789abcdef");
        let s = format!("54321.abcdefghijklmnop.{ch}");
        assert_eq!(split_state(&s), Some((54321, "abcdefghijklmnop".into(), ch.clone())));
        assert_eq!(split_state(&format!("80.abcdefghijklmnop.{ch}")), None, "port reserve");
        assert_eq!(split_state(&format!("54321.court.{ch}")), None, "etat trop court");
        assert_eq!(split_state("54321.abcdefghijklmnop.x"), None, "defi trop court");
        assert_eq!(split_state(&format!("54321.abc/defghijklmnop.{ch}")), None, "caractere refuse");
    }

    #[test]
    fn pkce_s256() {
        // Vecteur de la RFC 7636, annexe B.
        assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn keeps_only_known_fields() {
        let v = json!({ "access_token": "a", "refresh_token": "r", "workspace_name": "W", "owner": { "user": {} }, "x": 1 });
        let t = token_fields(&v).unwrap();
        assert_eq!(t["accessToken"], "a");
        assert_eq!(t["refreshToken"], "r");
        assert_eq!(t["workspaceName"], "W");
        assert!(t.get("owner").is_none());
        assert!(token_fields(&json!({})).is_none());
    }
}
