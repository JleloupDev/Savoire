// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pont de test : l'index d'un vault (src/index_db.rs) en lignes JSON sur
// l'entree et la sortie standard, sans fenetre ni Tauri. Les tests du
// pilote TypeScript (tests/frontend/unit/desktop-tests) s'en servent pour
// passer le contrat des moteurs sur le SQLite natif.
//
//   cargo build --example index_stdio
//   target/debug/examples/index_stdio [fichier | :memory:]
//
// Une requete par ligne : { "op": "exec", "sql" }, { "op": "all", "sql",
// "params" }, { "op": "batch", "statements" }. Une reponse par ligne :
// { "ok": true, "value" } ou { "ok": false, "error" }.

use savoire_desktop_lib::index_db::{IndexDb, Statement};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Exec { sql: String },
    All {
        sql: String,
        #[serde(default)]
        params: Vec<Value>,
    },
    Batch { statements: Vec<Statement> },
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ":memory:".into());
    let db = IndexDb::open(Path::new(&path)).expect("index illisible");
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Request>(&line) {
            Err(e) => Err(e.to_string()),
            Ok(Request::Exec { sql }) => db.exec(&sql).map(|_| Value::Null),
            Ok(Request::All { sql, params }) => db.all(&sql, &params).map(|r| json!(r)),
            Ok(Request::Batch { statements }) => db.batch(&statements).map(|_| Value::Null),
        };
        let reply = match answer {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
