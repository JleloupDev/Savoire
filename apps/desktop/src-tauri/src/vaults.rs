// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les dossiers de vault que la personne a choisis.
//
// Deux choses, volontairement liees :
// - la liste des vaults recents, gardee dans le dossier de configuration de
//   l'application (recent-vaults.json) ;
// - les racines AUTORISEES pendant cette session : seul un dossier choisi
//   dans la boite de dialogue (ou deja present dans la liste, donc choisi
//   avant) peut etre lu ou ecrit. Le front ne peut pas ajouter un chemin de
//   lui-meme : il n'y a aucune commande pour ca.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Nombre de vaults gardes dans la liste.
pub const MAX_RECENT: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    /// Chemin absolu canonique du dossier : c'est aussi l'identifiant de la racine.
    pub path: String,
    /// Nom affiche (par defaut : le nom du dossier).
    pub name: String,
    pub last_opened_ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct RecentFile {
    version: u32,
    vaults: Vec<RecentVault>,
}

/// Ce que voit le front d'un vault recent.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVaultView {
    pub path: String,
    pub name: String,
    pub last_opened_ms: u64,
    /// Le dossier existe-t-il encore (disque demonte, dossier deplace) ?
    pub exists: bool,
}

pub struct VaultRegistry {
    file: PathBuf,
    recent: Mutex<Vec<RecentVault>>,
    authorized: Mutex<HashSet<PathBuf>>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Ajoute ou remonte un vault en tete de liste (logique pure, testee).
pub fn upsert(list: &mut Vec<RecentVault>, path: &str, name: Option<&str>, at_ms: u64) {
    let previous = list.iter().position(|v| v.path == path).map(|i| list.remove(i));
    let name = match (name, previous) {
        (Some(n), _) => n.to_string(),
        (None, Some(p)) => p.name,
        (None, None) => folder_name(Path::new(path)),
    };
    list.insert(0, RecentVault { path: path.to_string(), name, last_opened_ms: at_ms });
    list.truncate(MAX_RECENT);
}

impl VaultRegistry {
    pub fn load(file: PathBuf) -> Self {
        let recent = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RecentFile>(&bytes).ok())
            .map(|f| f.vaults)
            .unwrap_or_default();
        VaultRegistry { file, recent: Mutex::new(recent), authorized: Mutex::new(HashSet::new()) }
    }

    fn save(&self, list: &[RecentVault]) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_vec_pretty(&RecentFile { version: 1, vaults: list.to_vec() })
            .map_err(|e| e.to_string())?;
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, body).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }

    /// Un dossier choisi par la personne : autorise et mis en tete de liste.
    pub fn admit(&self, dir: &Path, name: Option<&str>) -> Result<RecentVault, String> {
        let real = dir.canonicalize().map_err(|e| format!("dossier introuvable : {e}"))?;
        if !real.is_dir() {
            return Err("ce n'est pas un dossier".into());
        }
        self.authorized.lock().unwrap().insert(real.clone());
        let key = real.to_string_lossy().into_owned();
        let mut list = self.recent.lock().unwrap();
        upsert(&mut list, &key, name, now_ms());
        self.save(&list)?;
        Ok(list[0].clone())
    }

    pub fn list(&self) -> Vec<RecentVaultView> {
        self.recent
            .lock()
            .unwrap()
            .iter()
            .map(|v| RecentVaultView {
                path: v.path.clone(),
                name: v.name.clone(),
                last_opened_ms: v.last_opened_ms,
                exists: Path::new(&v.path).is_dir(),
            })
            .collect()
    }

    /// Rouvre un vault de la liste : seul un chemin deja choisi est accepte.
    pub fn reopen(&self, path: &str) -> Result<RecentVault, String> {
        let known = self.recent.lock().unwrap().iter().any(|v| v.path == path);
        if !known {
            return Err("ce dossier n'est pas dans la liste des vaults".into());
        }
        let real = Path::new(path).canonicalize().map_err(|e| format!("dossier introuvable : {e}"))?;
        if real.to_string_lossy() != path {
            // Le chemin pointe ailleurs qu'au moment du choix (lien remplace) :
            // on ne suit pas, la personne doit choisir le dossier a nouveau.
            return Err("le dossier a change de place, choisissez-le a nouveau".into());
        }
        self.admit(&real, None)
    }

    pub fn forget(&self, path: &str) -> Result<(), String> {
        let mut list = self.recent.lock().unwrap();
        list.retain(|v| v.path != path);
        self.save(&list)?;
        self.authorized.lock().unwrap().remove(Path::new(path));
        Ok(())
    }

    pub fn rename(&self, path: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("nom vide".into());
        }
        let mut list = self.recent.lock().unwrap();
        let entry = list.iter_mut().find(|v| v.path == path).ok_or("vault inconnu")?;
        entry.name = name.to_string();
        self.save(&list)
    }

    /// La racine d'une commande de fichiers, si elle est autorisee.
    pub fn root(&self, root: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(root);
        if self.authorized.lock().unwrap().contains(&path) {
            Ok(path)
        } else {
            Err("vault non autorise : ouvrez d'abord le dossier".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_remonte_garde_le_nom_et_borne() {
        let mut list = Vec::new();
        upsert(&mut list, "/a/Notes", None, 1);
        upsert(&mut list, "/b/Projet", Some("Mon projet"), 2);
        assert_eq!(list[0].name, "Mon projet");
        upsert(&mut list, "/a/Notes", None, 3);
        assert_eq!(list[0].path, "/a/Notes");
        assert_eq!(list[0].name, "Notes");
        assert_eq!(list[0].last_opened_ms, 3);
        assert_eq!(list.len(), 2);
        upsert(&mut list, "/b/Projet", None, 4);
        assert_eq!(list[0].name, "Mon projet");
        for i in 0..30 {
            upsert(&mut list, &format!("/x/{i}"), None, 10 + i);
        }
        assert_eq!(list.len(), MAX_RECENT);
    }

    #[test]
    fn seule_une_racine_admise_est_autorisee() {
        let base = std::env::temp_dir().join(format!("savoire-reg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let vault = base.join("Vault");
        fs::create_dir_all(&vault).unwrap();
        let reg = VaultRegistry::load(base.join("conf").join("recent-vaults.json"));
        let real = vault.canonicalize().unwrap();
        let key = real.to_string_lossy().into_owned();
        assert!(reg.root(&key).is_err());
        assert!(reg.reopen(&key).is_err());
        reg.admit(&vault, None).unwrap();
        assert_eq!(reg.root(&key).unwrap(), real);
        // Relue depuis le disque : la liste survit, l'autorisation non.
        let again = VaultRegistry::load(base.join("conf").join("recent-vaults.json"));
        assert_eq!(again.list().len(), 1);
        assert!(again.root(&key).is_err());
        again.reopen(&key).unwrap();
        assert!(again.root(&key).is_ok());
        again.forget(&key).unwrap();
        assert!(again.root(&key).is_err());
        assert!(again.list().is_empty());
        fs::remove_dir_all(&base).unwrap();
    }
}
