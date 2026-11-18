// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Tests d'integration des hubs temps reel (WebSocket) : vault, sync, room,
// edgesync ; controle d'acces, diffusion, persistance, revocation.

mod common;

use common::{LONG, SHORT, b64};
use serde_json::json;

#[tokio::test]
async fn connection_requires_a_token() {
    let app = app!();
    assert!(app.hub("vault", "").await.is_err());
    assert!(app.hub("room", "bad").await.is_err());
    let res = app.http.get(app.url("/hubs/vault")).send().await.unwrap();
    assert_eq!(res.status(), 401);
    let (_, t) = app.user("alice").await;
    let res = app.http.get(app.url("/hubs/vault")).bearer_auth(&t).send().await.unwrap();
    assert_ne!(res.status(), 401);
    assert!(app.hub("nope", &t).await.is_err());
}

#[tokio::test]
async fn vault_hub_sync() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let mut a = app.hub("vault", &ta).await.unwrap();
    let mut b = app.hub("vault", &ta).await.unwrap();
    a.invoke("JoinVault", json!([v])).await.unwrap();
    assert_eq!(a.wait_event("InitVault", LONG).await.unwrap(), json!([v, []]));
    b.invoke("JoinVault", json!([v])).await.unwrap();
    b.wait_event("InitVault", LONG).await.unwrap();
    a.invoke("PushVaultOperation", json!([v, b64(b"op1")])).await.unwrap();
    assert_eq!(b.wait_event("VaultOperationReceived", LONG).await.unwrap(), json!([v, b64(b"op1")]));
    assert!(a.no_event("VaultOperationReceived", SHORT).await);
    // Base64 invalide : ignore sans erreur.
    assert!(a.invoke("PushVaultOperation", json!([v, "@@@"])).await.is_ok());
    let mut c = app.hub("vault", &ta).await.unwrap();
    c.invoke("JoinVault", json!([v])).await.unwrap();
    assert_eq!(c.wait_event("InitVault", LONG).await.unwrap()[1], json!([b64(b"op1")]));
    // Compaction : l'etat remplace le journal.
    a.invoke("SnapshotVault", json!([v, b64(b"state")])).await.unwrap();
    let mut d = app.hub("vault", &ta).await.unwrap();
    d.invoke("JoinVault", json!([v])).await.unwrap();
    assert_eq!(d.wait_event("InitVault", LONG).await.unwrap()[1], json!([b64(b"state")]));
    assert!(d.invoke("Nope", json!([])).await.is_err());
}

#[tokio::test]
async fn vault_hub_access_control() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let vb = app.vault(&bob, &tb, "b").await;
    let doc = app.document(&ta, &v).await;
    let mut h = app.hub("vault", &tb).await.unwrap();
    for (m, args) in [
        ("JoinVault", json!([v])),
        ("PushVaultOperation", json!([v, b64(b"x")])),
        ("JoinIndex", json!([v, "tags"])),
        ("AcquireLock", json!([v, doc])),
    ] {
        let e = h.invoke(m, args).await.unwrap_err();
        assert!(e.ends_with("HubException: vault-not-found"), "{m}: {e}");
        assert!(e.starts_with(&format!("An unexpected error occurred invoking '{m}' on the server.")), "{e}");
    }
    // Un document d'un autre vault ne s'inscrit pas dans le sien.
    assert_eq!(h.invoke("RegisterDocuments", json!([vb, [doc]])).await.unwrap(), json!([doc]));
    let mut room = app.hub("room", &tb).await.unwrap();
    assert!(room.invoke("JoinRoom", json!([vb, doc])).await.unwrap_err().ends_with("document-not-in-vault"));
    let mut sync = app.hub("sync", &tb).await.unwrap();
    let unregistered = uuid::Uuid::new_v4().to_string();
    assert!(sync.invoke("JoinDocument", json!([vb, unregistered])).await.unwrap_err().ends_with("document-not-in-vault"));
    // Lecteur : ecrire est refuse avec « access-denied ».
    app.grant_vault(&ta, &v, &bob, "read").await;
    assert!(h.invoke("JoinVault", json!([v])).await.is_ok());
    assert!(h.invoke("PushVaultOperation", json!([v, b64(b"x")])).await.unwrap_err().ends_with("access-denied"));
}

#[tokio::test]
async fn index_channels_and_compaction() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let mut a = app.hub("vault", &ta).await.unwrap();
    let mut b = app.hub("vault", &ta).await.unwrap();
    assert_eq!(a.invoke("JoinIndex", json!([v, "tags"])).await.unwrap(), json!([]));
    b.invoke("JoinIndex", json!([v, "tags"])).await.unwrap();
    a.invoke("PushIndexUpdate", json!([v, "tags", b64(b"u1")])).await.unwrap();
    assert_eq!(b.wait_event("IndexUpdateReceived", LONG).await.unwrap(), json!([v, "tags", b64(b"u1")]));
    // b n'a recu u1 qu'en direct : sa compaction ne remplace rien (jointure sans op).
    b.invoke("SnapshotIndex", json!([v, "tags", b64(b"state-b")])).await.unwrap();
    let mut c = app.hub("vault", &ta).await.unwrap();
    assert_eq!(c.invoke("JoinIndex", json!([v, "tags"])).await.unwrap(), json!([b64(b"u1")]));
    // c a rejoue u1 : sa compaction le remplace ; une op arrivee depuis reste.
    a.invoke("PushIndexUpdate", json!([v, "tags", b64(b"u2")])).await.unwrap();
    c.invoke("SnapshotIndex", json!([v, "tags", b64(b"state-c")])).await.unwrap();
    let mut d = app.hub("vault", &ta).await.unwrap();
    let ops = d.invoke("JoinIndex", json!([v, "tags"])).await.unwrap();
    assert_eq!(ops, json!([b64(b"u2"), b64(b"state-c")]));
    // Deuxieme compaction de c : plus rien a remplacer.
    c.invoke("SnapshotIndex", json!([v, "tags", b64(b"again")])).await.unwrap();
    assert_eq!(d.invoke("JoinIndex", json!([v, "tags"])).await.unwrap().as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn edit_locks() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    app.grant_vault(&ta, &v, &bob, "write").await;
    let mut a = app.hub("vault", &ta).await.unwrap();
    let mut b = app.hub("vault", &tb).await.unwrap();
    a.invoke("JoinVault", json!([v])).await.unwrap();
    b.invoke("JoinVault", json!([v])).await.unwrap();
    let got = a.invoke("AcquireLock", json!([v, "d1"])).await.unwrap();
    assert_eq!(got, json!({ "holderUserId": alice, "holderDisplayName": "alice", "isHeldByCaller": true }));
    assert_eq!(b.wait_event("LockChanged", LONG).await.unwrap(), json!([v, "d1", alice, "alice"]));
    let other = b.invoke("AcquireLock", json!([v, "d1"])).await.unwrap();
    assert_eq!(other["isHeldByCaller"], false);
    assert_eq!(b.invoke("GetLock", json!([v, "d1"])).await.unwrap()["holderUserId"], alice);
    b.invoke("RequestLock", json!([v, "d1"])).await.unwrap();
    assert_eq!(a.wait_event("LockRequested", LONG).await.unwrap(), json!([v, "d1", bob, "bob"]));
    // Fermer la connexion rend le verrou.
    drop(a);
    assert_eq!(b.wait_event("LockChanged", LONG).await.unwrap(), json!([v, "d1", null, null]));
    assert_eq!(b.invoke("GetLock", json!([v, "d1"])).await.unwrap(), json!(null));
}

#[tokio::test]
async fn sync_hub_documents() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let mut a = app.hub("sync", &ta).await.unwrap();
    let mut b = app.hub("sync", &ta).await.unwrap();
    let mut outsider = app.hub("sync", &ta).await.unwrap();
    a.invoke("JoinVault", json!([v])).await.unwrap();
    assert_eq!(a.wait_event("VaultJoined", LONG).await.unwrap(), json!([v]));
    a.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    assert_eq!(a.wait_event("InitDocument", LONG).await.unwrap(), json!([doc, []]));
    b.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    a.invoke("PushOperation", json!([v, doc, "client-a", b64(b"op")])).await.unwrap();
    let got = b.wait_event("ReceiveOperation", LONG).await.unwrap();
    assert_eq!(got[0], doc.as_str());
    assert_eq!(got[1], "client-a");
    assert_eq!(got[2], b64(b"op"));
    // L'auteur vient du serveur.
    assert_eq!(got[3], json!({ "id": alice, "name": "alice", "guest": false }));
    assert!(a.no_event("ReceiveOperation", SHORT).await);
    assert!(outsider.no_event("ReceiveOperation", SHORT).await);
    assert!(a.invoke("PushOperation", json!([v, doc, "c", "%%%"])).await.is_ok());
    a.invoke("UpdateAwareness", json!([v, doc, "aw"])).await.unwrap();
    assert_eq!(b.wait_event("AwarenessUpdated", LONG).await.unwrap(), json!([doc, "aw"]));
    a.invoke("UpdatePresence", json!([v, doc, 42])).await.unwrap();
    assert_eq!(b.wait_event("PresenceUpdated", LONG).await.unwrap(), json!([doc, alice, alice, 42]));
    // Persistance et compaction.
    let mut c = app.hub("sync", &ta).await.unwrap();
    c.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    assert_eq!(c.wait_event("InitDocument", LONG).await.unwrap()[1], json!([b64(b"op")]));
    a.invoke("SnapshotDocument", json!([v, doc, b64(b"snap")])).await.unwrap();
    c.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    assert_eq!(c.wait_event("InitDocument", LONG).await.unwrap()[1], json!([b64(b"snap")]));
    // Pas entre dans le document : rien ne lui est relaye.
    outsider.invoke("UpdateAwareness", json!([v, doc, "x"])).await.unwrap();
    assert!(a.no_event("AwarenessUpdated", SHORT).await);
}

#[tokio::test]
async fn guest_author_on_share_link() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let (link, id) = app.link_token(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), "write").await;
    let mut owner = app.hub("sync", &ta).await.unwrap();
    owner.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut guest = app.hub("sync", &link).await.unwrap();
    guest.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    guest.invoke("PushOperation", json!([v, doc, "g", b64(b"x")])).await.unwrap();
    let got = owner.wait_event("ReceiveOperation", LONG).await.unwrap();
    assert_eq!(got[3], json!({ "id": format!("share:{id}"), "name": "Invité", "guest": true }));
    // Lien en lecture : pas d'ecriture.
    let (read, _) = app.link_token(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), "read").await;
    let mut r = app.hub("sync", &read).await.unwrap();
    assert!(r.invoke("PushOperation", json!([v, doc, "g", b64(b"x")])).await.unwrap_err().ends_with("access-denied"));
    // Un lien vers une note n'ouvre que celle-ci.
    let other = app.document(&ta, &v).await;
    assert!(r.invoke("JoinDocument", json!([v, other])).await.unwrap_err().ends_with("access-denied"));
}

#[tokio::test]
async fn document_rooms() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    let mut a = app.hub("room", &ta).await.unwrap();
    let mut b = app.hub("room", &ta).await.unwrap();
    let mut outside = app.hub("room", &ta).await.unwrap();
    a.invoke("JoinRoom", json!([v, doc])).await.unwrap();
    assert_eq!(a.wait_event("RoomJoined", LONG).await.unwrap(), json!([doc, null]));
    b.invoke("JoinRoom", json!([v, doc])).await.unwrap();
    a.invoke("PushSnapshot", json!([v, doc, "{\"x\":1}"])).await.unwrap();
    assert_eq!(b.wait_event("SnapshotReceived", LONG).await.unwrap(), json!([doc, alice, "{\"x\":1}"]));
    assert!(a.no_event("SnapshotReceived", SHORT).await);
    assert!(outside.no_event("SnapshotReceived", SHORT).await);
    a.invoke("UpdatePresence", json!([v, doc, "{\"cursor\":1}"])).await.unwrap();
    assert_eq!(b.wait_event("PresenceUpdated", LONG).await.unwrap(), json!([doc, alice, "{\"cursor\":1}"]));
    let mut c = app.hub("room", &ta).await.unwrap();
    c.invoke("JoinRoom", json!([v, doc])).await.unwrap();
    assert_eq!(c.wait_event("RoomJoined", LONG).await.unwrap(), json!([doc, "{\"x\":1}"]));
}

#[tokio::test]
async fn edgesync_relay() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (_, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let mut a = app.hub("edgesync", &ta).await.unwrap();
    let mut b = app.hub("edgesync", &ta).await.unwrap();
    assert_eq!(a.invoke("Join", json!([v])).await.unwrap(), json!([]));
    let peers = b.invoke("Join", json!([v])).await.unwrap();
    let a_id = peers[0].as_str().unwrap().to_string();
    let up = a.wait_event("PeerUp", LONG).await.unwrap();
    let b_id = up[1].as_str().unwrap().to_string();
    assert_eq!(a.invoke("ClaimOwner", json!([v])).await.unwrap(), json!(true));
    assert_eq!(b.invoke("ClaimOwner", json!([v])).await.unwrap(), json!(false));
    a.invoke("Relay", json!([v, b_id, "frame"])).await.unwrap();
    assert_eq!(b.wait_event("Frame", LONG).await.unwrap(), json!([v, a_id, "frame"]));
    // Hors de la room : rien.
    let mut stranger = app.hub("edgesync", &tb).await.unwrap();
    assert!(stranger.invoke("Join", json!([v])).await.unwrap_err().ends_with("vault-not-found"));
    stranger.invoke("Relay", json!([v, b_id, "x"])).await.unwrap();
    assert!(b.no_event("Frame", SHORT).await);
    // Le depart libere la revendication.
    drop(a);
    assert_eq!(b.wait_event("PeerDown", LONG).await.unwrap(), json!([v, a_id]));
    assert_eq!(b.invoke("ClaimOwner", json!([v])).await.unwrap(), json!(true));
}

#[tokio::test]
async fn revocation_cuts_open_connections() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    app.grant_vault(&ta, &v, &bob, "write").await;
    let mut owner = app.hub("sync", &ta).await.unwrap();
    owner.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut b = app.hub("sync", &tb).await.unwrap();
    b.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut bv = app.hub("vault", &tb).await.unwrap();
    bv.invoke("JoinVault", json!([v])).await.unwrap();
    assert_eq!(app.delete(&ta, &format!("/api/v1/vaults/{v}/members/{bob}")).await.0, 204);
    assert_eq!(bv.wait_event("VaultAccessChanged", LONG).await.unwrap(), json!([v]));
    assert_eq!(b.wait_event("AccessRevoked", LONG).await.unwrap(), json!([doc, bob]));
    owner.invoke("PushOperation", json!([v, doc, "c", b64(b"secret")])).await.unwrap();
    assert!(b.no_event("ReceiveOperation", SHORT).await);
    assert!(bv.invoke("CheckVaultAccess", json!([v])).await.unwrap_err().ends_with("vault-not-found"));
}

#[tokio::test]
async fn revoked_link_and_disabled_account_stop_receiving() {
    let app = app!();
    let (alice, ta) = app.user("alice").await;
    let (bob, tb) = app.user("bob").await;
    let v = app.vault(&alice, &ta, "v").await;
    let doc = app.document(&ta, &v).await;
    app.grant_vault(&ta, &v, &bob, "read").await;
    let (link, link_id) = app.link_token(&ta, &format!("/api/v1/documents/{doc}/sharing/links"), "read").await;
    let mut owner = app.hub("sync", &ta).await.unwrap();
    owner.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut guest = app.hub("sync", &link).await.unwrap();
    guest.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    let mut b = app.hub("sync", &tb).await.unwrap();
    b.invoke("JoinDocument", json!([v, doc])).await.unwrap();
    assert_eq!(app.delete(&ta, &format!("/api/v1/sharing/links/{link_id}")).await.0, 204);
    assert!(guest.wait_event("AccessRevoked", LONG).await.is_some());
    assert_eq!(app.post(&app.admin_token(), &format!("/api/v1/admin/users/{bob}/disable"), json!({})).await.0, 204);
    assert!(b.wait_event("AccessRevoked", LONG).await.is_some());
    owner.invoke("PushOperation", json!([v, doc, "c", b64(b"x")])).await.unwrap();
    assert!(guest.no_event("ReceiveOperation", SHORT).await);
    assert!(b.no_event("ReceiveOperation", SHORT).await);
}

#[tokio::test]
async fn connection_closes_when_token_expires() {
    let app = app!();
    let (alice, _) = app.user("alice").await;
    let short = app.token_with(&alice, Some(&format!("{alice}@test.local")), Some("alice"), true, 2);
    let mut h = app.hub("vault", &short).await.unwrap();
    assert!(h.closed_within(std::time::Duration::from_secs(5)).await);
}

#[tokio::test]
async fn hub_writes_stop_at_quota_and_calls_are_limited() {
    let app = app!(json!({ "Limits": { "AccountBytes": 10, "HubCallsPerMinute": 5 } }));
    let (alice, ta) = app.user("alice").await;
    let v = app.vault(&alice, &ta, "v").await;
    let mut h = app.hub("vault", &ta).await.unwrap();
    h.invoke("PushVaultOperation", json!([v, b64(b"12345")])).await.unwrap();
    let e = h.invoke("PushVaultOperation", json!([v, b64(b"1234567")])).await.unwrap_err();
    assert!(e.ends_with("quota-exceeded"), "{e}");
    let mut last = Ok(json!(null));
    for _ in 0..5 {
        last = h.invoke("CheckVaultAccess", json!([v])).await;
    }
    assert!(last.unwrap_err().ends_with("rate-limited"));
}
