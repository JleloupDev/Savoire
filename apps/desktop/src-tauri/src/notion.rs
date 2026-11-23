// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion a Notion pour l'import (ADR-035), cote bureau.
//
// La page de l'application ne voit jamais le jeton : il est gardé ici, dans
// notion-connection.json (dossier de configuration, droits 0600), et chaque
// appel a l'API de Notion passe par notion_api. Le jeton vient du serveur
// Savoire, qui garde le secret de l'integration (backend/src/api/notion.rs) :
// la page recoit un ticket sur l'ecoute locale (oauth.rs) et nous le passe
// avec son « verifier » PKCE.
//
// LECTURE SEULE par construction : seules les routes de lecture de l'API de
// Notion passent (GET, et les trois POST qui ne font que lire : recherche,
// requete d'une source de donnees, requete d'une vue). Rien ne peut ecrire
// dans l'espace Notion de la personne.
//
// Les appels passent par le `curl` du systeme, comme web_fetch.rs. Les
// secrets (jeton, corps) vont par l'entree standard (`--config -`), jamais
// en argument : ils n'apparaissent pas dans la liste des processus.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

const API: &str = "https://api.notion.com";
/// Version de l'API : sources de donnees et vues (2025-09-03).
const NOTION_VERSION: &str = "2025-09-03";
const TIMEOUT_SECS: u32 = 60;
/// Reponse de l'API au plus.
const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;
/// Fichier (image, piece jointe) au plus.
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Ou Notion range les fichiers envoyes dans les pages (adresses signees).
const FILE_HOSTS: &[&str] = &[
    "prod-files-secure.s3.us-west-2.amazonaws.com",
    "s3.us-west-2.amazonaws.com",
    "file.notion.so",
    "img.notion.so",
    "www.notion.so",
];

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    /// Serveur Savoire qui a fait l'echange (et qui renouvelle le jeton).
    server: String,
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_name: Option<String>,
    #[serde(default)]
    workspace_icon: Option<String>,
}

/// Ce que la page sait de la connexion : jamais le jeton.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionStatus {
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    workspace_icon: Option<String>,
}

impl From<&Connection> for NotionStatus {
    fn from(c: &Connection) -> Self {
        NotionStatus { workspace_id: c.workspace_id.clone(), workspace_name: c.workspace_name.clone(), workspace_icon: c.workspace_icon.clone() }
    }
}

pub struct NotionConnection {
    file: PathBuf,
    current: Mutex<Option<Connection>>,
}

impl NotionConnection {
    pub fn load(dir: &Path) -> Self {
        let file = dir.join("notion-connection.json");
        let current = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Connection>(&b).ok());
        NotionConnection { file, current: Mutex::new(current) }
    }

    fn get(&self) -> Option<Connection> {
        self.current.lock().ok()?.clone()
    }

    fn set(&self, c: Option<Connection>) -> Result<(), String> {
        match &c {
            Some(c) => crate::servers::write_json(&self.file, c, true)?,
            None => {
                let _ = std::fs::remove_file(&self.file);
            }
        }
        *self.current.lock().map_err(|_| "verrou empoisonne".to_string())? = c;
        Ok(())
    }
}

// ── Regles ────────────────────────────────────────────────────────────────

/// Identifiant Notion : 32 chiffres hexadecimaux, avec ou sans tirets.
fn is_id(s: &str) -> bool {
    let hex = s.bytes().filter(|b| *b != b'-').count();
    (hex == 32) && s.len() <= 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Parametres de requete : des caracteres d'URL simples.
fn is_query(q: &str) -> bool {
    q.len() <= 512 && q.bytes().all(|b| b.is_ascii_alphanumeric() || b"_=&%.-".contains(&b))
}

/// La route est-elle une lecture permise ? `post` : les POST qui ne font que lire.
pub fn allowed_route(method: &str, path: &str) -> bool {
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (path, None),
    };
    if query.is_some_and(|q| !is_query(q)) {
        return false;
    }
    let Some(rest) = route.strip_prefix("/v1/") else { return false };
    let seg: Vec<&str> = rest.split('/').collect();
    match (method, seg.as_slice()) {
        ("POST", ["search"]) => true,
        ("POST", ["data_sources", id, "query"]) => is_id(id),
        ("POST", ["views", id, "queries"]) => is_id(id),
        ("GET", ["pages", id]) => is_id(id),
        ("GET", ["pages", id, "properties", prop]) => is_id(id) && !prop.is_empty() && prop.len() <= 64 && is_query(prop),
        ("GET", ["blocks", id]) => is_id(id),
        ("GET", ["blocks", id, "children"]) => is_id(id),
        ("GET", ["data_sources", id]) => is_id(id),
        ("GET", ["databases", id]) => is_id(id),
        ("GET", ["views"]) => true,
        ("GET", ["views", id]) => is_id(id),
        ("GET", ["views", id, "queries", q]) => is_id(id) && !q.is_empty() && q.len() <= 64 && is_query(q),
        ("GET", ["users", id]) => is_id(id),
        ("GET", ["comments"]) => true,
        _ => false,
    }
}

/// Un fichier de Notion : https, un hote de la liste, caracteres d'URL seulement.
pub fn allowed_file(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    FILE_HOSTS.contains(&host)
        && url.len() <= 4096
        && url.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~:/?#[]@!$&'()*+,;=%".contains(&b))
}

/// Chaine entre guillemets pour un fichier de configuration de curl.
fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── curl ─────────────────────────────────────────────────────────────────

struct HttpReply {
    status: u16,
    retry_after: Option<u64>,
    body: Vec<u8>,
}

/// Un appel : `config` (lignes de configuration de curl) passe par l'entree standard.
fn curl(config: &str, max_bytes: u64) -> Result<HttpReply, String> {
    let mut cmd = Command::new("curl");
    cmd.args([
        "--silent", "--show-error", "--include",
        "--proto", "=https,http", "--max-redirs", "0",
        "--max-time", &TIMEOUT_SECS.to_string(),
        "--max-filesize", &max_bytes.to_string(),
        "--user-agent", "Savoire",
        "--config", "-",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("curl introuvable : {e}"))?;
    child.stdin.take().ok_or("entree de curl fermee")?.write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("appel impossible : {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    parse_reply(&out.stdout)
}

/// Reponse de `curl --include` : la DERNIERE serie d'en-tetes, puis le corps.
fn parse_reply(raw: &[u8]) -> Result<HttpReply, String> {
    let mut rest = raw;
    loop {
        let end = rest.windows(4).position(|w| w == b"\r\n\r\n").ok_or("reponse sans en-tetes")?;
        let head = String::from_utf8_lossy(&rest[..end]).to_string();
        let body = &rest[end + 4..];
        let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("statut illisible")?;
        // 1xx (100 Continue) : la vraie reponse suit.
        if (100..200).contains(&status) {
            rest = body;
            continue;
        }
        let retry_after = head
            .lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("retry-after")).map(|(_, v)| v.trim().to_string()))
            .and_then(|v| v.parse().ok());
        return Ok(HttpReply { status, retry_after, body: body.to_vec() });
    }
}

fn api_config(token: &str, method: &str, path: &str, body: Option<&str>) -> String {
    let mut c = format!(
        "url = {}\nrequest = {}\nheader = {}\nheader = {}\n",
        quoted(&format!("{API}{path}")),
        quoted(method),
        quoted(&format!("Authorization: Bearer {token}")),
        quoted(&format!("Notion-Version: {NOTION_VERSION}")),
    );
    if let Some(b) = body {
        c.push_str(&format!("header = {}\ndata-binary = {}\n", quoted("Content-Type: application/json"), quoted(b)));
    }
    c
}

fn server_post(server: &str, path: &str, body: &serde_json::Value) -> Result<HttpReply, String> {
    let url = format!("{}{path}", server.trim_end_matches('/'));
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = {}\ndata-binary = {}\n",
        quoted(&url),
        quoted("Content-Type: application/json"),
        quoted(&body.to_string()),
    );
    curl(&config, 1024 * 1024)
}

fn connection_of(server: &str, v: &serde_json::Value, previous: Option<&Connection>) -> Option<Connection> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(Connection {
        server: server.to_string(),
        access_token: s("accessToken")?,
        refresh_token: s("refreshToken").or_else(|| previous.and_then(|p| p.refresh_token.clone())),
        workspace_id: s("workspaceId").or_else(|| previous.and_then(|p| p.workspace_id.clone())),
        workspace_name: s("workspaceName").or_else(|| previous.and_then(|p| p.workspace_name.clone())),
        workspace_icon: s("workspaceIcon").or_else(|| previous.and_then(|p| p.workspace_icon.clone())),
    })
}

/// Jeton expire : un neuf par le serveur. None si impossible.
fn refresh(conn: &Connection) -> Option<Connection> {
    let rt = conn.refresh_token.as_deref()?;
    let r = server_post(&conn.server, "/api/v1/notion/refresh", &serde_json::json!({ "refreshToken": rt })).ok()?;
    if r.status != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&r.body).ok()?;
    connection_of(&conn.server, &v, Some(conn))
}

// ── Commandes ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn notion_status(conn: State<'_, NotionConnection>) -> Option<NotionStatus> {
    conn.get().as_ref().map(NotionStatus::from)
}

/// Reprend le jeton aupres du serveur (ticket recu sur l'ecoute locale).
#[tauri::command]
pub async fn notion_connect(
    conn: State<'_, NotionConnection>,
    server: String,
    ticket: String,
    state: String,
    verifier: String,
) -> Result<NotionStatus, String> {
    let server = crate::servers::validate_url(&server)?;
    let body = serde_json::json!({ "ticket": ticket, "state": state, "verifier": verifier });
    let s = server.clone();
    let r = tauri::async_runtime::spawn_blocking(move || server_post(&s, "/api/v1/notion/ticket", &body))
        .await
        .map_err(|e| e.to_string())??;
    if r.status != 200 {
        return Err(match r.status {
            404 => "Autorisation expirée : recommencez.".into(),
            403 => "Autorisation refusée.".into(),
            s => format!("Le serveur a refusé la connexion ({s})."),
        });
    }
    let v: serde_json::Value = serde_json::from_slice(&r.body).map_err(|_| "réponse du serveur illisible".to_string())?;
    let c = connection_of(&server, &v, None).ok_or("réponse du serveur sans jeton")?;
    let status = NotionStatus::from(&c);
    conn.set(Some(c))?;
    Ok(status)
}

#[tauri::command]
pub fn notion_disconnect(conn: State<'_, NotionConnection>) -> Result<(), String> {
    conn.set(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiReply {
    status: u16,
    retry_after: Option<u64>,
    body: String,
}

/// Un appel de LECTURE a l'API de Notion (voir allowed_route).
#[tauri::command]
pub async fn notion_api(
    conn: State<'_, NotionConnection>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ApiReply, String> {
    let method = method.to_ascii_uppercase();
    if !allowed_route(&method, &path) {
        return Err(format!("appel refusé : {method} {path}"));
    }
    if body.as_ref().is_some_and(|b| b.len() > 64 * 1024 || method != "POST") {
        return Err("corps refusé".into());
    }
    let current = conn.get().ok_or("Notion n'est pas connecté.")?;
    let (m, p, b) = (method.clone(), path.clone(), body.clone());
    let token = current.access_token.clone();
    let mut reply = tauri::async_runtime::spawn_blocking(move || curl(&api_config(&token, &m, &p, b.as_deref()), MAX_JSON_BYTES))
        .await
        .map_err(|e| e.to_string())??;
    if reply.status == 401 {
        let c = current.clone();
        if let Some(fresh) = tauri::async_runtime::spawn_blocking(move || refresh(&c)).await.map_err(|e| e.to_string())? {
            let token = fresh.access_token.clone();
            conn.set(Some(fresh))?;
            reply = tauri::async_runtime::spawn_blocking(move || curl(&api_config(&token, &method, &path, body.as_deref()), MAX_JSON_BYTES))
                .await
                .map_err(|e| e.to_string())??;
        }
    }
    Ok(ApiReply { status: reply.status, retry_after: reply.retry_after, body: String::from_utf8_lossy(&reply.body).into_owned() })
}

/// Un fichier d'une page Notion (image, piece jointe), par son adresse signee.
#[tauri::command]
pub async fn notion_download(url: String) -> Result<Response, String> {
    if !allowed_file(&url) {
        return Err(format!("adresse refusée : {url}"));
    }
    let config = format!("url = {}\n", quoted(&url));
    let r = tauri::async_runtime::spawn_blocking(move || curl(&config, MAX_FILE_BYTES)).await.map_err(|e| e.to_string())??;
    if r.status != 200 {
        return Err(format!("fichier indisponible ({})", r.status));
    }
    Ok(Response::new(r.body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const DASHED: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn lecture_seule() {
        assert!(allowed_route("POST", "/v1/search"));
        assert!(allowed_route("GET", &format!("/v1/blocks/{ID}/children?page_size=100&start_cursor={DASHED}")));
        assert!(allowed_route("GET", &format!("/v1/pages/{DASHED}")));
        assert!(allowed_route("POST", &format!("/v1/data_sources/{ID}/query")));
        assert!(allowed_route("GET", &format!("/v1/views?database_id={ID}")));
        // Ecritures : jamais.
        assert!(!allowed_route("PATCH", &format!("/v1/pages/{ID}")));
        assert!(!allowed_route("POST", "/v1/pages"));
        assert!(!allowed_route("DELETE", &format!("/v1/blocks/{ID}")));
        assert!(!allowed_route("PATCH", &format!("/v1/blocks/{ID}/children")));
        assert!(!allowed_route("POST", &format!("/v1/blocks/{ID}/children")));
        assert!(!allowed_route("POST", "/v1/comments"));
        // Formes douteuses.
        assert!(!allowed_route("GET", "/v1/pages/../oauth/token"));
        assert!(!allowed_route("GET", "/v1/pages/xyz"));
        assert!(!allowed_route("GET", &format!("/v1/blocks/{ID}/children?a=b c")));
        assert!(!allowed_route("GET", "https://evil.example/v1/search"));
    }

    #[test]
    fn fichiers_de_notion_seulement() {
        assert!(allowed_file("https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/image.png?X-Amz-Signature=abc"));
        assert!(!allowed_file("http://prod-files-secure.s3.us-west-2.amazonaws.com/a.png"));
        assert!(!allowed_file("https://evil.example/a.png"));
        assert!(!allowed_file("https://s3.us-west-2.amazonaws.com.evil.example/a.png"));
        assert!(!allowed_file("https://file.notion.so/a\nb"));
    }

    #[test]
    fn configuration_echappee() {
        assert_eq!(quoted("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }

    #[test]
    fn reponse_avec_continue() {
        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/2 429\r\nretry-after: 7\r\ncontent-type: application/json\r\n\r\n{\"x\":1}";
        let r = parse_reply(raw).unwrap();
        assert_eq!(r.status, 429);
        assert_eq!(r.retry_after, Some(7));
        assert_eq!(r.body, b"{\"x\":1}");
    }
}
