// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Temps reel : quatre hubs sur WebSocket, qui remplacent les hubs SignalR du
// serveur .NET (memes methodes, memes evenements, memes groupes) :
//   /hubs/vault     repertoire CRDT du vault, registre des documents, index
//                   partages, verrous d'edition ;
//   /hubs/sync      documents CRDT (notes) ;
//   /hubs/room      documents « snapshot » (dessins, tableaux...) ;
//   /hubs/edgesync  relais aveugle du protocole pair a pair.
//
// Protocole (trames texte JSON, voir docs/Architecture/realtime-protocol.md) :
//   client -> serveur  { "t": "invoke", "id": "1", "m": "JoinVault", "a": [...] }
//                      ("id" absent : pas de reponse attendue)
//                      { "t": "ping" }
//   serveur -> client  { "t": "hello", "connectionId": "..." }  (a l'ouverture)
//                      { "t": "result", "id": "1", "r": ... }
//                      { "t": "error", "id": "1", "e": "message" }
//                      { "t": "event", "m": "InitVault", "a": [...] }
//                      { "t": "pong" }
//
// Un refus attendu porte un code stable, comme le faisait HubErrorFilter :
// « ... HubException: vault-not-found » (document-not-in-vault, access-denied,
// quota-exceeded, rate-limited).

pub mod hubs;
pub mod presence;
pub mod socket;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::access::{self, Level};
use crate::auth::Principal;
use crate::db::users;
use crate::domain::is_link_caller;
use crate::services::rate_limit::RateLimiter;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HubKind {
    Vault,
    Sync,
    Room,
    EdgeSync,
}

impl HubKind {
    pub fn parse(name: &str) -> Option<HubKind> {
        match name {
            "vault" => Some(HubKind::Vault),
            "sync" => Some(HubKind::Sync),
            "room" => Some(HubKind::Room),
            "edgesync" => Some(HubKind::EdgeSync),
            _ => None,
        }
    }
}

/// Etat d'une connexion (Context.Items cote SignalR).
#[derive(Default)]
pub struct ConnItems {
    pub joined_docs: HashSet<String>,
    pub joined_rooms: HashSet<String>,
    /// Ops d'index rendues a CETTE connexion : SnapshotIndex ne remplacera qu'elles.
    pub joined_index: HashMap<String, Vec<String>>,
}

pub struct Conn {
    pub tx: mpsc::UnboundedSender<String>,
    pub principal: Principal,
    pub items: Mutex<ConnItems>,
}

/// Les connexions et groupes d'un hub.
#[derive(Default)]
pub struct Hub {
    pub conns: DashMap<String, std::sync::Arc<Conn>>,
    groups: DashMap<String, HashSet<String>>,
}

pub fn event(method: &str, args: Vec<Value>) -> String {
    json!({ "t": "event", "m": method, "a": args }).to_string()
}

impl Hub {
    pub fn add_to_group(&self, conn: &str, group: &str) {
        self.groups.entry(group.to_string()).or_default().insert(conn.to_string());
    }

    pub fn remove_from_group(&self, conn: &str, group: &str) {
        let empty = match self.groups.get_mut(group) {
            Some(mut g) => {
                g.remove(conn);
                g.is_empty()
            }
            None => false,
        };
        if empty {
            self.groups.remove_if(group, |_, g| g.is_empty());
        }
    }

    fn remove_everywhere(&self, conn: &str) {
        self.groups.retain(|_, g| {
            g.remove(conn);
            !g.is_empty()
        });
    }

    fn members(&self, group: &str) -> Vec<String> {
        self.groups.get(group).map(|g| g.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn send_to(&self, conn: &str, msg: &str) {
        if let Some(c) = self.conns.get(conn) {
            let _ = c.tx.send(msg.to_string());
        }
    }

    /// Diffuse au groupe, sauf `except` (OthersInGroup).
    pub fn send_group(&self, group: &str, except: Option<&str>, msg: &str) {
        for id in self.members(group) {
            if Some(id.as_str()) != except {
                self.send_to(&id, msg);
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub hub: HubKind,
    pub conn: String,
    pub caller: String,
    pub vault_id: String,
    pub doc_id: Option<String>,
    pub group: String,
}

#[derive(Clone, Debug)]
pub struct LockHolder {
    pub user_id: String,
    pub display_name: String,
    pub conn: String,
}

/// Rooms du relais EdgeSync (en memoire, non persistees).
#[derive(Default)]
pub struct EdgeRooms {
    pub rooms: DashMap<String, HashSet<String>>,
    pub vaults_by_conn: DashMap<String, HashSet<String>>,
    pub owners: DashMap<String, String>,
}

pub struct Realtime {
    pub vault: Hub,
    pub sync: Hub,
    pub room: Hub,
    pub edge: Hub,
    /// Abonnements, par connexion puis par groupe (revue du 14/11/2026, M7).
    subs: DashMap<String, HashMap<String, Subscription>>,
    /// Verrous d'edition, cle « {vaultId}/{docId} ». Ne survivent pas au redemarrage : c'est voulu.
    pub locks: DashMap<String, LockHolder>,
    pub edge_rooms: EdgeRooms,
    pub limiter: RateLimiter,
    /// Agents IA presents dans une note, le temps d'un appel (presence.rs).
    pub agent_presence: presence::AgentPresences,
}

impl Default for Realtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Realtime {
    pub fn new() -> Self {
        Realtime {
            vault: Hub::default(),
            sync: Hub::default(),
            room: Hub::default(),
            edge: Hub::default(),
            subs: DashMap::new(),
            locks: DashMap::new(),
            edge_rooms: EdgeRooms::default(),
            limiter: RateLimiter::new(),
            agent_presence: presence::AgentPresences::default(),
        }
    }

    pub fn hub(&self, kind: HubKind) -> &Hub {
        match kind {
            HubKind::Vault => &self.vault,
            HubKind::Sync => &self.sync,
            HubKind::Room => &self.room,
            HubKind::EdgeSync => &self.edge,
        }
    }

    pub fn subscribe(&self, s: Subscription) {
        self.subs.entry(s.conn.clone()).or_default().insert(s.group.clone(), s);
    }

    pub fn unsubscribe(&self, conn: &str, group: &str) {
        if let Some(mut m) = self.subs.get_mut(conn) {
            m.remove(group);
        }
    }

    pub fn forget(&self, kind: HubKind, conn: &str) {
        self.subs.remove(conn);
        self.hub(kind).remove_everywhere(conn);
        self.hub(kind).conns.remove(conn);
    }

    fn all_subs(&self) -> Vec<Subscription> {
        self.subs.iter().flat_map(|e| e.value().values().cloned().collect::<Vec<_>>()).collect()
    }

    // ── Notifications (ex-handlers MediatR) ──────────────────────────────────

    /// Les membres d'un vault ont change (droit donne ou retire, membre ajoute
    /// ou retire, vault supprime, droits d'un dossier...).
    pub async fn vault_membership_changed(&self, st: &AppState, vault_id: &str) {
        self.edge.send_group(&format!("edge:{vault_id}"), None, &event("MembershipChanged", vec![json!(vault_id)]));
        self.vault.send_group(vault_id, None, &event("VaultAccessChanged", vec![json!(vault_id)]));
        let subs: Vec<_> = self.all_subs().into_iter().filter(|s| s.vault_id == vault_id).collect();
        self.recheck(st, subs).await;
    }

    /// Un droit sur un document est retire.
    pub async fn access_revoked(&self, st: &AppState, doc_id: &str, user_id: &str) {
        self.sync.send_group(&format!("doc-events:{doc_id}"), None, &event("AccessRevoked", vec![json!(doc_id), json!(user_id)]));
        let subs: Vec<_> = self.all_subs().into_iter().filter(|s| s.doc_id.as_deref() == Some(doc_id)).collect();
        self.recheck(st, subs).await;
    }

    /// Un compte est bloque ou supprime, ou un lien revoque (« share:{id} »).
    pub async fn caller_access_changed(&self, st: &AppState, caller: &str) {
        let subs: Vec<_> = self.all_subs().into_iter().filter(|s| s.caller == caller).collect();
        self.recheck(st, subs).await;
    }

    /// Les abonnements sans droit sont sortis de leur groupe ; la connexion est prevenue.
    async fn recheck(&self, st: &AppState, subs: Vec<Subscription>) {
        if subs.is_empty() {
            return;
        }
        let mut verdicts: HashMap<(String, String, Option<String>), bool> = HashMap::new();
        for s in subs {
            let key = (s.caller.clone(), s.vault_id.clone(), s.doc_id.clone());
            let allowed = match verdicts.get(&key) {
                Some(v) => *v,
                None => {
                    let v = allowed(st, &s).await;
                    verdicts.insert(key, v);
                    v
                }
            };
            if allowed {
                continue;
            }
            self.unsubscribe(&s.conn, &s.group);
            let hub = self.hub(s.hub);
            hub.remove_from_group(&s.conn, &s.group);
            let target = s.doc_id.clone().unwrap_or_else(|| s.vault_id.clone());
            hub.send_to(&s.conn, &event("AccessRevoked", vec![json!(target), json!(s.caller)]));
            tracing::info!(hub = ?s.hub, group = %s.group, "Abonnement retire (droit perdu)");
        }
    }
}

async fn allowed(st: &AppState, s: &Subscription) -> bool {
    let Ok(mut c) = st.db.acquire().await else { return true };
    // Un compte bloque ou supprime n'a plus rien.
    if !is_link_caller(&s.caller) {
        match users::by_id(&mut c, &s.caller).await {
            Ok(Some(u)) if !users::is_locked(&u) => {}
            Ok(_) => return false,
            Err(_) => return true,
        }
    }
    let r = match &s.doc_id {
        None => access::check_vault(&mut c, &s.caller, &s.vault_id, Level::Read).await,
        Some(d) => access::check_document(&mut c, &s.caller, &s.vault_id, d, Level::Read).await,
    };
    match r {
        Ok(()) => true,
        Err(e) => hub_code(&e).is_none(),
    }
}

/// Code stable d'un refus attendu ; None pour une autre erreur.
pub fn hub_code(e: &crate::error::AppError) -> Option<&'static str> {
    use crate::error::AppError::*;
    match e {
        DocumentNotInVault(_) => Some("document-not-in-vault"),
        VaultNotFound(_) => Some("vault-not-found"),
        AccessDenied(_) | Unauthorized(_) => Some("access-denied"),
        QuotaExceeded(_) | StorageUnavailable => Some("quota-exceeded"),
        TooManyRequests => Some("rate-limited"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_and_others() {
        let hub = Hub::default();
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        for (id, tx) in [("a", tx1), ("b", tx2)] {
            hub.conns.insert(id.into(), std::sync::Arc::new(Conn { tx, principal: Principal::default(), items: Mutex::new(ConnItems::default()) }));
            hub.add_to_group(id, "g");
        }
        hub.send_group("g", Some("a"), "hello");
        assert!(rx1.try_recv().is_err());
        assert_eq!(rx2.try_recv().unwrap(), "hello");
        hub.remove_from_group("b", "g");
        hub.send_group("g", None, "x");
        assert_eq!(rx1.try_recv().unwrap(), "x");
        assert!(rx2.try_recv().is_err());
        hub.remove_everywhere("a");
        assert!(hub.members("g").is_empty());
    }

    #[test]
    fn codes() {
        use crate::error::AppError;
        assert_eq!(hub_code(&AppError::DocumentNotInVault("v".into())), Some("document-not-in-vault"));
        assert_eq!(hub_code(&AppError::VaultNotFound("v".into())), Some("vault-not-found"));
        assert_eq!(hub_code(&AppError::StorageUnavailable), Some("quota-exceeded"));
        assert_eq!(hub_code(&AppError::internal("x")), None);
    }
}
