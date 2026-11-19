// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// OAuth pour le MCP (ADR-033) : ChatGPT et Claude.ai se branchent sur
// /api/mcp sans jeton colle a la main. Savoire est le serveur d'autorisation
// de son propre MCP (specification d'autorisation MCP 2025-11-25) :
//
//   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server            RFC 8414
//   POST /api/oauth/register                                RFC 7591 (enregistrement dynamique)
//   GET  /api/oauth/authorize                               code + PKCE S256 -> ecran d'accord
//   POST /api/oauth/token                                   code, renouvellement
//   GET  /api/v1/oauth/requests/{id}                        ecran d'accord (compte connecte)
//   POST /api/v1/oauth/requests/{id}/decide                 { approve, agentId?, vaultIds? }
//   GET  /api/v1/me/oauth-grants, DELETE .../{id}           acces accordes (Parametres > API)
//
// Un client peut aussi se designer par une adresse https (Client ID Metadata
// Document) : le serveur lit le document et verifie ses adresses de retour.
//
// L'ecran d'accord (apps/web, /oauth/consent) fait choisir l'AGENT que portera
// l'IA et les vaults ouverts. Le jeton d'acces (sva_, une heure) est rattache
// a cet acces ; le renouvellement (svr_, 30 jours) est remplace a chaque usage.
// Codes et jetons : seulement leur empreinte en base. Les memes regles que
// les jetons personnels s'appliquent ensuite au MCP (agent, vaults, droits).

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Redirect, Response};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};

use super::{Body, Policy, ReqParts, client_ip, no_content, ok, public_base, rate};
use crate::auth::Auth;
use crate::db::repos;
use crate::domain::{Ts, is_link_caller, new_id_n, now, random_token};
use crate::error::{AppError, AppResult, raw_json};
use crate::state::AppState;

pub const ACCESS_PREFIX: &str = "sva_";
pub const REFRESH_PREFIX: &str = "svr_";
const ACCESS_TTL_S: i64 = 3600;
const REFRESH_TTL_DAYS: i64 = 30;
const CODE_TTL_S: i64 = 300;
const REQUEST_TTL_S: i64 = 600;
pub const SCOPE: &str = "mcp";
pub const CONSENT_PATH: &str = "/oauth/consent";
const MAX_REDIRECTS: usize = 10;

/// Un jeton d'acces OAuth (a verifier en base).
pub fn looks_like(token: &str) -> bool {
    token.len() > 20 && token.len() < 200 && token.starts_with(ACCESS_PREFIX)
}

fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// L'adresse du MCP (la ressource protegee).
pub fn resource_url(base: &str) -> String {
    format!("{base}/api/mcp")
}

/// Ce que dit l'en-tete WWW-Authenticate d'un refus du MCP (RFC 9728, section 5.1).
pub fn www_authenticate(base: &str) -> String {
    format!("Bearer realm=\"savoire\", error=\"invalid_token\", scope=\"{SCOPE}\", resource_metadata=\"{base}/.well-known/oauth-protected-resource\"")
}

// ── Metadonnees ──────────────────────────────────────────────────────────────

fn json_no_store(status: u16, v: Value) -> Response {
    let mut r = raw_json(status, v.to_string());
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r
}

pub async fn protected_resource(State(st): State<AppState>, ReqParts(parts): ReqParts) -> Response {
    let base = public_base(&st, &parts);
    json_no_store(200, json!({
        "resource": resource_url(&base),
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": [SCOPE],
        "resource_name": "Savoire",
    }))
}

pub async fn authorization_server(State(st): State<AppState>, ReqParts(parts): ReqParts) -> Response {
    let base = public_base(&st, &parts);
    json_no_store(200, json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/api/oauth/authorize"),
        "token_endpoint": format!("{base}/api/oauth/token"),
        "registration_endpoint": format!("{base}/api/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": [SCOPE],
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    }))
}

// ── Erreurs OAuth ────────────────────────────────────────────────────────────

fn oauth_error(status: u16, error: &str, description: &str) -> Response {
    json_no_store(status, json!({ "error": error, "error_description": description }))
}

/// Erreur avant de connaitre une adresse de retour sure : une page, pas une redirection.
fn error_page(status: u16, message: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Savoire</title><body style=\"font-family:sans-serif;max-width:520px;margin:60px auto\"><h2>Connexion impossible</h2><p>{}</p></body>",
        html_escape(message)
    );
    let mut r = (axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::BAD_REQUEST), body).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    r
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn with_query(uri: &str, pairs: &[(&str, &str)]) -> String {
    let mut u = url::Url::parse(uri).expect("adresse verifiee");
    {
        let mut q = u.query_pairs_mut();
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
    }
    u.to_string()
}

// ── Clients ──────────────────────────────────────────────────────────────────

/// Une adresse de retour acceptable : https, ou http sur la machine locale. Sans fragment.
pub fn valid_redirect(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else { return false };
    if u.fragment().is_some() || uri.len() > 2000 {
        return false;
    }
    match u.scheme() {
        "https" => u.host_str().is_some(),
        "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

struct Client {
    client_id: String,
    name: String,
    redirect_uris: Vec<String>,
}

async fn client_get(c: &mut PgConnection, id: &str) -> AppResult<Option<Client>> {
    let r = sqlx::query("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1").bind(id).fetch_optional(&mut *c).await?;
    Ok(r.map(|r| {
        let uris: Value = r.get("redirect_uris");
        Client {
            client_id: r.get("client_id"),
            name: r.get("client_name"),
            redirect_uris: uris.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        }
    }))
}

async fn client_save(c: &mut PgConnection, cl: &Client, kind: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, kind, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris",
    )
    .bind(&cl.client_id)
    .bind(&cl.name)
    .bind(json!(cl.redirect_uris))
    .bind(kind)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

fn clean_name(v: Option<&Value>) -> String {
    let n: String = v.and_then(Value::as_str).unwrap_or("Client MCP").trim().chars().take(100).collect();
    if n.is_empty() { "Client MCP".into() } else { n }
}

fn redirect_list(v: Option<&Value>) -> Result<Vec<String>, String> {
    let list: Vec<String> = v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if list.is_empty() || list.len() > MAX_REDIRECTS {
        return Err(format!("redirect_uris : de 1 a {MAX_REDIRECTS} adresses."));
    }
    if let Some(bad) = list.iter().find(|u| !valid_redirect(u)) {
        return Err(format!("redirect_uri refusee (https, ou http sur localhost) : {bad}"));
    }
    Ok(list)
}

/// POST /api/oauth/register (RFC 7591) : un client public (PKCE), sans secret.
pub async fn register(State(st): State<AppState>, ReqParts(parts): ReqParts, body: axum::body::Bytes) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let Ok(meta) = serde_json::from_slice::<Value>(&body) else {
        return Ok(oauth_error(400, "invalid_client_metadata", "JSON attendu."));
    };
    let redirect_uris = match redirect_list(meta.get("redirect_uris")) {
        Ok(l) => l,
        Err(m) => return Ok(oauth_error(400, "invalid_redirect_uri", &m)),
    };
    if let Some(g) = meta.get("grant_types").and_then(Value::as_array)
        && g.iter().any(|x| !matches!(x.as_str(), Some("authorization_code" | "refresh_token")))
    {
        return Ok(oauth_error(400, "invalid_client_metadata", "grant_types : authorization_code, refresh_token."));
    }
    let cl = Client { client_id: format!("svc_{}", new_id_n()), name: clean_name(meta.get("client_name")), redirect_uris };
    let mut c = st.db.acquire().await?;
    client_save(&mut c, &cl, "dcr").await?;
    Ok(json_no_store(201, json!({
        "client_id": cl.client_id,
        "client_id_issued_at": now().timestamp(),
        "client_name": cl.name,
        "redirect_uris": cl.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPE,
    })))
}

/// Client ID Metadata Document : le client se designe par une adresse https ; on lit son document.
async fn client_from_metadata(st: &AppState, client_id: &str) -> Result<Client, String> {
    let u = url::Url::parse(client_id).map_err(|_| "client_id illisible.".to_string())?;
    if u.scheme() != "https" || u.path() == "/" || u.fragment().is_some() {
        return Err("client_id : adresse https d'un document attendue.".into());
    }
    let res = st.http.get(client_id).timeout(Duration::from_secs(5)).header(header::ACCEPT, "application/json").send().await.map_err(|_| "Document du client injoignable.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("Document du client : statut {}.", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|_| "Document du client illisible.".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("Document du client trop gros.".into());
    }
    let doc: Value = serde_json::from_slice(&bytes).map_err(|_| "Document du client : JSON attendu.".to_string())?;
    if doc.get("client_id").and_then(Value::as_str) != Some(client_id) {
        return Err("Document du client : client_id ne correspond pas a son adresse.".into());
    }
    let redirect_uris = redirect_list(doc.get("redirect_uris"))?;
    Ok(Client { client_id: client_id.into(), name: clean_name(doc.get("client_name")), redirect_uris })
}

async fn resolve_client(st: &AppState, client_id: &str) -> Result<Client, String> {
    let mut c = st.db.acquire().await.map_err(|e| e.to_string())?;
    if client_id.starts_with("https://") {
        // Relu a chaque autorisation : le document peut changer (adresses de retour).
        let cl = client_from_metadata(st, client_id).await?;
        client_save(&mut c, &cl, "cimd").await.map_err(|e| e.to_string())?;
        return Ok(cl);
    }
    client_get(&mut c, client_id).await.map_err(|e| e.to_string())?.ok_or_else(|| "Client inconnu : il doit d'abord s'enregistrer.".into())
}

// ── Autorisation ─────────────────────────────────────────────────────────────

pub async fn authorize(State(st): State<AppState>, ReqParts(parts): ReqParts, Query(q): Query<HashMap<String, String>>) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    let base = public_base(&st, &parts);
    let get = |k: &str| q.get(k).map(String::as_str).filter(|v| !v.is_empty());
    let Some(client_id) = get("client_id") else { return Ok(error_page(400, "client_id manquant.")) };
    let client = match resolve_client(&st, client_id).await {
        Ok(c) => c,
        Err(m) => return Ok(error_page(400, &m)),
    };
    // Une seule adresse enregistree : elle peut etre omise. Sinon elle doit correspondre exactement.
    let redirect_uri = match get("redirect_uri") {
        Some(r) if client.redirect_uris.iter().any(|u| u == r) => r.to_string(),
        None if client.redirect_uris.len() == 1 => client.redirect_uris[0].clone(),
        _ => return Ok(error_page(400, "Adresse de retour inconnue pour ce client.")),
    };
    let state = get("state").map(str::to_string);
    let back = |error: &str, desc: &str| -> Response {
        let mut pairs = vec![("error", error), ("error_description", desc), ("iss", base.as_str())];
        if let Some(s) = &state {
            pairs.push(("state", s.as_str()));
        }
        Redirect::to(&with_query(&redirect_uri, &pairs)).into_response()
    };
    if get("response_type") != Some("code") {
        return Ok(back("unsupported_response_type", "response_type=code attendu."));
    }
    let challenge = match (get("code_challenge"), get("code_challenge_method")) {
        (Some(ch), Some("S256")) if (43..=128).contains(&ch.len()) => ch.to_string(),
        _ => return Ok(back("invalid_request", "PKCE obligatoire : code_challenge et code_challenge_method=S256.")),
    };
    if let Some(r) = get("resource")
        && r.trim_end_matches('/') != resource_url(&base)
        && r.trim_end_matches('/') != base
    {
        return Ok(back("invalid_target", "Ressource inconnue : seulement le MCP de Savoire."));
    }
    let id = random_token();
    let at = now();
    let mut c = st.db.acquire().await?;
    sqlx::query("DELETE FROM oauth_requests WHERE expires_at < $1").bind(at).execute(&mut *c).await?;
    sqlx::query(
        "INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&client.client_id)
    .bind(&redirect_uri)
    .bind(&state)
    .bind(&challenge)
    .bind(get("scope"))
    .bind(at)
    .bind(at + chrono::Duration::seconds(REQUEST_TTL_S))
    .execute(&mut *c)
    .await?;
    Ok(Redirect::to(&format!("{base}{CONSENT_PATH}?request={}", urlencoding::encode(&id))).into_response())
}

struct PendingRequest {
    client_id: String,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: String,
    expires_at: Ts,
}

async fn request_get(c: &mut PgConnection, id: &str) -> AppResult<Option<PendingRequest>> {
    let r = sqlx::query("SELECT client_id, redirect_uri, state, code_challenge, expires_at FROM oauth_requests WHERE id = $1").bind(id).fetch_optional(&mut *c).await?;
    Ok(r.map(|r| PendingRequest {
        client_id: r.get("client_id"),
        redirect_uri: r.get("redirect_uri"),
        state: r.get("state"),
        code_challenge: r.get("code_challenge"),
        expires_at: r.get("expires_at"),
    }))
}

fn require_account(caller: &str) -> AppResult<()> {
    if is_link_caller(caller) {
        return Err(AppError::denied("Un lien de partage ne donne pas d'acces OAuth."));
    }
    Ok(())
}

/// L'ecran d'accord lit la demande : qui demande, vers ou il revient.
pub async fn request_info(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let r = request_get(&mut c, &id).await?.filter(|r| r.expires_at > now()).ok_or_else(|| AppError::DocumentNotFound("demande".into()))?;
    let name = client_get(&mut c, &r.client_id).await?.map(|c| c.name).unwrap_or_else(|| "Client MCP".into());
    let host = url::Url::parse(&r.redirect_uri).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    // Ce que la personne peut choisir : ses vaults, et les agents qu'elle peut porter.
    let vaults = repos::vaults_for_user(&mut c, &p.sub).await?;
    let ids: Vec<String> = vaults.iter().map(|(v, _)| v.id.clone()).collect();
    let agents: Vec<Value> = crate::db::agents::list_for(&mut c, &p.sub, &ids)
        .await?
        .iter()
        .map(|a| json!({ "id": a.id, "name": a.name, "vaultId": a.vault_id }))
        .collect();
    let vaults: Vec<Value> = vaults.iter().map(|(v, _)| json!({ "id": v.id, "name": v.name })).collect();
    Ok(ok(&json!({ "clientName": name, "clientId": r.client_id, "redirectHost": host, "expiresAt": r.expires_at, "vaults": vaults, "agents": agents })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideRequest {
    approve: Option<bool>,
    agent_id: Option<String>,
    vault_ids: Option<Vec<String>>,
}

/// La personne accepte (agent, vaults) ou refuse. Rend l'adresse ou renvoyer le client.
pub async fn decide(State(st): State<AppState>, Auth(p): Auth, ReqParts(parts): ReqParts, Path(id): Path<String>, Body(req): Body<DecideRequest>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let base = public_base(&st, &parts);
    let mut c = st.db.acquire().await?;
    let r = request_get(&mut c, &id).await?.filter(|r| r.expires_at > now()).ok_or_else(|| AppError::DocumentNotFound("demande".into()))?;
    // Une demande ne sert qu'une fois, acceptee ou refusee.
    sqlx::query("DELETE FROM oauth_requests WHERE id = $1").bind(&id).execute(&mut *c).await?;
    let mut pairs: Vec<(&str, String)> = vec![("iss", base.clone())];
    if let Some(s) = &r.state {
        pairs.push(("state", s.clone()));
    }
    if req.approve != Some(true) {
        pairs.push(("error", "access_denied".into()));
        let list: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        return Ok(ok(&json!({ "redirect": with_query(&r.redirect_uri, &list) })));
    }
    // L'agent : le sien, ou un agent d'un de ses vaults. Aucun : lecture seule.
    let agent_id = match req.agent_id.filter(|a| !a.is_empty()) {
        None => None,
        Some(a) => {
            let agent = crate::db::agents::get(&mut c, &a).await?.ok_or_else(|| AppError::validation("Agent inconnu."))?;
            if !crate::api::agents::can_use(&mut c, &p.sub, &agent).await? {
                return Err(AppError::validation("Cet agent ne vous est pas accessible."));
            }
            Some(a)
        }
    };
    let vault_ids = match req.vault_ids {
        None => None,
        Some(ids) if ids.is_empty() => return Err(AppError::validation("Choisissez au moins un vault (ou tous).")),
        Some(ids) => {
            let mine: std::collections::HashSet<String> = repos::vaults_for_user(&mut c, &p.sub).await?.into_iter().map(|(v, _)| v.id).collect();
            if ids.iter().any(|i| !mine.contains(i)) {
                return Err(AppError::validation("Un des vaults choisis ne vous est pas accessible."));
            }
            Some(ids.join(","))
        }
    };
    let name = client_get(&mut c, &r.client_id).await?.map(|c| c.name).unwrap_or_else(|| "Client MCP".into());
    let code = random_token();
    sqlx::query(
        "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, agent_id, vault_ids, client_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(hash(&code))
    .bind(&r.client_id)
    .bind(&r.redirect_uri)
    .bind(&r.code_challenge)
    .bind(&p.sub)
    .bind(&agent_id)
    .bind(&vault_ids)
    .bind(&name)
    .bind(now() + chrono::Duration::seconds(CODE_TTL_S))
    .execute(&mut *c)
    .await?;
    pairs.push(("code", code));
    let list: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Ok(ok(&json!({ "redirect": with_query(&r.redirect_uri, &list) })))
}

// ── Jetons ───────────────────────────────────────────────────────────────────

/// PKCE (RFC 7636) : BASE64URL(SHA256(verifier)) == challenge.
pub fn pkce_ok(verifier: &str, challenge: &str) -> bool {
    (43..=128).contains(&verifier.len()) && b64url(&Sha256::digest(verifier.as_bytes())) == challenge
}

async fn issue(c: &mut PgConnection, grant_id: &str) -> AppResult<Value> {
    let access = format!("{ACCESS_PREFIX}{}", random_token());
    let refresh = format!("{REFRESH_PREFIX}{}", random_token());
    let at = now();
    sqlx::query("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'access', $3), ($4, $2, 'refresh', $5)")
        .bind(hash(&access))
        .bind(grant_id)
        .bind(at + chrono::Duration::seconds(ACCESS_TTL_S))
        .bind(hash(&refresh))
        .bind(at + chrono::Duration::days(REFRESH_TTL_DAYS))
        .execute(&mut *c)
        .await?;
    // Les jetons d'acces expires de cet acces ne servent plus.
    sqlx::query("DELETE FROM oauth_tokens WHERE grant_id = $1 AND expires_at < $2").bind(grant_id).bind(at).execute(&mut *c).await?;
    Ok(json!({ "access_token": access, "token_type": "Bearer", "expires_in": ACCESS_TTL_S, "refresh_token": refresh, "scope": SCOPE }))
}

/// Le client d'une requete au point de jeton : champ client_id, en-tete Basic,
/// ou emetteur d'un client_assertion (RFC 7523). Secret et signature ignores :
/// clients publics, c'est PKCE qui lie le code a qui l'a demande.
fn client_of(form: &HashMap<String, String>, headers: &HeaderMap) -> Option<String> {
    if let Some(id) = form.get("client_id").filter(|v| !v.is_empty()) {
        return Some(id.clone());
    }
    if let Some(jwt) = form.get("client_assertion") {
        let payload = jwt.split('.').nth(1)?;
        let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
        return claims.get("sub").or_else(|| claims.get("iss")).and_then(Value::as_str).map(str::to_string);
    }
    let h = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let raw = h.strip_prefix("Basic ").or_else(|| h.strip_prefix("basic "))?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(raw.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let id = text.split(':').next()?;
    Some(urlencoding::decode(id).ok()?.into_owned())
}

pub async fn token(State(st): State<AppState>, ReqParts(parts): ReqParts, headers: HeaderMap, body: axum::body::Bytes) -> AppResult<Response> {
    if let Err(r) = rate(&st, Policy::Anonymous, None, &client_ip(&st, &parts)) {
        return Ok(r);
    }
    // Formulaire (RFC 6749) ; un corps JSON est accepte aussi.
    let form: HashMap<String, String> = if body.first() == Some(&b'{') {
        serde_json::from_slice::<HashMap<String, Value>>(&body)
            .map(|m| m.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect())
            .unwrap_or_default()
    } else {
        url::form_urlencoded::parse(&body).into_owned().collect()
    };
    let Some(client_id) = client_of(&form, &headers) else { return Ok(oauth_error(401, "invalid_client", "client_id manquant.")) };
    // RFC 8707 : un seul public possible, le MCP de cette instance.
    let base = public_base(&st, &parts);
    if let Some(r) = form.get("resource").map(|r| r.trim_end_matches('/'))
        && r != resource_url(&base)
        && r != base
    {
        return Ok(oauth_error(400, "invalid_target", "Ressource inconnue : seulement le MCP de Savoire."));
    }
    let mut c = st.db.acquire().await?;
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let code = form.get("code").cloned().unwrap_or_default();
            let row = sqlx::query(
                "UPDATE oauth_codes SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL
                 RETURNING client_id, redirect_uri, code_challenge, user_id, agent_id, vault_ids, client_name, expires_at",
            )
            .bind(hash(&code))
            .bind(now())
            .fetch_optional(&mut *c)
            .await?;
            let Some(row) = row else { return Ok(oauth_error(400, "invalid_grant", "Code inconnu ou deja utilise.")) };
            let expires: Ts = row.get("expires_at");
            if expires <= now() {
                return Ok(oauth_error(400, "invalid_grant", "Code expire."));
            }
            if row.get::<String, _>("client_id") != client_id {
                return Ok(oauth_error(400, "invalid_grant", "Code delivre a un autre client."));
            }
            let redirect: String = row.get("redirect_uri");
            if form.get("redirect_uri").is_some_and(|r| r != &redirect) {
                return Ok(oauth_error(400, "invalid_grant", "redirect_uri differente de celle de la demande."));
            }
            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
            if !pkce_ok(&verifier, &row.get::<String, _>("code_challenge")) {
                return Ok(oauth_error(400, "invalid_grant", "code_verifier incorrect (PKCE)."));
            }
            let grant_id = new_id_n();
            sqlx::query(
                "INSERT INTO oauth_grants (id, user_id, client_id, client_name, agent_id, vault_ids, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(&grant_id)
            .bind(row.get::<String, _>("user_id"))
            .bind(&client_id)
            .bind(row.get::<String, _>("client_name"))
            .bind(row.get::<Option<String>, _>("agent_id"))
            .bind(row.get::<Option<String>, _>("vault_ids"))
            .bind(now())
            .execute(&mut *c)
            .await?;
            sqlx::query("UPDATE oauth_clients SET last_used_at = $2 WHERE client_id = $1").bind(&client_id).bind(now()).execute(&mut *c).await?;
            Ok(json_no_store(200, issue(&mut c, &grant_id).await?))
        }
        Some("refresh_token") => {
            let refresh = form.get("refresh_token").cloned().unwrap_or_default();
            // Le renouvellement ne sert qu'une fois : il est remplace.
            let row = sqlx::query(
                "DELETE FROM oauth_tokens t USING oauth_grants g
                  WHERE t.token_hash = $1 AND t.kind = 'refresh' AND g.id = t.grant_id
                 RETURNING t.expires_at, g.id, g.client_id, g.revoked_at",
            )
            .bind(hash(&refresh))
            .fetch_optional(&mut *c)
            .await?;
            let Some(row) = row else { return Ok(oauth_error(400, "invalid_grant", "Jeton de renouvellement inconnu.")) };
            let expires: Ts = row.get("expires_at");
            let revoked: Option<Ts> = row.get("revoked_at");
            if expires <= now() || revoked.is_some() {
                return Ok(oauth_error(400, "invalid_grant", "Acces expire ou revoque."));
            }
            if row.get::<String, _>("client_id") != client_id {
                return Ok(oauth_error(400, "invalid_grant", "Jeton delivre a un autre client."));
            }
            let grant_id: String = row.get("id");
            Ok(json_no_store(200, issue(&mut c, &grant_id).await?))
        }
        _ => Ok(oauth_error(400, "unsupported_grant_type", "authorization_code ou refresh_token.")),
    }
}

/// Un jeton d'acces OAuth valide : la personne, son agent et ses vaults.
pub struct OAuthAccess {
    pub grant_id: String,
    pub user_id: String,
    pub agent_id: Option<String>,
    pub vault_ids: Option<Vec<String>>,
    pub last_used_at: Option<Ts>,
}

pub async fn access_of(c: &mut PgConnection, token: &str) -> AppResult<Option<OAuthAccess>> {
    let row = sqlx::query(
        "SELECT g.id, g.user_id, g.agent_id, g.vault_ids, g.last_used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > $2 AND g.revoked_at IS NULL",
    )
    .bind(hash(token))
    .bind(now())
    .fetch_optional(&mut *c)
    .await?;
    Ok(row.map(|r| OAuthAccess {
        grant_id: r.get("id"),
        user_id: r.get("user_id"),
        agent_id: r.get("agent_id"),
        vault_ids: r.get::<Option<String>, _>("vault_ids").filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::to_string).collect()),
        last_used_at: r.get("last_used_at"),
    }))
}

pub async fn touch(c: &mut PgConnection, grant_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE oauth_grants SET last_used_at = $2 WHERE id = $1").bind(grant_id).bind(now()).execute(&mut *c).await?;
    Ok(())
}

// ── Acces accordes (Parametres > API) ────────────────────────────────────────

pub async fn list_grants(State(st): State<AppState>, Auth(p): Auth) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let rows = sqlx::query(
        "SELECT id, client_id, client_name, agent_id, vault_ids, created_at, last_used_at FROM oauth_grants
          WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .bind(&p.sub)
    .fetch_all(&mut *c)
    .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            let vaults: Option<String> = r.get("vault_ids");
            json!({
                "id": r.get::<String, _>("id"), "clientId": r.get::<String, _>("client_id"), "clientName": r.get::<String, _>("client_name"),
                "agentId": r.get::<Option<String>, _>("agent_id"),
                "vaultIds": vaults.filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::to_string).collect::<Vec<_>>()),
                "createdAt": r.get::<Ts, _>("created_at"), "lastUsedAt": r.get::<Option<Ts>, _>("last_used_at"),
            })
        })
        .collect();
    Ok(ok(&list))
}

pub async fn revoke_grant(State(st): State<AppState>, Auth(p): Auth, Path(id): Path<String>) -> AppResult<Response> {
    require_account(&p.sub)?;
    let mut c = st.db.acquire().await?;
    let n = sqlx::query("UPDATE oauth_grants SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(&id)
        .bind(&p.sub)
        .bind(now())
        .execute(&mut *c)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::DocumentNotFound(id));
    }
    sqlx::query("DELETE FROM oauth_tokens WHERE grant_id = $1").bind(&id).execute(&mut *c).await?;
    Ok(no_content())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects() {
        assert!(valid_redirect("https://chatgpt.com/connector_platform_oauth_redirect"));
        assert!(valid_redirect("https://claude.ai/api/mcp/auth_callback"));
        assert!(valid_redirect("http://localhost:6274/oauth/callback"));
        assert!(!valid_redirect("http://evil.example/cb"));
        assert!(!valid_redirect("https://a.example/cb#frag"));
        assert!(!valid_redirect("javascript:alert(1)"));
    }

    #[test]
    fn pkce() {
        // Exemple de la RFC 7636, annexe B.
        assert!(pkce_ok("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!pkce_ok("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "autre"));
        assert!(!pkce_ok("court", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    }

    #[test]
    fn header() {
        assert_eq!(
            www_authenticate("https://s.example"),
            "Bearer realm=\"savoire\", error=\"invalid_token\", scope=\"mcp\", resource_metadata=\"https://s.example/.well-known/oauth-protected-resource\""
        );
    }
}
