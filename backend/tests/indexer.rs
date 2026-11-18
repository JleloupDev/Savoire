// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tests d'integration du pair indexeur : relais des routes publiques vers un
// faux pair, recherche globale, reglage du vault, API interne et son flux.

mod common;

use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use common::{SERVICE_TOKEN, b64};
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct Peer {
    calls: Arc<Mutex<Vec<Value>>>,
    mode: Arc<Mutex<String>>,
}

async fn fake_peer() -> (String, Peer) {
    let peer = Peer::default();
    *peer.mode.lock().unwrap() = "ok".into();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .route(
            "/v1/vaults/{vault}/call",
            axum::routing::post(|State(p): State<Peer>, Path(vault): Path<String>, headers: axum::http::HeaderMap, body: axum::Json<Value>| async move {
                let mut rec = body.0.clone();
                rec["vault"] = json!(vault);
                rec["auth"] = json!(headers.get("authorization").and_then(|v| v.to_str().ok()));
                p.calls.lock().unwrap().push(rec);
                let mode = p.mode.lock().unwrap().clone();
                match mode.as_str() {
                    "bad" => (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": { "code": "too_complex", "message": "trop", "stack": "secret" } }))),
                    "crash" => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({ "oops": true }))),
                    _ => (axum::http::StatusCode::OK, axum::Json(json!({ "result": { "rows": [{ "id": "n1", "path": "a.md" }], "total": 1 } }))),
                }
            }),
        )
        .route(
            "/v1/search",
            axum::routing::post(|body: axum::Json<Value>| async move {
                let ids = body.0["vaultIds"].clone();
                axum::Json(json!({ "hits": [{ "id": "h1", "score": 0.5, "title": "T" }], "total": 1, "index": { "status": "ready" }, "seen": ids }))
            }),
        )
        .route("/v1/vaults/{vault}/status", axum::routing::get(|| async { axum::Json(json!({ "status": "ready", "seq": 3 })) }))
        .with_state(peer.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    (url, peer)
}

fn indexer_config(url: &str) -> Value {
    json!({ "Indexer": { "ServiceToken": SERVICE_TOKEN, "Instances": [{ "Name": "only", "Url": url }], "RetryAfterSeconds": 7 } })
}

#[tokio::test]
async fn without_peer_internal_api_is_404_and_public_routes_503() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    assert_eq!(app.get(SERVICE_TOKEN, "/internal/indexer/vaults?instance=x").await.0, 404);
    let r = app.post_h(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await;
    assert_eq!(r.0, 503);
    assert_eq!(r.1["error"]["code"], "unavailable");
    assert_eq!(r.2["retry-after"], "5");
}

#[tokio::test]
async fn calls_are_relayed_with_the_caller() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let r = app.post(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({ "limit": 1 })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    assert_eq!(r.1, json!({ "rows": [{ "id": "n1", "path": "a.md" }], "total": 1 }));
    let call = peer.calls.lock().unwrap()[0].clone();
    assert_eq!(call["capability"], "query");
    assert_eq!(call["params"], json!({ "limit": 1 }));
    // L'appelant, et ses regles d'acces (ACL) : proprietaire, aucun filtre.
    assert_eq!(call["caller"], json!({ "userId": alice, "access": { "base": "admin" } }));
    assert_eq!(call["auth"], format!("Bearer {SERVICE_TOKEN}"));
    // Non membre : refuse ; lien de partage : refuse.
    assert_eq!(app.post(&tb, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await.0, 404);
    let (link, _) = app.link_token(&ta, &format!("/api/v1/vaults/{v}/sharing/links"), "read").await;
    assert_eq!(app.post(&link, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await.0, 403);
    // Erreurs du pair : 400 passe (reecrite), le reste devient 503.
    *peer.mode.lock().unwrap() = "bad".into();
    let r = app.post(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await;
    assert_eq!(r.0, 400);
    assert_eq!(r.1, json!({ "error": { "code": "too_complex", "message": "trop" } }));
    *peer.mode.lock().unwrap() = "crash".into();
    let r = app.post_h(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await;
    assert_eq!((r.0, r.2["retry-after"].to_str().unwrap()), (503, "7"));
    // Corps et noms verifies avant tout relais.
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/index/Query/run"), json!({})).await.0, 400);
    let bad = app.http.post(app.url(&format!("/api/v1/vaults/{v}/index/query/run"))).bearer_auth(&ta).body("{nope").send().await.unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test]
async fn unreachable_peer_is_503() {
    let app = app!(json!({ "Indexer": { "ServiceToken": SERVICE_TOKEN, "Instances": [{ "Name": "down", "Url": "http://127.0.0.1:9" }], "TimeoutMs": 500 } }));
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let r = app.post(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await;
    assert_eq!(r.0, 503);
    assert_eq!(r.1["error"]["message"], "Le pair indexeur est injoignable.");
}

#[tokio::test]
async fn vault_setting() {
    let (url, _) = fake_peer().await;
    let app = app!(indexer_config(&url));
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    app.grant_vault(&ta, &v, &bob, "read").await;
    let s = app.get(&tb, &format!("/api/v1/vaults/{v}/indexer")).await;
    assert_eq!(s.1, json!({ "mode": "managed", "state": { "status": "ready", "seq": 3 } }));
    assert_eq!(app.put(&tb, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "none" })).await.0, 403);
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "organization" })).await.0, 400);
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "none", "url": "https://x" })).await.0, 400);
    let r = app.put(&ta, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "organization", "url": "https://idx.org" })).await;
    assert_eq!(r.1, json!({ "mode": "organization", "url": "https://idx.org" }));
    let call = app.post_h(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await;
    assert_eq!(call.0, 503);
    assert_eq!(call.1["mode"], "organization");
    assert_eq!(call.1["url"], "https://idx.org");
    assert!(!call.2.contains_key("retry-after"));
    app.put(&ta, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "none" })).await;
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await.1["mode"], "none");
}

#[tokio::test]
async fn global_search() {
    let (url, _) = fake_peer().await;
    let app = app!(indexer_config(&url));
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let r = app.post(&ta, "/api/v1/search", json!({ "text": "x" })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    // Un seul vault demande : le pair l'oublie, le relais le complete. Le vault « default » n'est pas a elle.
    assert_eq!(r.1["hits"], json!([{ "id": "h1", "score": 0.5, "title": "T", "vaultId": v }]));
    assert_eq!(r.1["index"], json!({ "status": "ready" }));
    assert_eq!(app.post(&ta, "/api/v1/search", json!({ "vaultIds": "x" })).await.0, 400);
    assert_eq!(app.post(&ta, "/api/v1/search", json!({ "limit": 0 })).await.0, 400);
    assert_eq!(app.post(&ta, "/api/v1/search", json!({ "cursor": "zzz" })).await.1["error"]["code"], "invalid_cursor");
    assert_eq!(app.http.post(app.url("/api/v1/search")).bearer_auth(&ta).send().await.unwrap().status(), 400);
}

#[tokio::test]
async fn per_user_rate_limit() {
    let (url, _) = fake_peer().await;
    let mut cfg = indexer_config(&url);
    cfg["Indexer"]["RateLimit"] = json!({ "PerUserPerMinute": 2, "PerVaultPerMinute": 100 });
    let app = app!(cfg);
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let mut last = 0;
    for _ in 0..3 {
        last = app.post(&ta, &format!("/api/v1/vaults/{v}/index/query/run"), json!({})).await.0;
    }
    assert_eq!(last, 429);
}

#[tokio::test]
async fn internal_api_and_feed() {
    let (url, _) = fake_peer().await;
    let app = app!(indexer_config(&url));
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    assert_eq!(app.get("", "/internal/indexer/vaults?instance=only").await.0, 401);
    assert_eq!(app.get("wrong", "/internal/indexer/vaults?instance=only").await.0, 401);
    assert_eq!(app.get(&ta, "/internal/indexer/vaults?instance=only").await.0, 401);
    assert_eq!(app.get(SERVICE_TOKEN, "/internal/indexer/vaults").await.1["error"]["code"], "unknown_instance");
    assert_eq!(app.get(SERVICE_TOKEN, "/internal/indexer/vaults?instance=other").await.0, 400);
    let vaults = app.get(SERVICE_TOKEN, "/internal/indexer/vaults?instance=only").await;
    assert!(vaults.1["vaults"].as_array().unwrap().iter().any(|x| x["vaultId"] == v));
    // Ecritures : une ligne par ressource dans le flux.
    let mut vh = app.hub("vault", &ta).await.unwrap();
    vh.invoke("PushVaultOperation", json!([v, b64(b"t1")])).await.unwrap();
    vh.invoke("PushVaultOperation", json!([v, b64(b"t2")])).await.unwrap();
    let mut sh = app.hub("sync", &ta).await.unwrap();
    sh.invoke("PushOperation", json!([v, doc, "c", b64(b"d1")])).await.unwrap();
    vh.invoke("PushIndexUpdate", json!([v, "settings/properties", b64(b"p")])).await.unwrap();
    vh.invoke("PushIndexUpdate", json!([v, "tags", b64(b"ignored")])).await.unwrap();
    let feed = app.get(SERVICE_TOKEN, "/internal/indexer/changes?instance=only&since=0").await;
    assert_eq!(feed.0, 200, "{}", feed.1);
    let kinds: Vec<(String, Option<String>)> = feed.1["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["vaultId"] == v)
        .map(|c| (c["kind"].as_str().unwrap().to_string(), c["docId"].as_str().map(str::to_string)))
        .collect();
    assert_eq!(kinds, vec![("vault".into(), None), ("document".into(), Some(doc.clone())), ("settings".into(), None)]);
    let last = feed.1["last"].as_i64().unwrap();
    assert_eq!(feed.1["epoch"].as_str().unwrap().len(), 32);
    assert_eq!(app.get(SERVICE_TOKEN, &format!("/internal/indexer/changes?instance=only&since={last}")).await.1["changes"], json!([]));
    assert_eq!(app.get(SERVICE_TOKEN, "/internal/indexer/changes?instance=only&since=-1").await.0, 400);
    let tree = app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/tree")).await;
    assert_eq!(tree.1, json!({ "updates": [b64(b"t1"), b64(b"t2")], "format": "yjs" }));
    let d = app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/documents/{doc}")).await;
    assert_eq!(d.1, json!({ "updates": [b64(b"d1")], "format": "yjs" }));
    let s = app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/settings/properties")).await;
    assert_eq!(s.1["updates"], json!([b64(b"p")]));
    assert_eq!(app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/settings/tags")).await.0, 404);
    // Un annexe suit son document.
    let annex = format!("{doc}~text");
    sh.invoke("PushOperation", json!([v, annex, "c", b64(b"a")])).await.unwrap_or(json!(null));
    // Room : son dernier etat JSON.
    let room_doc = app.document(&ta, &v).await;
    let mut rh = app.hub("room", &ta).await.unwrap();
    rh.invoke("PushSnapshot", json!([v, room_doc, "{\"a\":1}"])).await.unwrap();
    let r = app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/documents/{room_doc}")).await;
    assert_eq!(r.1, json!({ "updates": [b64(b"{\"a\":1}")], "format": "json" }));
    // Vault hors du pair gere : plus rien ; supprime : « vault-deleted ».
    app.put(&ta, &format!("/api/v1/vaults/{v}/indexer"), json!({ "mode": "none" })).await;
    assert_eq!(app.get(SERVICE_TOKEN, &format!("/internal/indexer/vaults/{v}/tree")).await.0, 404);
    let gone = app.get(SERVICE_TOKEN, &format!("/internal/indexer/changes?instance=only&since={last}")).await;
    assert!(gone.1["changes"].as_array().unwrap().iter().any(|c| c["vaultId"] == v && c["kind"] == "vault-deleted"));
    app.delete(&ta, &format!("/api/v1/vaults/{v}")).await;
    let after = app.get(SERVICE_TOKEN, "/internal/indexer/changes?instance=only&since=0").await;
    let rows: Vec<&Value> = after.1["changes"].as_array().unwrap().iter().filter(|c| c["vaultId"] == v).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "vault-deleted");
}

#[tokio::test]
async fn open_api_reads_through_the_peer() {
    let (url, peer) = fake_peer().await;
    let app = app!(indexer_config(&url));
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let other = app.vault(&alice, &ta, "Autre").await;
    let token = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "t", "vaultIds": [v] })).await.1["token"].as_str().unwrap().to_string();
    let r = app.post(&token, &format!("/api/open/v1/vaults/{v}/search"), json!({ "text": "plan", "limit": 99 })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    let call = peer.calls.lock().unwrap().last().unwrap().clone();
    assert_eq!(call["capability"], "search");
    assert_eq!(call["params"], json!({ "text": "plan", "limit": 50 }));
    assert_eq!(app.post(&token, &format!("/api/open/v1/vaults/{other}/search"), json!({ "text": "x" })).await.1["error"]["code"], "forbidden_vault");
    assert_eq!(app.get(&token, &format!("/api/open/v1/vaults/{v}/notes/read")).await.0, 400);
    app.get(&token, &format!("/api/open/v1/vaults/{v}/notes/read?path=a.md")).await;
    assert_eq!(peer.calls.lock().unwrap().last().unwrap()["params"], json!({ "path": "a.md" }));
    let notes = app.get(&token, &format!("/api/open/v1/vaults/{v}/notes?folder=P&limit=5")).await;
    assert_eq!(notes.0, 200);
    let p = peer.calls.lock().unwrap().last().unwrap()["params"].clone();
    assert_eq!(p, json!({ "from": { "notes": true, "folder": "P" }, "sort": [{ "field": { "doc": "path" } }], "limit": 5 }));
    let mcp = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "list_notes", "arguments": { "vault": "journal" } } })).await;
    let text = mcp.1["result"]["content"][0]["text"].as_str().unwrap().to_string();
    assert!(text.starts_with("1 note(s) dans Journal :"), "{text}");
    assert!(text.contains("- a.md (id : n1)"));
}
