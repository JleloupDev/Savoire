// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tests d'integration de l'API REST (comptes, vaults, partage, droits
// herites, pieces jointes, publications, administration, effacement).

mod common;

use serde_json::json;

// ── Comptes ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn auth_config_is_public() {
    let app = app!();
    let r = app.get("", "/api/v1/auth/config").await;
    assert_eq!(r.0, 200);
    assert_eq!(r.1["webClientId"], "web-test-client");
    assert_eq!(r.1["desktopClientId"], "desktop-test-client");
    assert_eq!(r.1["issuer"], app.idp.as_str());
}

#[tokio::test]
async fn first_request_creates_the_account() {
    let app = app!();
    let t = app.token("alice-sub", Some("alice@test.local"), Some("Alice"));
    let r = app.get(&t, "/api/v1/auth/me").await;
    assert_eq!(r.0, 200, "{}", r.1);
    assert_eq!(r.1, json!({ "id": "alice-sub", "displayName": "Alice", "email": "alice@test.local", "isAdmin": false }));
}

#[tokio::test]
async fn admin_email_needs_verification() {
    let app = app!();
    let r = app.get(&app.admin_token(), "/api/v1/auth/me").await;
    assert_eq!(r.1["isAdmin"], true);
    let unverified = app.token_with("other-admin", Some(common::ADMIN_EMAIL), None, false, 600);
    let r = app.get(&unverified, "/api/v1/auth/me").await;
    assert_eq!(r.0, 200);
    assert_eq!(r.1["isAdmin"], false);
    assert_eq!(r.1["email"], "");
}

#[tokio::test]
async fn missing_or_bad_token_is_401() {
    let app = app!();
    assert_eq!(app.get("", "/api/v1/auth/me").await.0, 401);
    assert_eq!(app.get("not-a-jwt", "/api/v1/auth/me").await.0, 401);
    let expired = app.token_with("x", Some("x@test.local"), None, true, -120);
    assert_eq!(app.get(&expired, "/api/v1/auth/me").await.0, 401);
    assert_eq!(app.post("", "/api/v1/auth/login", json!({})).await.0, 404);
}

#[tokio::test]
async fn health_and_store_config() {
    let app = app!(json!({ "Store": { "Url": "https://store.test", "PublicKey": "" } }));
    assert_eq!(app.get("", "/health/live").await.1, json!({ "status": "live" }));
    assert_eq!(app.get("", "/health/ready").await.1, json!({ "status": "ready" }));
    assert_eq!(app.get("", "/api/v1/store/config").await.1, json!({ "url": "https://store.test", "publicKey": null }));
}

// ── Vaults ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn vault_lifecycle() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    assert_eq!(app.post("", &format!("/api/v1/users/{alice}/vaults"), json!({ "name": "x" })).await.0, 401);
    let v = app.vault(&alice, &ta, "Notes").await;
    let list = app.get(&ta, &format!("/api/v1/users/{alice}/vaults")).await;
    assert_eq!(list.1["vaults"][0]["role"], "owner");
    assert_eq!(list.1["sharedWithMe"], json!([]));
    // Bob ne voit pas le vault d'Alice dans les siens.
    let lb = app.get(&tb, &format!("/api/v1/users/{bob}/vaults")).await;
    assert_eq!(lb.1["vaults"], json!([]));
    // Seul le proprietaire renomme, supprime, ajoute des membres.
    assert_eq!(app.delete(&tb, &format!("/api/v1/vaults/{v}")).await.0, 403);
    assert_eq!(app.patch(&ta, &format!("/api/v1/vaults/{v}"), json!({ "name": "Renomme" })).await.1["name"], "Renomme");
    let add = app.post(&ta, &format!("/api/v1/vaults/{v}/members"), json!({ "userId": bob, "role": "editor" })).await;
    assert_eq!(add.0, 200, "{}", add.1);
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/members"), json!({ "userId": bob, "role": "editor" })).await.0, 409);
    let lb = app.get(&tb, &format!("/api/v1/users/{bob}/vaults")).await;
    assert_eq!(lb.1["vaults"][0]["role"], "editor");
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/members/{bob}")).await.0, 204);
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}")).await.0, 204);
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}")).await.0, 404);
}

#[tokio::test]
async fn vault_count_is_bounded() {
    let app = app!(json!({ "Limits": { "VaultsPerAccount": 2 } }));
    let (alice, ta) = app.user("alice").await;
    app.vault(&alice, &ta, "a").await;
    app.vault(&alice, &ta, "b").await;
    let r = app.post(&ta, &format!("/api/v1/users/{alice}/vaults"), json!({ "name": "c" })).await;
    assert_eq!(r.0, 413);
    assert_eq!(r.1["type"], "https://errors.app/quota-exceeded");
}

#[tokio::test]
async fn member_identities_and_blobs() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let key = common::b64(&[7u8; 32]);
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/members/identity"), json!({ "signPubBase64": key })).await.0, 204);
    let ids = app.get(&ta, &format!("/api/v1/vaults/{v}/members/identities")).await;
    assert_eq!(ids.1, json!({ "signPubsBase64": [key] }));
    assert_eq!(app.get(&tb, &format!("/api/v1/vaults/{v}/members/identities")).await.0, 404);
    // Blobs EdgeSync et cle enveloppee : opaques, par vault (et par compte pour la cle).
    let blob = common::b64(b"opaque");
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/edgesync-blobs/a/b"), json!({ "bytesBase64": blob })).await.0, 204);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/edgesync-blobs/a/b")).await.1["bytesBase64"], blob);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/edgesync-blobs/missing")).await.0, 404);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/key-wrap")).await.0, 404);
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/key-wrap"), json!({ "bytesBase64": blob })).await.0, 204);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/key-wrap")).await.1["bytesBase64"], blob);
    // Cle d'identite : creee une fois, puis la meme.
    let k1 = app.get(&ta, "/api/v1/identity/key").await.1["privateKey"].clone();
    assert_eq!(k1.as_str().unwrap().len(), 64);
    assert_eq!(app.get(&ta, "/api/v1/identity/key").await.1["privateKey"], k1);
}

// ── Comptes des autres ───────────────────────────────────────────────────────

#[tokio::test]
async fn users_lookup() {
    let app = app!(json!({ "Limits": { "LookupsPerMinute": 3 } }));
    let (bob, _) = app.user("bob").await;
    let (_, ta) = app.user("alice").await;
    assert_eq!(app.get("", &format!("/api/v1/users/{bob}")).await.0, 401);
    let r = app.get(&ta, &format!("/api/v1/users?email={bob}@test.local")).await;
    assert_eq!(r.1, json!({ "id": bob, "displayName": "bob" }));
    assert_eq!(app.get(&ta, "/api/v1/users").await.0, 400);
    assert_eq!(app.get(&ta, "/api/v1/users/nobody").await.0, 404);
    let r = app.get_h(&ta, "/api/v1/users/nobody").await;
    assert_eq!(r.0, 429);
    assert!(r.2.contains_key("retry-after"));
}

// ── Partage ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn sharing_permissions_and_links() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let s = app.get(&ta, &format!("/api/v1/vaults/{v}/sharing")).await;
    assert_eq!(s.1, json!({ "resourceType": "vault", "resourceId": v, "permissions": [], "links": [] }));
    assert_eq!(app.get("", &format!("/api/v1/vaults/{v}/sharing")).await.0, 401);
    assert_eq!(app.post(&tb, &format!("/api/v1/vaults/{v}/sharing/permissions"), json!({ "subjectId": bob, "permission": "read" })).await.0, 403);
    app.grant_vault(&ta, &v, &bob, "read").await;
    let lb = app.get(&tb, &format!("/api/v1/users/{bob}/vaults")).await;
    assert_eq!(lb.1["vaults"][0]["role"], "viewer");
    app.grant_vault(&ta, &v, &bob, "write").await;
    let lb = app.get(&tb, &format!("/api/v1/users/{bob}/vaults")).await;
    assert_eq!(lb.1["vaults"][0]["role"], "editor");
    let s = app.get(&ta, &format!("/api/v1/vaults/{v}/sharing")).await;
    assert_eq!(s.1["permissions"][0]["subjectDisplayName"], "bob");
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/sharing/permissions/{bob}")).await.0, 204);
    assert_eq!(app.get(&tb, &format!("/api/v1/users/{bob}/vaults")).await.1["vaults"], json!([]));
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/sharing/permissions/{bob}")).await.0, 403);
    // « admin » et « none » sont refuses sur un lien ; « none » sur un vault.
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/sharing/links"), json!({ "permission": "admin" })).await.0, 500);
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/sharing/permissions"), json!({ "subjectId": bob, "permission": "none" })).await.0, 500);
    // Lien de partage : un jeton limite, puis revoque.
    let link = app.post(&ta, &format!("/api/v1/vaults/{v}/sharing/links"), json!({ "permission": "read" })).await;
    assert_eq!(link.1["isValid"], true);
    let token = link.1["token"].as_str().unwrap().to_string();
    let access = app.get("", &format!("/api/v1/share/{token}/access")).await;
    assert_eq!(access.0, 200);
    assert_eq!(access.1["vaultId"], v);
    assert_eq!(access.1["permission"], "read");
    assert_eq!(app.get("", "/api/v1/share/nope/access").await.0, 403);
    assert_eq!(app.post(&tb, &format!("/api/v1/vaults/{v}/sharing/links"), json!({ "permission": "read" })).await.0, 403);
    assert_eq!(app.delete(&ta, &format!("/api/v1/sharing/links/{}", link.1["id"].as_str().unwrap())).await.0, 204);
    assert_eq!(app.get("", &format!("/api/v1/share/{token}/access")).await.0, 403);
}

#[tokio::test]
async fn document_link_keeps_its_path() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let link = app.post(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), json!({ "permission": "write", "path": "/notes/plan.md" })).await;
    assert_eq!(link.0, 200, "{}", link.1);
    let access = app.get("", &format!("/api/v1/share/{}/access", link.1["token"].as_str().unwrap())).await;
    assert_eq!(access.1["resourceType"], "document");
    assert_eq!(access.1["resourceId"], doc);
    assert_eq!(access.1["vaultId"], v);
    assert_eq!(access.1["path"], "notes/plan.md");
    // Un document inconnu ne se partage pas.
    assert_eq!(app.post(&ta, "/api/v1/documents/unknown/sharing/links", json!({ "permission": "read" })).await.0, 403);
}

#[tokio::test]
async fn link_scope_is_enforced() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (mallory, tm) = app.user("mallory").await;
    let va = app.vault(&alice, &ta, "a").await;
    let vm = app.vault(&mallory, &tm, "m").await;
    let foreign = app.document(&ta, &va).await;
    let (link, _) = app.link_token(&tm, &format!("/api/v1/vaults/{vm}/sharing/links"), "write").await;
    // Un lien vers SON vault n'ouvre pas un document d'un autre vault.
    let mut hub = app.hub("sync", &link).await.unwrap();
    let e = hub.invoke("JoinDocument", json!([vm, foreign])).await.unwrap_err();
    assert!(e.ends_with("HubException: document-not-in-vault"), "{e}");
    // Jeton de vue : pour un document du vault annonce seulement.
    let g = app.post(&tm, "/api/v1/view/internal-grants", json!({ "vaultId": vm, "docId": foreign })).await;
    assert_eq!(g.0, 403);
    let own = app.document(&tm, &vm).await;
    let g = app.post(&tm, "/api/v1/view/internal-grants", json!({ "vaultId": vm, "docId": own, "permission": "write", "path": "a.md" })).await;
    assert_eq!(g.0, 200, "{}", g.1);
    let redeemed = app.post("", "/api/v1/view/grants/redeem", json!({ "grantToken": g.1["grantToken"] })).await;
    assert_eq!(redeemed.0, 200);
    assert_eq!(redeemed.1["userId"], mallory);
    let view = redeemed.1["accessToken"].as_str().unwrap().to_string();
    // La vue ouvre son document, pas le vault, ni un autre document.
    let mut hub = app.hub("sync", &view).await.unwrap();
    assert!(hub.invoke("JoinDocument", json!([vm, own])).await.is_ok());
    let other = app.document(&tm, &vm).await;
    assert!(hub.invoke("JoinDocument", json!([vm, other])).await.unwrap_err().ends_with("access-denied"));
    let mut vh = app.hub("vault", &view).await.unwrap();
    assert!(vh.invoke("JoinVault", json!([vm])).await.unwrap_err().ends_with("access-denied"));
    assert_eq!(app.post("", "/api/v1/view/grants/redeem", json!({ "grantToken": "bad" })).await.0, 403);
}

#[tokio::test]
async fn anonymous_view_grant_with_share_token() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let link = app.post(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), json!({ "permission": "read" })).await;
    let share = link.1["token"].as_str().unwrap();
    let g = app.post("", "/api/v1/view/grants", json!({ "vaultId": v, "docId": doc, "shareToken": share })).await;
    assert_eq!(g.0, 200, "{}", g.1);
    assert_eq!(g.1["permission"], "read");
    let w = app.post("", "/api/v1/view/grants", json!({ "vaultId": v, "docId": doc, "shareToken": share, "permission": "write" })).await;
    assert_eq!(w.0, 403);
    assert_eq!(app.post("", "/api/v1/view/grants", json!({ "vaultId": v, "docId": doc })).await.0, 403);
}

// ── Droits herites ───────────────────────────────────────────────────────────

#[tokio::test]
async fn acl_inheritance_and_overrides() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    app.grant_vault(&ta, &v, &bob, "read").await;
    let place = app.put(&ta, &format!("/api/v1/vaults/{v}/documents/folders"), json!([{ "docId": doc, "folder": "Projets/A" }, { "docId": "ghost", "folder": "x" }])).await;
    assert_eq!(place.1, json!({ "rejected": ["ghost"] }));
    let mut hub = app.hub("sync", &tb).await.unwrap();
    // Lecteur du vault : lit, n'ecrit pas.
    assert!(hub.invoke("JoinDocument", json!([v, doc])).await.is_ok());
    assert!(hub.invoke("PushOperation", json!([v, doc, "c", common::b64(b"x")])).await.unwrap_err().ends_with("access-denied"));
    // Redacteur du dossier : ecrit.
    let r = app.put(&ta, &format!("/api/v1/vaults/{v}/acl/entries"), json!({ "folder": "Projets", "subjectId": bob, "permission": "write" })).await;
    assert_eq!(r.0, 204, "{}", r.1);
    assert!(hub.invoke("PushOperation", json!([v, doc, "c", common::b64(b"x")])).await.is_ok());
    // « none » sur la note : plus rien, meme en lecture.
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/acl/entries"), json!({ "docId": doc, "subjectId": bob, "permission": "none" })).await.0, 204);
    assert!(hub.invoke("JoinDocument", json!([v, doc])).await.unwrap_err().ends_with("vault-not-found"));
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/acl/entries?docId={doc}&subjectId={bob}")).await.0, 204);
    // Heritage coupe sur le dossier : seuls ses droits propres restent.
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/acl/inherit"), json!({ "folder": "Projets/A", "inherit": false })).await.0, 204);
    assert!(hub.invoke("JoinDocument", json!([v, doc])).await.unwrap_err().ends_with("vault-not-found"));
    let view = app.get(&ta, &format!("/api/v1/vaults/{v}/acl?folder=Projets/A")).await;
    assert_eq!(view.1["inherit"], false);
    assert_eq!(view.1["level"], "folder");
    let inherited = view.1["inherited"].as_array().unwrap();
    assert!(inherited.iter().any(|i| i["subjectId"] == bob && i["source"] == "folder:Projets" && i["permission"] == "write"));
    assert!(inherited.iter().any(|i| i["subjectId"] == alice && i["source"] == "owner"));
    // Seuls les administrateurs gerent les droits.
    assert_eq!(app.get(&tb, &format!("/api/v1/vaults/{v}/acl?folder=Projets")).await.0, 403);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/acl")).await.0, 400);
    // Le proprietaire garde tout.
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/acl/entries"), json!({ "docId": doc, "subjectId": alice, "permission": "none" })).await.0, 400);
}

#[tokio::test]
async fn folder_rename_moves_rights() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    app.put(&ta, &format!("/api/v1/vaults/{v}/documents/folders"), json!([{ "docId": doc, "folder": "Old/Sub" }])).await;
    app.put(&ta, &format!("/api/v1/vaults/{v}/acl/entries"), json!({ "folder": "Old", "subjectId": bob, "permission": "read" })).await;
    let mut hub = app.hub("sync", &tb).await.unwrap();
    assert!(hub.invoke("JoinDocument", json!([v, doc])).await.is_ok());
    assert_eq!(app.post(&ta, &format!("/api/v1/vaults/{v}/acl/folders/rename"), json!({ "from": "Old", "to": "New" })).await.0, 204);
    let view = app.get(&ta, &format!("/api/v1/vaults/{v}/acl?folder=New")).await;
    assert_eq!(view.1["entries"][0]["subjectId"], bob);
    assert!(hub.invoke("JoinDocument", json!([v, doc])).await.is_ok());
    assert_eq!(app.post(&tb, &format!("/api/v1/vaults/{v}/acl/folders/rename"), json!({ "from": "New", "to": "Other" })).await.0, 404);
}

// ── Pieces jointes ───────────────────────────────────────────────────────────

async fn upload(app: &common::TestApp, token: &str, path: &str, bytes: &[u8]) -> (u16, serde_json::Value) {
    let boundary = "savoire-test-boundary";
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let res = app
        .http
        .post(app.url(path))
        .bearer_auth(token)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .unwrap();
    let s = res.status().as_u16();
    let t = res.text().await.unwrap();
    (s, serde_json::from_str(&t).unwrap_or(serde_json::Value::String(t)))
}

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

#[tokio::test]
async fn attachments_access() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let (_, tc) = app.user("carol").await;
    let v = app.vault(&alice, &ta, "v").await;
    let file = app.document(&ta, &v).await;
    let r = upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments/{file}"), PNG).await;
    assert_eq!(r.0, 200, "{}", r.1);
    assert_eq!(r.1["path"], file);
    let res = app.http.get(app.url(&format!("/api/v1/vaults/{v}/attachments/{file}"))).bearer_auth(&ta).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert!(res.headers()["content-security-policy"].to_str().unwrap().starts_with("sandbox"));
    assert_eq!(res.bytes().await.unwrap().as_ref(), PNG);
    assert_eq!(app.get("", &format!("/api/v1/vaults/{v}/attachments/{file}")).await.0, 401);
    assert_eq!(app.get(&tc, &format!("/api/v1/vaults/{v}/attachments/{file}")).await.0, 404);
    app.grant_vault(&ta, &v, &bob, "read").await;
    assert_eq!(app.get(&tb, &format!("/api/v1/vaults/{v}/attachments/{file}")).await.0, 200);
    assert_eq!(upload(&app, &tb, &format!("/api/v1/vaults/{v}/attachments"), PNG).await.0, 403);
    assert_eq!(app.get(&ta, &format!("/api/v1/vaults/{v}/attachments/..%2Fetc")).await.0, 400);
    // Ancien envoi : nom genere par le serveur.
    let legacy = upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments"), PNG).await;
    assert!(legacy.1["path"].as_str().unwrap().ends_with(".png"));
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/attachments/{}", legacy.1["path"].as_str().unwrap())).await.0, 204);
    assert_eq!(upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments/bad_id"), PNG).await.0, 400);
    assert_eq!(upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments"), &[]).await.0, 400);
}

#[tokio::test]
async fn note_link_reads_only_images_of_its_folder() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let note = app.document(&ta, &v).await;
    let inside = app.document(&ta, &v).await;
    let outside = app.document(&ta, &v).await;
    for f in [&inside, &outside] {
        assert_eq!(upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments/{f}"), PNG).await.0, 200);
    }
    let r = app.put(&ta, &format!("/api/v1/vaults/{v}/attachments/{inside}/placement"), json!({ "noteId": note, "name": "Photo.png" })).await;
    assert_eq!(r.0, 204, "{}", r.1);
    assert_eq!(app.put(&ta, &format!("/api/v1/vaults/{v}/attachments/{inside}/placement"), json!({ "noteId": "ghost" })).await.0, 403);
    let (link, _) = app.link_token(&ta, &format!("/api/v1/documents/{note}/sharing/links"), "read").await;
    let list = app.get(&link, &format!("/api/v1/vaults/{v}/documents/{note}/attachments")).await;
    assert_eq!(list.1, json!([{ "id": inside, "name": "Photo.png" }]));
    assert_eq!(app.get(&link, &format!("/api/v1/vaults/{v}/attachments/{inside}")).await.0, 200);
    assert_eq!(app.get(&link, &format!("/api/v1/vaults/{v}/attachments/{outside}")).await.0, 403);
    assert_eq!(upload(&app, &link, &format!("/api/v1/vaults/{v}/attachments/{inside}"), PNG).await.0, 403);
    // Image sortie du dossier : plus lisible par le lien.
    app.put(&ta, &format!("/api/v1/vaults/{v}/attachments/{inside}/placement"), json!({ "noteId": null })).await;
    assert_eq!(app.get(&link, &format!("/api/v1/vaults/{v}/attachments/{inside}")).await.0, 403);
}

#[tokio::test]
async fn upload_stops_at_quota() {
    let app = app!(json!({ "Limits": { "AccountBytes": 20 } }));
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    app.grant_vault(&ta, &v, &bob, "write").await;
    assert_eq!(upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments"), PNG).await.0, 200);
    // Le membre consomme le quota du proprietaire.
    let r = upload(&app, &tb, &format!("/api/v1/vaults/{v}/attachments"), PNG).await;
    assert_eq!(r.0, 413, "{}", r.1);
    let usage = app.get(&ta, "/api/v1/auth/me/usage").await;
    assert_eq!(usage.1["quotaBytes"], 20);
    assert_eq!(usage.1["usedBytes"], PNG.len());
}

// ── Publications ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn publication_lifecycle() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    app.grant_vault(&ta, &v, &bob, "write").await;
    let path = format!("/api/v1/vaults/{v}/documents/{doc}/publication");
    assert_eq!(app.get(&ta, &path).await.0, 204);
    let body = json!({ "title": "Mon été", "description": "D", "html": "<p>Bonjour</p><script>x</script>", "indexable": false });
    assert_eq!(app.put(&tb, &path, body.clone()).await.0, 403);
    let p = app.put(&ta, &path, body).await;
    assert_eq!(p.0, 200, "{}", p.1);
    let slug = p.1["slug"].as_str().unwrap().to_string();
    assert!(slug.starts_with("mon-ete-"));
    assert_eq!(p.1["path"], format!("/p/{slug}"));
    // Un redacteur met a jour le contenu d'une page deja publiee.
    let r = app.put(&tb, &format!("{path}/content"), json!({ "title": "Mon été", "description": "", "html": "<p>Nouveau</p>" })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    let page = app.http.get(app.url(&format!("/p/{slug}"))).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let csp = page.headers()["content-security-policy"].to_str().unwrap().to_string();
    assert!(csp.contains("frame-ancestors 'self'") && csp.contains("sandbox"));
    assert_eq!(page.headers()["x-robots-tag"], "noindex, nofollow");
    let html = page.text().await.unwrap();
    assert!(html.contains("<p>Nouveau</p>") && html.contains("<title>Mon été</title>"));
    let embed = app.http.get(app.url(&format!("/p/{slug}?embed=1"))).send().await.unwrap();
    assert!(embed.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors *"));
    assert_eq!(app.delete(&tb, &path).await.0, 403);
    assert_eq!(app.delete(&ta, &path).await.0, 204);
    assert_eq!(app.http.get(app.url(&format!("/p/{slug}"))).send().await.unwrap().status(), 404);
    assert_eq!(app.put(&tb, &format!("{path}/content"), json!({ "title": "", "description": "", "html": "" })).await.0, 404);
    assert_eq!(app.http.get(app.url("/p/BAD_SLUG")).send().await.unwrap().status(), 404);
}

// ── Administration et retours ────────────────────────────────────────────────

#[tokio::test]
async fn admin_routes() {
    let app = app!();
    let (bob, tb) = app.user("bob").await;
    let admin = app.admin_token();
    assert_eq!(app.get("", "/api/v1/admin/users").await.0, 401);
    assert_eq!(app.get(&tb, "/api/v1/admin/users").await.0, 403);
    let list = app.get(&admin, "/api/v1/admin/users").await;
    assert_eq!(list.0, 200);
    assert!(list.1.as_array().unwrap().iter().any(|u| u["id"] == bob && u["isLockedOut"] == false));
    assert_eq!(app.post(&admin, &format!("/api/v1/admin/users/{bob}/disable"), json!({})).await.0, 204);
    // Un jeton encore valide chez l'IdP est refuse des maintenant.
    assert_eq!(app.get(&tb, "/api/v1/auth/me").await.0, 401);
    let list = app.get(&admin, "/api/v1/admin/users").await;
    assert!(list.1.as_array().unwrap().iter().any(|u| u["id"] == bob && u["isLockedOut"] == true));
}

#[tokio::test]
async fn feedback_flow() {
    let app = app!();
    let (_, tb) = app.user("bob").await;
    let admin = app.admin_token();
    assert_eq!(app.post("", "/api/v1/feedback", json!({ "message": "x" })).await.0, 401);
    assert_eq!(app.post(&tb, "/api/v1/feedback", json!({ "message": "" })).await.0, 400);
    assert_eq!(app.post(&tb, "/api/v1/feedback", json!({ "message": "x", "screenshot": common::b64(b"GIF89a....") })).await.0, 400);
    let shot = format!("data:image/png;base64,{}", common::b64(PNG));
    let r = app.post(&tb, "/api/v1/feedback", json!({ "message": "  Bug  ", "context": { "page": "x" }, "screenshot": shot })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    let id = r.1["id"].as_str().unwrap().to_string();
    let list = app.get(&admin, "/api/v1/admin/feedback").await;
    assert_eq!(list.1[0]["message"], "Bug");
    assert_eq!(list.1[0]["context"], "{\"page\":\"x\"}");
    assert_eq!(list.1[0]["hasScreenshot"], true);
    let res = app.http.get(app.url(&format!("/api/v1/admin/feedback/{id}/screenshot"))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(res.headers()["content-type"], "image/png");
    assert_eq!(app.post(&admin, &format!("/api/v1/admin/feedback/{id}/archive"), json!({ "archived": true })).await.0, 204);
    assert_eq!(app.get(&admin, "/api/v1/admin/feedback").await.1, json!([]));
    assert_eq!(app.get(&admin, "/api/v1/admin/feedback?archived=true").await.1.as_array().unwrap().len(), 1);
    assert_eq!(app.delete(&admin, &format!("/api/v1/admin/feedback/{id}")).await.0, 204);
    assert_eq!(app.delete(&admin, &format!("/api/v1/admin/feedback/{id}")).await.0, 404);
}

// ── Effacement ───────────────────────────────────────────────────────────────

async fn count(app: &common::TestApp, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).bind(bind).fetch_one(&app.state.db).await.unwrap()
}

#[tokio::test]
async fn deleting_a_vault_erases_everything() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let mut hub = app.hub("sync", &ta).await.unwrap();
    hub.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    hub.invoke("PushOperation", json!([v, doc, "c", common::b64(b"op")])).await.unwrap();
    app.post(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), json!({ "permission": "read" })).await;
    app.put(&ta, &format!("/api/v1/vaults/{v}/documents/{doc}/publication"), json!({ "title": "t", "description": "", "html": "<p/>", "indexable": true })).await;
    assert_eq!(upload(&app, &ta, &format!("/api/v1/vaults/{v}/attachments"), PNG).await.0, 200);
    let tok = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "n", "vaultIds": [v] })).await;
    assert_eq!(tok.0, 200, "{}", tok.1);
    assert_eq!(count(&app, "SELECT count(*) FROM operations_log WHERE resource_id = $1", &doc).await, 1);
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}")).await.0, 204);
    assert_eq!(count(&app, "SELECT count(*) FROM operations_log WHERE resource_id = $1", &doc).await, 0);
    assert_eq!(count(&app, "SELECT count(*) FROM share_links WHERE resource_id = $1", &doc).await, 0);
    assert_eq!(count(&app, "SELECT count(*) FROM publications WHERE vault_id = $1", &v).await, 0);
    assert!(!app.storage.join(&v).exists());
    // Le jeton qui ne visait que ce vault est revoque.
    let list = app.get(&ta, "/api/v1/me/access-tokens").await;
    assert_eq!(list.1[0]["revoked"], true);
    let purge = app.post(&app.admin_token(), "/api/v1/admin/orphans/purge?dryRun=true", json!({})).await;
    assert_eq!(purge.0, 200);
    assert_eq!(purge.1["dryRun"], true);
}

#[tokio::test]
async fn deleting_my_account() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let vb = app.vault(&bob, &tb, "b").await;
    app.grant_vault(&tb, &vb, &alice, "write").await;
    app.post(&ta, "/api/v1/feedback", json!({ "message": "bye" })).await;
    assert_eq!(app.http.delete(app.url("/api/v1/auth/me")).bearer_auth(&ta).send().await.unwrap().status(), 400);
    let r = app.http.delete(app.url("/api/v1/auth/me")).bearer_auth(&ta).json(&json!({ "confirm": "SUPPRIMER" })).send().await.unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(count(&app, "SELECT count(*) FROM vaults WHERE id = $1", &v).await, 0);
    assert_eq!(count(&app, "SELECT count(*) FROM vault_members WHERE user_id = $1", &alice).await, 0);
    assert_eq!(count(&app, "SELECT count(*) FROM feedback_reports WHERE user_id = $1", &alice).await, 0);
    assert_eq!(count(&app, r#"SELECT count(*) FROM "AspNetUsers" WHERE "Id" = $1"#, &alice).await, 0);
    // Le jeton encore valide ne recree pas le compte.
    assert_eq!(app.get(&ta, "/api/v1/auth/me").await.0, 401);
    assert_eq!(app.delete(&app.admin_token(), &format!("/api/v1/admin/users/{bob}")).await.0, 204);
    assert_eq!(count(&app, "SELECT count(*) FROM vaults WHERE id = $1", &vb).await, 0);
}

// ── Jetons personnels ────────────────────────────────────────────────────────

#[tokio::test]
async fn access_tokens_lifecycle() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let vb_owner = app.user("carol").await;
    let foreign = app.vault(&vb_owner.0, &vb_owner.1, "c").await;
    assert_eq!(app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "" })).await.0, 400);
    assert_eq!(app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "x", "vaultIds": [foreign] })).await.0, 400);
    assert_eq!(app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "x", "vaultIds": [] })).await.0, 400);
    let created = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": " Claude ", "vaultIds": [v], "expiresInDays": 30 })).await;
    assert_eq!(created.0, 200, "{}", created.1);
    let token = created.1["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("svp_"));
    assert_eq!(created.1["info"]["name"], "Claude");
    assert_eq!(created.1["info"]["prefix"], &token[..10]);
    // Un jeton personnel n'ouvre jamais les routes de l'application.
    assert_eq!(app.get(&token, "/api/v1/auth/me").await.0, 401);
    // L'API ouverte : les vaults du jeton seulement.
    let list = app.get(&token, "/api/open/v1/vaults").await;
    assert_eq!(list.1["vaults"].as_array().unwrap().len(), 1);
    assert_eq!(list.1["vaults"][0]["id"], v);
    assert_eq!(app.get(&ta, "/api/open/v1/vaults").await.0, 401);
    let id = created.1["info"]["id"].as_str().unwrap().to_string();
    assert_eq!(app.delete(&tb, &format!("/api/v1/me/access-tokens/{id}")).await.0, 404);
    assert_eq!(app.delete(&ta, &format!("/api/v1/me/access-tokens/{id}")).await.0, 204);
    assert_eq!(app.get(&token, "/api/open/v1/vaults").await.0, 401);
    let desc = app.http.get(app.url("/api/open/v1/openapi.yaml")).send().await.unwrap().text().await.unwrap();
    assert!(desc.contains(&format!("{}/api/open/v1", app.base)));
}

#[tokio::test]
async fn mcp_protocol() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    app.vault(&alice, &ta, "Journal").await;
    let created = app.post(&ta, "/api/v1/me/access-tokens", json!({ "name": "mcp" })).await;
    let token = created.1["token"].as_str().unwrap().to_string();
    let init = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).await;
    assert_eq!(init.1["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init.1["result"]["serverInfo"]["name"], "savoire");
    let notif = app.http.post(app.url("/api/mcp")).bearer_auth(&token).json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).send().await.unwrap();
    assert_eq!(notif.status(), 202);
    let tools = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    assert_eq!(tools.1["result"]["tools"].as_array().unwrap().len(), 4);
    let call = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "list_vaults" } })).await;
    assert!(call.1["result"]["content"][0]["text"].as_str().unwrap().contains("Journal"));
    let missing = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "search", "arguments": { "vault": "Journal" } } })).await;
    assert_eq!(missing.1["error"]["code"], -32602);
    let unknown_vault = app.post(&token, "/api/mcp", json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "search", "arguments": { "vault": "nope", "query": "x" } } })).await;
    assert_eq!(unknown_vault.1["result"]["isError"], true);
    let bad = app.http.post(app.url("/api/mcp")).bearer_auth(&token).body("{oops").send().await.unwrap();
    assert_eq!(bad.json::<serde_json::Value>().await.unwrap()["error"]["code"], -32700);
    assert_eq!(app.get(&token, "/api/mcp").await.0, 405);
}

// ── CORS et rapports d'erreur ────────────────────────────────────────────────

#[tokio::test]
async fn cors_accepts_desktop_app_only() {
    let app = app!(json!({ "AllowedOrigins": ["https://app.test"] }));
    let pre = |origin: &'static str| {
        app.http
            .request(reqwest::Method::OPTIONS, app.url("/api/v1/auth/me"))
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "GET")
            .header("Access-Control-Request-Headers", "authorization")
            .send()
    };
    let ok = pre("tauri://localhost").await.unwrap();
    assert_eq!(ok.headers()["access-control-allow-origin"], "tauri://localhost");
    assert_eq!(ok.headers()["access-control-allow-credentials"], "true");
    let web = pre("https://app.test").await.unwrap();
    assert_eq!(web.headers()["access-control-allow-origin"], "https://app.test");
    let evil = pre("https://evil.test").await.unwrap();
    assert!(!evil.headers().contains_key("access-control-allow-origin"));
}

#[tokio::test]
async fn error_reports_config() {
    let app = app!();
    let r = app.get("", "/api/v1/errors/config").await;
    assert_eq!(r.1["dsn"], serde_json::Value::Null);
    assert_eq!(app.http.post(app.url("/api/v1/errors/envelope")).body("{}").send().await.unwrap().status(), 404);
}

#[tokio::test]
async fn anonymous_routes_are_rate_limited() {
    let app = app!(json!({ "Limits": { "AnonymousPerMinute": 2 } }));
    let mut codes = vec![];
    for _ in 0..3 {
        codes.push(app.get("", "/api/v1/share/nope/access").await.0);
    }
    assert_eq!(codes, vec![403, 403, 429]);
}

#[tokio::test]
async fn expired_vault_grant_is_enforced() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let past = (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
    let r = app.post(&ta, &format!("/api/v1/vaults/{v}/sharing/permissions"), json!({ "subjectId": bob, "permission": "write", "expiresAt": past })).await;
    assert_eq!(r.0, 200, "{}", r.1);
    let mut hub = app.hub("vault", &tb).await.unwrap();
    assert!(hub.invoke("JoinVault", json!([v])).await.unwrap_err().ends_with("vault-not-found"));
    // Le balayage retire le droit et le membre.
    assert_eq!(savoire_server::services::accounts::sweep_expired_permissions(&app.state).await.unwrap(), 1);
    assert_eq!(count(&app, "SELECT count(*) FROM vault_members WHERE user_id = $1", &bob).await, 0);
}
