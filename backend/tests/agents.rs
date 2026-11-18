// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents IA (ADR-033) : agents declares, jeton rattache a un agent, MCP qui
// passe par le catalogue du pair, accords en attente, ecritures du pair avec
// un ticket, auteur de chaque operation.

mod common;

use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use common::{SERVICE_TOKEN, b64};
use serde_json::{Value, json};

/// Un faux pair : il rend un catalogue, et pour « append » ecrit dans la note
/// par l'API interne du serveur, avec le ticket recu.
#[derive(Clone, Default)]
struct Peer {
    calls: Arc<Mutex<Vec<Value>>>,
    server: Arc<Mutex<String>>,
    last_write: Arc<Mutex<Option<(u16, Value)>>>,
}

fn catalog() -> Value {
    let t = |name: &str, action: &str| json!({ "name": name, "title": name, "description": name, "action": action,
        "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": [], "additionalProperties": false } });
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
                    return axum::Json(json!({ "result": catalog() }));
                }
                let params = &call["params"];
                if params["name"] == "append" || params["name"] == "move_note" {
                    let doc = params["args"]["id"].as_str().unwrap_or("").to_string();
                    let server = p.server.lock().unwrap().clone();
                    let r = reqwest::Client::new()
                        .post(format!("{server}/internal/indexer/vaults/{vault}/write"))
                        .bearer_auth(SERVICE_TOKEN)
                        .json(&json!({ "ticket": params["ticket"], "ops": [{ "target": "document", "docId": doc, "update": b64(b"agent-op") }] }))
                        .send()
                        .await
                        .unwrap();
                    let status = r.status().as_u16();
                    let body: Value = r.json().await.unwrap_or(Value::Null);
                    *p.last_write.lock().unwrap() = Some((status, body));
                    if status != 200 {
                        return axum::Json(json!({ "result": { "text": "Échec de l'écriture.", "isError": true } }));
                    }
                }
                axum::Json(json!({ "result": { "text": format!("{} fait ({})", params["name"].as_str().unwrap(), params["mode"].as_str().unwrap()), "isError": false } }))
            }),
        )
        .with_state(peer.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    (url, peer)
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
    assert_eq!(names, vec!["list_vaults", "search", "append", "move_note"]);
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
    assert_eq!(names, vec!["list_vaults", "search"]);
    let denied = mcp(&app, &plain, 3, "tools/call", json!({ "name": "append", "arguments": { "vault": v, "id": doc, "text": "x" } })).await;
    assert_eq!(denied["result"]["isError"], true);
}
