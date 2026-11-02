// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index SQLite d'un vault (ADR-027) : la contrepartie Rust du pilote
// TauriSqlDriver (@savoire/indexer-core/tauri).
//
// L'index est DERIVE des notes : jamais synchronise, toujours
// reconstructible. Il vit dans `<vault>/.savoire/index.sqlite` (mode WAL).
// Le noyau d'indexation (TypeScript, dans la page) ecrit lui-meme son SQL,
// toujours parametre ; ces commandes l'executent :
//  - index_exec : un script sans parametre ;
//  - index_all : les lignes d'une requete (noms des colonnes, puis valeurs) ;
//  - index_batch : plusieurs instructions dans UNE transaction, tout ou rien ;
//  - index_close : ferme la base du vault.
//
// Securite : seule une racine autorisee a un index (meme garde que les
// commandes de fichiers : vaults.rs, paths.rs) et le fichier est fixe. Le SQL
// vient de la page : ATTACH est refuse (et VACUUM INTO, qui passe par lui),
// pour qu'il ne puisse ni lire ni ecrire un autre fichier que l'index. Les
// extensions ne se chargent pas (desactivees par defaut dans SQLite).
//
// Les commandes tournent hors du fil principal (spawn_blocking) : une
// construction ne fige pas la fenetre. Une connexion par vault, gardee
// ouverte, derriere un verrou : un seul ecrivain.
//
// Valeurs : JSON <-> SQLite. Un nombre entier devient INTEGER, un autre REAL
// (comme SQLite WebAssembly) ; un booleen 0 / 1 ; un BLOB passe en
// hexadecimal, `{ "$hex": "..." }`.

use crate::paths::{self, INDEX_PATH};
use crate::vaults::VaultRegistry;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{ffi, params_from_iter, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Cle d'un BLOB dans le JSON.
const HEX_KEY: &str = "$hex";
/// Instructions preparees gardees en cache par connexion.
const STATEMENT_CACHE: usize = 500;

#[derive(Deserialize, Debug)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Lignes d'une requete : les noms des colonnes une fois, puis les valeurs.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// Refuse ATTACH et DETACH : le SQL de la page ne sort pas du fichier d'index.
unsafe extern "C" fn authorize(
    _data: *mut c_void,
    action: c_int,
    _a: *const c_char,
    _b: *const c_char,
    _c: *const c_char,
    _d: *const c_char,
) -> c_int {
    if action == ffi::SQLITE_ATTACH || action == ffi::SQLITE_DETACH {
        ffi::SQLITE_DENY
    } else {
        ffi::SQLITE_OK
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("hexadecimal invalide".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).ok_or("hexadecimal invalide")?, 16).map_err(|_| "hexadecimal invalide".into()))
        .collect()
}

/// Valeur JSON -> valeur liee a un parametre.
pub fn to_sql(v: &Value) -> Result<SqlValue, String> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().ok_or("nombre invalide")?),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) => match (o.len(), o.get(HEX_KEY)) {
            (1, Some(Value::String(h))) => SqlValue::Blob(unhex(h)?),
            _ => return Err("valeur de parametre invalide".into()),
        },
        Value::Array(_) => return Err("valeur de parametre invalide".into()),
    })
}

/// Valeur d'une colonne -> JSON.
pub fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => {
            let mut o = Map::new();
            o.insert(HEX_KEY.into(), Value::String(hex(b)));
            Value::Object(o)
        }
    }
}

fn is_ddl(sql: &str) -> bool {
    let head = sql.trim_start();
    ["CREATE", "DROP", "ALTER"]
        .iter()
        .any(|k| head.len() >= k.len() && head[..k.len()].eq_ignore_ascii_case(k))
}

fn err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Les lignes d'une instruction preparee.
fn read_rows(stmt: &mut rusqlite::Statement<'_>, values: &[SqlValue]) -> Result<Rows, String> {
    let columns: Vec<String> = stmt.column_names().map(|c| c.to_string()).collect();
    let n = columns.len();
    let mut out = Rows { columns, rows: Vec::new() };
    let mut rows = stmt.query(params_from_iter(values.iter())).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        let mut line = Vec::with_capacity(n);
        for i in 0..n {
            line.push(from_sql(row.get_ref(i).map_err(err)?));
        }
        out.rows.push(line);
    }
    Ok(out)
}

/// Execute une instruction jusqu'au bout. `query` plutot qu'`execute` : une
/// instruction qui rend des lignes (PRAGMA, RETURNING) est acceptee aussi.
fn drain(stmt: &mut rusqlite::Statement<'_>, values: &[SqlValue]) -> Result<(), String> {
    let mut rows = stmt.query(params_from_iter(values.iter())).map_err(err)?;
    while rows.next().map_err(err)?.is_some() {}
    Ok(())
}

/// La base d'index d'un vault.
pub struct IndexDb {
    conn: Mutex<Connection>,
}

impl IndexDb {
    /// Ouvre (ou cree) une base. `":memory:"` : en memoire (tests).
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(err)?;
        // Securite d'abord : aucune base attachee, jamais.
        // SAFETY: la connexion est ouverte et vit autant que le rappel ; le
        // rappel n'utilise aucune donnee (pointeur nul).
        unsafe {
            ffi::sqlite3_limit(conn.handle(), ffi::SQLITE_LIMIT_ATTACHED, 0);
            ffi::sqlite3_set_authorizer(conn.handle(), Some(authorize), std::ptr::null_mut());
        }
        conn.busy_timeout(std::time::Duration::from_millis(5000)).map_err(err)?;
        if path != Path::new(":memory:") {
            // WAL : lecteurs et ecrivain en parallele ; NORMAL est sur en WAL.
            conn.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        }
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;").map_err(err)?;
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        Ok(IndexDb { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // Un panic pendant une requete ne laisse pas de transaction ouverte
        // (Transaction annule a la destruction) : on reprend la connexion.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn exec(&self, sql: &str) -> Result<(), String> {
        self.lock().execute_batch(sql).map_err(err)
    }

    pub fn all(&self, sql: &str, params: &[Value]) -> Result<Rows, String> {
        let values = params.iter().map(to_sql).collect::<Result<Vec<_>, _>>()?;
        let conn = self.lock();
        if is_ddl(sql) {
            read_rows(&mut conn.prepare(sql).map_err(err)?, &values)
        } else {
            read_rows(&mut *conn.prepare_cached(sql).map_err(err)?, &values)
        }
    }

    /// Toutes les instructions dans une transaction : tout ou rien.
    pub fn batch(&self, statements: &[Statement]) -> Result<(), String> {
        let prepared = statements
            .iter()
            .map(|s| Ok((s.sql.as_str(), s.params.iter().map(to_sql).collect::<Result<Vec<_>, String>>()?)))
            .collect::<Result<Vec<_>, String>>()?;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
        for (sql, values) in &prepared {
            if is_ddl(sql) {
                drain(&mut tx.prepare(sql).map_err(err)?, values)?;
            } else {
                drain(&mut *tx.prepare_cached(sql).map_err(err)?, values)?;
            }
        }
        // Sans commit (erreur plus haut), la transaction est annulee a sa destruction.
        tx.commit().map_err(err)
    }
}

/// Les bases d'index ouvertes, par racine de vault.
#[derive(Default)]
pub struct IndexDbs {
    open: Mutex<HashMap<PathBuf, Arc<IndexDb>>>,
}

impl IndexDbs {
    /// La base d'un vault autorise, ouverte au premier appel.
    pub fn get(&self, reg: &VaultRegistry, root: &str) -> Result<Arc<IndexDb>, String> {
        let root = reg.root(root)?;
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(db) = open.get(&root) {
            return Ok(db.clone());
        }
        // Meme garde que les fichiers : `.savoire` ne doit pas mener hors du vault.
        let file = paths::resolve(&root, INDEX_PATH, false)?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let db = Arc::new(IndexDb::open(&file)?);
        open.insert(root, db.clone());
        Ok(db)
    }

    pub fn close(&self, reg: &VaultRegistry, root: &str) -> Result<(), String> {
        let root = reg.root(root)?;
        self.open.lock().unwrap_or_else(|p| p.into_inner()).remove(&root);
        Ok(())
    }
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn index_exec(
    reg: State<'_, VaultRegistry>,
    dbs: State<'_, IndexDbs>,
    root: String,
    sql: String,
) -> Result<(), String> {
    let db = dbs.get(&reg, &root)?;
    blocking(move || db.exec(&sql)).await
}

#[tauri::command]
pub async fn index_all(
    reg: State<'_, VaultRegistry>,
    dbs: State<'_, IndexDbs>,
    root: String,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Rows, String> {
    let db = dbs.get(&reg, &root)?;
    blocking(move || db.all(&sql, &params.unwrap_or_default())).await
}

#[tauri::command]
pub async fn index_batch(
    reg: State<'_, VaultRegistry>,
    dbs: State<'_, IndexDbs>,
    root: String,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let db = dbs.get(&reg, &root)?;
    blocking(move || db.batch(&statements)).await
}

#[tauri::command]
pub fn index_close(reg: State<'_, VaultRegistry>, dbs: State<'_, IndexDbs>, root: String) -> Result<(), String> {
    dbs.close(&reg, &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn st(sql: &str, params: Vec<Value>) -> Statement {
        Statement { sql: sql.into(), params }
    }

    fn mem() -> IndexDb {
        IndexDb::open(Path::new(":memory:")).unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("savoire-index-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn fts5_json_et_version() {
        let db = mem();
        let v = db.all("SELECT sqlite_version() AS v", &[]).unwrap();
        let version = v.rows[0][0].as_str().unwrap().to_string();
        let parts: Vec<u32> = version.split('.').map(|p| p.parse().unwrap()).collect();
        // contentless_delete : SQLite 3.43 ou plus.
        assert!(parts[0] == 3 && parts[1] >= 43, "SQLite trop ancien : {version}");
        db.exec(
            "CREATE VIRTUAL TABLE f USING fts5(title, body, content='', contentless_delete=1, \
             tokenize='unicode61 remove_diacritics 2')",
        )
        .unwrap();
        db.batch(&[
            st("INSERT INTO f (rowid, title, body) VALUES (?, ?, ?)", vec![json!(1), json!("Été"), json!("réseau électrique")]),
            st("INSERT INTO f (rowid, title, body) VALUES (?, ?, ?)", vec![json!(2), json!("Hiver"), json!("neige")]),
        ])
        .unwrap();
        let r = db.all("SELECT rowid FROM f WHERE f MATCH ? ORDER BY bm25(f)", &[json!("reseau")]).unwrap();
        assert_eq!(r.rows, vec![vec![json!(1)]]);
        db.batch(&[st("DELETE FROM f WHERE rowid = ?", vec![json!(1)])]).unwrap();
        assert!(db.all("SELECT rowid FROM f WHERE f MATCH ?", &[json!("ete")]).unwrap().rows.is_empty());
        let j = db.all("SELECT value FROM json_each(?)", &[json!("[\"a\",2]")]).unwrap();
        assert_eq!(j.columns, vec!["value"]);
        assert_eq!(j.rows, vec![vec![json!("a")], vec![json!(2)]]);
    }

    #[test]
    fn valeurs_entieres_reelles_textes_blobs() {
        let db = mem();
        let r = db
            .all(
                "SELECT ? AS i, typeof(?) AS ti, ? AS r, typeof(?) AS tr, ? AS t, ? AS n, ? AS b, ? AS bl",
                &[json!(2), json!(2), json!(2.5), json!(2.5), json!("é"), Value::Null, json!(true), json!({ "$hex": "00ff10" })],
            )
            .unwrap();
        assert_eq!(r.columns, vec!["i", "ti", "r", "tr", "t", "n", "b", "bl"]);
        assert_eq!(
            r.rows[0],
            vec![json!(2), json!("integer"), json!(2.5), json!("real"), json!("é"), Value::Null, json!(1), json!({ "$hex": "00ff10" })]
        );
        assert!(db.all("SELECT ?", &[json!([1])]).is_err());
        assert!(db.all("SELECT ?", &[json!({ "$hex": "0" })]).is_err());
    }

    #[test]
    fn un_batch_est_tout_ou_rien() {
        let db = mem();
        db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)").unwrap();
        db.batch(&[st("INSERT INTO t VALUES (?, ?)", vec![json!("a"), json!(1)])]).unwrap();
        let bad = db.batch(&[
            st("INSERT INTO t VALUES (?, ?)", vec![json!("b"), json!(2)]),
            st("INSERT INTO t VALUES (?, ?)", vec![json!("a"), json!(3)]),
        ]);
        assert!(bad.is_err());
        let r = db.all("SELECT k, v FROM t ORDER BY k", &[]).unwrap();
        assert_eq!(r.rows, vec![vec![json!("a"), json!(1)]]);
        // Les instructions qui rendent des lignes passent aussi dans un batch.
        db.batch(&[
            st("CREATE TABLE IF NOT EXISTS u (x)", vec![]),
            st("INSERT INTO u VALUES (?) RETURNING x", vec![json!(7)]),
            st("PRAGMA user_version", vec![]),
        ])
        .unwrap();
        assert_eq!(db.all("SELECT x FROM u", &[]).unwrap().rows, vec![vec![json!(7)]]);
    }

    #[test]
    fn refuse_de_sortir_du_fichier() {
        let dir = temp_dir("attach");
        let db = IndexDb::open(&dir.join("index.sqlite")).unwrap();
        db.exec("CREATE TABLE t (x)").unwrap();
        let other = dir.join("autre.sqlite");
        let q = |s: &str| s.replace("%F", &other.to_string_lossy());
        assert!(db.exec(&q("ATTACH DATABASE '%F' AS a")).is_err());
        assert!(db.all(&q("ATTACH DATABASE '%F' AS a"), &[]).is_err());
        assert!(db.batch(&[st(&q("ATTACH '%F' AS a"), vec![])]).is_err());
        assert!(db.exec(&q("VACUUM INTO '%F'")).is_err());
        assert!(!other.exists());
        drop(db);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fichier_wal_et_reouverture() {
        let dir = temp_dir("wal");
        let file = dir.join("index.sqlite");
        {
            let db = IndexDb::open(&file).unwrap();
            let mode = db.all("PRAGMA journal_mode", &[]).unwrap();
            assert_eq!(mode.rows[0][0], json!("wal"));
            db.exec("CREATE TABLE t (x)").unwrap();
            db.batch(&[st("INSERT INTO t VALUES (?)", vec![json!("garde")])]).unwrap();
        }
        let db = IndexDb::open(&file).unwrap();
        assert_eq!(db.all("SELECT x FROM t", &[]).unwrap().rows, vec![vec![json!("garde")]]);
        drop(db);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn seule_une_racine_autorisee_a_un_index() {
        let base = temp_dir("roots");
        let vault = base.join("Vault");
        fs::create_dir_all(&vault).unwrap();
        let reg = VaultRegistry::load(base.join("conf").join("recent-vaults.json"));
        let dbs = IndexDbs::default();
        let key = vault.canonicalize().unwrap().to_string_lossy().into_owned();
        assert!(dbs.get(&reg, &key).is_err());
        reg.admit(&vault, None).unwrap();
        let db = dbs.get(&reg, &key).unwrap();
        db.exec("CREATE TABLE t (x)").unwrap();
        assert!(vault.join(INDEX_PATH).is_file());
        // La meme connexion est rendue tant que la base est ouverte.
        assert!(Arc::ptr_eq(&db, &dbs.get(&reg, &key).unwrap()));
        dbs.close(&reg, &key).unwrap();
        assert!(!Arc::ptr_eq(&db, &dbs.get(&reg, &key).unwrap()));
        drop(db);
        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuse_un_dossier_savoire_qui_sort_du_vault() {
        let base = temp_dir("escape");
        let vault = base.join("Vault");
        let outside = base.join("ailleurs");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, vault.join(".savoire")).unwrap();
        let reg = VaultRegistry::load(base.join("conf").join("recent-vaults.json"));
        reg.admit(&vault, None).unwrap();
        let key = vault.canonicalize().unwrap().to_string_lossy().into_owned();
        assert!(IndexDbs::default().get(&reg, &key).is_err());
        assert!(!outside.join("index.sqlite").exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
