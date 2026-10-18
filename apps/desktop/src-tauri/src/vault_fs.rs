// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Commandes de fichiers d'un vault : la contrepartie Rust du port
// IVaultFileSystem (packages/platform/src/fileSystem.ts).
//
// Chaque commande recoit la racine du vault (chemin absolu rendu a
// l'ouverture du dossier) et un chemin RELATIF. La racine doit avoir ete
// autorisee (vaults.rs), le chemin ne peut pas en sortir (paths.rs).
// Le contenu binaire passe en octets bruts (corps de la requete IPC et
// reponse brute), pas en tableau JSON.

use crate::paths::{self, SAVOIRE_DIR, TMP_DIR};
use crate::vaults::VaultRegistry;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<u64>,
}

fn entry(root: &Path, full: &Path, meta: &fs::Metadata) -> Option<FileEntry> {
    let path = paths::to_relative(root, full)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    if meta.is_dir() {
        Some(FileEntry { path, kind: "directory", size: None, mtime_ms })
    } else {
        Some(FileEntry { path, kind: "file", size: Some(meta.len()), mtime_ms })
    }
}

fn target(reg: &VaultRegistry, root: &str, rel: &str, allow_root: bool) -> Result<(PathBuf, PathBuf), String> {
    let root = reg.root(root)?;
    let full = paths::resolve(&root, rel, allow_root)?;
    Ok((root, full))
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Ecriture atomique : un fichier temporaire dans `.savoire/tmp/`, puis un
/// renommage. Un autre outil ne voit jamais un fichier a moitie ecrit.
fn write_atomic(root: &Path, full: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_dir = root.join(TMP_DIR);
    let tmp = tmp_dir.join(format!(
        "{}-{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let staged = fs::create_dir_all(&tmp_dir).and_then(|_| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    });
    match staged.and_then(|_| fs::rename(&tmp, full)) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Autre systeme de fichiers sous la racine (point de montage) :
            // on retombe sur une ecriture directe.
            let _ = fs::remove_file(&tmp);
            fs::write(full, bytes).map_err(|e| e.to_string())
        }
    }
}

/// En-tete d'une requete binaire : la valeur est encodee en pourcents (UTF-8).
fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("en-tete manquant : {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    percent_decode(raw)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("encodage invalide")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "encodage invalide")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "encodage invalide".into())
}

#[tauri::command]
pub fn vault_read_text(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<String, String> {
    let (_, full) = target(&reg, &root, &path, false)?;
    fs::read_to_string(full).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_read_bytes(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<Response, String> {
    let (_, full) = target(&reg, &root, &path, false)?;
    fs::read(full).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write_text(
    reg: State<'_, VaultRegistry>,
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let (root, full) = target(&reg, &root, &path, false)?;
    write_atomic(&root, &full, content.as_bytes())
}

#[tauri::command]
pub fn vault_write_bytes(reg: State<'_, VaultRegistry>, request: Request<'_>) -> Result<(), String> {
    let root = header(&request, "x-vault-root")?;
    let path = header(&request, "x-vault-path")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("corps binaire attendu".into());
    };
    let (root, full) = target(&reg, &root, &path, false)?;
    write_atomic(&root, &full, bytes)
}

#[tauri::command]
pub fn vault_exists(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<bool, String> {
    let (_, full) = target(&reg, &root, &path, true)?;
    Ok(full.exists())
}

#[tauri::command]
pub fn vault_stat(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<Option<FileEntry>, String> {
    let (root, full) = target(&reg, &root, &path, false)?;
    match fs::metadata(&full) {
        Ok(meta) => Ok(entry(&root, &full, &meta)),
        Err(_) => Ok(None),
    }
}

fn walk(root: &Path, dir: &Path, recursive: bool, out: &mut Vec<FileEntry>) -> Result<(), String> {
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let full = item.path();
        // Les liens symboliques ne sont pas suivis : ils pourraient mener
        // hors du vault, ou boucler.
        let meta = match fs::symlink_metadata(&full) {
            Ok(m) if !m.file_type().is_symlink() => m,
            _ => continue,
        };
        if let Some(rel) = paths::to_relative(root, &full) {
            if paths::is_internal_tmp(&rel) {
                continue;
            }
        }
        if let Some(e) = entry(root, &full, &meta) {
            out.push(e);
        }
        if recursive && meta.is_dir() {
            walk(root, &full, true, out)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn vault_list(
    reg: State<'_, VaultRegistry>,
    root: String,
    dir: String,
    recursive: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let (root, full) = target(&reg, &root, &dir, true)?;
    let mut out = Vec::new();
    walk(&root, &full, recursive.unwrap_or(false), &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
pub fn vault_mkdir(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<(), String> {
    let (_, full) = target(&reg, &root, &path, false)?;
    fs::create_dir_all(full).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_rename(reg: State<'_, VaultRegistry>, root: String, from: String, to: String) -> Result<(), String> {
    let (_, src) = target(&reg, &root, &from, false)?;
    let (_, dst) = target(&reg, &root, &to, false)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_remove(reg: State<'_, VaultRegistry>, root: String, path: String) -> Result<(), String> {
    // La racine elle-meme ne se supprime jamais (allow_root = false), ni
    // le dossier `.savoire` en entier par megarde depuis le front.
    if path == SAVOIRE_DIR {
        return Err("le dossier .savoire ne se supprime pas d'un bloc".into());
    }
    let (_, full) = target(&reg, &root, &path, false)?;
    let meta = match fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if meta.is_dir() {
        fs::remove_dir_all(full).map_err(|e| e.to_string())
    } else {
        fs::remove_file(full).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_les_en_tetes() {
        assert_eq!(percent_decode("Projet%2FNote%20%C3%A9t%C3%A9.md").unwrap(), "Projet/Note été.md");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%4").is_err());
    }

    #[test]
    fn ecriture_atomique_sans_trace() {
        let root = std::env::temp_dir().join(format!("savoire-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let full = root.join("a").join("b.md");
        write_atomic(&root, &full, b"bonjour").unwrap();
        write_atomic(&root, &full, b"bonsoir").unwrap();
        assert_eq!(fs::read_to_string(&full).unwrap(), "bonsoir");
        assert_eq!(fs::read_dir(root.join(TMP_DIR)).unwrap().count(), 0);
        let mut listed = Vec::new();
        walk(&root, &root, true, &mut listed).unwrap();
        let names: Vec<_> = listed.iter().map(|e| e.path.as_str()).collect();
        assert!(names.contains(&"a/b.md"));
        assert!(!names.iter().any(|p| p.starts_with(TMP_DIR)));
        fs::remove_dir_all(&root).unwrap();
    }
}
