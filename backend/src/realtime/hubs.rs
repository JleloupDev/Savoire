// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les methodes des hubs. Controle d'acces a chaque appel, AVANT l'entree dans
// un groupe de diffusion : sinon, meme refuse, l'appelant recevrait deja les
// mises a jour en direct.

use std::sync::Arc;

use base64::Engine;
use serde_json::{Value, json};

use super::{Conn, HubKind, LockHolder, Subscription, event};
use crate::access::{self, Level};
use crate::db::repos;
use crate::domain::{Operation, crdt, is_link_caller, is_share_link_caller, now};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Une relayee est un message du protocole : 2 Mio de base64, bien au-dela d'une enveloppe legitime.
const MAX_FRAME_BASE64: usize = 2 * 1024 * 1024;

fn arg_str(args: &[Value], i: usize) -> AppResult<String> {
    match args.get(i) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(AppError::internal(format!("argument {i} : texte attendu"))),
    }
}

fn arg_str_list(args: &[Value], i: usize) -> AppResult<Vec<String>> {
    match args.get(i) {
        Some(Value::Array(a)) => Ok(a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
        Some(Value::Null) | None => Ok(vec![]),
        _ => Err(AppError::internal(format!("argument {i} : liste attendue"))),
    }
}

fn b64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn b64_out(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub async fn invoke(st: &AppState, kind: HubKind, conn_id: &str, conn: &Arc<Conn>, method: &str, args: &[Value]) -> AppResult<Value> {
    let caller = conn.principal.sub.clone();
    if caller.is_empty() {
        return Err(AppError::Unauthorized("Not authenticated.".into()));
    }
    match kind {
        HubKind::Vault => vault_hub(st, conn_id, conn, &caller, method, args).await,
        HubKind::Sync => sync_hub(st, conn_id, conn, &caller, method, args).await,
        HubKind::Room => room_hub(st, conn_id, conn, &caller, method, args).await,
        HubKind::EdgeSync => edge_hub(st, conn_id, &caller, method, args).await,
    }
}

fn unknown(method: &str) -> AppError {
    AppError::internal(format!("Methode inconnue : {method}"))
}

fn caller_name(conn: &Conn) -> String {
    conn.principal.display_name.clone().or_else(|| conn.principal.email.clone()).unwrap_or_else(|| "Quelqu'un".into())
}

async fn ensure_room(st: &AppState, vault_id: &str, bytes: usize) -> AppResult<()> {
    st.quota.ensure_room(&st.limits(), vault_id, bytes as i64).await
}

// ── /hubs/vault ──────────────────────────────────────────────────────────────

async fn vault_hub(st: &AppState, conn_id: &str, conn: &Arc<Conn>, caller: &str, method: &str, args: &[Value]) -> AppResult<Value> {
    let rt = &st.realtime;
    let hub = &rt.vault;
    let mut c = st.db.acquire().await?;
    match method {
        "JoinVault" => {
            let vault_id = arg_str(args, 0)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            let ops = repos::ops_all(&mut c, crdt::VAULT, &format!("vault:{vault_id}")).await?;
            hub.add_to_group(conn_id, &vault_id);
            rt.subscribe(Subscription { hub: HubKind::Vault, conn: conn_id.into(), caller: caller.into(), vault_id: vault_id.clone(), doc_id: None, group: vault_id.clone() });
            let ops: Vec<String> = ops.iter().map(|o| b64_out(&o.op_bytes)).collect();
            tracing::info!(connection = conn_id, vault = %vault_id, ops = ops.len(), "Client entre dans le vault");
            hub.send_to(conn_id, &event("InitVault", vec![json!(vault_id), json!(ops)]));
            Ok(Value::Null)
        }
        "CheckVaultAccess" => {
            let vault_id = arg_str(args, 0)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            Ok(Value::Null)
        }
        "PushVaultOperation" => {
            let vault_id = arg_str(args, 0)?;
            let op64 = arg_str(args, 1)?;
            let Some(bytes) = b64(&op64) else {
                tracing::warn!(connection = conn_id, "Op de vault invalide (base64)");
                return Ok(Value::Null);
            };
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            ensure_room(st, &vault_id, bytes.len()).await?;
            let n = bytes.len();
            let op = Operation::create(crdt::VAULT, &format!("vault:{vault_id}"), "vault-client", now(), bytes);
            repos::op_append(&mut c, &op).await?;
            st.quota.added(&vault_id, n as i64);
            hub.send_group(&vault_id, Some(conn_id), &event("VaultOperationReceived", vec![json!(vault_id), json!(op64)]));
            Ok(Value::Null)
        }
        "SnapshotVault" => {
            let vault_id = arg_str(args, 0)?;
            let Some(bytes) = b64(&arg_str(args, 1)?) else { return Ok(Value::Null) };
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            repos::ops_compact(&mut c, crdt::VAULT, &format!("vault:{vault_id}"), bytes, true).await?;
            st.quota.invalidate(&vault_id);
            tracing::info!(vault = %vault_id, connection = conn_id, "Vault compacte");
            Ok(Value::Null)
        }
        "RegisterDocuments" => {
            let vault_id = arg_str(args, 0)?;
            let ids = arg_str_list(args, 1)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            let rejected = repos::docs_register(&mut c, &vault_id, &ids, caller).await?;
            if !rejected.is_empty() {
                tracing::warn!(vault = %vault_id, count = rejected.len(), "RegisterDocuments : document(s) deja dans un autre vault");
            }
            Ok(json!(rejected))
        }
        "JoinIndex" => {
            let vault_id = arg_str(args, 0)?;
            let ns = arg_str(args, 1)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            let stored = repos::ops_all(&mut c, crdt::INDEX, &index_id(&vault_id, &ns)).await?;
            let group = format!("idx:{vault_id}:{ns}");
            hub.add_to_group(conn_id, &group);
            rt.subscribe(Subscription { hub: HubKind::Vault, conn: conn_id.into(), caller: caller.into(), vault_id: vault_id.clone(), doc_id: None, group });
            conn.items.lock().unwrap().joined_index.insert(format!("{vault_id}:{ns}"), stored.iter().map(|o| o.id.clone()).collect());
            Ok(json!(stored.iter().map(|o| b64_out(&o.op_bytes)).collect::<Vec<_>>()))
        }
        "PushIndexUpdate" => {
            let vault_id = arg_str(args, 0)?;
            let ns = arg_str(args, 1)?;
            let update = arg_str(args, 2)?;
            let Some(bytes) = b64(&update) else { return Ok(Value::Null) };
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            ensure_room(st, &vault_id, bytes.len()).await?;
            let n = bytes.len();
            // Le serveur est un passe-plat : il empile des octets opaques.
            let op = Operation::create(crdt::INDEX, &index_id(&vault_id, &ns), "server-relay", now(), bytes);
            repos::op_append(&mut c, &op).await?;
            st.quota.added(&vault_id, n as i64);
            hub.send_group(&format!("idx:{vault_id}:{ns}"), Some(conn_id), &event("IndexUpdateReceived", vec![json!(vault_id), json!(ns), json!(update)]));
            Ok(Value::Null)
        }
        "SnapshotIndex" => {
            // Remplace par l'etat du client EXACTEMENT les ops qu'il a recues a JoinIndex.
            let vault_id = arg_str(args, 0)?;
            let ns = arg_str(args, 1)?;
            let Some(bytes) = b64(&arg_str(args, 2)?) else { return Ok(Value::Null) };
            let key = format!("{vault_id}:{ns}");
            let covered = conn.items.lock().unwrap().joined_index.get(&key).cloned().unwrap_or_default();
            if covered.is_empty() {
                tracing::info!(vault = %vault_id, ns = %ns, "SnapshotIndex ignore : rien a remplacer");
                return Ok(Value::Null);
            }
            conn.items.lock().unwrap().joined_index.remove(&key);
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            let replaced = repos::ops_replace(&mut c, crdt::INDEX, &index_id(&vault_id, &ns), &covered, bytes).await?;
            st.quota.invalidate(&vault_id);
            tracing::info!(vault = %vault_id, ns = %ns, replaced, "Index compacte");
            Ok(Value::Null)
        }
        "AcquireLock" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            // Prendre la main, c'est s'appreter a ecrire.
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            let candidate = LockHolder { user_id: caller.into(), display_name: caller_name(conn), conn: conn_id.into() };
            let holder = rt.locks.entry(format!("{vault_id}/{doc_id}")).or_insert(candidate).clone();
            let acquired = holder.conn == conn_id;
            if acquired {
                hub.send_group(&vault_id, Some(conn_id), &event("LockChanged", vec![json!(vault_id), json!(doc_id), json!(holder.user_id), json!(holder.display_name)]));
            }
            Ok(lock_dto(&holder, acquired))
        }
        "GetLock" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            Ok(match rt.locks.get(&format!("{vault_id}/{doc_id}")) {
                Some(h) => lock_dto(&h, h.conn == conn_id),
                None => Value::Null,
            })
        }
        "ReleaseLock" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            let removed = rt.locks.remove_if(&format!("{vault_id}/{doc_id}"), |_, h| h.conn == conn_id).is_some();
            if removed {
                hub.send_group(&vault_id, None, &event("LockChanged", vec![json!(vault_id), json!(doc_id), Value::Null, Value::Null]));
            }
            Ok(Value::Null)
        }
        "RequestLock" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Write).await?;
            if let Some(h) = rt.locks.get(&format!("{vault_id}/{doc_id}")).map(|h| h.clone()) {
                hub.send_to(&h.conn, &event("LockRequested", vec![json!(vault_id), json!(doc_id), json!(caller), json!(caller_name(conn))]));
            }
            Ok(Value::Null)
        }
        _ => Err(unknown(method)),
    }
}

fn index_id(vault_id: &str, ns: &str) -> String {
    format!("index:{vault_id}:{ns}")
}

fn lock_dto(h: &LockHolder, held: bool) -> Value {
    json!({ "holderUserId": h.user_id, "holderDisplayName": h.display_name, "isHeldByCaller": held })
}

// ── /hubs/sync ───────────────────────────────────────────────────────────────

/// L'auteur d'une modification, donne par le serveur (jamais par le client).
/// Un lien de partage ou un jeton de vue sans compte : « Invité ».
fn author_of(conn: &Conn, caller: &str) -> Value {
    if is_link_caller(caller) {
        let viewer = conn.principal.view_user_id.clone();
        return match viewer {
            Some(v) if !v.is_empty() && !v.starts_with("share:") => {
                json!({ "id": v, "name": conn.principal.display_name.clone().unwrap_or_else(|| "Invité".into()), "guest": false })
            }
            other => {
                let id = if is_share_link_caller(caller) { caller.to_string() } else { other.unwrap_or_else(|| caller.to_string()) };
                json!({ "id": id, "name": "Invité", "guest": true })
            }
        };
    }
    let name = conn.principal.display_name.clone().or_else(|| conn.principal.email.clone()).unwrap_or_else(|| caller.to_string());
    json!({ "id": caller, "name": name, "guest": false })
}

async fn sync_hub(st: &AppState, conn_id: &str, conn: &Arc<Conn>, caller: &str, method: &str, args: &[Value]) -> AppResult<Value> {
    let rt = &st.realtime;
    let hub = &rt.sync;
    let mut c = st.db.acquire().await?;
    match method {
        "JoinVault" => {
            let vault_id = arg_str(args, 0)?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            let group = format!("vault:{vault_id}");
            hub.add_to_group(conn_id, &group);
            rt.subscribe(Subscription { hub: HubKind::Sync, conn: conn_id.into(), caller: caller.into(), vault_id: vault_id.clone(), doc_id: None, group });
            hub.send_to(conn_id, &event("VaultJoined", vec![json!(vault_id)]));
            Ok(Value::Null)
        }
        "LeaveVault" => {
            let vault_id = arg_str(args, 0)?;
            let group = format!("vault:{vault_id}");
            rt.unsubscribe(conn_id, &group);
            hub.remove_from_group(conn_id, &group);
            Ok(Value::Null)
        }
        "JoinDocument" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            access::check_document(&mut c, caller, &vault_id, &doc_id, Level::Read).await?;
            let ops = repos::ops_all(&mut c, crdt::DOCUMENT, &doc_id).await?;
            let is_member = match repos::vault_get(&mut c, &vault_id).await? {
                Some(v) => v.is_owner(caller) || repos::member_get(&mut c, &vault_id, caller).await?.is_some(),
                None => false,
            };
            let group = format!("doc:{doc_id}");
            hub.add_to_group(conn_id, &group);
            rt.subscribe(Subscription { hub: HubKind::Sync, conn: conn_id.into(), caller: caller.into(), vault_id: vault_id.clone(), doc_id: Some(doc_id.clone()), group });
            conn.items.lock().unwrap().joined_docs.insert(doc_id.clone());
            // Hors membres (droit sur le document seul) : evenements du document.
            if !is_member {
                hub.add_to_group(conn_id, &format!("doc-events:{doc_id}"));
            }
            let ops: Vec<String> = ops.iter().map(|o| b64_out(&o.op_bytes)).collect();
            tracing::info!(connection = conn_id, doc = %doc_id, ops = ops.len(), member = is_member, "Client entre dans le document");
            hub.send_to(conn_id, &event("InitDocument", vec![json!(doc_id), json!(ops)]));
            Ok(Value::Null)
        }
        "LeaveDocument" => {
            let doc_id = arg_str(args, 1)?;
            conn.items.lock().unwrap().joined_docs.remove(&doc_id);
            let group = format!("doc:{doc_id}");
            rt.unsubscribe(conn_id, &group);
            hub.remove_from_group(conn_id, &group);
            Ok(Value::Null)
        }
        "PushOperation" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            let client_id = arg_str(args, 2)?;
            let op64 = arg_str(args, 3)?;
            let Some(bytes) = b64(&op64) else {
                tracing::warn!(connection = conn_id, "Op invalide (base64)");
                return Ok(Value::Null);
            };
            access::check_document(&mut c, caller, &vault_id, &doc_id, Level::Write).await?;
            ensure_room(st, &vault_id, bytes.len()).await?;
            let n = bytes.len();
            let op = Operation::create(crdt::DOCUMENT, &doc_id, &client_id, now(), bytes);
            repos::op_append(&mut c, &op).await?;
            st.quota.added(&vault_id, n as i64);
            hub.send_group(
                &format!("doc:{doc_id}"),
                Some(conn_id),
                &event("ReceiveOperation", vec![json!(doc_id), json!(client_id), json!(op64), author_of(conn, caller)]),
            );
            Ok(Value::Null)
        }
        "UpdateAwareness" => {
            let doc_id = arg_str(args, 1)?;
            let awareness = arg_str(args, 2)?;
            // Relaye seulement pour un document ou l'appelant est entre.
            if conn.items.lock().unwrap().joined_docs.contains(&doc_id) {
                hub.send_group(&format!("doc:{doc_id}"), Some(conn_id), &event("AwarenessUpdated", vec![json!(doc_id), json!(awareness)]));
            }
            Ok(Value::Null)
        }
        "SnapshotDocument" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            let Some(bytes) = b64(&arg_str(args, 2)?) else { return Ok(Value::Null) };
            access::check_document(&mut c, caller, &vault_id, &doc_id, Level::Write).await?;
            repos::ops_compact(&mut c, crdt::DOCUMENT, &doc_id, bytes, true).await?;
            st.quota.invalidate(&vault_id);
            tracing::info!(doc = %doc_id, connection = conn_id, "Document compacte");
            Ok(Value::Null)
        }
        "UpdatePresence" => {
            let doc_id = arg_str(args, 1)?;
            let cursor = args.get(2).cloned().unwrap_or(json!(0));
            if conn.items.lock().unwrap().joined_docs.contains(&doc_id) {
                hub.send_group(&format!("doc:{doc_id}"), Some(conn_id), &event("PresenceUpdated", vec![json!(doc_id), json!(caller), json!(caller), cursor]));
            }
            Ok(Value::Null)
        }
        _ => Err(unknown(method)),
    }
}

// ── /hubs/room ───────────────────────────────────────────────────────────────

async fn room_hub(st: &AppState, conn_id: &str, conn: &Arc<Conn>, caller: &str, method: &str, args: &[Value]) -> AppResult<Value> {
    let rt = &st.realtime;
    let hub = &rt.room;
    let mut c = st.db.acquire().await?;
    match method {
        "JoinRoom" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            access::check_document(&mut c, caller, &vault_id, &doc_id, Level::Read).await?;
            // Le journal d'une room ne garde qu'un snapshot compacte.
            let history = repos::ops_all(&mut c, crdt::ROOM, &doc_id).await?;
            let snapshot = history.last().map(|o| String::from_utf8_lossy(&o.op_bytes).into_owned());
            let group = format!("room:{doc_id}");
            hub.add_to_group(conn_id, &group);
            rt.subscribe(Subscription { hub: HubKind::Room, conn: conn_id.into(), caller: caller.into(), vault_id, doc_id: Some(doc_id.clone()), group });
            conn.items.lock().unwrap().joined_rooms.insert(doc_id.clone());
            hub.send_to(conn_id, &event("RoomJoined", vec![json!(doc_id), json!(snapshot)]));
            Ok(Value::Null)
        }
        "LeaveRoom" => {
            let doc_id = arg_str(args, 1)?;
            conn.items.lock().unwrap().joined_rooms.remove(&doc_id);
            let group = format!("room:{doc_id}");
            rt.unsubscribe(conn_id, &group);
            hub.remove_from_group(conn_id, &group);
            Ok(Value::Null)
        }
        "PushSnapshot" => {
            let vault_id = arg_str(args, 0)?;
            let doc_id = arg_str(args, 1)?;
            let snapshot = arg_str(args, 2)?;
            access::check_document(&mut c, caller, &vault_id, &doc_id, Level::Write).await?;
            // Remplace une donnee existante : verifiee, sans s'ajouter au compteur.
            ensure_room(st, &vault_id, snapshot.len()).await?;
            repos::ops_compact(&mut c, crdt::ROOM, &doc_id, snapshot.clone().into_bytes(), true).await?;
            hub.send_group(&format!("room:{doc_id}"), Some(conn_id), &event("SnapshotReceived", vec![json!(doc_id), json!(caller), json!(snapshot)]));
            Ok(Value::Null)
        }
        "UpdatePresence" => {
            let doc_id = arg_str(args, 1)?;
            let presence = arg_str(args, 2)?;
            if conn.items.lock().unwrap().joined_rooms.contains(&doc_id) {
                hub.send_group(&format!("room:{doc_id}"), Some(conn_id), &event("PresenceUpdated", vec![json!(doc_id), json!(caller), json!(presence)]));
            }
            Ok(Value::Null)
        }
        _ => Err(unknown(method)),
    }
}

// ── /hubs/edgesync ───────────────────────────────────────────────────────────
//
// Relais aveugle du protocole EdgeSync : presentation des pairs presents dans
// la room d'un vault, et transfert adresse de trames OPAQUES (chiffrees et
// signees de bout en bout). Seuls les membres du vault entrent dans sa room.

async fn edge_hub(st: &AppState, conn_id: &str, caller: &str, method: &str, args: &[Value]) -> AppResult<Value> {
    let rt = &st.realtime;
    let rooms = &rt.edge_rooms;
    match method {
        "Join" => {
            let vault_id = arg_str(args, 0)?;
            let mut c = st.db.acquire().await?;
            access::check_vault(&mut c, caller, &vault_id, Level::Read).await?;
            let existing: Vec<String> = {
                let mut room = rooms.rooms.entry(vault_id.clone()).or_default();
                let existing = room.iter().filter(|id| *id != conn_id).cloned().collect();
                room.insert(conn_id.to_string());
                existing
            };
            rooms.vaults_by_conn.entry(conn_id.to_string()).or_default().insert(vault_id.clone());
            let group = format!("edge:{vault_id}");
            rt.edge.add_to_group(conn_id, &group);
            rt.subscribe(Subscription { hub: HubKind::EdgeSync, conn: conn_id.into(), caller: caller.into(), vault_id: vault_id.clone(), doc_id: None, group: group.clone() });
            rt.edge.send_group(&group, Some(conn_id), &event("PeerUp", vec![json!(vault_id), json!(conn_id)]));
            Ok(json!(existing))
        }
        "ClaimOwner" => {
            let vault_id = arg_str(args, 0)?;
            let inside = rooms.rooms.get(&vault_id).is_some_and(|r| r.contains(conn_id));
            if !inside {
                return Ok(json!(false));
            }
            let mut claimed = false;
            rooms.owners.entry(vault_id).or_insert_with(|| {
                claimed = true;
                conn_id.to_string()
            });
            Ok(json!(claimed))
        }
        "Relay" => {
            let vault_id = arg_str(args, 0)?;
            let to = arg_str(args, 1)?;
            let frame = arg_str(args, 2)?;
            if frame.len() > MAX_FRAME_BASE64 {
                return Ok(Value::Null);
            }
            // Les deux bouts doivent etre dans la room : pas de sondage d'un vault a l'autre.
            let ok = rooms.rooms.get(&vault_id).is_some_and(|r| r.contains(conn_id) && r.contains(&to));
            if ok {
                rt.edge.send_to(&to, &event("Frame", vec![json!(vault_id), json!(conn_id), json!(frame)]));
            }
            Ok(Value::Null)
        }
        _ => Err(unknown(method)),
    }
}

/// Fin d'une connexion : verrous rendus, rooms quittees.
pub async fn disconnected(st: &AppState, kind: HubKind, conn_id: &str) {
    let rt = &st.realtime;
    match kind {
        HubKind::Vault => {
            // Sans cela, fermer un onglet laisserait le document verrouille pour tout le monde.
            let freed: Vec<String> = rt.locks.iter().filter(|e| e.value().conn == conn_id).map(|e| e.key().clone()).collect();
            for key in freed {
                if rt.locks.remove_if(&key, |_, h| h.conn == conn_id).is_none() {
                    continue;
                }
                if let Some((vault_id, doc_id)) = key.split_once('/') {
                    rt.vault.send_group(vault_id, None, &event("LockChanged", vec![json!(vault_id), json!(doc_id), Value::Null, Value::Null]));
                }
            }
        }
        HubKind::EdgeSync => {
            let rooms = &rt.edge_rooms;
            if let Some((_, vaults)) = rooms.vaults_by_conn.remove(conn_id) {
                for vault_id in vaults {
                    let empty = match rooms.rooms.get_mut(&vault_id) {
                        Some(mut r) => {
                            r.remove(conn_id);
                            r.is_empty()
                        }
                        None => false,
                    };
                    if empty {
                        rooms.rooms.remove_if(&vault_id, |_, r| r.is_empty());
                    }
                    // La revendication part avec la connexion qui l'a faite.
                    rooms.owners.remove_if(&vault_id, |_, owner| owner == conn_id);
                    rt.edge.send_group(&format!("edge:{vault_id}"), Some(conn_id), &event("PeerDown", vec![json!(vault_id), json!(conn_id)]));
                }
            }
        }
        _ => {}
    }
    tracing::info!(hub = ?kind, connection = conn_id, "Client deconnecte");
}
