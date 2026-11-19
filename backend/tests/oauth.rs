// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// OAuth du MCP (ADR-033) : le parcours de ChatGPT ou Claude.ai, des
// metadonnees jusqu'a la revocation dans Parametres > API.

mod common;

use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const REDIRECT: &str = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-un-peu-plus-long";

fn challenge(v: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()))
}

fn no_redirect() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

/// GET /api/oauth/authorize ; rend (statut, Location).
async fn authorize(app: &common::TestApp, query: &[(&str, &str)]) -> (u16, String) {
    let r = no_redirect().get(app.url("/api/oauth/authorize")).query(query).send().await.unwrap();
    let loc = r.headers().get("location").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    (r.status().as_u16(), loc)
}

fn param(url: &str, key: &str) -> Option<String> {
    url::Url::parse(url).ok()?.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

async fn token(app: &common::TestApp, form: &[(&str, &str)]) -> (u16, Value) {
    let r = app.http.post(app.url("/api/oauth/token")).form(form).send().await.unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
}

async fn mcp(app: &common::TestApp, token: &str, method: &str, params: Value) -> (u16, Value, reqwest::header::HeaderMap) {
    app.post_h(token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })).await
}

/// Enregistrement, puis une demande acceptee : rend (client_id, code).
async fn approved_code(app: &common::TestApp, ta: &str, decision: Value) -> (String, String) {
    let reg = app.post("", "/api/oauth/register", json!({ "client_name": "ChatGPT", "redirect_uris": [REDIRECT] })).await;
    assert_eq!(reg.0, 201, "{}", reg.1);
    let client_id = reg.1["client_id"].as_str().unwrap().to_string();
    let ch = challenge(VERIFIER);
    let (s, loc) = authorize(app, &[
        ("response_type", "code"), ("client_id", &client_id), ("redirect_uri", REDIRECT), ("state", "xyz"),
        ("code_challenge", &ch), ("code_challenge_method", "S256"), ("scope", "mcp"), ("resource", &app.url("/api/mcp")),
    ]).await;
    assert_eq!(s, 303, "{loc}");
    assert!(loc.contains("/oauth/consent?request="), "{loc}");
    let request = param(&loc, "request").unwrap();
    let info = app.get(ta, &format!("/api/v1/oauth/requests/{request}")).await;
    assert_eq!(info.0, 200, "{}", info.1);
    assert_eq!(info.1["clientName"], "ChatGPT");
    assert_eq!(info.1["redirectHost"], "chatgpt.com");
    let d = app.post(ta, &format!("/api/v1/oauth/requests/{request}/decide"), decision).await;
    assert_eq!(d.0, 200, "{}", d.1);
    let back = d.1["redirect"].as_str().unwrap().to_string();
    assert!(back.starts_with(REDIRECT));
    assert_eq!(param(&back, "state").as_deref(), Some("xyz"));
    assert_eq!(param(&back, "iss").as_deref(), Some(app.base.as_str()));
    // La demande ne sert qu'une fois.
    assert_eq!(app.get(ta, &format!("/api/v1/oauth/requests/{request}")).await.0, 404);
    (client_id, param(&back, "code").unwrap())
}

#[tokio::test]
async fn metadata_and_challenge() {
    let app = app!();
    let (s, pr) = app.get("", "/.well-known/oauth-protected-resource").await;
    assert_eq!(s, 200);
    assert_eq!(pr["resource"], app.url("/api/mcp"));
    assert_eq!(pr["authorization_servers"][0], app.base);
    assert_eq!(app.get("", "/.well-known/oauth-protected-resource/api/mcp").await.1, pr);
    let (s, asm) = app.get("", "/.well-known/oauth-authorization-server").await;
    assert_eq!(s, 200);
    assert_eq!(asm["issuer"], app.base);
    assert_eq!(asm["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(asm["registration_endpoint"], app.url("/api/oauth/register"));
    assert_eq!(asm["token_endpoint_auth_methods_supported"], json!(["none"]));
    // Sans jeton : 401 et l'adresse des metadonnees.
    let (s, _, h) = mcp(&app, "", "initialize", json!({})).await;
    assert_eq!(s, 401);
    let www = h.get("www-authenticate").unwrap().to_str().unwrap();
    assert!(www.starts_with("Bearer ") && www.contains("scope=\"mcp\""), "{www}");
    assert!(www.contains(&format!("resource_metadata=\"{}/.well-known/oauth-protected-resource\"", app.base)), "{www}");
}

#[tokio::test]
async fn registration_and_authorize_refusals() {
    let app = app!();
    // Adresses de retour : https (ou localhost), sans fragment.
    assert_eq!(app.post("", "/api/oauth/register", json!({ "redirect_uris": ["http://evil.example/cb"] })).await.0, 400);
    assert_eq!(app.post("", "/api/oauth/register", json!({ "redirect_uris": [] })).await.0, 400);
    assert_eq!(app.post("", "/api/oauth/register", json!({ "redirect_uris": [REDIRECT], "grant_types": ["client_credentials"] })).await.0, 400);
    let reg = app.post("", "/api/oauth/register", json!({ "client_name": "Claude", "redirect_uris": [REDIRECT, "https://claude.ai/api/mcp/auth_callback"] })).await;
    assert_eq!(reg.0, 201);
    assert!(reg.1.get("client_secret").is_none());
    let id = reg.1["client_id"].as_str().unwrap().to_string();
    let ch = challenge(VERIFIER);
    // Client inconnu, adresse de retour inconnue : une page, pas de redirection.
    let (s, loc) = authorize(&app, &[("response_type", "code"), ("client_id", "svc_inconnu"), ("redirect_uri", REDIRECT), ("code_challenge", &ch), ("code_challenge_method", "S256")]).await;
    assert_eq!((s, loc.as_str()), (400, ""));
    let (s, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("redirect_uri", "https://evil.example/cb"), ("code_challenge", &ch), ("code_challenge_method", "S256")]).await;
    assert_eq!((s, loc.as_str()), (400, ""));
    // Deux adresses enregistrees : elle doit etre donnee.
    let (s, _) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("code_challenge", &ch), ("code_challenge_method", "S256")]).await;
    assert_eq!(s, 400);
    // Sans PKCE S256 : renvoye au client avec une erreur.
    let (s, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("redirect_uri", REDIRECT), ("state", "s1"), ("code_challenge", &ch), ("code_challenge_method", "plain")]).await;
    assert_eq!(s, 303);
    assert_eq!(param(&loc, "error").as_deref(), Some("invalid_request"));
    assert_eq!(param(&loc, "state").as_deref(), Some("s1"));
    let (_, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("redirect_uri", REDIRECT)]).await;
    assert_eq!(param(&loc, "error").as_deref(), Some("invalid_request"));
    // Une autre ressource que le MCP.
    let (_, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("redirect_uri", REDIRECT), ("code_challenge", &ch), ("code_challenge_method", "S256"), ("resource", "https://autre.example/mcp")]).await;
    assert_eq!(param(&loc, "error").as_deref(), Some("invalid_target"));
}

#[tokio::test]
async fn denied_consent_returns_access_denied() {
    let app = app!();
    let (_, ta) = app.user("alice").await;
    let reg = app.post("", "/api/oauth/register", json!({ "redirect_uris": [REDIRECT] })).await;
    let id = reg.1["client_id"].as_str().unwrap().to_string();
    let ch = challenge(VERIFIER);
    let (_, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &id), ("code_challenge", &ch), ("code_challenge_method", "S256")]).await;
    let request = param(&loc, "request").unwrap();
    // Sans compte : 401.
    assert_eq!(app.get("", &format!("/api/v1/oauth/requests/{request}")).await.0, 401);
    let d = app.post(&ta, &format!("/api/v1/oauth/requests/{request}/decide"), json!({ "approve": false })).await;
    assert_eq!(d.0, 200);
    let back = d.1["redirect"].as_str().unwrap();
    assert_eq!(param(back, "error").as_deref(), Some("access_denied"));
    assert!(param(back, "code").is_none());
}

#[tokio::test]
async fn full_flow_with_agent_vaults_refresh_and_revocation() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let journal = app.vault(&alice, &ta, "Journal").await;
    let _autre = app.vault(&alice, &ta, "Autre").await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Secretaire", "permissions": { "read": "direct" } })).await;
    let agent_id = agent.1["id"].as_str().unwrap().to_string();
    let bob_agent = app.post(&tb, "/api/v1/agents", json!({ "name": "Espion", "permissions": { "read": "direct" } })).await.1["id"].as_str().unwrap().to_string();

    // L'ecran d'accord refuse l'agent ou le vault d'un autre.
    let reg = app.post("", "/api/oauth/register", json!({ "redirect_uris": [REDIRECT] })).await;
    let cid = reg.1["client_id"].as_str().unwrap().to_string();
    let ch = challenge(VERIFIER);
    for bad in [json!({ "approve": true, "agentId": bob_agent }), json!({ "approve": true, "vaultIds": ["nope"] })] {
        let (_, loc) = authorize(&app, &[("response_type", "code"), ("client_id", &cid), ("code_challenge", &ch), ("code_challenge_method", "S256")]).await;
        let request = param(&loc, "request").unwrap();
        assert_eq!(app.post(&ta, &format!("/api/v1/oauth/requests/{request}/decide"), bad).await.0, 400);
    }

    let (client_id, code) = approved_code(&app, &ta, json!({ "approve": true, "agentId": agent_id, "vaultIds": [journal] })).await;

    // Echange : mauvais verifier, mauvais client, mauvaise adresse de retour.
    let (s, e) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("redirect_uri", REDIRECT), ("code_verifier", "x".repeat(50).as_str())]).await;
    assert_eq!((s, e["error"].as_str()), (400, Some("invalid_grant")));
    // Le code est brule par la tentative ratee : un nouveau parcours.
    let (s, _) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("code_verifier", VERIFIER)]).await;
    assert_eq!(s, 400);
    let (client_id, code) = approved_code(&app, &ta, json!({ "approve": true, "agentId": agent_id, "vaultIds": [journal] })).await;
    let (s, _) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("redirect_uri", "https://claude.ai/api/mcp/auth_callback"), ("code_verifier", VERIFIER)]).await;
    assert_eq!(s, 400);
    let (_, code) = approved_code(&app, &ta, json!({ "approve": true, "agentId": agent_id, "vaultIds": [journal] })).await;
    let (s, _) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", "svc_autre"), ("code_verifier", VERIFIER)]).await;
    assert_eq!(s, 400);

    let (client_id, code) = approved_code(&app, &ta, json!({ "approve": true, "agentId": agent_id, "vaultIds": [journal] })).await;
    let resource = app.url("/api/mcp");
    let (s, _) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("code_verifier", VERIFIER), ("resource", "https://autre.example/mcp")]).await;
    assert_eq!(s, 400);
    let (s, t) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER), ("resource", &resource)]).await;
    assert_eq!(s, 200, "{t}");
    assert_eq!(t["token_type"], "Bearer");
    let access = t["access_token"].as_str().unwrap().to_string();
    let refresh = t["refresh_token"].as_str().unwrap().to_string();
    assert!(access.starts_with("sva_") && refresh.starts_with("svr_"));
    // Usage unique du code.
    let (s, _) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("code_verifier", VERIFIER)]).await;
    assert_eq!(s, 400);
    // En base : seulement des empreintes.
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_tokens WHERE token_hash = $1 OR token_hash = $2").bind(&access).bind(&refresh).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(stored, 0);

    // Le MCP accepte le jeton ; seulement le vault choisi.
    let (s, init, _) = mcp(&app, &access, "initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    assert_eq!(s, 200, "{init}");
    assert_eq!(init["result"]["serverInfo"]["name"], "savoire");
    let (_, list, _) = mcp(&app, &access, "tools/call", json!({ "name": "list_vaults", "arguments": {} })).await;
    let text = list["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string();
    assert!(text.contains("Journal") && !text.contains("Autre"), "{list}");
    // Il n'ouvre pas l'application.
    assert_eq!(app.get(&access, "/api/v1/auth/me").await.0, 401);
    // Le jeton de renouvellement n'est pas un jeton d'acces.
    assert_eq!(mcp(&app, &refresh, "ping", json!({})).await.0, 401);

    // Renouvellement : nouveau couple, l'ancien renouvellement ne sert plus.
    let (s, t2) = token(&app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", "svc_autre")]).await;
    assert_eq!(s, 400, "{t2}");
    let (s, t2) = token(&app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id)]).await;
    assert_eq!(s, 400, "le renouvellement a ete brule par l'essai d'un autre client : {t2}");
    let (client_id, code) = approved_code(&app, &ta, json!({ "approve": true, "agentId": agent_id, "vaultIds": [journal] })).await;
    let (_, t) = token(&app, &[("grant_type", "authorization_code"), ("code", &code), ("client_id", &client_id), ("code_verifier", VERIFIER)]).await;
    let refresh = t["refresh_token"].as_str().unwrap().to_string();
    let (s, t2) = token(&app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id)]).await;
    assert_eq!(s, 200, "{t2}");
    let access2 = t2["access_token"].as_str().unwrap().to_string();
    assert_eq!(token(&app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id)]).await.0, 400);
    assert_eq!(mcp(&app, &access2, "ping", json!({})).await.0, 200);

    // Parametres > API : la liste, l'agent et les vaults ; Bob ne voit rien.
    let grants = app.get(&ta, "/api/v1/me/oauth-grants").await;
    assert_eq!(grants.0, 200);
    let g = grants.1.as_array().unwrap().iter().find(|g| g["agentId"] == agent_id && g["vaultIds"] == json!([journal])).cloned().unwrap();
    assert_eq!(app.get(&tb, "/api/v1/me/oauth-grants").await.1, json!([]));
    let gid = g["id"].as_str().unwrap();
    assert_eq!(app.delete(&tb, &format!("/api/v1/me/oauth-grants/{gid}")).await.0, 404);

    // Revocation de tous les acces : plus de MCP, plus de renouvellement.
    for g in grants.1.as_array().unwrap() {
        assert_eq!(app.delete(&ta, &format!("/api/v1/me/oauth-grants/{}", g["id"].as_str().unwrap())).await.0, 204);
    }
    let (s, _, h) = mcp(&app, &access2, "ping", json!({})).await;
    assert_eq!(s, 401);
    assert!(h.get("www-authenticate").unwrap().to_str().unwrap().contains("resource_metadata="));
    assert_eq!(mcp(&app, &access, "ping", json!({})).await.0, 401);
    assert_eq!(token(&app, &[("grant_type", "refresh_token"), ("refresh_token", t2["refresh_token"].as_str().unwrap()), ("client_id", &client_id)]).await.0, 400);
    assert_eq!(app.get(&ta, "/api/v1/me/oauth-grants").await.1, json!([]));
}
