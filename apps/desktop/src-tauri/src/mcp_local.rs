// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// MCP local (ADR-033) : Claude Desktop, Claude Code ou un autre client MCP
// local se branche sur l'appli de bureau ouverte. Memes regles que le MCP du
// serveur (un agent, ses droits, les accords « demander ») ; seule l'arrivee
// change.
//
// Transport : HTTP sur 127.0.0.1 seulement (« Streamable HTTP » sans flux
// SSE : un message JSON-RPC par POST, une reponse JSON), jeton local exige
// (Authorization: Bearer). Choisi parce qu'il n'ajoute aucune dependance
// (std::net, comme le retour de connexion d'oauth.rs) et qu'il marche avec
// l'appli deja ouverte, la ou est le vault. Pour les clients qui ne parlent
// que stdio (Claude Desktop), le meme programme sert de pont :
// `savoire-desktop --mcp-stdio` lit une ligne JSON-RPC, la poste ici, ecrit
// la reponse (voir stdio_bridge). Le jeton et le port sont dans
// `mcp-local.json`, a cote des reglages de l'appli.
//
// Ce module ne comprend pas MCP : il relaie chaque message a la fenetre
// principale (evenement « mcp-local-request ») et attend sa reponse
// (commande mcp_local_reply). C'est la page qui sert initialize, tools/list,
// tools/call (apps/web/src/agents/localMcp.ts).
//
// Protections : adresse locale seulement ; jeton compare en temps constant ;
// toute requete qui porte un en-tete Origin est refusee (une page web ne
// peut pas viser ce serveur depuis le navigateur) ; Host doit etre local
// (pas de reliure DNS) ; corps limite a 1 Mio.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const REQUEST_EVENT: &str = "mcp-local-request";
const CONFIG_FILE: &str = "mcp-local.json";
const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADERS: usize = 64 * 1024;
/// Un accord « demander » peut attendre la personne : 10 minutes au plus.
const REPLY_TIMEOUT: Duration = Duration::from_secs(600);
pub const DEFAULT_PORT: u16 = 7337;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct McpConfig {
    pub port: u16,
    pub token: String,
}

#[derive(Serialize, Clone)]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub config_file: String,
    /// Le programme a donner a un client stdio (`--mcp-stdio`).
    pub exe: String,
}

#[derive(Serialize, Clone)]
struct RequestPayload {
    id: u64,
    body: String,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

/// Les messages qui attendent la reponse de la page (mcp_local_reply).
pub(crate) type Pending = Arc<Mutex<HashMap<u64, Sender<String>>>>;

/// Passe un message a la page ; false : aucune fenetre ne l'a recu.
pub(crate) type Relay = Arc<dyn Fn(u64, String) -> bool + Send + Sync>;

pub struct McpLocal {
    config_file: PathBuf,
    running: Mutex<Option<Running>>,
    pending: Pending,
    next: Arc<AtomicU64>,
}

impl McpLocal {
    pub fn new(config_dir: &Path) -> Self {
        McpLocal {
            config_file: config_dir.join(CONFIG_FILE),
            running: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: Arc::new(AtomicU64::new(1)),
        }
    }

    fn config(&self, port: Option<u16>) -> Result<McpConfig, String> {
        let mut cfg = read_config(&self.config_file).unwrap_or(McpConfig { port: DEFAULT_PORT, token: String::new() });
        if cfg.token.len() < 32 {
            cfg.token = new_token()?;
        }
        if let Some(p) = port.filter(|p| *p >= 1024) {
            cfg.port = p;
        }
        write_config(&self.config_file, &cfg)?;
        Ok(cfg)
    }

    /// La file des reponses attendues : un autre serveur de la page (le MCP
    /// d'une demande a Claude, claude_cli.rs) repond par mcp_local_reply.
    pub(crate) fn relay_parts(&self) -> (Pending, Arc<AtomicU64>) {
        (self.pending.clone(), self.next.clone())
    }

    fn status(&self) -> McpStatus {
        let cfg = read_config(&self.config_file).unwrap_or(McpConfig { port: DEFAULT_PORT, token: String::new() });
        let running = self.running.lock().map(|r| r.as_ref().map(|x| x.port)).unwrap_or(None);
        let port = running.unwrap_or(cfg.port);
        McpStatus {
            running: running.is_some(),
            port,
            token: cfg.token,
            url: format!("http://127.0.0.1:{port}/mcp"),
            config_file: self.config_file.display().to_string(),
            exe: std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        }
    }
}

// ── Jeton et fichier de reglages ─────────────────────────────────────────────

/// 32 octets aleatoires du systeme, en hexadecimal.
pub(crate) fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    random_bytes(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn random_bytes(out: &mut [u8]) -> Result<(), String> {
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(out)).map_err(|e| format!("aleatoire indisponible : {e}"))
}

#[cfg(not(unix))]
fn random_bytes(out: &mut [u8]) -> Result<(), String> {
    // Windows : sans dependance, on melange plusieurs graines aleatoires du
    // systeme (RandomState) et l'horloge. Le jeton ne protege qu'une adresse
    // locale ; il est regenerable depuis les Parametres.
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_usize(i);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let v = h.finish().to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
    Ok(())
}

pub fn read_config(file: &Path) -> Option<McpConfig> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

fn write_config(file: &Path, cfg: &McpConfig) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// Comparaison en temps constant.
pub fn token_matches(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    if expected.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ── Requetes HTTP ────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Lit une requete HTTP/1.1 (en-tetes puis corps de Content-Length).
pub fn read_request(stream: &mut impl Read) -> Result<Request, (u16, &'static str)> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| (400, "requete illisible"))?;
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or((400, "requete illisible"))?.to_string();
    let path = parts.next().ok_or((400, "requete illisible"))?.to_string();
    let mut headers = HashMap::new();
    let mut size = line.len();
    loop {
        let mut h = String::new();
        let n = reader.read_line(&mut h).map_err(|_| (400, "en-tetes illisibles"))?;
        size += n;
        if size > MAX_HEADERS {
            return Err((431, "en-tetes trop grands"));
        }
        let h = h.trim_end();
        if n == 0 || h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return Err((413, "corps trop grand"));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|_| (400, "corps incomplet"))?;
    Ok(Request { method, path, headers, body })
}

/// Ce que le serveur fait d'une requete, avant de la relayer a la page.
#[derive(Debug, PartialEq)]
pub enum Decision {
    Relay(String),
    Reply(u16, String),
}

pub fn decide(req: &Request, token: &str) -> Decision {
    let deny = |code: u16, msg: &str| Decision::Reply(code, serde_json::json!({ "error": msg }).to_string());
    // Une page web qui viserait ce serveur porte toujours un Origin.
    if req.headers.contains_key("origin") {
        return deny(403, "Origine refusee : le MCP local ne repond qu'aux programmes du poste.");
    }
    let host = req.headers.get("host").map(|h| h.to_ascii_lowercase()).unwrap_or_default();
    let host_name = host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or(host);
    if !matches!(host_name.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return deny(403, "Hote refuse.");
    }
    if req.path.split('?').next() != Some("/mcp") {
        return deny(404, "Route inconnue : /mcp.");
    }
    let bearer = req.headers.get("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).unwrap_or("");
    if !token_matches(bearer.trim(), token) {
        return deny(401, "Jeton local absent ou faux (Parametres > Agents > MCP local).");
    }
    if req.method != "POST" {
        return Decision::Reply(405, String::new());
    }
    match String::from_utf8(req.body.clone()) {
        Ok(s) => Decision::Relay(s),
        Err(_) => deny(400, "Corps UTF-8 attendu."),
    }
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn rpc_unavailable(message: &str) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32603, "message": message } }).to_string()
}

/// Sert un ecouteur local : chaque message accepte est passe a la page par
/// `relay`, et sa reponse attendue dans `pending`.
pub(crate) fn serve(listener: TcpListener, token: String, stop: Arc<AtomicBool>, pending: Pending, next: Arc<AtomicU64>, relay: Relay) {
    for conn in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = conn else { continue };
        let (relay, token, pending, next) = (relay.clone(), token.clone(), pending.clone(), next.clone());
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
            let req = match read_request(&mut stream) {
                Ok(r) => r,
                Err((code, msg)) => return write_response(&mut stream, code, &serde_json::json!({ "error": msg }).to_string()),
            };
            let body = match decide(&req, &token) {
                Decision::Reply(code, body) => return write_response(&mut stream, code, &body),
                Decision::Relay(b) => b,
            };
            let id = next.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel();
            pending.lock().unwrap().insert(id, tx);
            if !relay(id, body) {
                pending.lock().unwrap().remove(&id);
                return write_response(&mut stream, 503, &rpc_unavailable("Savoire n'a pas de fenetre ouverte."));
            }
            match rx.recv_timeout(REPLY_TIMEOUT) {
                // Reponse vide : c'etait une notification.
                Ok(reply) if reply.is_empty() => write_response(&mut stream, 202, ""),
                Ok(reply) => write_response(&mut stream, 200, &reply),
                Err(_) => {
                    pending.lock().unwrap().remove(&id);
                    write_response(&mut stream, 503, &rpc_unavailable("Savoire n'a pas repondu a temps (vault ferme, ou accord attendu)."))
                }
            }
        });
    }
}

// ── Commandes ────────────────────────────────────────────────────────────────

/// Demarre le serveur (ou le redemarre sur un autre port) ; rend l'etat.
#[tauri::command]
pub fn mcp_local_start(app: AppHandle, state: tauri::State<'_, McpLocal>, port: Option<u16>) -> Result<McpStatus, String> {
    stop_running(&state);
    let cfg = state.config(port)?;
    // L'ancien serveur libere son port en se reveillant : quelques essais.
    let mut tries = 0;
    let listener = loop {
        match TcpListener::bind(("127.0.0.1", cfg.port)) {
            Ok(l) => break l,
            Err(e) if tries < 10 => { tries += 1; std::thread::sleep(Duration::from_millis(100)); let _ = e; }
            Err(e) => return Err(format!("port {} indisponible : {e}", cfg.port)),
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    let (pending, next) = (state.pending.clone(), state.next.clone());
    let (s, token) = (stop.clone(), cfg.token.clone());
    let relay: Relay = Arc::new(move |id, body| app.emit_to("main", REQUEST_EVENT, RequestPayload { id, body }).is_ok());
    std::thread::spawn(move || serve(listener, token, s, pending, next, relay));
    *state.running.lock().map_err(|_| "verrou empoisonne")? = Some(Running { port: cfg.port, stop });
    Ok(state.status())
}

fn stop_running(state: &McpLocal) {
    if let Some(r) = state.running.lock().ok().and_then(|mut g| g.take()) {
        r.stop.store(true, Ordering::SeqCst);
        // Debloque accept() : une connexion vers soi-meme.
        let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], r.port).into(), Duration::from_millis(300));
    }
}

#[tauri::command]
pub fn mcp_local_stop(state: tauri::State<'_, McpLocal>) -> McpStatus {
    stop_running(&state);
    state.status()
}

#[tauri::command]
pub fn mcp_local_status(state: tauri::State<'_, McpLocal>) -> McpStatus {
    state.status()
}

/// Nouveau jeton : les clients deja configures devront prendre le nouveau.
#[tauri::command]
pub fn mcp_local_new_token(app: AppHandle, state: tauri::State<'_, McpLocal>) -> Result<McpStatus, String> {
    let mut cfg = read_config(&state.config_file).unwrap_or(McpConfig { port: DEFAULT_PORT, token: String::new() });
    cfg.token = new_token()?;
    write_config(&state.config_file, &cfg)?;
    let was_running = state.running.lock().map(|r| r.is_some()).unwrap_or(false);
    if was_running {
        return mcp_local_start(app, state, Some(cfg.port));
    }
    Ok(state.status())
}

/// La page repond a un message (vide : notification, HTTP 202).
#[tauri::command]
pub fn mcp_local_reply(state: tauri::State<'_, McpLocal>, id: u64, body: String) {
    if let Some(tx) = state.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
        let _ = tx.send(body);
    }
}

// ── Pont stdio (Claude Desktop) ──────────────────────────────────────────────

/// Le dossier de configuration de l'appli, sans Tauri (meme regle que
/// app_config_dir : XDG sous Linux, Application Support sous macOS, APPDATA
/// sous Windows).
pub fn config_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join(identifier))
    }
    #[cfg(target_os = "macos")]
    {
        Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support").join(identifier))
    }
    #[cfg(target_os = "windows")]
    {
        Some(PathBuf::from(std::env::var_os("APPDATA")?).join(identifier))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = identifier;
        None
    }
}

/// POST d'un message au serveur local ; rend (statut, corps).
pub fn post(port: u16, token: &str, body: &str) -> std::io::Result<(u16, String)> {
    let mut s = TcpStream::connect(("127.0.0.1", port))?;
    s.set_read_timeout(Some(REPLY_TIMEOUT + Duration::from_secs(5)))?;
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes())?;
    let mut raw = String::new();
    s.read_to_string(&mut raw)?;
    let (head, rest) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Ok((status, rest.to_string()))
}

/// `savoire-desktop --mcp-stdio` : une ligne JSON-RPC lue, une reponse ecrite.
/// L'appli doit etre ouverte, le MCP local active.
pub fn stdio_bridge(identifier: &str) -> i32 {
    let Some(cfg) = config_dir(identifier).and_then(|d| read_config(&d.join(CONFIG_FILE))) else {
        eprintln!("Savoire : MCP local jamais active (Parametres > Agents > MCP local).");
        return 1;
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let id = serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v.get("id").cloned()).unwrap_or(serde_json::Value::Null);
        let reply = match post(cfg.port, &cfg.token, &line) {
            Ok((202, _)) => continue,
            Ok((200, body)) => body,
            Ok((code, body)) => {
                let msg = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v.get("error").and_then(|e| e.as_str().map(str::to_string)).or_else(|| v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).map(str::to_string)));
                serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": msg.unwrap_or_else(|| format!("Savoire a repondu {code}.")) } }).to_string()
            }
            Err(e) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": format!("Savoire n'est pas ouvert, ou le MCP local est coupe ({e}).") } }).to_string(),
        };
        if writeln!(out, "{}", reply.replace('\n', " ")).is_err() || out.flush().is_err() {
            break;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, headers: &[(&str, &str)], body: &str) -> Request {
        Request {
            method: method.into(),
            path: "/mcp".into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn reads_a_request() {
        let raw = b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:7337\r\nContent-Length: 2\r\nAuthorization: Bearer x\r\n\r\n{}";
        let r = read_request(&mut &raw[..]).unwrap();
        assert_eq!((r.method.as_str(), r.path.as_str(), r.body.as_slice()), ("POST", "/mcp", &b"{}"[..]));
        assert_eq!(r.headers["authorization"], "Bearer x");
    }

    #[test]
    fn guards() {
        let ok = [("host", "127.0.0.1:7337"), ("authorization", "Bearer tok-123")];
        assert_eq!(decide(&req("POST", &ok, "{}"), "tok-123"), Decision::Relay("{}".into()));
        // Jeton faux ou absent.
        assert!(matches!(decide(&req("POST", &ok, "{}"), "autre-jeton"), Decision::Reply(401, _)));
        assert!(matches!(decide(&req("POST", &[("host", "localhost")], "{}"), "tok"), Decision::Reply(401, _)));
        // Une page web (Origin) ou un autre hote : refuses.
        let web = [("host", "127.0.0.1:7337"), ("authorization", "Bearer tok-123"), ("origin", "https://evil.test")];
        assert!(matches!(decide(&req("POST", &web, "{}"), "tok-123"), Decision::Reply(403, _)));
        let rebind = [("host", "evil.test:7337"), ("authorization", "Bearer tok-123")];
        assert!(matches!(decide(&req("POST", &rebind, "{}"), "tok-123"), Decision::Reply(403, _)));
        assert!(matches!(decide(&req("GET", &ok, ""), "tok-123"), Decision::Reply(405, _)));
    }

    #[test]
    fn token_rules() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("", ""));
        let t = new_token().unwrap();
        assert_eq!(t.len(), 64);
        assert_ne!(t, new_token().unwrap());
    }

    #[test]
    fn config_round_trip() {
        let dir = std::env::temp_dir().join(format!("savoire-mcp-test-{}", std::process::id()));
        let m = McpLocal::new(&dir);
        let a = m.config(Some(7400)).unwrap();
        let b = m.config(None).unwrap();
        assert_eq!(a, b);
        assert_eq!(b.port, 7400);
        let _ = std::fs::remove_dir_all(dir);
    }
}
