// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Recherche globale : fusion des pages rendues par plusieurs instances du
// pair indexeur, et curseur compose pour la page suivante.
//
// Chaque instance rend ses resultats tries par score. La fusion prend le
// meilleur score en tete des pages (a egalite : vaultId puis id). Elle
// s'arrete quand une instance a epuise sa page mais en a d'autres : on ne
// peut pas classer ce qu'on n'a pas vu. La page rendue peut donc etre plus
// courte que « limit » ; « next » dit qu'il y a une suite.
//
// Le curseur compose garde, par instance encore active, le curseur de la page
// en cours et le nombre de resultats deja rendus de cette page. Il est opaque
// pour le client (base64url d'un JSON).

use std::collections::BTreeMap;

use base64::Engine;
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub cursor: Option<String>,
    pub skip: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cursor {
    pub parts: BTreeMap<String, Part>,
    pub partial: bool,
}

impl Cursor {
    pub fn start<'a>(instances: impl Iterator<Item = &'a String>) -> Self {
        Cursor { parts: instances.map(|n| (n.clone(), Part { cursor: None, skip: 0 })).collect(), partial: false }
    }

    pub fn encode(&self) -> String {
        let mut parts = Map::new();
        for (name, p) in &self.parts {
            parts.insert(name.clone(), json!({ "c": p.cursor, "s": p.skip }));
        }
        let root = json!({ "v": 1, "p": parts, "x": self.partial });
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(root.to_string())
    }

    pub fn decode(cursor: &str) -> Option<Cursor> {
        let b64 = cursor.replace('-', "+").replace('_', "/");
        let pad = (4 - b64.len() % 4) % 4;
        let bytes = base64::engine::general_purpose::STANDARD.decode(format!("{b64}{}", "=".repeat(pad))).ok()?;
        let root: Value = serde_json::from_slice(&bytes).ok()?;
        if root.get("v")?.as_i64()? != 1 {
            return None;
        }
        let mut parts = BTreeMap::new();
        for (name, node) in root.get("p")?.as_object()? {
            let part = node.as_object()?;
            let c = match part.get("c") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Null) | None => None,
                _ => return None,
            };
            let s = match part.get("s") {
                Some(v) => v.as_i64()?,
                None => 0,
            };
            if s < 0 {
                return None;
            }
            parts.insert(name.clone(), Part { cursor: c, skip: s as usize });
        }
        let partial = match root.get("x") {
            Some(v) => v.as_bool()?,
            None => false,
        };
        Some(Cursor { parts, partial })
    }
}

/// La page rendue par une instance.
pub struct InstancePage {
    pub instance: String,
    pub part: Part,
    pub hits: Vec<Map<String, Value>>,
    pub next: Option<String>,
}

fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn text<'a>(hit: &'a Map<String, Value>, name: &str) -> &'a str {
    hit.get(name).and_then(Value::as_str).unwrap_or("")
}

/// Ordre de la fusion : score decroissant, puis vaultId, puis id.
fn compare(a: &Map<String, Value>, b: &Map<String, Value>) -> std::cmp::Ordering {
    let sa = number(a.get("score")).unwrap_or(0.0);
    let sb = number(b.get("score")).unwrap_or(0.0);
    sb.partial_cmp(&sa)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| text(a, "vaultId").cmp(text(b, "vaultId")))
        .then_with(|| text(a, "id").cmp(text(b, "id")))
}

/// Fusionne les pages : les resultats (au plus `limit`) et l'etat de chaque
/// instance encore active apres cette page.
pub fn merge(pages: &[InstancePage], limit: usize) -> (Vec<Map<String, Value>>, BTreeMap<String, Part>) {
    let mut pos: Vec<usize> = pages.iter().map(|p| p.part.skip.min(p.hits.len())).collect();
    let mut hits = vec![];
    while hits.len() < limit {
        let blocked = pages.iter().enumerate().any(|(i, p)| pos[i] >= p.hits.len() && p.next.is_some());
        if blocked {
            break;
        }
        let mut best: Option<usize> = None;
        for (i, p) in pages.iter().enumerate() {
            if pos[i] >= p.hits.len() {
                continue;
            }
            best = match best {
                None => Some(i),
                Some(b) if compare(&p.hits[pos[i]], &pages[b].hits[pos[b]]).is_lt() => Some(i),
                keep => keep,
            };
        }
        let Some(b) = best else { break };
        hits.push(pages[b].hits[pos[b]].clone());
        pos[b] += 1;
    }
    let mut remaining = BTreeMap::new();
    for (i, p) in pages.iter().enumerate() {
        if pos[i] < p.hits.len() {
            remaining.insert(p.instance.clone(), Part { cursor: p.part.cursor.clone(), skip: pos[i] });
        } else if let Some(next) = &p.next {
            remaining.insert(p.instance.clone(), Part { cursor: Some(next.clone()), skip: 0 });
        }
    }
    (hits, remaining)
}

const STATUS_RANK: [&str; 4] = ["ready", "lagging", "building", "unavailable"];

/// Etat d'index le moins avance parmi ceux qui ont repondu.
pub fn worst_index(states: &[Option<Map<String, Value>>]) -> Value {
    let mut rank = 0usize;
    let mut progress: Option<f64> = None;
    let mut lag: Option<i64> = None;
    for s in states.iter().flatten() {
        let status = s.get("status").and_then(Value::as_str).unwrap_or("ready");
        rank = rank.max(STATUS_RANK.iter().position(|x| *x == status).unwrap_or(0));
        if let Some(p) = number(s.get("progress")) {
            progress = Some(progress.map_or(p, |q| q.min(p)));
        }
        if let Some(l) = number(s.get("lagMs")) {
            lag = Some(lag.unwrap_or(0).max(l as i64));
        }
    }
    let mut index = json!({ "status": STATUS_RANK[rank] });
    if let Some(p) = progress {
        index["progress"] = json!(p);
    }
    if let Some(l) = lag {
        index["lagMs"] = json!(l);
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(id: &str, vault: &str, score: f64) -> Map<String, Value> {
        json!({ "id": id, "vaultId": vault, "score": score }).as_object().unwrap().clone()
    }

    fn page(name: &str, hits: Vec<Map<String, Value>>, next: Option<&str>) -> InstancePage {
        InstancePage { instance: name.into(), part: Part { cursor: None, skip: 0 }, hits, next: next.map(str::to_string) }
    }

    #[test]
    fn merges_by_score_then_ids() {
        let pages = vec![
            page("a", vec![hit("1", "v1", 0.9), hit("2", "v1", 0.5)], None),
            page("b", vec![hit("3", "v2", 0.9), hit("4", "v2", 0.7)], None),
        ];
        let (hits, rest) = merge(&pages, 10);
        let ids: Vec<&str> = hits.iter().map(|h| text(h, "id")).collect();
        assert_eq!(ids, vec!["1", "3", "4", "2"]);
        assert!(rest.is_empty());
    }

    #[test]
    fn stops_when_an_instance_has_more_pages() {
        let pages = vec![page("a", vec![hit("1", "v1", 0.9)], Some("next-a")), page("b", vec![hit("3", "v2", 0.5)], None)];
        let (hits, rest) = merge(&pages, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(rest["a"], Part { cursor: Some("next-a".into()), skip: 0 });
        assert_eq!(rest["b"], Part { cursor: None, skip: 0 });
    }

    #[test]
    fn limit_keeps_position() {
        let pages = vec![page("a", vec![hit("1", "v", 0.9), hit("2", "v", 0.8)], None)];
        let (hits, rest) = merge(&pages, 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(rest["a"].skip, 1);
    }

    #[test]
    fn cursor_round_trip() {
        let mut parts = BTreeMap::new();
        parts.insert("a".to_string(), Part { cursor: Some("x".into()), skip: 3 });
        parts.insert("b".to_string(), Part { cursor: None, skip: 0 });
        let c = Cursor { parts, partial: true };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        assert_eq!(Cursor::decode("not base64!"), None);
        let bad = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"v":2,"p":{}}"#);
        assert_eq!(Cursor::decode(&bad), None);
    }

    #[test]
    fn worst_index_state() {
        let s = |v: Value| Some(v.as_object().unwrap().clone());
        let w = worst_index(&[s(json!({"status":"ready","progress":1.0})), s(json!({"status":"building","progress":0.4,"lagMs":30})), None]);
        assert_eq!(w, json!({"status":"building","progress":0.4,"lagMs":30}));
        assert_eq!(worst_index(&[]), json!({"status":"ready"}));
    }
}
