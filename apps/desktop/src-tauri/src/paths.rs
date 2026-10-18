// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Chemins d'un vault : le front ne parle qu'en chemins RELATIFS a la racine,
// separes par « / ». Ce module refuse tout ce qui pourrait sortir de la
// racine : chemin absolu, « .. », lien symbolique qui pointe ailleurs.
// C'est la seule barriere entre la page web et le disque : chaque commande
// de fichiers y passe.

use std::path::{Component, Path, PathBuf};

/// Dossier cache de Savoire a la racine du vault.
pub const SAVOIRE_DIR: &str = ".savoire";
/// Fichiers temporaires des ecritures atomiques : jamais signales au front.
pub const TMP_DIR: &str = ".savoire/tmp";

/// Decoupe un chemin relatif et verifie chaque morceau.
/// `allow_root` : la chaine vide designe la racine (lister la racine).
pub fn split_relative(rel: &str, allow_root: bool) -> Result<Vec<&str>, String> {
    if rel.is_empty() {
        return if allow_root { Ok(Vec::new()) } else { Err("chemin vide".into()) };
    }
    if rel.contains('\\') || rel.contains('\0') {
        return Err(format!("chemin invalide : {rel}"));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts {
        if part.is_empty() || *part == "." || *part == ".." {
            return Err(format!("chemin invalide : {rel}"));
        }
        // Une lettre de lecteur (« C: ») ferait un chemin absolu sous Windows.
        if cfg!(windows) && part.contains(':') {
            return Err(format!("chemin invalide : {rel}"));
        }
    }
    Ok(parts)
}

/// Chemin absolu d'un chemin relatif, garanti sous la racine.
/// `root` doit etre deja canonique (voir vaults.rs).
pub fn resolve(root: &Path, rel: &str, allow_root: bool) -> Result<PathBuf, String> {
    let parts = split_relative(rel, allow_root)?;
    let mut full = root.to_path_buf();
    for part in parts {
        full.push(part);
    }
    // Un composant normal peut encore etre un lien symbolique vers l'exterieur :
    // on verifie l'ancetre existant le plus proche, une fois resolu.
    let mut probe = full.as_path();
    loop {
        if probe.exists() {
            let real = probe
                .canonicalize()
                .map_err(|e| format!("chemin illisible : {e}"))?;
            if !real.starts_with(root) {
                return Err(format!("chemin hors du vault : {rel}"));
            }
            break;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err(format!("chemin hors du vault : {rel}")),
        }
    }
    Ok(full)
}

/// Chemin relatif (« a/b.md ») d'un chemin absolu sous la racine.
pub fn to_relative(root: &Path, full: &Path) -> Option<String> {
    let rest = full.strip_prefix(root).ok()?;
    let mut out: Vec<String> = Vec::new();
    for comp in rest.components() {
        match comp {
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("/"))
    }
}

/// Un fichier temporaire de Savoire : invisible pour le front.
pub fn is_internal_tmp(rel: &str) -> bool {
    rel == TMP_DIR || rel.starts_with(&format!("{TMP_DIR}/"))
}

/// Nom d'un nouveau vault : un seul morceau de chemin.
pub fn validate_folder_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("nom vide".into());
    }
    let parts = split_relative(trimmed, false)?;
    if parts.len() != 1 {
        return Err(format!("nom invalide : {trimmed}"));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("savoire-paths-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn refuse_les_chemins_qui_sortent() {
        assert!(split_relative("../x", false).is_err());
        assert!(split_relative("a/../../x", false).is_err());
        assert!(split_relative("/etc/passwd", false).is_err());
        assert!(split_relative("a//b", false).is_err());
        assert!(split_relative("a/./b", false).is_err());
        assert!(split_relative("a\\b", false).is_err());
        assert!(split_relative("", false).is_err());
        assert_eq!(split_relative("", true).unwrap().len(), 0);
        assert_eq!(split_relative("Projet/Note.md", false).unwrap(), vec!["Projet", "Note.md"]);
    }

    #[test]
    fn resout_sous_la_racine() {
        let root = temp_root("resolve");
        let p = resolve(&root, "a/b/c.md", false).unwrap();
        assert_eq!(p, root.join("a").join("b").join("c.md"));
        assert_eq!(resolve(&root, "", true).unwrap(), root);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuse_un_lien_vers_l_exterieur() {
        let root = temp_root("symlink");
        let outside = temp_root("outside");
        std::os::unix::fs::symlink(&outside, root.join("fuite")).unwrap();
        assert!(resolve(&root, "fuite/x.md", false).is_err());
        assert!(resolve(&root, "fuite", false).is_err());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn relatif_et_temporaires() {
        let root = PathBuf::from("/v");
        assert_eq!(to_relative(&root, &root.join("a").join("b.md")).as_deref(), Some("a/b.md"));
        assert_eq!(to_relative(&root, &root), None);
        assert_eq!(to_relative(&root, Path::new("/w/x")), None);
        assert!(is_internal_tmp(".savoire/tmp/123"));
        assert!(!is_internal_tmp(".savoire/state.bin"));
    }

    #[test]
    fn nom_de_vault() {
        assert_eq!(validate_folder_name("  Notes ").unwrap(), "Notes");
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("..").is_err());
        assert!(validate_folder_name(" ").is_err());
    }
}
