// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le contexte de l'editeur pour l'IA : l'application dit ou travaille la
// personne, l'IA le lit par MCP (get_context), dans la portee de son agent.
// Epingles et surlignages pour l'IA : en base, lus par list_pins et get_context.

mod common;

use std::time::{Duration, Instant};

use savoire_server::api::editor_context::ContextEntry;
use serde_json::{Value, json};

async fn mcp(app: &common::TestApp, token: &str, method: &str, params: Value) -> Value {
    app.post(token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })).await.1
}

async fn call(app: &common::TestApp, token: &str, name: &str, args: Value) -> Value {
    mcp(app, token, "tools/call", json!({ "name": name, "arguments": args })).await["result"].clone()
}

fn text(r: &Value) -> String {
    r["content"][0]["text"].as_str().unwrap_or("").to_string()
}

fn anchor(doc: &str, quote: &str) -> Value {
    json!({ "docId": doc, "start": "AAEBAQ==", "end": "AAEBBg==", "quote": quote, "prefix": "juste avant ", "suffix": " juste après" })
}

fn context(vault: &str, doc: &str, path: &str, selection: &str) -> Value {
    json!({
        "vaultId": vault, "docId": doc, "path": path, "selection": selection, "anchor": anchor(doc, selection),
        "before": "les dix mots qui précèdent", "after": "les dix mots qui suivent",
        "headingPath": ["MCP", "Bases"], "blockHash": "0123456789abcdef", "at": 1_795_000_000_000i64, "tabId": "onglet-1",
    })
}

/// Un agent de la personne et le jeton qui le porte.
async fn agent_token(app: &common::TestApp, user_token: &str, definition: Value) -> String {
    let agent = app.post(user_token, "/api/v1/agents", definition).await;
    assert_eq!(agent.0, 200, "{}", agent.1);
    let t = app.post(user_token, "/api/v1/me/access-tokens", json!({ "name": "IA", "agentId": agent.1["id"] })).await;
    assert_eq!(t.0, 200, "{}", t.1);
    t.1["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn the_ai_reads_where_the_person_works() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let token = agent_token(&app, &ta, json!({ "name": "Secrétaire", "permissions": { "read": "direct" } })).await;

    // Les outils sont offerts, en lecture seule, avec ou sans pair indexeur.
    let tools = mcp(&app, &token, "tools/list", json!({})).await;
    let list = tools["result"]["tools"].as_array().unwrap().clone();
    let get = list.iter().find(|t| t["name"] == "get_context").expect("get_context");
    assert!(list.iter().any(|t| t["name"] == "list_pins"));
    assert_eq!(get["annotations"]["readOnlyHint"], true);
    assert!(get["description"].as_str().unwrap().contains("« ici »"));
    assert_eq!(get["inputSchema"]["properties"]["seconds_ago"]["type"], "integer");
    let init = mcp(&app, &token, "initialize", json!({})).await;
    assert!(init["result"]["instructions"].as_str().unwrap().contains("get_context"));

    // Rien d'envoye : l'IA le sait, et demande.
    let none = call(&app, &token, "get_context", json!({})).await;
    assert_eq!(none["isError"], false);
    assert!(text(&none).contains("Aucun contexte"), "{none}");

    // L'application envoie la selection.
    let sent = app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "Projets/Plan.md", "le passage à reformuler")).await;
    assert_eq!(sent.0, 204, "{}", sent.1);
    let r = call(&app, &token, "get_context", json!({})).await;
    let t = text(&r);
    assert_eq!(r["isError"], false, "{r}");
    assert!(t.contains("le passage à reformuler") && t.contains("Projets/Plan.md") && t.contains("MCP > Bases") && t.contains("vault : Journal"), "{t}");
    let data = &r["structuredContent"];
    assert_eq!(data["selection"], "le passage à reformuler");
    assert_eq!(data["anchor"], anchor(&doc, "le passage à reformuler"));
    assert_eq!((data["noteId"].as_str(), data["vaultId"].as_str()), (Some(doc.as_str()), Some(v.as_str())));
    assert_eq!((&data["stale"], &data["isCursor"], &data["tabId"]), (&json!(false), &json!(false), &json!("onglet-1")));
    assert!(data["ageSeconds"].as_u64().unwrap() < 30);
    assert_eq!(data["highlights"], json!([]));

    // Un curseur : pas de selection, mais l'endroit.
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "Projets/Plan.md", "")).await.0, 204);
    let cursor = call(&app, &token, "get_context", json!({})).await;
    assert_eq!(cursor["structuredContent"]["isCursor"], true);
    assert!(text(&cursor).contains("le curseur est entre"));

    // Bornes : une selection trop longue est coupee, une ancre fausse refusee.
    let long = "é".repeat(5000);
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "a.md", &long)).await.0, 204);
    let cut = call(&app, &token, "get_context", json!({})).await;
    assert_eq!(cut["structuredContent"]["selection"].as_str().unwrap().chars().count(), 4000);
    assert_eq!(cut["structuredContent"]["selectionTruncated"], true);
    let mut bad = context(&v, &doc, "a.md", "x");
    bad["anchor"]["start"] = json!("");
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", bad).await.0, 400);
    let mut bad = context(&v, &doc, "a.md", "x");
    bad.as_object_mut().unwrap().remove("anchor");
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", bad).await.0, 400);

    // Chacun son contexte ; on n'en envoie pas pour une note qu'on ne lit pas, ni sans compte.
    assert_eq!(app.post(&tb, "/api/v1/me/editor-context", context(&v, &doc, "a.md", "x")).await.0, 404);
    assert_eq!(app.post("", "/api/v1/me/editor-context", context(&v, &doc, "a.md", "x")).await.0, 401);
    let other = app.document(&ta, &app.vault(&alice, &ta, "Autre").await).await;
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &other, "a.md", "x")).await.0, 404);
    let bob_token = agent_token(&app, &tb, json!({ "name": "B", "permissions": { "read": "direct" } })).await;
    assert!(text(&call(&app, &bob_token, "get_context", json!({})).await).contains("Aucun contexte"));
    // Le jeton d'une IA n'ouvre pas la route de l'application.
    assert_eq!(app.post(&token, "/api/v1/me/editor-context", context(&v, &doc, "a.md", "x")).await.0, 401);
}

fn entry(vault: &str, doc: &str, selection: &str, received: Instant) -> ContextEntry {
    ContextEntry {
        vault_id: vault.into(),
        doc_id: doc.into(),
        path: "Projets/Plan.md".into(),
        selection: selection.into(),
        selection_truncated: false,
        anchor: anchor(doc, selection),
        before: String::new(),
        after: String::new(),
        heading_path: vec![],
        block_hash: String::new(),
        tab_id: "t".into(),
        client_at: None,
        received,
        received_at: chrono::Utc::now(),
    }
}

#[tokio::test]
async fn seconds_ago_and_the_stale_hint() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let token = agent_token(&app, &ta, json!({ "name": "Secrétaire", "permissions": { "read": "direct" } })).await;
    let Some(old) = Instant::now().checked_sub(Duration::from_secs(40)) else { return };
    // Il y a 40 s : une selection ; il y a 5 s : la personne a clique ailleurs.
    app.state.editor_contexts.push(&alice, entry(&v, &doc, "ce dont elle parlait", old));
    app.state.editor_contexts.push(&alice, entry(&v, &doc, "", old + Duration::from_secs(35)));
    let now = call(&app, &token, "get_context", json!({})).await;
    assert_eq!(now["structuredContent"]["isCursor"], true);
    let then = call(&app, &token, "get_context", json!({ "seconds_ago": 20 })).await;
    assert_eq!(then["structuredContent"]["selection"], "ce dont elle parlait");
    let age = then["structuredContent"]["ageSeconds"].as_u64().unwrap();
    assert!((40..60).contains(&age), "{age}");
    assert_eq!(then["structuredContent"]["stale"], false);
    // Un nombre hors bornes ne casse rien.
    assert_eq!(call(&app, &token, "get_context", json!({ "seconds_ago": -5 })).await["structuredContent"]["isCursor"], true);
    assert_eq!(call(&app, &token, "get_context", json!({ "seconds_ago": 999_999 })).await["structuredContent"]["selection"], "ce dont elle parlait");

    // Plus de deux minutes : la derniere entree est gardee, avec le conseil de confirmer.
    let (bob, tb) = app.user("bob").await;
    let vb = app.vault(&bob, &tb, "Carnet").await;
    let docb = app.document(&tb, &vb).await;
    let token_b = agent_token(&app, &tb, json!({ "name": "B", "permissions": { "read": "direct" } })).await;
    let Some(long_ago) = Instant::now().checked_sub(Duration::from_secs(300)) else { return };
    app.state.editor_contexts.push(&bob, entry(&vb, &docb, "vieille sélection", long_ago));
    let stale = call(&app, &token_b, "get_context", json!({})).await;
    assert_eq!(stale["structuredContent"]["stale"], true);
    assert!(stale["structuredContent"]["ageSeconds"].as_u64().unwrap() >= 300);
    assert!(text(&stale).contains("demandez à la personne de confirmer"), "{stale}");
    assert!(text(&stale).contains("vieille sélection"));
}

#[tokio::test]
async fn the_agent_scope_hides_what_it_cannot_read() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let private = app.vault(&alice, &ta, "Privé").await;
    let doc = app.document(&ta, &v).await;
    let secret_doc = app.document(&ta, &private).await;
    let leaks = |r: &Value| r.to_string().contains("secret") || r.to_string().contains(&secret_doc);

    // La personne travaille dans le vault prive ; elle y a aussi une epingle et un surlignage.
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&private, &secret_doc, "Intime/secret.md", "texte secret")).await.0, 204);
    for kind in ["pin", "highlight"] {
        let m = app.post(&ta, "/api/v1/me/ai-marks", json!({ "vaultId": private, "docId": secret_doc, "kind": kind, "label": "secret", "path": "Intime/secret.md", "anchor": anchor(&secret_doc, "texte secret") })).await;
        assert_eq!(m.0, 200, "{}", m.1);
    }

    // Agent borne au vault Journal : il ne voit rien du vault prive.
    let scoped = agent_token(&app, &ta, json!({ "name": "Borné", "permissions": { "read": "direct" }, "scope": { "vaultIds": [v] } })).await;
    let r = call(&app, &scoped, "get_context", json!({})).await;
    assert!(text(&r).contains("hors de la portée"), "{r}");
    assert!(!leaks(&r), "{r}");
    let pins = call(&app, &scoped, "list_pins", json!({})).await;
    assert!(text(&pins).contains("Aucune épingle") && !leaks(&pins), "{pins}");
    assert_eq!(call(&app, &scoped, "list_pins", json!({ "vault": "Inconnu" })).await["isError"], true);

    // Jeton limite au vault Journal (sans agent) : pareil.
    let limited = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "limité", "vaultIds": [v] })).await.1["token"].as_str().unwrap().to_string();
    let r = call(&app, &limited, "get_context", json!({})).await;
    assert!(text(&r).contains("hors de la portée") && !leaks(&r), "{r}");
    // Un jeton sans limite ni agent lit (lecture seule).
    let plain = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "lecture" })).await.1["token"].as_str().unwrap().to_string();
    let r = call(&app, &plain, "get_context", json!({})).await;
    assert_eq!(r["structuredContent"]["selection"], "texte secret");
    assert_eq!(r["structuredContent"]["highlights"][0]["text"], "texte secret");

    // Agent borne a un dossier : le chemin de la note decide.
    let folder = agent_token(&app, &ta, json!({ "name": "Projets", "permissions": { "read": "direct" }, "scope": { "folders": ["Projets"] } })).await;
    assert!(text(&call(&app, &folder, "get_context", json!({})).await).contains("hors de la portée"));
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "Projets/Plan.md", "dans le dossier")).await.0, 204);
    assert_eq!(call(&app, &folder, "get_context", json!({})).await["structuredContent"]["selection"], "dans le dossier");
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "Ailleurs/Plan.md", "hors du dossier")).await.0, 204);
    let r = call(&app, &folder, "get_context", json!({})).await;
    assert!(text(&r).contains("hors de la portée") && !r.to_string().contains("hors du dossier"), "{r}");

    // Un agent qui ne lit pas : ni outil, ni reponse.
    let blind = agent_token(&app, &ta, json!({ "name": "Aveugle", "permissions": { "read": "deny" } })).await;
    let tools = mcp(&app, &blind, "tools/list", json!({})).await;
    assert!(!tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "get_context" || t["name"] == "list_pins"));
    assert_eq!(call(&app, &blind, "get_context", json!({})).await["isError"], true);
    assert_eq!(call(&app, &blind, "list_pins", json!({})).await["isError"], true);

    // La personne perd l'acces au vault : son ancien contexte ne se lit plus.
    app.grant_vault(&ta, &v, &bob, "read").await;
    assert_eq!(app.post(&tb, "/api/v1/me/editor-context", context(&v, &doc, "Projets/Plan.md", "vu par bob")).await.0, 204);
    let bob_token = agent_token(&app, &tb, json!({ "name": "B", "permissions": { "read": "direct" } })).await;
    assert_eq!(call(&app, &bob_token, "get_context", json!({})).await["structuredContent"]["selection"], "vu par bob");
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/members/{bob}")).await.0, 204);
    let gone = call(&app, &bob_token, "get_context", json!({})).await;
    assert!(text(&gone).contains("hors de la portée") && !gone.to_string().contains("vu par bob"), "{gone}");
}

#[tokio::test]
async fn pins_and_highlights_for_the_ai() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "Journal").await;
    let doc = app.document(&ta, &v).await;
    let token = agent_token(&app, &ta, json!({ "name": "Secrétaire", "permissions": { "read": "direct" } })).await;
    let mark = |kind: &str, label: &str, quote: &str| json!({ "vaultId": v, "docId": doc, "kind": kind, "label": label, "path": "Projets/Plan.md", "anchor": anchor(&doc, quote) });

    // Epingle (un passage, ou un simple endroit), surlignages.
    let pin = app.post(&ta, "/api/v1/me/ai-marks", mark("pin", " Conclusion ", "le dernier paragraphe")).await;
    assert_eq!(pin.0, 200, "{}", pin.1);
    assert_eq!((pin.1["label"].as_str(), pin.1["kind"].as_str()), (Some("Conclusion"), Some("pin")));
    let pin_id = pin.1["id"].as_str().unwrap().to_string();
    assert_eq!(app.post(&ta, "/api/v1/me/ai-marks", mark("pin", "Ici", "")).await.0, 200);
    let h1 = app.post(&ta, "/api/v1/me/ai-marks", mark("highlight", "", "premier passage")).await;
    assert_eq!(h1.0, 200, "{}", h1.1);
    assert_eq!(app.post(&ta, "/api/v1/me/ai-marks", mark("highlight", "", "second passage")).await.0, 200);
    // Un surlignage porte sur du texte ; un genre inconnu est refuse ; pas dans le vault d'un autre.
    assert_eq!(app.post(&ta, "/api/v1/me/ai-marks", mark("highlight", "", "")).await.0, 400);
    assert_eq!(app.post(&ta, "/api/v1/me/ai-marks", mark("note", "", "x")).await.0, 400);
    assert_eq!(app.post(&tb, "/api/v1/me/ai-marks", mark("pin", "x", "x")).await.0, 404);

    // Elles sont a la personne : listees pour elle seule, par note ou par genre.
    let all = app.get(&ta, &format!("/api/v1/me/ai-marks?vaultId={v}&docId={doc}")).await;
    assert_eq!(all.1["marks"].as_array().unwrap().len(), 4);
    assert_eq!(app.get(&ta, "/api/v1/me/ai-marks?kind=highlight").await.1["marks"].as_array().unwrap().len(), 2);
    assert_eq!(app.get(&tb, "/api/v1/me/ai-marks").await.1["marks"], json!([]));
    assert_eq!(app.get(&ta, "/api/v1/me/ai-marks?kind=autre").await.0, 400);

    // L'IA lit les epingles par leur nom, et les surlignages avec le contexte (meme sans contexte).
    let pins = call(&app, &token, "list_pins", json!({ "vault": "journal" })).await;
    let t = text(&pins);
    assert!(t.contains("2 épingle(s)") && t.contains("Conclusion") && t.contains("le dernier paragraphe") && t.contains("un endroit (curseur)"), "{t}");
    assert_eq!(pins["structuredContent"]["pins"].as_array().unwrap().len(), 2);
    assert!(pins["structuredContent"]["pins"].as_array().unwrap().iter().any(|p| p["label"] == "Conclusion" && p["anchor"]["quote"] == "le dernier paragraphe" && p["noteId"] == json!(doc)));
    let ctx = call(&app, &token, "get_context", json!({})).await;
    let texts: Vec<&str> = ctx["structuredContent"]["highlights"].as_array().unwrap().iter().map(|h| h["text"].as_str().unwrap()).collect();
    assert!(texts.contains(&"premier passage") && texts.contains(&"second passage") && texts.len() == 2, "{ctx}");
    assert!(text(&ctx).contains("Passages surlignés pour l'IA (2)"));
    assert!(ctx["structuredContent"]["highlights"][0]["anchor"]["start"].is_string());

    // Le passage a change dans la note : l'application rafraichit le texte de l'ancre.
    let h1_id = h1.1["id"].as_str().unwrap();
    assert_eq!(app.patch(&ta, &format!("/api/v1/me/ai-marks/{h1_id}"), json!({ "anchor": anchor(&doc, "premier passage, retouché"), "path": "Projets/Plan 2.md" })).await.0, 204);
    assert_eq!(app.patch(&tb, &format!("/api/v1/me/ai-marks/{h1_id}"), json!({ "label": "x" })).await.0, 404);
    assert_eq!(app.patch(&ta, &format!("/api/v1/me/ai-marks/{pin_id}"), json!({ "label": "Fin" })).await.0, 204);
    let after = call(&app, &token, "get_context", json!({})).await;
    assert!(after.to_string().contains("premier passage, retouché") && after.to_string().contains("Projets/Plan 2.md"), "{after}");
    assert!(text(&call(&app, &token, "list_pins", json!({})).await).contains("Fin"));

    // Retirer une epingle ; effacer les surlignages de la note ; pas ceux d'un autre.
    assert_eq!(app.delete(&tb, &format!("/api/v1/me/ai-marks/{pin_id}")).await.0, 404);
    assert_eq!(app.delete(&ta, &format!("/api/v1/me/ai-marks/{pin_id}")).await.0, 204);
    assert_eq!(app.delete(&ta, &format!("/api/v1/me/ai-marks/{pin_id}")).await.0, 404);
    assert_eq!(app.delete(&tb, &format!("/api/v1/me/ai-marks?docId={doc}&kind=highlight")).await.1["deleted"], 0);
    assert_eq!(app.delete(&ta, &format!("/api/v1/me/ai-marks?vaultId={v}&docId={doc}&kind=highlight")).await.1["deleted"], 2);
    let left = app.get(&ta, "/api/v1/me/ai-marks").await;
    assert_eq!(left.1["marks"].as_array().unwrap().len(), 1);
    assert_eq!(call(&app, &token, "get_context", json!({})).await["structuredContent"]["highlights"], json!([]));

    // Le vault disparait : ses marques aussi.
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}")).await.0, 204);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_marks").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn nothing_is_sent_for_an_end_to_end_vault() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "Chiffré").await;
    let doc = app.document(&ta, &v).await;
    // Un vault EdgeSync : sa cle est enveloppee sur le serveur, qui ne lit rien.
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/key-wrap"), json!({ "bytesBase64": common::b64(b"cle enveloppee") })).await.0, 204);
    assert_eq!(app.post(&ta, "/api/v1/me/editor-context", context(&v, &doc, "a.md", "texte en clair")).await.0, 403);
    let m = app.post(&ta, "/api/v1/me/ai-marks", json!({ "vaultId": v, "docId": doc, "kind": "pin", "label": "x", "path": "a.md", "anchor": anchor(&doc, "texte en clair") })).await;
    assert_eq!(m.0, 403, "{}", m.1);
    let token = agent_token(&app, &ta, json!({ "name": "S", "permissions": { "read": "direct" } })).await;
    assert!(text(&call(&app, &token, "get_context", json!({})).await).contains("Aucun contexte"));
}
