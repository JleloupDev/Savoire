// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les serveurs Savoire connus de la version bureau, et la session de chacun.
//
// Deux fichiers dans le dossier de configuration de l'application :
// - servers.json : les adresses saisies (les plus recentes d'abord) et le
//   serveur choisi. Rien de secret.
// - server-sessions.json : par serveur, les comptes connectes tels que l'app
//   web les garde (jeton de renouvellement compris). Droits 0600 sous Unix :
//   lisible par la seule personne. Pas de trousseau du systeme : Tauri n'a pas
//   de greffon officiel leger pour ca, et il faudrait une dependance de plus.
//
// Le front ne choisit aucun chemin : les fichiers sont fixes ici.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Nombre d'adresses gardees.
pub const MAX_SERVERS: usize = 10;
/// Taille maximale d'une adresse.
const MAX_URL_LEN: usize = 2048;
/// Taille maximale de la session d'un serveur (comptes en JSON).
const MAX_SESSION_LEN: usize = 64 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    /// Adresses connues, la plus recente d'abord.
    pub servers: Vec<String>,
    /// Serveur choisi (celui de la derniere connexion), s'il y en a un.
    pub current: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct ServersFile {
    version: u32,
    #[serde(flatten)]
    list: ServerList,
}

#[derive(Default, Serialize, Deserialize)]
struct SessionsFile {
    version: u32,
    sessions: BTreeMap<String, String>,
}

/// Verifie une adresse deja normalisee par le front : http(s)://hote[...],
/// sans espace, ni identifiants, ni requete, ni ancre, ni `/` final.
pub fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() || url.len() > MAX_URL_LEN {
        return Err("adresse de serveur invalide".into());
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or("l'adresse doit commencer par http:// ou https://")?;
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err("adresse de serveur sans hote".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '@' | '\\')) {
        return Err("adresse de serveur invalide".into());
    }
    Ok(url.trim_end_matches('/').to_string())
}

/// Met une adresse en tete de liste et la choisit (logique pure, testee).
pub fn select(list: &mut ServerList, url: &str) {
    list.servers.retain(|s| s != url);
    list.servers.insert(0, url.to_string());
    list.servers.truncate(MAX_SERVERS);
    list.current = Some(url.to_string());
}

/// Retire une adresse ; le choix tombe si c'etait elle (logique pure, testee).
pub fn forget(list: &mut ServerList, url: &str) {
    list.servers.retain(|s| s != url);
    if list.current.as_deref() == Some(url) {
        list.current = None;
    }
}

pub struct ServerSettings {
    servers_file: PathBuf,
    sessions_file: PathBuf,
    list: Mutex<ServerList>,
    sessions: Mutex<BTreeMap<String, String>>,
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(file: &Path) -> T {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Ecriture atomique (fichier temporaire puis renommage), droits 0600 si `private`.
fn write_json<T: Serialize>(file: &Path, value: &T, private: bool) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    let _ = fs::remove_file(&tmp);
    write_new(&tmp, &body, private)?;
    fs::rename(&tmp, file).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn write_new(path: &Path, body: &[u8], private: bool) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    if private {
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(|e| e.to_string())?;
    f.write_all(body).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn write_new(path: &Path, body: &[u8], _private: bool) -> Result<(), String> {
    // Windows : le dossier de configuration est deja propre a la personne.
    fs::write(path, body).map_err(|e| e.to_string())
}

impl ServerSettings {
    pub fn load(dir: &Path) -> Self {
        let servers_file = dir.join("servers.json");
        let sessions_file = dir.join("server-sessions.json");
        let list = read_json::<ServersFile>(&servers_file).list;
        let sessions = read_json::<SessionsFile>(&sessions_file).sessions;
        Self { servers_file, sessions_file, list: Mutex::new(list), sessions: Mutex::new(sessions) }
    }

    pub fn list(&self) -> ServerList {
        self.list.lock().unwrap().clone()
    }

    fn save_list(&self, list: &ServerList) -> Result<(), String> {
        write_json(&self.servers_file, &ServersFile { version: 1, list: list.clone() }, false)
    }

    fn save_sessions(&self, sessions: &BTreeMap<String, String>) -> Result<(), String> {
        write_json(&self.sessions_file, &SessionsFile { version: 1, sessions: sessions.clone() }, true)
    }

    pub fn select(&self, url: &str) -> Result<ServerList, String> {
        let url = validate_url(url)?;
        let mut list = self.list.lock().unwrap();
        select(&mut list, &url);
        self.save_list(&list)?;
        Ok(list.clone())
    }

    pub fn forget(&self, url: &str) -> Result<ServerList, String> {
        let mut list = self.list.lock().unwrap();
        forget(&mut list, url);
        self.save_list(&list)?;
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.remove(url).is_some() {
            self.save_sessions(&sessions)?;
        }
        Ok(list.clone())
    }

    pub fn session(&self, url: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(url).cloned()
    }

    /// None efface la session du serveur (deconnexion).
    pub fn set_session(&self, url: &str, data: Option<String>) -> Result<(), String> {
        let url = validate_url(url)?;
        let mut sessions = self.sessions.lock().unwrap();
        match data {
            Some(d) if d.len() > MAX_SESSION_LEN => return Err("session trop grande".into()),
            Some(d) => {
                // Pas d'entree pour un serveur que la personne n'a pas choisi.
                if !self.list.lock().unwrap().servers.iter().any(|s| s == &url) {
                    return Err("serveur inconnu".into());
                }
                sessions.insert(url, d);
            }
            None => {
                if sessions.remove(&url).is_none() {
                    return Ok(());
                }
            }
        }
        self.save_sessions(&sessions)
    }
}

/// Les serveurs connus et le serveur choisi.
#[tauri::command]
pub fn server_list(settings: State<'_, ServerSettings>) -> ServerList {
    settings.list()
}

/// Choisit un serveur (l'ajoute a la liste s'il est nouveau).
#[tauri::command]
pub fn server_select(settings: State<'_, ServerSettings>, url: String) -> Result<ServerList, String> {
    settings.select(&url)
}

/// Oublie un serveur et sa session.
#[tauri::command]
pub fn server_forget(settings: State<'_, ServerSettings>, url: String) -> Result<ServerList, String> {
    settings.forget(&url)
}

/// La session gardee pour un serveur (comptes en JSON), ou None.
#[tauri::command]
pub fn server_session_get(settings: State<'_, ServerSettings>, url: String) -> Option<String> {
    settings.session(&url)
}

/// Garde (ou efface, avec None) la session d'un serveur.
#[tauri::command]
pub fn server_session_set(
    settings: State<'_, ServerSettings>,
    url: String,
    data: Option<String>,
) -> Result<(), String> {
    settings.set_session(&url, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("savoire-servers-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn adresse_validee() {
        assert_eq!(validate_url("https://savoire.exemple.fr/").unwrap(), "https://savoire.exemple.fr");
        assert_eq!(validate_url("http://192.168.1.10:5000").unwrap(), "http://192.168.1.10:5000");
        assert!(validate_url("ftp://x").is_err());
        assert!(validate_url("https://").is_err());
        assert!(validate_url("https://a b").is_err());
        assert!(validate_url("https://u:p@hote").is_err());
        assert!(validate_url("https://hote/?x=1").is_err());
        assert!(validate_url("savoire.exemple.fr").is_err());
    }

    #[test]
    fn choix_remonte_et_borne() {
        let mut list = ServerList::default();
        for i in 0..12 {
            select(&mut list, &format!("https://s{i}"));
        }
        assert_eq!(list.servers.len(), MAX_SERVERS);
        select(&mut list, "https://s5");
        assert_eq!(list.servers[0], "https://s5");
        assert_eq!(list.servers.iter().filter(|s| *s == "https://s5").count(), 1);
        assert_eq!(list.current.as_deref(), Some("https://s5"));
        forget(&mut list, "https://s5");
        assert_eq!(list.current, None);
        assert!(!list.servers.contains(&"https://s5".to_string()));
    }

    #[test]
    fn memorise_entre_deux_lancements() {
        let dir = temp_dir("persist");
        let s = ServerSettings::load(&dir);
        s.select("https://a.exemple").unwrap();
        s.select("http://127.0.0.1:5000").unwrap();
        s.set_session("http://127.0.0.1:5000", Some("[{\"userId\":\"u\"}]".into())).unwrap();
        // Pas de session pour un serveur jamais choisi.
        assert!(s.set_session("https://inconnu", Some("[]".into())).is_err());

        let again = ServerSettings::load(&dir);
        assert_eq!(again.list().current.as_deref(), Some("http://127.0.0.1:5000"));
        assert_eq!(again.list().servers, vec!["http://127.0.0.1:5000", "https://a.exemple"]);
        assert_eq!(again.session("http://127.0.0.1:5000").as_deref(), Some("[{\"userId\":\"u\"}]"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("server-sessions.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        again.set_session("http://127.0.0.1:5000", None).unwrap();
        again.forget("https://a.exemple").unwrap();
        let last = ServerSettings::load(&dir);
        assert_eq!(last.session("http://127.0.0.1:5000"), None);
        assert_eq!(last.list().servers, vec!["http://127.0.0.1:5000"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
