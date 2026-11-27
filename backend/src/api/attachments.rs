// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes d'un vault : envoi, lecture, suppression.
//   POST   /api/v1/vaults/{vaultId}/attachments             (multipart « file », nom genere)
//   POST   /api/v1/vaults/{vaultId}/attachments/{fileId}    (rangee sous l'id du document)
//   PUT    /api/v1/vaults/{vaultId}/attachments/{fileId}/placement   { noteId, name }
//   GET    /api/v1/vaults/{vaultId}/documents/{docId}/attachments
//   GET    /api/v1/vaults/{vaultId}/attachments/{*path}
//   DELETE /api/v1/vaults/{vaultId}/attachments/{*path}
//
// Lire exige le droit de lecture sur le vault, ecrire celui d'ecriture. La
// lecture n'est pas anonyme : le client lit l'image en fetch authentifie et
// l'affiche par une URL blob:. Tout type de fichier est garde tel quel ; a la
// lecture, seules les images, videos et sons s'affichent, le reste se
// telecharge, dans un bac a sable.

use std::sync::LazyLock;

use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncReadExt;

use super::{Body, Policy, ReqParts, bad_request, client_ip, no_content, ok, rate, status};
use crate::access::{self, Level};
use crate::auth::Auth;
use crate::db::repos;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const MAX_FILE_SIZE: usize = 50 * 1024 * 1024;

static STORAGE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9]{1,8})?$").unwrap());
static FILE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());

struct Upload {
    name: String,
    content_type: String,
    bytes: Vec<u8>,
}

async fn read_file(mut mp: Multipart) -> Result<Option<Upload>, Response> {
    while let Some(field) = mp.next_field().await.map_err(|_| bad_request("Invalid form."))? {
        if field.name() != Some("file") {
            continue;
        }
        let name = field.file_name().unwrap_or("file").to_string();
        let content_type = field.content_type().unwrap_or("application/octet-stream").to_string();
        let bytes = field.bytes().await.map_err(|_| bad_request("File too large (max 50 MB)."))?;
        return Ok(Some(Upload { name, content_type, bytes: bytes.to_vec() }));
    }
    Ok(None)
}

async fn store(st: &AppState, caller: &str, ip: &str, vault_id: &str, file_id: Option<&str>, mp: Multipart) -> AppResult<Response> {
    if let Err(r) = rate(st, Policy::Upload, Some(caller), ip) {
        return Ok(r);
    }
    let file = match read_file(mp).await {
        Ok(Some(f)) => f,
        Ok(None) => return Ok(super::problem(400, "One or more validation errors occurred.", "Le champ « file » est requis.")),
        Err(r) => return Ok(r),
    };
    if file.bytes.is_empty() {
        return Ok(bad_request("Empty file."));
    }
    if file.bytes.len() > MAX_FILE_SIZE {
        return Ok(bad_request("File too large (max 50 MB)."));
    }
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, caller, vault_id, Level::Write).await?;
    st.quota.ensure_room(&st.limits(), vault_id, file.bytes.len() as i64).await?;
    let path = match file_id {
        None => st.store.write_new(vault_id, &file.name, &file.bytes).await?,
        Some(id) => {
            st.store.put(vault_id, id, &file.bytes).await?;
            // Le pair indexeur relit le fichier (texte d'un PDF, d'un Word, d'une image).
            repos::indexer_record_file(&mut c, id).await?;
            id.to_string()
        }
    };
    st.quota.added(vault_id, file.bytes.len() as i64);
    Ok(ok(&json!({ "fileName": file.name, "path": path, "size": file.bytes.len(), "contentType": file.content_type })))
}

pub async fn upload(State(st): State<AppState>, Auth(p): Auth, ReqParts(parts): ReqParts, Path(vault_id): Path<String>, mp: Multipart) -> AppResult<Response> {
    store(&st, &p.sub, &client_ip(&st, &parts), &vault_id, None, mp).await
}

pub async fn upload_with_id(
    State(st): State<AppState>,
    Auth(p): Auth,
    ReqParts(parts): ReqParts,
    Path((vault_id, file_id)): Path<(String, String)>,
    mp: Multipart,
) -> AppResult<Response> {
    // Meme route que la lecture ({*path}) : un identifiant, sans « / ».
    if !FILE_ID.is_match(&file_id) {
        return Ok(bad_request("Invalid file id."));
    }
    store(&st, &p.sub, &client_ip(&st, &parts), &vault_id, Some(&file_id), mp).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRequest {
    note_id: Option<String>,
    name: Option<String>,
}

/// PUT {fileId}/placement : rangement annonce par le client (la note dont le
/// dossier contient la piece jointe, et son nom).
pub async fn place(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, rest)): Path<(String, String)>, Body(req): Body<PlacementRequest>) -> AppResult<Response> {
    let Some(file_id) = rest.strip_suffix("/placement").map(str::to_string) else { return Ok(status(404)) };
    if !FILE_ID.is_match(&file_id) {
        return Ok(bad_request("Invalid file id."));
    }
    if let Some(n) = &req.note_id
        && !FILE_ID.is_match(n)
    {
        return Ok(bad_request("Invalid note id."));
    }
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Write).await?;
    if let Some(name) = &req.name
        && (name.encode_utf16().count() > 255 || name.contains('/'))
    {
        return Err(AppError::validation("Nom de piece jointe invalide."));
    }
    if req.note_id.as_deref() == Some(file_id.as_str()) {
        return Err(AppError::validation("Une piece jointe ne se range pas sous elle-meme."));
    }
    match repos::doc_get(&mut c, &file_id).await? {
        Some(f) if f.vault_id == vault_id => {}
        _ => return Err(AppError::denied("Piece jointe inconnue dans ce vault.")),
    }
    if let Some(note) = &req.note_id {
        match repos::doc_get(&mut c, note).await? {
            Some(n) if n.vault_id == vault_id => {}
            _ => return Err(AppError::denied("Note inconnue dans ce vault.")),
        }
    }
    repos::doc_set_placement(&mut c, &file_id, req.note_id.as_deref(), req.name.as_deref()).await?;
    Ok(no_content())
}

/// Pieces jointes rangees dans le dossier d'une note (page de partage).
pub async fn list_of_note(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, doc_id)): Path<(String, String)>) -> AppResult<Response> {
    let mut c = st.db.acquire().await?;
    access::check_document(&mut c, &p.sub, &vault_id, &doc_id, Level::Read).await?;
    let children = repos::doc_children(&mut c, &vault_id, &doc_id).await?;
    Ok(ok(&children.iter().map(|d| json!({ "id": d.doc_id, "name": d.name })).collect::<Vec<_>>()))
}

pub async fn download(
    State(st): State<AppState>,
    Auth(p): Auth,
    headers: axum::http::HeaderMap,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Response> {
    if !STORAGE_PATH.is_match(&path) {
        return Ok(bad_request("Invalid path."));
    }
    let mut c = st.db.acquire().await?;
    access::check_attachment(&mut c, &p.sub, &vault_id, &path, Level::Read).await?;
    drop(c);
    let Some(file) = st.store.read(&vault_id, &path).await? else { return Ok(status(404)) };
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
    let (mut res, sniffed) = ranged_body(file, &headers, ext.is_none()).await?;
    let (kind, download) = match ext {
        Some(e) => (content_type_of(&e).to_string(), false),
        None => {
            // Rangee sous un identifiant : le type se lit dans les premiers octets.
            let t = sniff(&sniffed);
            if t.starts_with("image/") || t.starts_with("video/") || t.starts_with("audio/") {
                (t.to_string(), false)
            } else {
                ("application/octet-stream".to_string(), true)
            }
        }
    };
    let h = res.headers_mut();
    // Rien ne s'execute jamais depuis un fichier envoye : bac a sable, type non devine.
    h.insert("content-security-policy", HeaderValue::from_static("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&kind).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    if download {
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=fichier; filename*=UTF-8''fichier"));
    }
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    Ok(res)
}

pub async fn delete(State(st): State<AppState>, Auth(p): Auth, Path((vault_id, path)): Path<(String, String)>) -> AppResult<Response> {
    if !STORAGE_PATH.is_match(&path) {
        return Ok(bad_request("Invalid path."));
    }
    let mut c = st.db.acquire().await?;
    access::check_vault(&mut c, &p.sub, &vault_id, Level::Write).await?;
    st.store.delete(&vault_id, &path).await?;
    st.quota.invalidate(&vault_id);
    Ok(no_content())
}

/// Le corps d'un fichier : entier, ou le morceau demande (Range: bytes=a-b) :
/// lecteurs video et audio, PDF ouverts page par page, applications. Seul le
/// morceau est lu sur le disque. Rend aussi ses premiers octets si `sniff`.
pub async fn ranged_body(mut file: tokio::fs::File, headers: &axum::http::HeaderMap, sniff: bool) -> AppResult<(Response, Vec<u8>)> {
    use tokio::io::AsyncSeekExt;
    let total = file.metadata().await?.len() as usize;
    let mut head = Vec::new();
    if sniff {
        head = vec![0u8; total.min(512)];
        file.read_exact(&mut head).await?;
        file.seek(std::io::SeekFrom::Start(0)).await?;
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|r| parse_range(r, total));
    let mut res = match range {
        Some((start, end)) => {
            file.seek(std::io::SeekFrom::Start(start as u64)).await?;
            let mut part = vec![0u8; end - start + 1];
            file.read_exact(&mut part).await?;
            let mut r = part.into_response();
            *r.status_mut() = axum::http::StatusCode::PARTIAL_CONTENT;
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
                r.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            r
        }
        None => {
            let mut r = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file)).into_response();
            if let Ok(v) = HeaderValue::from_str(&total.to_string()) {
                r.headers_mut().insert(header::CONTENT_LENGTH, v);
            }
            r
        }
    };
    res.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    Ok((res, head))
}

/// « bytes=a-b », « bytes=a- », « bytes=-n » : (debut, fin incluse), ou None.
fn parse_range(r: &str, total: usize) -> Option<(usize, usize)> {
    let spec = r.strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: usize = n.parse().ok()?;
            (total.saturating_sub(n), total - 1)
        }
        (a, "") => (a.parse().ok()?, total - 1),
        (a, b) => (a.parse().ok()?, b.parse::<usize>().ok()?.min(total - 1)),
    };
    (start <= end && end < total).then_some((start, end))
}

pub fn content_type_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Type d'un fichier d'apres ses premiers octets.
pub fn sniff(b: &[u8]) -> &'static str {
    let at = |offset: usize, sig: &[u8]| b.len() >= offset + sig.len() && &b[offset..offset + sig.len()] == sig;
    if at(0, &[0x89, 0x50, 0x4E, 0x47]) {
        return "image/png";
    }
    if at(0, &[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if at(0, b"GIF8") {
        return "image/gif";
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return "image/webp";
    }
    if at(4, b"ftypavi") {
        return "image/avif";
    }
    if at(4, b"ftypqt") {
        return "video/quicktime";
    }
    if at(4, b"ftypM4A") {
        return "audio/mp4";
    }
    if at(4, b"ftyp") {
        return "video/mp4";
    }
    if at(0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        return "video/webm";
    }
    if at(0, b"OggS") {
        return "audio/ogg";
    }
    if at(0, b"fLaC") {
        return "audio/flac";
    }
    if at(0, b"ID3") || at(0, &[0xFF, 0xFB]) || at(0, &[0xFF, 0xF3]) {
        return "audio/mpeg";
    }
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return "audio/wav";
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(512)]);
    let head = head.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let lower = head.get(..5).unwrap_or(head).to_ascii_lowercase();
    if lower.starts_with("<svg") || lower.starts_with("<?xml") {
        return "image/svg+xml";
    }
    "application/octet-stream"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_types() {
        assert_eq!(sniff(&[0x89, 0x50, 0x4E, 0x47, 0, 0]), "image/png");
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8"), "image/webp");
        assert_eq!(sniff(b"\0\0\0\x18ftypisom"), "video/mp4");
        assert_eq!(sniff(b"\0\0\0\x18ftypqt  "), "video/quicktime");
        assert_eq!(sniff(b"  <SVG xmlns"), "image/svg+xml");
        assert_eq!(sniff(b"%PDF-1.7"), "application/octet-stream");
        assert_eq!(sniff(b""), "application/octet-stream");
    }

    #[test]
    fn path_rules() {
        assert!(STORAGE_PATH.is_match("abc123.png"));
        assert!(STORAGE_PATH.is_match("9f0e-12"));
        assert!(!STORAGE_PATH.is_match("../etc/passwd"));
        assert!(!STORAGE_PATH.is_match("a.b.c"));
        assert!(FILE_ID.is_match("d0c-1d"));
        assert!(!FILE_ID.is_match("bad_id"));
        assert_eq!(content_type_of("jpeg"), "image/jpeg");
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=5-500", 100), Some((5, 99)));
        assert_eq!(parse_range("bytes=200-300", 100), None);
    }
}
