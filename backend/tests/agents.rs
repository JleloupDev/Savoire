// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents IA (ADR-033) : agents declares, jeton rattache a un agent, MCP qui
// passe par le catalogue du pair, accords en attente, ecritures du pair avec
// un ticket, auteur de chaque operation.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use common::{LONG, SERVICE_TOKEN, SHORT, b64};
use serde_json::{Value, json};

/// Un faux pair : il rend un catalogue, et pour « append » ecrit dans la note
/// par l'API interne du serveur, avec le ticket recu.
#[derive(Clone, Default)]
struct Peer {
    calls: Arc<Mutex<Vec<Value>>>,
    server: Arc<Mutex<String>>,
    last_write: Arc<Mutex<Option<(u16, Value)>>>,
    /// Le catalogue offre aussi add_image.
    image: Arc<std::sync::atomic::AtomicBool>,
    /// « append » montre aussi l'agent dans la note (route presence) ; reponses du serveur gardees.
    presence: Arc<std::sync::atomic::AtomicBool>,
    presence_replies: Arc<Mutex<Vec<u16>>>,
}

fn catalog() -> Value {
    let t = |name: &str, action: &str| json!({ "name": name, "title": name, "description": name, "action": action,
        "inputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "ns": { "type": "string" } }, "required": [], "additionalProperties": false } });
    json!({ "tools": [t("search", "read"), t("append", "edit"), t("move_note", "organize"), t("trash_note", "delete")] })
}

async fn fake_peer() -> (String, Peer) {
    let peer = Peer::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .route(
            "/v1/vaults/{vault}/call",
            axum::routing::post(|State(p): State<Peer>, Path(vault): Path<String>, body: axum::Json<Value>| async move {
                let call = body.0.clone();
                p.calls.lock().unwrap().push(call.clone());
                if call["capability"] != "tools" {
                    return axum::Json(json!({ "result": {} }));
                }
                if call["method"] == "list" {
                    let mut cat = catalog();
                    if p.image.load(std::sync::atomic::Ordering::Relaxed) {
                        cat["tools"].as_array_mut().unwrap().push(json!({ "name": "add_image", "title": "Ajouter une image", "description": "Ajoute une image.", "action": "edit",
                            "inputSchema": { "type": "object", "properties": { "path": { "type": "string" }, "fileId": { "type": "string" }, "fileName": { "type": "string" } }, "required": ["fileId"], "additionalProperties": false } }));
                    }
                    return axum::Json(json!({ "result": cat }));
                }
                let params = &call["params"];
                if params["name"] == "append" || params["name"] == "move_note" {
                    let doc = params["args"]["id"].as_str().unwrap_or("").to_string();
                    let server = p.server.lock().unwrap().clone();
                    let r = reqwest::Client::new()
                        .post(format!("{server}/internal/indexer/vaults/{vault}/write"))
                        .bearer_auth(SERVICE_TOKEN)
                        // Avec « ns » : une ecriture dans un canal partage (Revision, types des proprietes).
                        .json(&json!({ "ticket": params["ticket"], "ops": [match params["args"]["ns"].as_str() {
                            Some(ns) => json!({ "target": "index", "ns": ns, "update": b64(b"agent-op") }),
                            None => json!({ "target": "document", "docId": doc, "update": b64(b"agent-op") }),
                        }] }))
                        .send()
                        .await
                        .unwrap();
                    let status = r.status().as_u16();
                    let body: Value = r.json().await.unwrap_or(Value::Null);
                    *p.last_write.lock().unwrap() = Some((status, body));
                    if status != 200 {
                        return axum::Json(json!({ "result": { "text": "Échec de l'écriture.", "isError": true } }));
                    }
                    if p.presence.load(std::sync::atomic::Ordering::Relaxed) {
                        // Ce que fait le vrai pair : il lit, puis il ecrit, avec la couleur de l'agent.
                        for (state, doc_id) in [("reading", doc.as_str()), ("writing", doc.as_str()), ("writing", "pas-une-note")] {
                            let r = reqwest::Client::new()
                                .post(format!("{server}/internal/indexer/vaults/{vault}/presence"))
                                .bearer_auth(SERVICE_TOKEN)
                                .json(&json!({ "ticket": params["ticket"], "docId": doc_id, "state": state, "color": params["agent"]["color"], "range": presence_range() }))
                                .send()
                                .await
                                .unwrap();
                            p.presence_replies.lock().unwrap().push(r.status().as_u16());
                        }
                    }
                }
                axum::Json(json!({ "result": { "text": format!("{} fait ({})", params["name"].as_str().unwrap(), params["mode"].as_str().unwrap()), "isError": false } }))
            }),
        )
        .with_state(peer.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    (url, peer)
}

/// Un passage de la note, en positions relatives de Yjs (JSON).
fn presence_range() -> Value {
    json!({ "anchor": { "tname": "codemirror", "item": null, "assoc": 0 }, "head": { "tname": "codemirror", "item": null, "assoc": -1 } })
}

/// Une mise a jour d'awareness de Yjs a un seul etat : (clientID, horloge, etat).
fn decode_awareness(update_b64: &str) -> (u64, u64, Value) {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(update_b64).unwrap();
    let mut at = 0usize;
    let mut var_uint = |bytes: &[u8]| {
        let (mut n, mut shift) = (0u64, 0);
        loop {
            let b = bytes[at];
            at += 1;
            n |= ((b & 0x7f) as u64) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                return n;
            }
        }
    };
    assert_eq!(var_uint(&bytes), 1, "un seul etat");
    let client = var_uint(&bytes);
    let clock = var_uint(&bytes);
    let len = var_uint(&bytes) as usize;
    assert_eq!(at + len, bytes.len());
    (client, clock, serde_json::from_slice(&bytes[at..]).unwrap())
}

fn indexer_config(url: &str) -> Value {
    json!({ "Indexer": { "ServiceToken": SERVICE_TOKEN, "Instances": [{ "Name": "only", "Url": url }] } })
}

async fn mcp(app: &common::TestApp, token: &str, id: i64, method: &str, params: Value) -> Value {
    app.post(token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await.1
}

#[tokio::test]
async fn agents_lifecycle_and_rights() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let created = app.post(&ta, "/api/v1/agents", json!({ "name": " Archiviste ", "instructions": "Range.", "permissions": { "read": "direct", "create": "propose", "organize": "ask" } })).await;
    assert_eq!(created.0, 200, "{}", created.1);
    let id = created.1["id"].as_str().unwrap().to_string();
    assert_eq!(created.1["name"], "Archiviste");
    // Un mode sans sens pour l'action devient interdit.
    assert_eq!(created.1["permissions"]["create"], "deny");
    assert_eq!(created.1["permissions"]["organize"], "ask");
    assert_eq!(app.get(&ta, "/api/v1/agents").await.1["agents"].as_array().unwrap().len(), 1);
    // Bob ne le voit pas, ne le modifie pas, ne le rattache pas a un jeton.
    assert_eq!(app.get(&tb, "/api/v1/agents").await.1["agents"], json!([]));
    assert_eq!(app.put(&tb, &format!("/api/v1/agents/{id}"), json!({ "name": "x" })).await.0, 403);
    assert_eq!(app.post(&tb, "/api/v1/me/access-tokens", json!({ "name": "t", "agentId": id })).await.0, 400);
    // Agent du vault : seulement par un administrateur, et visible des membres.
    assert_ne!(app.post(&tb, "/api/v1/agents", json!({ "name": "Jardinier", "vaultId": v, "permissions": {} })).await.0, 200);
    let shared = app.post(&ta, "/api/v1/agents", json!({ "name": "Jardinier", "vaultId": v, "permissions": { "read": "direct" } })).await;
    assert_eq!(shared.0, 200, "{}", shared.1);
    assert_eq!(shared.1["vaultId"], v);
    // Consommation par jour.
    assert_eq!(app.post(&ta, &format!("/api/v1/agents/{id}/usage"), json!({ "inputTokens": 120, "outputTokens": 30, "calls": 2, "runs": 1 })).await.0, 204);
    app.post(&ta, &format!("/api/v1/agents/{id}/usage"), json!({ "inputTokens": 10, "outputTokens": 5, "runs": 1 })).await;
    let usage = app.get(&ta, "/api/v1/agents/usage?days=7").await;
    assert_eq!(usage.1["days"][0]["inputTokens"], 130);
    assert_eq!(usage.1["days"][0]["runs"], 2);
    assert_eq!(app.post(&tb, &format!("/api/v1/agents/{id}/usage"), json!({ "inputTokens": 1 })).await.0, 403);
    assert_eq!(app.delete(&tb, &format!("/api/v1/agents/{id}")).await.0, 403);
    assert_eq!(app.delete(&ta, &format!("/api/v1/agents/{id}")).await.0, 204);
}

#[tokio::test]
async fn chatgpt_acts_through_the_peer_with_the_agent_rights() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Secrétaire", "permissions": { "read": "direct", "edit": "direct", "organize": "ask", "delete": "deny" } })).await;
    let agent_id = agent.1["id"].as_str().unwrap().to_string();
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "ChatGPT", "agentId": agent_id })).await;
    assert_eq!(token.1["info"]["agentId"], agent_id);
    let token = token.1["token"].as_str().unwrap().to_string();

    // Le catalogue : ce que l'agent a le droit de faire, avec le parametre vault.
    let tools = mcp(&app, &token, 1, "tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["list_vaults", "get_context", "list_pins", "search", "append", "move_note", "get_mode", "request_mode"]);
    let append = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "append").unwrap().clone();
    assert_eq!(append["inputSchema"]["required"][0], "vault");
    assert_eq!(append["annotations"]["readOnlyHint"], false);

    // Ecrire en direct : le pair ecrit avec son ticket ; l'operation porte l'agent.
    let r = mcp(&app, &token, 2, "tools/call", json!({ "name": "append", "arguments": { "vault": "Journal", "id": doc, "text": "x" } })).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert_eq!(r["result"]["content"][0]["text"], "append fait (direct)");
    assert_eq!(peer.last_write.lock().unwrap().clone().unwrap().0, 200);
    let call = peer.calls.lock().unwrap().iter().rev().find(|c| c["params"]["name"] == "append").unwrap().clone();
    assert_eq!(call["params"]["agent"]["name"], "Secrétaire");
    assert_eq!(call["params"]["actor"]["onBehalfOf"]["userId"], alice);
    assert!(call["params"]["args"].get("vault").is_none());
    assert_eq!(call["caller"]["access"]["base"], "admin");
    let author: Value = sqlx::query_scalar("SELECT author FROM operations_log WHERE resource_id = $1").bind(&doc).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(author["agentName"], "Secrétaire");
    assert_eq!(author["id"], alice);
    // Le ticket ne sert qu'une fois, pendant l'appel.
    let reuse = app.post(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/write"), json!({ "ticket": call["params"]["ticket"], "ops": [] })).await;
    assert_eq!(reuse.0, 403);

    // Interdit : refuse sans meme appeler le pair.
    let before = peer.calls.lock().unwrap().len();
    let denied = mcp(&app, &token, 3, "tools/call", json!({ "name": "trash_note", "arguments": { "vault": "Journal", "id": doc } })).await;
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(peer.calls.lock().unwrap().len(), before);

    // Demander : en attente, puis fait quand la personne accepte.
    let held = mcp(&app, &token, 4, "tools/call", json!({ "name": "move_note", "arguments": { "vault": "Journal", "id": doc, "to": "Archives/" } })).await;
    assert!(held["result"]["content"][0]["text"].as_str().unwrap().contains("en attente"), "{held}");
    assert!(!peer.calls.lock().unwrap().iter().any(|c| c["params"]["name"] == "move_note"));
    let list = app.get(&ta, "/api/v1/agents/approvals").await;
    let approval = list.1["approvals"][0].clone();
    assert_eq!((approval["status"].as_str(), approval["agentName"].as_str()), (Some("pending"), Some("Secrétaire")));
    let decided = app.post(&ta, &format!("/api/v1/agents/approvals/{}/decide", approval["id"].as_str().unwrap()), json!({ "approve": true })).await;
    assert_eq!(decided.0, 200, "{}", decided.1);
    assert_eq!(decided.1["status"], "done");
    assert_eq!(decided.1["result"], "move_note fait (direct)");
    // Une seule fois.
    assert_eq!(app.post(&ta, &format!("/api/v1/agents/approvals/{}/decide", approval["id"].as_str().unwrap()), json!({ "approve": true })).await.0, 400);

    // Journal des actions externes et appels comptes.
    let actions = app.get(&ta, "/api/v1/agents/actions").await;
    let tools_done: Vec<&str> = actions.1["actions"].as_array().unwrap().iter().map(|a| a["tool"].as_str().unwrap()).collect();
    assert!(tools_done.contains(&"append") && tools_done.contains(&"move_note"));
    let usage = app.get(&ta, "/api/v1/agents/usage").await;
    assert!(usage.1["days"][0]["calls"].as_i64().unwrap() >= 2);

    // Les outils des agents ne s'appellent jamais par la route publique.
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/index/tools/call"), json!({})).await.0, 404);
}

#[tokio::test]
async fn propose_mode_cannot_touch_notes_and_tokens_without_agent_stay_read_only() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Correcteur", "permissions": { "read": "direct", "edit": "propose" } })).await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "c", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();
    // Le pair essaie d'ecrire dans la note : le serveur refuse (ticket en mode proposition).
    let r = mcp(&app, &token, 1, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "id": doc, "text": "x" } })).await;
    assert_eq!(r["result"]["isError"], true);
    assert_eq!(peer.last_write.lock().unwrap().clone().unwrap().0, 403);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM operations_log WHERE resource_id = $1").bind(&doc).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0);
    // Un jeton sans agent : lecture seule.
    let plain = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "lecture" })).await.1["token"].as_str().unwrap().to_string();
    let tools = mcp(&app, &plain, 2, "tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["list_vaults", "get_context", "list_pins", "search"]);
    let denied = mcp(&app, &plain, 3, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "id": doc, "text": "x" } })).await;
    assert_eq!(denied["result"]["isError"], true);
}

#[tokio::test]
async fn agent_writes_property_types_in_direct_mode_only() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Bases").await;
    let status = || peer.last_write.lock().unwrap().clone().unwrap().0;
    let types = format!("index:{v}:settings/properties");
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Bibliothécaire", "permissions": { "read": "direct", "edit": "direct" } })).await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "d", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();

    // En direct : les types des proprietes du vault (colonnes des bases), signes de l'agent.
    let r = mcp(&app, &token, 1, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "ns": "settings/properties" } })).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert_eq!(status(), 200);
    let author: Value = sqlx::query_scalar("SELECT author FROM operations_log WHERE resource_id = $1").bind(&types).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(author["agentName"], "Bibliothécaire");
    // Aucun autre canal partage.
    mcp(&app, &token, 2, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "ns": "settings/autre" } })).await;
    assert_eq!(status(), 403);

    // En mode proposition : la Revision seulement.
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Correcteur", "permissions": { "read": "direct", "edit": "propose" } })).await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "p", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();
    mcp(&app, &token, 3, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "ns": "settings/properties" } })).await;
    assert_eq!(status(), 403);
    mcp(&app, &token, 4, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "ns": "map/review" } })).await;
    assert_eq!(status(), 200);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM operations_log WHERE resource_id = $1").bind(&types).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn oauth_token_carries_the_chosen_agent() {
    use base64::Engine;
    use sha2::Digest;
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Secrétaire", "permissions": { "read": "direct", "edit": "direct" } })).await;
    let agent_id = agent.1["id"].as_str().unwrap().to_string();
    // Le parcours OAuth de ChatGPT, en bref (le detail : tests/oauth.rs).
    let redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    let reg = app.post("", "/api/oauth/register", json!({ "client_name": "ChatGPT", "redirect_uris": [redirect] })).await;
    let client_id = reg.1["client_id"].as_str().unwrap().to_string();
    let verifier = "v".repeat(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let r = http.get(app.url("/api/oauth/authorize"))
        .query(&[("response_type", "code"), ("client_id", &client_id), ("code_challenge", &challenge), ("code_challenge_method", "S256")])
        .send().await.unwrap();
    let loc = r.headers()["location"].to_str().unwrap().to_string();
    let request = loc.split("request=").nth(1).unwrap().to_string();
    let d = app.post(&ta, &format!("/api/v1/oauth/requests/{request}/decide"), json!({ "approve": true, "agentId": agent_id })).await;
    let back = url::Url::parse(d.1["redirect"].as_str().unwrap()).unwrap();
    let code = back.query_pairs().find(|(k, _)| k == "code").unwrap().1.into_owned();
    let t: Value = app.http.post(app.url("/api/oauth/token"))
        .form(&[("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", verifier.as_str())])
        .send().await.unwrap().json().await.unwrap();
    let token = t["access_token"].as_str().unwrap().to_string();
    // Les droits et le nom de l'agent choisi a l'ecran d'accord.
    let tools = mcp(&app, &token, 1, "tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["list_vaults", "get_context", "list_pins", "search", "append", "get_mode", "request_mode"]);
    let r = mcp(&app, &token, 2, "tools/call", json!({ "name": "append", "arguments": { "vault": "Journal", "id": doc, "text": "x" } })).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    let author: Value = sqlx::query_scalar("SELECT author FROM operations_log WHERE resource_id = $1").bind(&doc).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(author["agentName"], "Secrétaire");
}

#[tokio::test]
async fn add_image_takes_a_chatgpt_file_and_never_fetches_a_private_address() {
    let (url, peer) = fake_peer().await;
    peer.image.store(true, std::sync::atomic::Ordering::Relaxed);
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Photographe", "permissions": { "read": "direct", "edit": "direct" } })).await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "g", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();

    // ChatGPT voit un champ fichier (openai/fileParams) a la place de fileId.
    let tools = mcp(&app, &token, 1, "tools/list", json!({})).await;
    let t = tools["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "add_image").unwrap().clone();
    assert_eq!(t["_meta"]["openai/fileParams"], json!(["image"]));
    assert!(t["inputSchema"]["properties"].get("fileId").is_none());
    assert_eq!(t["inputSchema"]["properties"]["image"]["required"], json!(["download_url", "file_id"]));
    assert_eq!(t["inputSchema"]["required"], json!(["vault"]));

    // Adresse locale, http, rien : refuse avant le pair.
    for args in [
        json!({ "vault": v, "path": "a.md", "image": { "download_url": "https://127.0.0.1/x.png", "file_id": "f" } }),
        json!({ "vault": v, "path": "a.md", "url": "http://exemple.org/x.png" }),
        json!({ "vault": v, "path": "a.md", "url": "https://localhost/x.png" }),
        json!({ "vault": v, "path": "a.md" }),
    ] {
        let r = mcp(&app, &token, 2, "tools/call", json!({ "name": "add_image", "arguments": args })).await;
        assert_eq!(r["result"]["isError"], true, "{r}");
    }
    assert!(!peer.calls.lock().unwrap().iter().any(|c| c["params"]["name"] == "add_image"));
}

fn text(r: &Value) -> String {
    r["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
}

fn names(tools: &Value) -> Vec<String> {
    tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn request_mode_switches_between_edit_and_review_only_with_the_person_approval() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Correcteur", "permissions": { "read": "direct", "edit": "propose", "create": "ask", "delete": "ask" } })).await;
    let agent_id = agent.1["id"].as_str().unwrap().to_string();
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "c", "agentId": agent_id })).await.1["token"].as_str().unwrap().to_string();
    let agent_perms = || async { app.get(&ta, "/api/v1/agents").await.1["agents"].as_array().unwrap().iter().find(|a| a["id"] == agent_id).unwrap()["permissions"].clone() };
    let approvals = || async { app.get(&ta, "/api/v1/agents/approvals").await.1["approvals"].as_array().unwrap().clone() };

    // Les deux outils du serveur, par defaut.
    let n = names(&mcp(&app, &token, 1, "tools/list", json!({})).await);
    assert!(n.contains(&"get_mode".into()) && n.contains(&"request_mode".into()), "{n:?}");
    let r = mcp(&app, &token, 2, "tools/call", json!({ "name": "get_mode", "arguments": {} })).await;
    assert!(text(&r).contains("mode révision"), "{r}");

    // La demande : un accord en attente, rien ne change encore.
    let r = mcp(&app, &token, 3, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "Corriger vite les fautes." } })).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    assert!(text(&r).contains("en attente") && text(&r).contains("Ne la refaites pas"), "{r}");
    assert_eq!(agent_perms().await["edit"], "propose");
    let list = approvals().await;
    assert_eq!(list.len(), 1);
    assert_eq!((list[0]["tool"].as_str(), list[0]["status"].as_str()), (Some("request_mode"), Some("pending")));
    assert!(list[0]["summary"].as_str().unwrap().contains("Corriger vite les fautes."));
    let first = list[0]["id"].as_str().unwrap().to_string();
    // Pas de doublon tant qu'elle attend ; get_mode le dit.
    let again = mcp(&app, &token, 4, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "Encore." } })).await;
    assert!(text(&again).contains("attend déjà"), "{again}");
    assert_eq!(approvals().await.len(), 1);
    assert!(text(&mcp(&app, &token, 5, "tools/call", json!({ "name": "get_mode", "arguments": {} })).await).contains(&first));

    // L'agent ne s'accorde jamais sa demande : son jeton n'ouvre pas les routes de l'appli.
    assert_eq!(app.post(&token, &format!("/api/v1/agents/approvals/{first}/decide"), json!({ "approve": true })).await.0, 401);
    assert_eq!(approvals().await[0]["status"], "pending");

    // Refusee : rien ne change.
    let refused = app.post(&ta, &format!("/api/v1/agents/approvals/{first}/decide"), json!({ "approve": false })).await;
    assert_eq!((refused.0, refused.1["status"].as_str()), (200, Some("refused")), "{}", refused.1);
    let p = agent_perms().await;
    assert_eq!((p["edit"].as_str(), p["create"].as_str()), (Some("propose"), Some("ask")));

    // Acceptee : edition, l'agent modifie la note directement.
    mcp(&app, &token, 6, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "Corriger." } })).await;
    let id = approvals().await.iter().find(|a| a["status"] == "pending").unwrap()["id"].as_str().unwrap().to_string();
    let done = app.post(&ta, &format!("/api/v1/agents/approvals/{id}/decide"), json!({ "approve": true })).await;
    assert_eq!((done.0, done.1["status"].as_str()), (200, Some("done")), "{}", done.1);
    let p = agent_perms().await;
    assert_eq!((p["edit"].as_str(), p["create"].as_str(), p["delete"].as_str()), (Some("direct"), Some("direct"), Some("ask")));
    // Le journal des actions dit que c'est fait, pas seulement « en attente ».
    let log = app.get(&ta, "/api/v1/agents/actions").await.1["actions"].clone();
    assert!(log.as_array().unwrap().iter().any(|a| a["tool"] == "request_mode" && a["status"] == "done"), "{log}");
    let w = mcp(&app, &token, 7, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "id": doc, "text": "x" } })).await;
    assert_eq!(text(&w), "append fait (direct)", "{w}");
    let same = mcp(&app, &token, 8, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "x" } })).await;
    assert!(text(&same).contains("déjà en mode édition"), "{same}");

    // Retour en revision : modifier propose, creer demande avant.
    mcp(&app, &token, 9, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "propose", "reason": "Relecture." } })).await;
    let id = approvals().await.iter().find(|a| a["status"] == "pending").unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(app.post(&ta, &format!("/api/v1/agents/approvals/{id}/decide"), json!({ "approve": true })).await.1["status"], "done");
    let p = agent_perms().await;
    assert_eq!((p["edit"].as_str(), p["create"].as_str()), (Some("propose"), Some("ask")));

    // Option coupee : l'outil n'est plus propose, et refuse s'il est appele.
    let mut def = app.get(&ta, "/api/v1/agents").await.1["agents"][0].clone();
    def["canRequestMode"] = json!(false);
    let put = app.put(&ta, &format!("/api/v1/agents/{agent_id}"), def).await;
    assert_eq!((put.0, &put.1["canRequestMode"]), (200, &json!(false)), "{}", put.1);
    let n = names(&mcp(&app, &token, 10, "tools/list", json!({})).await);
    assert!(n.contains(&"get_mode".into()) && !n.contains(&"request_mode".into()), "{n:?}");
    let before = approvals().await.len();
    let off = mcp(&app, &token, 11, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "x" } })).await;
    assert_eq!(off["result"]["isError"], true, "{off}");
    assert_eq!(approvals().await.len(), before);

    // Un jeton sans agent n'a ni l'un ni l'autre.
    let plain = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "lecture" })).await.1["token"].as_str().unwrap().to_string();
    assert!(!names(&mcp(&app, &plain, 12, "tools/list", json!({})).await).iter().any(|n| n.ends_with("_mode")));
    let r = mcp(&app, &plain, 13, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "x" } })).await;
    assert_eq!(r["result"]["isError"], true, "{r}");
}

#[tokio::test]
async fn request_mode_never_exceeds_the_person_rights() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let add = app.post(&ta, &format!("/api/v1/vaults/{v}/members"), json!({ "userId": bob, "role": "editor" })).await;
    assert!(add.0 < 300, "{}", add.1);
    // Un agent du vault : seul un administrateur le modifie, donc change son mode.
    let shared = app.post(&ta, "/api/v1/agents", json!({ "name": "Jardinier", "vaultId": v, "permissions": { "read": "direct", "edit": "propose" } })).await;
    let token = app.post(&tb, "/api/v1/me/access-tokens", json!({ "name": "b", "agentId": shared.1["id"] })).await;
    assert_eq!(token.0, 200, "{}", token.1);
    let token = token.1["token"].as_str().unwrap().to_string();
    let r = mcp(&app, &token, 1, "tools/call", json!({ "name": "request_mode", "arguments": { "mode": "direct", "reason": "x" } })).await;
    assert_eq!(r["result"]["isError"], true, "{r}");
    assert!(text(&r).contains("administrateur"), "{r}");
    assert_eq!(app.get(&tb, "/api/v1/agents/approvals").await.1["approvals"], json!([]));

    // Une lectrice : son agent en edition n'ecrit pas pour autant (get_mode le dit).
    let (carol, tc) = app.user("carol").await;
    let add = app.post(&ta, &format!("/api/v1/vaults/{v}/members"), json!({ "userId": carol, "role": "viewer" })).await;
    assert!(add.0 < 300, "{}", add.1);
    let own = app.post(&tc, "/api/v1/agents", json!({ "name": "Plume", "permissions": { "read": "direct", "edit": "direct" } })).await;
    let token = app.post(&tc, "/api/v1/me/access-tokens", json!({ "name": "c", "agentId": own.1["id"] })).await.1["token"].as_str().unwrap().to_string();
    let t = text(&mcp(&app, &token, 2, "tools/call", json!({ "name": "get_mode", "arguments": { "vault": v } })).await);
    assert!(t.contains("ne modifie pas") && t.contains("ne peut que lire"), "{t}");
}

#[tokio::test]
async fn agent_shows_in_the_open_note_then_leaves() {
    let (url, peer) = fake_peer().await;
    peer.presence.store(true, std::sync::atomic::Ordering::Relaxed);
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let other = app.document(&ta, &v).await;
    // La couleur de l'agent : validee, gardee, rendue.
    let bad = app.post(&ta, "/api/v1/agents", json!({ "name": "Secrétaire", "color": "rouge", "permissions": {} })).await;
    assert_eq!(bad.0, 400, "{}", bad.1);
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Secrétaire", "color": "#00AA77", "permissions": { "read": "direct", "edit": "direct" } })).await;
    assert_eq!(agent.1["color"], "#00aa77");
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "ChatGPT", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();

    // Alice a la note ouverte ; une autre note ouverte ailleurs ; Bob n'a aucun droit.
    let mut editor = app.hub("sync", &ta).await.unwrap();
    editor.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut elsewhere = app.hub("sync", &ta).await.unwrap();
    elsewhere.invoke("JoinDocument", json!([v, other])).await.unwrap();
    let mut bob = app.hub("sync", &tb).await.unwrap();
    assert!(bob.invoke("JoinDocument", json!([v, doc])).await.is_err());

    let r = mcp(&app, &token, 1, "tools/call", json!({ "name": "append", "arguments": { "vault": "Journal", "id": doc, "text": "x" } })).await;
    assert_eq!(r["result"]["isError"], false, "{r}");
    // Le pair recoit la couleur avec l'agent ; une note inconnue est refusee.
    let call = peer.calls.lock().unwrap().iter().rev().find(|c| c["params"]["name"] == "append").unwrap().clone();
    assert_eq!(call["params"]["agent"]["color"], "#00aa77");
    assert_eq!(*peer.presence_replies.lock().unwrap(), vec![204, 204, 403]);

    // L'ecriture, puis l'agent qui lit, puis qui ecrit : au nom de l'agent, jamais du pair.
    assert!(editor.wait_event("ReceiveOperation", LONG).await.is_some());
    let reading = editor.wait_event("AwarenessUpdated", LONG).await.unwrap();
    assert_eq!(reading[0], doc);
    let (client, clock1, state) = decode_awareness(reading[1].as_str().unwrap());
    assert_eq!(state["user"], json!({ "name": "Secrétaire", "color": "#00aa77", "colorLight": "#00aa7733" }));
    assert_eq!(state["agent"]["id"], agent.1["id"]);
    assert_eq!(state["agentState"], "reading");
    assert_eq!(state["reading"], presence_range());
    assert!(state.get("cursor").is_none());
    let (client2, clock2, state) = decode_awareness(editor.wait_event("AwarenessUpdated", LONG).await.unwrap()[1].as_str().unwrap());
    assert_eq!(client2, client);
    assert!(clock2 > clock1);
    assert_eq!(state["agentState"], "writing");
    assert_eq!(state["cursor"], presence_range());
    assert_eq!(app.state.realtime.agent_presence.len(), 1);

    // L'appel est fini : l'agent part de lui-meme, peu apres.
    let (client3, clock3, state) = decode_awareness(editor.wait_event("AwarenessUpdated", Duration::from_secs(6)).await.unwrap()[1].as_str().unwrap());
    assert_eq!((client3, state), (client, Value::Null));
    assert!(clock3 > clock2);
    assert!(app.state.realtime.agent_presence.is_empty());
    assert!(editor.no_event("AwarenessUpdated", SHORT).await);
    // Rien pour qui a une autre note ouverte.
    assert!(elsewhere.no_event("AwarenessUpdated", SHORT).await);

    // Hors d'un appel : le ticket ne vaut plus rien, et il faut le jeton de service.
    let body = json!({ "ticket": call["params"]["ticket"], "docId": doc, "state": "writing" });
    assert_eq!(app.post(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/presence"), body.clone()).await.0, 403);
    assert_eq!(app.post(&ta, &format!("/internal/indexer/vaults/{v}/presence"), body).await.0, 401);
    assert!(editor.no_event("AwarenessUpdated", SHORT).await);
}

/// Un agent n'ecrit pas dans le paragraphe ou la personne tape : l'application
/// dit quand elle tape (typingAt), et le serveur joint l'endroit a l'appel du
/// pair, pour une ecriture directe seulement, tant que la frappe est recente.
#[tokio::test]
async fn the_peer_learns_where_the_person_types_and_only_then() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    *peer.server.lock().unwrap() = app.base.clone();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let other_vault = app.vault(&alice, &ta, "Autre").await;
    let other_doc = app.document(&ta, &other_vault).await;
    let agent = app.post(&ta, "/api/v1/agents", json!({ "name": "Secrétaire", "permissions": { "read": "direct", "edit": "direct", "organize": "ask" } })).await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "ChatGPT", "agentId": agent.1["id"] })).await.1["token"].as_str().unwrap().to_string();
    let last = |name: &str| peer.calls.lock().unwrap().iter().rev().find(|c| c["params"]["name"] == name).unwrap().clone();
    // L'entree de l'application ; `typed_ago` : elle a tape il y a tant de millisecondes (a son horloge).
    let context = |typed_ago: Option<i64>| {
        let at = 1_795_000_000_000i64;
        let mut c = json!({
            "vaultId": v, "docId": doc, "path": "Plan.md", "selection": "",
            "anchor": { "docId": doc, "start": "AAEBAQ==", "end": "AAEBAQ==", "quote": "", "prefix": "ce qu'elle écrit", "suffix": "" },
            "before": "ce qu'elle écrit", "after": "", "headingPath": [], "blockHash": "0123456789abcdef", "at": at, "tabId": "onglet-1",
        });
        if let Some(ago) = typed_ago {
            c["typingAt"] = json!(at - ago);
        }
        c
    };
    let append = json!({ "name": "append", "arguments": { "vault": "Journal", "id": doc, "text": "x" } });
    let get_context = json!({ "name": "get_context", "arguments": {} });

    // Elle a seulement place son curseur : rien n'est joint a l'appel.
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(None)).await.0, 204);
    mcp(&app, &token, 1, "tools/call", append.clone()).await;
    assert!(last("append")["params"].get("typing").is_none());

    // Elle tape (il y a 1,5 s) : le pair recoit l'endroit et l'age de la frappe.
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(Some(1500))).await.0, 204);
    mcp(&app, &token, 2, "tools/call", append.clone()).await;
    let typing = last("append")["params"]["typing"].clone();
    assert_eq!(typing["docId"], doc, "{typing}");
    assert_eq!(typing["blockHash"], "0123456789abcdef");
    assert_eq!(typing["anchor"]["start"], "AAEBAQ==");
    assert_eq!(typing["anchor"]["prefix"], "ce qu'elle écrit");
    let age = typing["ageMs"].as_u64().unwrap();
    assert!((1500..8000).contains(&age), "{age}");
    // get_context le dit a l'IA, avant qu'elle n'ecrive.
    let ctx = mcp(&app, &token, 3, "tools/call", get_context.clone()).await;
    assert!(text(&ctx).contains("La personne écrit dans cette note en ce moment"), "{ctx}");
    assert_eq!(ctx["result"]["structuredContent"]["typing"], true);

    // Lire ne recoit rien ; un autre vault non plus.
    mcp(&app, &token, 4, "tools/call", json!({ "name": "search", "arguments": { "vault": "Journal", "query": "x" } })).await;
    assert!(last("search")["params"].get("typing").is_none());
    mcp(&app, &token, 5, "tools/call", json!({ "name": "append", "arguments": { "vault": "Autre", "id": other_doc, "text": "x" } })).await;
    let elsewhere = last("append");
    assert_eq!(elsewhere["params"]["args"]["id"], other_doc);
    assert!(elsewhere["params"].get("typing").is_none());

    // Une action qu'elle vient d'accepter s'ecrit, meme la ou elle tapait.
    mcp(&app, &token, 6, "tools/call", json!({ "name": "move_note", "arguments": { "vault": "Journal", "id": doc, "to": "Archives/" } })).await;
    let approval = app.get(&ta, "/api/v1/agents/approvals").await.1["approvals"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(Some(0))).await.0, 204);
    assert_eq!(app.post(&ta, &format!("/api/v1/agents/approvals/{approval}/decide"), json!({ "approve": true })).await.1["status"], "done");
    assert!(last("move_note")["params"].get("typing").is_none());

    // Elle a tape il y a plus de 8 s : elle ne tape plus.
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(Some(9000))).await.0, 204);
    mcp(&app, &token, 7, "tools/call", append.clone()).await;
    assert!(last("append")["params"].get("typing").is_none());
    let ctx = mcp(&app, &token, 8, "tools/call", get_context).await;
    assert!(!text(&ctx).contains("La personne écrit"), "{ctx}");
    assert!(ctx["result"]["structuredContent"].get("typing").is_none());

    // Les consignes du serveur parlent des demandes, des commentaires courts et de la frappe.
    let init = mcp(&app, &token, 9, "initialize", json!({})).await;
    let instructions = init["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("list_requests") && instructions.contains("peu et courts") && instructions.contains("propose: true"), "{instructions}");
}
