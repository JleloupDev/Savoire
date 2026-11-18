// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Configuration, lue comme le faisait le serveur .NET, pour garder les memes
// fichiers et les memes variables d'environnement :
//  1. appsettings.json, puis appsettings.{Environment}.json (dossier courant) ;
//  2. les variables d'environnement, « Section__Cle » pour « Section:Cle »
//     (ConnectionStrings__Savoire, Indexer__Instances__0__Url...) ;
//  3. les fichiers ecrits par les scripts d'amorcage (Savoire:OidcConfigFile,
//     Savoire:ErrorReportingConfigFile), relus quand ils changent.
// Les cles se lisent sans tenir compte de la casse, comme en .NET.
//
// Environnement : SAVOIRE_ENVIRONMENT, sinon ASPNETCORE_ENVIRONMENT, sinon
// Production.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use serde_json::{Map, Value};

#[derive(Clone, Debug, Default)]
pub struct Settings {
    root: Value,
    pub environment: String,
}

impl Settings {
    pub fn from_value(root: Value, environment: &str) -> Self {
        Settings { root, environment: environment.to_string() }
    }

    pub fn is_development(&self) -> bool {
        self.environment.eq_ignore_ascii_case("Development")
    }

    /// La valeur a ce chemin (« A:B:0:C »), sans tenir compte de la casse.
    pub fn get(&self, path: &str) -> Option<&Value> {
        let mut cur = &self.root;
        for seg in path.split(':') {
            cur = match cur {
                Value::Object(m) => {
                    m.get(seg).or_else(|| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(seg)).map(|(_, v)| v))?
                }
                Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
        Some(cur)
    }

    pub fn exists(&self, path: &str) -> bool {
        self.get(path).is_some()
    }

    /// Texte (un nombre ou un booleen est rendu en texte). Vide : None.
    pub fn str(&self, path: &str) -> Option<String> {
        match self.get(path)? {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    pub fn str_or(&self, path: &str, fallback: &str) -> String {
        self.str(path).unwrap_or_else(|| fallback.to_string())
    }

    pub fn bool_or(&self, path: &str, fallback: bool) -> bool {
        match self.get(path) {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s.trim().parse::<bool>().unwrap_or_else(|_| s.eq_ignore_ascii_case("true")),
            _ => fallback,
        }
    }

    pub fn i64_or(&self, path: &str, fallback: i64) -> i64 {
        match self.get(path) {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback),
            Some(Value::String(s)) => s.trim().parse().unwrap_or(fallback),
            _ => fallback,
        }
    }

    /// Liste : un tableau JSON, ou un objet a cles numeriques (variables d'environnement).
    pub fn list(&self, path: &str) -> Vec<Value> {
        match self.get(path) {
            Some(Value::Array(a)) => a.clone(),
            Some(Value::Object(m)) => {
                let mut items: Vec<(usize, Value)> =
                    m.iter().filter_map(|(k, v)| k.parse::<usize>().ok().map(|i| (i, v.clone()))).collect();
                items.sort_by_key(|(i, _)| *i);
                items.into_iter().map(|(_, v)| v).collect()
            }
            _ => vec![],
        }
    }

    pub fn str_list(&self, path: &str) -> Vec<String> {
        self.list(path)
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    /// Sous-section, comme une configuration a part.
    pub fn section(&self, path: &str) -> Settings {
        Settings { root: self.get(path).cloned().unwrap_or(Value::Null), environment: self.environment.clone() }
    }
}

/// Fusionne `over` dans `base` (les objets cle par cle, sans casse ; le reste remplace).
pub fn merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                let existing = b.keys().find(|bk| bk.eq_ignore_ascii_case(&k)).cloned();
                match existing {
                    Some(key) => merge(b.get_mut(&key).unwrap(), v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (b, o) => *b = o,
    }
}

/// Variables d'environnement « A__B__C=valeur » en objet { A: { B: { C: "valeur" } } }.
pub fn env_tree(vars: impl Iterator<Item = (String, String)>) -> Value {
    let mut root = Value::Object(Map::new());
    for (k, v) in vars {
        if !k.contains("__") && !KNOWN_FLAT.iter().any(|f| f.eq_ignore_ascii_case(&k)) {
            continue;
        }
        let segs: Vec<&str> = k.split("__").collect();
        let mut leaf = Value::String(v);
        for seg in segs.iter().rev() {
            let mut m = Map::new();
            m.insert((*seg).to_string(), leaf);
            leaf = Value::Object(m);
        }
        merge(&mut root, leaf);
    }
    root
}

/// Variables sans « __ » lues quand meme (comme en .NET).
const KNOWN_FLAT: &[&str] = &["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME", "ASPNETCORE_URLS", "PORT"];

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    // Les fichiers .NET acceptent les commentaires : on les retire grossierement.
    let cleaned: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    match serde_json::from_str(cleaned.trim_start_matches('\u{feff}')) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!(file = %path.display(), error = %e, "fichier de configuration illisible");
            None
        }
    }
}

/// La configuration, relue quand un fichier d'amorcage change.
pub struct Config {
    content_root: PathBuf,
    environment: String,
    current: RwLock<Arc<Settings>>,
    watched: RwLock<Vec<(PathBuf, Option<SystemTime>)>>,
    overrides: Value,
}

impl Config {
    pub fn load(content_root: &Path) -> Arc<Config> {
        Self::load_with(content_root, Value::Object(Map::new()))
    }

    /// `overrides` : appliquees en dernier (tests).
    pub fn load_with(content_root: &Path, overrides: Value) -> Arc<Config> {
        let environment = std::env::var("SAVOIRE_ENVIRONMENT")
            .or_else(|_| std::env::var("ASPNETCORE_ENVIRONMENT"))
            .unwrap_or_else(|_| "Production".into());
        let cfg = Config {
            content_root: content_root.to_path_buf(),
            environment,
            current: RwLock::new(Arc::new(Settings::default())),
            watched: RwLock::new(vec![]),
            overrides,
        };
        cfg.reload();
        Arc::new(cfg)
    }

    pub fn get(&self) -> Arc<Settings> {
        self.current.read().unwrap().clone()
    }

    fn reload(&self) {
        let mut root = Value::Object(Map::new());
        if let Some(v) = read_json(&self.content_root.join("appsettings.json")) {
            merge(&mut root, v);
        }
        if let Some(v) = read_json(&self.content_root.join(format!("appsettings.{}.json", self.environment))) {
            merge(&mut root, v);
        }
        merge(&mut root, env_tree(std::env::vars()));
        merge(&mut root, self.overrides.clone());
        let base = Settings::from_value(root.clone(), &self.environment);
        let mut watched = vec![];
        for key in ["Savoire:OidcConfigFile", "Savoire:ErrorReportingConfigFile"] {
            let Some(file) = base.str(key) else { continue };
            let path = if Path::new(&file).is_absolute() { PathBuf::from(&file) } else { self.content_root.join(&file) };
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if let Some(v) = read_json(&path) {
                merge(&mut root, v);
            }
            watched.push((path, mtime));
        }
        // Les reglages passes par le test (ou l'environnement) gardent le dernier mot.
        merge(&mut root, self.overrides.clone());
        *self.current.write().unwrap() = Arc::new(Settings::from_value(root, &self.environment));
        *self.watched.write().unwrap() = watched;
    }

    /// Relit la configuration si un fichier d'amorcage a change.
    pub fn refresh_if_changed(&self) {
        let changed = self.watched.read().unwrap().iter().any(|(p, m)| std::fs::metadata(p).and_then(|x| x.modified()).ok() != *m);
        if changed {
            tracing::info!("Fichier de configuration modifie : relecture.");
            self.reload();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn env_vars_become_sections() {
        let v = env_tree(
            vec![
                ("ConnectionStrings__Savoire".to_string(), "Host=x".to_string()),
                ("Indexer__Instances__0__Name".to_string(), "a".to_string()),
                ("HOME".to_string(), "/root".to_string()),
            ]
            .into_iter(),
        );
        let s = Settings::from_value(v, "Production");
        assert_eq!(s.str("connectionstrings:savoire").as_deref(), Some("Host=x"));
        assert_eq!(s.list("Indexer:Instances").len(), 1);
        assert!(s.get("HOME").is_none());
    }

    #[test]
    fn merge_is_case_insensitive() {
        let mut a = json!({"Auth": {"Oidc": {"Authority": "a"}}});
        merge(&mut a, json!({"auth": {"oidc": {"Audience": "b"}}}));
        let s = Settings::from_value(a, "Development");
        assert_eq!(s.str("Auth:Oidc:Authority").as_deref(), Some("a"));
        assert_eq!(s.str("Auth:Oidc:Audience").as_deref(), Some("b"));
        assert!(s.is_development());
    }

    #[test]
    fn typed_reads() {
        let s = Settings::from_value(json!({"L": {"N": "12", "B": "True", "Arr": ["x", "y"]}}), "x");
        assert_eq!(s.i64_or("L:N", 0), 12);
        assert!(s.bool_or("L:B", false));
        assert_eq!(s.str_list("L:Arr"), vec!["x", "y"]);
        assert_eq!(s.i64_or("L:Missing", 7), 7);
    }
}
