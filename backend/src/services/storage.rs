// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fichiers des vaults, sur le disque (ADR-002, ADR-020) :
// {Storage:Root}/{vaultId}/attachments/{chemin de stockage}.
// Le stockage Azure Blob du serveur .NET n'est pas repris (ADR-028 : pas
// d'Azure) : une installation qui l'utilisait copie ses blobs sous la racine.

use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;

use crate::error::AppResult;

#[derive(Clone, Debug)]
pub struct ContentStore {
    root: PathBuf,
}

impl ContentStore {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(ContentStore { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn attach_path(&self, vault_id: &str, storage_path: &str) -> PathBuf {
        self.root.join(vault_id).join("attachments").join(storage_path)
    }

    async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            let mut f = tokio::fs::File::create(&tmp).await?;
            f.write_all(bytes).await?;
            f.flush().await?;
            f.sync_all().await?;
        }
        tokio::fs::rename(&tmp, path).await
    }

    /// Le fichier, ou None s'il n'existe pas.
    pub async fn read(&self, vault_id: &str, storage_path: &str) -> AppResult<Option<tokio::fs::File>> {
        match tokio::fs::File::open(self.attach_path(vault_id, storage_path)).await {
            Ok(f) => Ok(Some(f)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Range le fichier sous un nom genere ({id}{extension}) ; rend ce nom.
    pub async fn write_new(&self, vault_id: &str, file_name: &str, bytes: &[u8]) -> AppResult<String> {
        let ext = Path::new(file_name).extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
        let storage_path = format!("{}{}", uuid::Uuid::new_v4().simple(), ext);
        Self::write_atomic(&self.attach_path(vault_id, &storage_path), bytes).await?;
        Ok(storage_path)
    }

    /// Ecrit (ou remplace) le fichier sous ce chemin de stockage.
    pub async fn put(&self, vault_id: &str, storage_path: &str, bytes: &[u8]) -> AppResult<()> {
        Self::write_atomic(&self.attach_path(vault_id, storage_path), bytes).await?;
        Ok(())
    }

    pub async fn delete(&self, vault_id: &str, storage_path: &str) -> AppResult<()> {
        match tokio::fs::remove_file(self.attach_path(vault_id, storage_path)).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Le dossier d'un vault, ou None si l'identifiant ne designe pas un
    /// dossier situe directement sous la racine (jamais « .. », ni un chemin).
    fn vault_dir(&self, vault_id: &str) -> Option<PathBuf> {
        if vault_id.trim().is_empty() || vault_id == "." || vault_id == ".." || vault_id.contains(['/', '\\', '\0']) {
            return None;
        }
        Some(self.root.join(vault_id))
    }

    /// Efface tous les fichiers d'un vault. Sans effet s'il n'en a pas.
    pub async fn delete_vault(&self, vault_id: &str) -> AppResult<()> {
        if let Some(dir) = self.vault_dir(vault_id) {
            match tokio::fs::remove_dir_all(&dir).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    /// Les vaults qui ont des fichiers.
    pub async fn list_vault_ids(&self) -> AppResult<Vec<String>> {
        let mut out = vec![];
        let mut rd = match tokio::fs::read_dir(&self.root).await {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = rd.next_entry().await? {
            if entry.file_type().await?.is_dir()
                && let Some(name) = entry.file_name().to_str()
            {
                out.push(name.to_string());
            }
        }
        Ok(out)
    }

    /// Octets des fichiers d'un vault (quota).
    pub async fn vault_bytes(&self, vault_id: &str) -> AppResult<i64> {
        let Some(dir) = self.vault_dir(vault_id) else { return Ok(0) };
        let total = tokio::task::spawn_blocking(move || dir_size(&dir)).await.unwrap_or(0);
        Ok(total)
    }

    /// Place libre du disque des donnees ; None si inconnue.
    pub fn free_bytes(&self) -> Option<i64> {
        free_space(&self.root)
    }
}

fn dir_size(dir: &Path) -> i64 {
    let mut total = 0i64;
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            total += dir_size(&entry.path());
        } else if let Ok(m) = entry.metadata() {
            total += m.len() as i64;
        }
    }
    total
}

#[cfg(unix)]
fn free_space(path: &Path) -> Option<i64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs ecrit dans une structure a nous, initialisee a zero.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail as i64).saturating_mul(st.f_frsize as i64))
}

#[cfg(not(unix))]
fn free_space(_path: &Path) -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_read_delete() {
        let dir = std::env::temp_dir().join(format!("savoire-store-{}", uuid::Uuid::new_v4()));
        let store = ContentStore::new(dir.clone()).unwrap();
        let name = store.write_new("v1", "photo.png", b"abc").await.unwrap();
        assert!(name.ends_with(".png"));
        assert!(store.read("v1", &name).await.unwrap().is_some());
        assert_eq!(store.vault_bytes("v1").await.unwrap(), 3);
        assert_eq!(store.list_vault_ids().await.unwrap(), vec!["v1"]);
        store.delete("v1", &name).await.unwrap();
        assert!(store.read("v1", &name).await.unwrap().is_none());
        store.delete_vault("v1").await.unwrap();
        assert_eq!(store.vault_bytes("..").await.unwrap(), 0);
        assert!(store.free_bytes().is_some_and(|b| b > 0));
        let _ = std::fs::remove_dir_all(dir);
    }
}
