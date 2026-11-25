// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Presence d'un agent IA dans une note (ADR-033) : pendant qu'une IA externe
// lit ou ecrit par le pair, les personnes qui ont la note ouverte voient un
// pair de plus, avec son curseur, au nom de l'agent.
//
// Le serveur fabrique lui-meme la mise a jour d'« awareness » de Yjs (celle
// que les editeurs s'echangent deja, relayee par AwarenessUpdated) : le nom
// vient du ticket, jamais du pair. Il la retire tout seul, peu apres la fin
// de l'appel, ou apres un silence : personne ne reste « observe » par une IA
// qui ne fait rien.
//
// Format d'une mise a jour (y-protocols/awareness) :
//   varUint(nombre d'etats) puis, par etat :
//   varUint(clientID) varUint(horloge) varString(JSON de l'etat, « null » : parti)

use std::time::Duration;

use base64::Engine;
use dashmap::DashMap;
use serde_json::{Value, json};

use super::event;
use crate::state::AppState;

/// La presence reste un instant apres la fin de l'appel : le temps de la voir.
pub const LINGER: Duration = Duration::from_millis(2500);
/// Sans nouvelle de l'appel (pair en panne, outil tres long) : elle part.
pub const SILENCE: Duration = Duration::from_secs(10);

/// Couleur d'un agent quand le pair n'en donne pas de valide.
const DEFAULT_COLOR: &str = "#7c3aed";

struct Entry {
    /// Horloge du dernier etat diffuse : sert aussi a reconnaitre une echeance perimee.
    clock: u64,
    ticket: String,
}

/// Les agents presents, par (document, clientID).
#[derive(Default)]
pub struct AgentPresences {
    entries: DashMap<(String, u32), Entry>,
}

/// Ce que l'agent fait dans la note.
pub struct Activity<'a> {
    pub doc_id: &'a str,
    pub ticket: &'a str,
    pub agent_id: &'a str,
    pub agent_name: &'a str,
    /// La personne pour qui il agit.
    pub user_id: &'a str,
    pub on_behalf_of: &'a str,
    /// « reading », « writing » ; tout autre mot : il a fini (« idle »).
    pub state: &'a str,
    pub color: Option<&'a str>,
    /// Passage lu, ou curseur : positions relatives de Yjs { anchor, head }.
    pub range: Option<&'a Value>,
}

fn var_uint(out: &mut Vec<u8>, mut n: u64) {
    while n > 0x7f {
        out.push(0x80 | (n & 0x7f) as u8);
        n >>= 7;
    }
    out.push(n as u8);
}

/// Une mise a jour d'awareness pour un seul client ; `state` absent : il est parti.
pub fn encode_awareness(client: u32, clock: u64, state: Option<&Value>) -> Vec<u8> {
    let text = state.map(Value::to_string).unwrap_or_else(|| "null".into());
    let mut out = Vec::with_capacity(text.len() + 16);
    var_uint(&mut out, 1);
    var_uint(&mut out, client as u64);
    var_uint(&mut out, clock);
    var_uint(&mut out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
    out
}

/// Le clientID de l'agent dans la note : stable pour un agent et une personne
/// (un seul curseur d'un appel a l'autre), jamais 0.
pub fn client_id(agent_id: &str, user_id: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in agent_id.bytes().chain([0u8]).chain(user_id.bytes()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h.max(1)
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// L'etat d'awareness de l'agent, tel que les editeurs le dessinent.
pub fn awareness_state(a: &Activity) -> Value {
    let color = a.color.filter(|c| valid_color(c)).unwrap_or(DEFAULT_COLOR);
    let mut state = json!({
        "user": { "name": a.agent_name, "color": color, "colorLight": format!("{color}33") },
        "agent": { "id": a.agent_id, "for": a.on_behalf_of },
        "agentState": a.state,
    });
    let range = a.range.filter(|r| r.get("anchor").is_some_and(Value::is_object) && r.get("head").is_some_and(Value::is_object));
    if let Some(r) = range {
        // Ecrire : le curseur, dessine comme celui d'une personne. Lire : un passage, marque legerement.
        let key = if a.state == "writing" { "cursor" } else { "reading" };
        state[key] = json!({ "anchor": r["anchor"], "head": r["head"] });
    }
    state
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn broadcast(st: &AppState, doc_id: &str, bytes: &[u8]) {
    let update = base64::engine::general_purpose::STANDARD.encode(bytes);
    st.realtime.sync.send_group(&format!("doc:{doc_id}"), None, &event("AwarenessUpdated", vec![json!(doc_id), json!(update)]));
}

impl AgentPresences {
    /// Diffuse ce que fait l'agent aux personnes qui ont la note ouverte.
    pub fn signal(&self, st: &AppState, a: &Activity) {
        let client = client_id(a.agent_id, a.user_id);
        let key = (a.doc_id.to_string(), client);
        if a.state != "reading" && a.state != "writing" {
            // Fini : l'etat affiche reste un instant, puis part.
            if let Some(e) = self.entries.get(&key) {
                self.expire_later(st, key.clone(), e.clock, LINGER);
            }
            return;
        }
        // Horloge croissante, meme apres un redemarrage du serveur : les
        // editeurs ignorent une horloge qui recule.
        let clock = {
            let mut e = self.entries.entry(key.clone()).or_insert(Entry { clock: 0, ticket: String::new() });
            e.clock = now_ms().max(e.clock + 1);
            e.ticket = a.ticket.to_string();
            e.clock
        };
        broadcast(st, a.doc_id, &encode_awareness(client, clock, Some(&awareness_state(a))));
        self.expire_later(st, key, clock, SILENCE);
    }

    /// L'appel est fini : ses presences partent dans un instant.
    pub fn end_call(&self, st: &AppState, ticket: &str) {
        let ending: Vec<((String, u32), u64)> = self.entries.iter().filter(|e| e.value().ticket == ticket).map(|e| (e.key().clone(), e.value().clock)).collect();
        for (key, clock) in ending {
            self.expire_later(st, key, clock, LINGER);
        }
    }

    fn expire_later(&self, st: &AppState, key: (String, u32), clock: u64, after: Duration) {
        let st = st.clone();
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            // Un etat plus recent a ete diffuse entre-temps : cette echeance ne vaut plus.
            if st.realtime.agent_presence.entries.remove_if(&key, |_, e| e.clock == clock).is_some() {
                broadcast(&st, &key.0, &encode_awareness(key.1, clock + 1, None));
            }
        });
    }

    /// Nombre de presences en cours (tests).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn awareness_bytes() {
        // Meme octets que encodeAwarenessUpdate de y-protocols.
        assert_eq!(encode_awareness(1, 2, Some(&json!({ "a": 1 }))), [&[1u8, 1, 2, 7][..], b"{\"a\":1}"].concat());
        assert_eq!(encode_awareness(300, 1, None), [&[1u8, 0xac, 0x02, 1, 4][..], b"null"].concat());
        // Horloge en millisecondes : 6 octets de 7 bits.
        let big = encode_awareness(1, 1_795_000_000_000, None);
        assert_eq!(&big[2..8], &[0x80, 0xbc, 0xd9, 0xf2, 0x9e, 0x34]);
    }

    #[test]
    fn client_ids() {
        assert_eq!(client_id("a1", "u1"), client_id("a1", "u1"));
        assert_ne!(client_id("a1", "u1"), client_id("a1", "u2"));
        assert_ne!(client_id("a1", "u1"), client_id("a2", "u1"));
        assert_ne!(client_id("ab", "c"), client_id("a", "bc"));
    }

    #[test]
    fn state_shape() {
        let range = json!({ "anchor": { "tname": "codemirror", "assoc": 0 }, "head": { "tname": "codemirror", "assoc": -1 } });
        let mut a = Activity { doc_id: "d", ticket: "t", agent_id: "a1", agent_name: "Archiviste", user_id: "u1", on_behalf_of: "Jean", state: "writing", color: Some("#0a7"), range: Some(&range) };
        let s = awareness_state(&a);
        assert_eq!(s["user"], json!({ "name": "Archiviste", "color": DEFAULT_COLOR, "colorLight": format!("{DEFAULT_COLOR}33") }));
        assert_eq!(s["agentState"], "writing");
        assert_eq!(s["cursor"], range);
        assert!(s.get("reading").is_none());
        a.state = "reading";
        a.color = Some("#00aa77");
        let s = awareness_state(&a);
        assert_eq!(s["user"]["color"], "#00aa77");
        assert_eq!(s["reading"], range);
        assert!(s.get("cursor").is_none());
        // Un passage mal forme est ignore : l'etat reste visible, sans position.
        let bad = json!({ "anchor": 3 });
        a.range = Some(&bad);
        assert!(awareness_state(&a).get("reading").is_none());
    }
}
