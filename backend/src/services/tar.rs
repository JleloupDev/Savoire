// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire une archive .tar (envoi de tout un dossier par une IA : add_file avec
// unpack). Format ustar, noms longs GNU (« L ») et pax (« path= ») ; seuls
// les fichiers ordinaires sont rendus (dossiers, liens et le reste ignores).
// Pas de compression : une IA qui a un terminal fait `tar -cf`.
//
// Les chemins sont nettoyes ici : jamais absolus, jamais « .. », jamais vides.

use std::ops::Range;

/// Un fichier de l'archive : son chemin (relatif, nettoye) et ses octets dans l'archive.
pub struct TarEntry {
    pub path: String,
    pub data: Range<usize>,
}

const BLOCK: usize = 512;

fn field(h: &[u8], at: usize, len: usize) -> &[u8] {
    let f = &h[at..at + len];
    let end = f.iter().position(|&b| b == 0).unwrap_or(len);
    &f[..end]
}

fn octal(h: &[u8], at: usize, len: usize) -> Result<usize, String> {
    let s = std::str::from_utf8(field(h, at, len)).map_err(|_| "Archive illisible (taille).".to_string())?;
    let s = s.trim_matches(|c: char| c == ' ' || c == '\0');
    if s.is_empty() {
        return Ok(0);
    }
    usize::from_str_radix(s, 8).map_err(|_| "Archive illisible (taille).".to_string())
}

/// « path=... » d'un en-tete pax.
fn pax_path(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    let mut rest = text;
    while !rest.is_empty() {
        let (len, after) = rest.split_once(' ')?;
        let n: usize = len.parse().ok()?;
        let record = rest.get(..n)?;
        let kv = record.get(len.len() + 1..)?.trim_end_matches('\n');
        if let Some(v) = kv.strip_prefix("path=") {
            return Some(v.to_string());
        }
        let _ = after;
        rest = rest.get(n..)?;
    }
    None
}

/// Chemin sur : relatif, sans « . » ni « .. », sans segment vide. None : a ignorer.
pub fn clean_path(raw: &str) -> Option<String> {
    let unix = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for seg in unix.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            s if s.chars().any(|c| c.is_control()) => return None,
            s => parts.push(s),
        }
    }
    if parts.is_empty() || parts[0] == ".trash" {
        return None;
    }
    Some(parts.join("/"))
}

/// Les fichiers ordinaires de l'archive. Err : archive illisible.
pub fn entries(bytes: &[u8], max_entries: usize) -> Result<Vec<TarEntry>, String> {
    let mut out = Vec::new();
    let mut at = 0usize;
    let mut long_name: Option<String> = None;
    while at + BLOCK <= bytes.len() {
        let h = &bytes[at..at + BLOCK];
        if h.iter().all(|&b| b == 0) {
            break;
        }
        let size = octal(h, 124, 12)?;
        let kind = h[156];
        let start = at + BLOCK;
        let end = start.checked_add(size).filter(|&e| e <= bytes.len()).ok_or("Archive tronquée.")?;
        let data = &bytes[start..end];
        let next = start + size.div_ceil(BLOCK) * BLOCK;
        match kind {
            b'L' => long_name = Some(String::from_utf8_lossy(field(data, 0, data.len())).into_owned()),
            b'x' => {
                if let Some(p) = pax_path(data) {
                    long_name = Some(p);
                }
            }
            b'g' => {}
            b'0' | 0 => {
                let name = match long_name.take() {
                    Some(n) => n,
                    None => {
                        let name = String::from_utf8_lossy(field(h, 0, 100)).into_owned();
                        let ustar = &h[257..262] == b"ustar";
                        let prefix = if ustar { String::from_utf8_lossy(field(h, 345, 155)).into_owned() } else { String::new() };
                        if prefix.is_empty() { name } else { format!("{prefix}/{name}") }
                    }
                };
                if let Some(path) = clean_path(&name) {
                    // Fichiers caches du systeme (macOS) : ignores.
                    if !path.split('/').any(|s| s.starts_with("._") || s == ".DS_Store") {
                        out.push(TarEntry { path, data: start..end });
                        if out.len() > max_entries {
                            return Err(format!("Trop de fichiers dans l'archive ({max_entries} au plus)."));
                        }
                    }
                }
            }
            _ => long_name = None,
        }
        at = next;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, size: usize, kind: u8) -> Vec<u8> {
        let mut h = vec![0u8; BLOCK];
        h[..name.len()].copy_from_slice(name.as_bytes());
        let s = format!("{size:011o}\0");
        h[124..136].copy_from_slice(s.as_bytes());
        h[156] = kind;
        h[257..263].copy_from_slice(b"ustar\0");
        h
    }

    fn file(name: &str, data: &[u8], kind: u8) -> Vec<u8> {
        let mut v = header(name, data.len(), kind);
        v.extend_from_slice(data);
        v.resize(v.len() + (BLOCK - data.len() % BLOCK) % BLOCK, 0);
        v
    }

    #[test]
    fn reads_files_long_names_and_skips_the_rest() {
        let long = format!("{}/fichier très long.json", "dossier".repeat(20));
        // Longueur d'un enregistrement pax : elle se compte elle-meme.
        let record = {
            let body = format!(" path={long}\n");
            let mut n = body.len() + 1;
            while format!("{n}{body}").len() != n {
                n += 1;
            }
            format!("{n}{body}")
        };
        let mut tar = Vec::new();
        tar.extend(file("a/b.txt", b"bonjour", b'0'));
        tar.extend(file("a/", b"", b'5'));
        tar.extend(file("././@LongLink", format!("{long}\0").as_bytes(), b'L'));
        tar.extend(file("tronque", b"long", b'0'));
        tar.extend(file("PaxHeaders/x", record.as_bytes(), b'x'));
        tar.extend(file("ignore", b"pax", b'0'));
        tar.extend(file("../../etc/passwd", b"non", b'0'));
        tar.extend(file("lien", b"", b'2'));
        tar.extend(vec![0u8; BLOCK * 2]);
        let e = entries(&tar, 100).unwrap();
        let names: Vec<_> = e.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(names, vec!["a/b.txt", long.as_str(), long.as_str()]);
        assert_eq!(&tar[e[0].data.clone()], b"bonjour");
        assert_eq!(&tar[e[2].data.clone()], b"pax");
    }

    #[test]
    fn limits_and_paths() {
        let mut tar = Vec::new();
        for i in 0..3 {
            tar.extend(file(&format!("f{i}"), b"x", b'0'));
        }
        assert!(entries(&tar, 2).is_err());
        assert!(entries(&tar[..512], 10).is_err(), "tronquee");
        assert_eq!(clean_path("/a//./b"), Some("a/b".into()));
        assert_eq!(clean_path("a/../b"), None);
        assert_eq!(clean_path(".trash/x"), None);
    }
}
