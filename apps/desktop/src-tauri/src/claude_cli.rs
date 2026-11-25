// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Claude avec l'abonnement de la personne (plugin-ai-claude-code), bureau
// seulement. Savoire lance le programme `claude` (Claude Code) que la
// personne a installe et connecte elle-meme. Il ne lit, ne copie ni ne
// reutilise jamais ses fichiers de session ou d'identifiants : c'est
// `claude` qui s'en sert, comme dans un terminal.
//
// Mode non interactif, en flux JSON :
// `claude -p --input-format stream-json --output-format stream-json --verbose`.
// La demande part par l'entree standard, jamais en argument (elle
// n'apparait pas dans la liste des processus). Les consignes systeme et la
// config MCP vont dans des fichiers 0600, effaces a la fin de la demande.
// Chaque ligne de sortie remonte a la fenetre qui a lance la demande
// (evenement « claude-cli ») ; la page la lit
// (packages/application/src/claudeCli.ts).
//
// Outils : aucun outil de Claude Code (--tools ""), aucun serveur MCP de la
// personne (--strict-mcp-config), rien qui demanderait un accord dans un
// terminal (--permission-mode dontAsk). Seuls les outils de Savoire, par un
// MCP propre a la demande : 127.0.0.1, port au hasard, jeton neuf, ferme
// avec la demande. Ses messages vont a la page (memes droits et memes
// accords que l'agent qui demande) ; la reponse revient par
// mcp_local_reply, comme pour le MCP local.
//
// Le programme : celui que la personne a choisi dans une boite de dialogue
// (claude-cli.json), sinon `claude` cherche dans le PATH et quelques
// dossiers d'installation connus. La page ne donne jamais de chemin : elle
// ne peut pas faire lancer un autre programme. Les arguments sont une
// liste, sans shell.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::mcp_local::{self, McpLocal, Relay};

pub const EVENT: &str = "claude-cli";
const CONFIG_FILE: &str = "claude-cli.json";
/// Filet de securite : la page coupe bien avant (silence, attente d'un outil).
const MAX_RUN: Duration = Duration::from_secs(30 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// Demandes en meme temps, au plus.
const MAX_RUNS: usize = 4;
/// Une ligne de sortie plus longue est ignoree.
const MAX_LINE: usize = 16 * 1024 * 1024;
/// La demande et ses consignes, au plus.
const MAX_INPUT: usize = 8 * 1024 * 1024;
const STDERR_TAIL: usize = 8 * 1024;
/// Le serveur MCP de la demande, tel que Claude le voit (outils mcp__savoire__*).
const MCP_SERVER: &str = "savoire";
/// Consignes quand la demande n'en a pas : pas celles d'un assistant de code.
const DEFAULT_SYSTEM: &str = "Tu réponds à une demande faite depuis Savoire, une application de notes. Réponds dans la langue de la demande, en Markdown.";

const NOT_FOUND: &str = "Claude Code est introuvable sur cet ordinateur. Installez-le (https://claude.com/claude-code), puis lancez « claude » une fois dans un terminal pour vous connecter. S’il est déjà installé, choisissez le programme dans Paramètres → IA.";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Ce que la page voit ──────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Programme choisi par la personne (sinon : cherche dans le PATH).
    pub chosen: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// Identifiant de la demande, choisi par la page.
    pub run: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Consignes systeme (vide : consignes par defaut).
    #[serde(default)]
    pub system: String,
    /// Le message, envoye par l'entree standard.
    pub prompt: String,
    /// Les outils de Savoire (MCP de la demande).
    #[serde(default)]
    pub tools: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    /// Une ligne de la sortie (un objet JSON du flux).
    Line { run: String, line: String },
    /// Un message du MCP de la demande ; la page repond par mcp_local_reply.
    Mcp { run: String, id: u64, body: String },
    /// Fin du programme : reason vaut exit, cancel ou timeout.
    Exit { run: String, code: Option<i32>, reason: String, stderr: String },
}

// ── Construction de la commande ──────────────────────────────────────────────

/// Identifiant de demande : lettres, chiffres et tirets.
pub fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Un nom de modele (« sonnet », « claude-opus-4-1 », « opus[1m] »), jamais une option.
pub fn valid_model(m: &str) -> bool {
    m.len() <= 100
        && m.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && m.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]".contains(c))
}

/// Le fichier choisi doit etre le programme claude, pas un autre.
pub fn program_name_ok(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).map(str::to_ascii_lowercase);
    matches!(name.as_deref(), Some("claude" | "claude.exe" | "claude.cmd"))
}

/// Les arguments de `claude`, dans cet ordre (les options a plusieurs
/// valeurs, --tools, --mcp-config, --allowedTools, sont suivies d'une autre
/// option ou finissent la liste).
pub fn build_args(model: Option<&str>, system_file: &Path, mcp_file: Option<&Path>) -> Result<Vec<OsString>, String> {
    let mut args: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Rien de la conversation n'est garde par Claude Code sur le disque.
        "--no-session-persistence",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--tools",
        "",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push("--system-prompt-file".into());
    args.push(system_file.into());
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        if !valid_model(m) {
            return Err(format!("Nom de modèle invalide : « {m} »."));
        }
        args.push(format!("--model={m}").into());
    }
    if let Some(file) = mcp_file {
        args.push("--mcp-config".into());
        args.push(file.into());
        args.push("--allowedTools".into());
        args.push(format!("mcp__{MCP_SERVER}").into());
    }
    Ok(args)
}

/// Le message de la personne, en une ligne du flux JSON d'entree. Un texte
/// qui commence par « / » serait lu comme une commande de Claude Code : il
/// est precede d'un mot.
pub fn user_line(prompt: &str) -> String {
    let content = if prompt.trim_start().starts_with('/') { format!("Demande :\n{prompt}") } else { prompt.to_string() };
    let mut line = serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string();
    line.push('\n');
    line
}

/// La config MCP de la demande : le serveur local, son jeton en en-tete.
pub fn mcp_config(port: u16, token: &str) -> String {
    serde_json::json!({
        "mcpServers": {
            MCP_SERVER: {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp"),
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    })
    .to_string()
}

// ── Trouver le programme ─────────────────────────────────────────────────────

#[cfg(windows)]
const PROGRAM_NAMES: &[&str] = &["claude.exe", "claude.cmd"];
#[cfg(not(windows))]
const PROGRAM_NAMES: &[&str] = &["claude"];

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Le premier `claude` du PATH, puis des dossiers donnes.
pub fn find_program(path_var: Option<&OsStr>, extra: &[PathBuf]) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    dirs.iter()
        .chain(extra.iter())
        .flat_map(|d| PROGRAM_NAMES.iter().map(move |n| d.join(n)))
        .find(|p| is_executable(p))
}

/// Ou les installateurs de Claude Code le posent, pour une appli lancee hors
/// d'un terminal (son PATH est souvent plus court). Jamais dans ~/.claude.
fn known_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut dirs = Vec::new();
        if let Some(home) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(home).join(".local").join("bin"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        dirs
    }
    #[cfg(not(windows))]
    {
        let mut dirs = Vec::new();
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".npm-global/bin"));
        }
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs
    }
}

/// La commande de base : sans fenetre sous Windows, et un PATH qui commence
/// par le dossier du programme (un `#!/usr/bin/env node` y trouve node).
fn base_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    if let Some(dir) = program.parent().filter(|d| !d.as_os_str().is_empty()) {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&p));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    // L'abonnement de la personne, pas une cle d'API trouvee dans l'environnement.
    cmd.env_remove("ANTHROPIC_API_KEY");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn wait_with_limit(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_tree(child);
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// `claude --version` (premiere ligne).
pub fn version_of(program: &Path) -> Result<String, String> {
    let mut cmd = base_command(program);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| spawn_error(&e, program))?;
    let out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out {
            let _ = o.take(4096).read_to_string(&mut s);
        }
        s
    });
    let Some(status) = wait_with_limit(&mut child, VERSION_TIMEOUT) else {
        return Err("Claude Code ne répond pas (claude --version).".into());
    };
    let text = reader.join().unwrap_or_default();
    let line = text.lines().next().unwrap_or("").trim().to_string();
    if !status.success() || line.is_empty() {
        return Err("Claude Code ne répond pas comme prévu (claude --version).".into());
    }
    Ok(line)
}

fn spawn_error(e: &std::io::Error, program: &Path) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => NOT_FOUND.into(),
        std::io::ErrorKind::PermissionDenied => format!("Savoire ne peut pas lancer {} (droits du fichier).", program.display()),
        _ => format!("Impossible de lancer Claude Code ({}) : {e}", program.display()),
    }
}

/// Ou en est le programme : choisi ou trouve, et sa version.
pub fn status_of(chosen: Option<PathBuf>, path_var: Option<&OsStr>, extra: &[PathBuf]) -> ClaudeStatus {
    let is_chosen = chosen.is_some();
    let path = chosen.or_else(|| find_program(path_var, extra));
    let Some(path) = path else {
        return ClaudeStatus { found: false, path: None, version: None, chosen: false, error: Some(NOT_FOUND.into()) };
    };
    let shown = Some(path.display().to_string());
    if !is_executable(&path) {
        return ClaudeStatus {
            found: false,
            path: shown,
            version: None,
            chosen: is_chosen,
            error: Some("Le programme choisi n’existe plus, ou ne peut pas être lancé : choisissez-le de nouveau.".into()),
        };
    }
    match version_of(&path) {
        Ok(v) => ClaudeStatus { found: true, path: shown, version: Some(v), chosen: is_chosen, error: None },
        Err(e) => ClaudeStatus { found: true, path: shown, version: None, chosen: is_chosen, error: Some(e) },
    }
}

// ── Lancer et suivre une demande ─────────────────────────────────────────────

pub struct RunSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// Ce qui part par l'entree standard, qui est ensuite fermee.
    pub stdin: String,
    pub limit: Duration,
}

/// De quoi arreter une demande.
#[derive(Clone)]
pub struct RunHandle {
    child: Arc<Mutex<Child>>,
    cancel: Arc<AtomicBool>,
}

impl RunHandle {
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut c) = self.child.lock() {
            kill_tree(&mut c);
        }
    }
}

/// Arrete le programme. Sous Windows, avec ses enfants (un claude.cmd lance node).
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
}

/// Lit la sortie ligne a ligne (lignes vides et trop longues ignorees).
fn pump_lines(out: impl Read, on_line: &dyn Fn(String)) {
    let mut reader = BufReader::new(out);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if buf.len() > MAX_LINE {
                    continue;
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\r', '\n']);
                if !line.trim().is_empty() {
                    on_line(line.to_string());
                }
            }
        }
    }
}

/// Lance le programme : l'entree est ecrite puis fermee, chaque ligne de
/// sortie va a `on_line`, puis `on_exit` recoit le code, la raison (exit,
/// cancel, timeout) et la fin de la sortie d'erreur.
pub fn spawn_run(
    spec: RunSpec,
    on_line: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(Option<i32>, &'static str, String) + Send + 'static,
) -> std::io::Result<RunHandle> {
    let mut cmd = base_command(&spec.program);
    cmd.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let input = spec.stdin;
    std::thread::spawn(move || {
        if let Some(mut s) = stdin {
            let _ = s.write_all(input.as_bytes());
            let _ = s.flush();
        }
    });
    let (out_done, out_wait) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        if let Some(o) = stdout {
            pump_lines(o, &on_line);
        }
        let _ = out_done.send(());
    });
    let (err_tx, err_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut e) = stderr {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = e.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > STDERR_TAIL {
                    tail.drain(..tail.len() - STDERR_TAIL);
                }
            }
        }
        let _ = err_tx.send(String::from_utf8_lossy(&tail).into_owned());
    });
    let handle = RunHandle { child: Arc::new(Mutex::new(child)), cancel: Arc::new(AtomicBool::new(false)) };
    let h = handle.clone();
    let limit = spec.limit;
    std::thread::spawn(move || {
        let start = Instant::now();
        let mut reason = "exit";
        let code = loop {
            let status = h.child.lock().map(|mut c| c.try_wait());
            match status {
                Ok(Ok(Some(s))) => {
                    // Tue par stop() juste avant : c'est un arret, pas une fin.
                    if reason == "exit" && h.cancel.load(Ordering::SeqCst) {
                        reason = "cancel";
                    }
                    break s.code();
                }
                Ok(Ok(None)) => {}
                _ => break None,
            }
            if reason == "exit" && h.cancel.load(Ordering::SeqCst) {
                reason = "cancel";
                h.stop();
            } else if reason == "exit" && start.elapsed() > limit {
                reason = "timeout";
                h.stop();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        // Un petit-enfant qui garderait la sortie ouverte ne bloque pas la fin.
        let _ = out_wait.recv_timeout(Duration::from_secs(3));
        let stderr = err_rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
        on_exit(code, reason, stderr);
    });
    Ok(handle)
}

// ── Fichiers et MCP d'une demande ────────────────────────────────────────────

fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(file: &Path, content: &str) -> Result<(), String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(file).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

/// Le dossier d'une demande (consignes, config MCP) : efface avec elle.
struct RunFiles(PathBuf);

impl Drop for RunFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Le MCP d'une demande : ferme avec elle.
struct RunMcp {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
}

impl RunMcp {
    fn open(relay: Relay, mcp: &McpLocal) -> Result<RunMcp, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("MCP de la demande : {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = mcp_local::new_token()?;
        let stop = Arc::new(AtomicBool::new(false));
        let (pending, next) = mcp.relay_parts();
        let (t, s) = (token.clone(), stop.clone());
        std::thread::spawn(move || mcp_local::serve(listener, t, s, pending, next, relay));
        Ok(RunMcp { port, token, stop })
    }
}

impl Drop for RunMcp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Debloque accept() : une connexion vers soi-meme.
        let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], self.port).into(), Duration::from_millis(300));
    }
}

// ── Etat et commandes ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    program: Option<PathBuf>,
}

pub struct ClaudeCli {
    config_file: PathBuf,
    work_dir: PathBuf,
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
}

impl ClaudeCli {
    pub fn new(config_dir: &Path, cache_dir: &Path) -> Self {
        let work_dir = cache_dir.join("claude-cli");
        // Restes d'une demande interrompue (appli fermee en cours) : effaces.
        let _ = std::fs::remove_dir_all(&work_dir);
        ClaudeCli { config_file: config_dir.join(CONFIG_FILE), work_dir, runs: Arc::new(Mutex::new(HashMap::new())) }
    }

    fn chosen(&self) -> Option<PathBuf> {
        let text = std::fs::read_to_string(&self.config_file).ok()?;
        serde_json::from_str::<Config>(&text).ok()?.program
    }

    fn save(&self, program: Option<PathBuf>) -> Result<(), String> {
        if let Some(dir) = self.config_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(&Config { program }).map_err(|e| e.to_string())?;
        std::fs::write(&self.config_file, text).map_err(|e| e.to_string())
    }

    /// Le programme a lancer : celui choisi, sinon celui du PATH.
    fn program(&self) -> Result<PathBuf, String> {
        if let Some(p) = self.chosen() {
            if !is_executable(&p) {
                return Err(format!("Le programme choisi pour Claude Code n’existe plus ({}) : choisissez-le de nouveau dans Paramètres → IA.", p.display()));
            }
            return Ok(p);
        }
        find_program(std::env::var_os("PATH").as_deref(), &known_dirs()).ok_or_else(|| NOT_FOUND.to_string())
    }
}

async fn status_now(chosen: Option<PathBuf>) -> Result<ClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_of(chosen, std::env::var_os("PATH").as_deref(), &known_dirs()))
        .await
        .map_err(|e| e.to_string())
}

/// Le programme claude : trouve ou non, sa version.
#[tauri::command]
pub async fn claude_cli_status(state: State<'_, ClaudeCli>) -> Result<ClaudeStatus, String> {
    status_now(state.chosen()).await
}

/// « Choisir le programme… » : la boite de dialogue s'ouvre ici, la page ne
/// donne jamais de chemin. forget : revenir au PATH.
#[tauri::command]
pub async fn claude_cli_choose(app: AppHandle, window: WebviewWindow, state: State<'_, ClaudeCli>, forget: Option<bool>) -> Result<ClaudeStatus, String> {
    if forget == Some(true) {
        state.save(None)?;
    } else {
        let dialog = app.dialog().file().set_title("Où est le programme claude (Claude Code) ?").set_parent(&window);
        if let Some(choice) = dialog.blocking_pick_file() {
            let path = choice.into_path().map_err(|e| e.to_string())?;
            if !program_name_ok(&path) {
                return Err("Choisissez le programme « claude » de Claude Code, pas un autre fichier.".into());
            }
            state.save(Some(path))?;
        }
    }
    status_now(state.chosen()).await
}

/// Lance une demande. Sa sortie arrive par l'evenement « claude-cli », a la
/// fenetre qui l'a lancee seulement.
#[tauri::command]
pub async fn claude_cli_start(app: AppHandle, window: WebviewWindow, state: State<'_, ClaudeCli>, mcp: State<'_, McpLocal>, request: StartRequest) -> Result<(), String> {
    if !valid_run_id(&request.run) {
        return Err("Demande invalide.".into());
    }
    if request.prompt.len() + request.system.len() > MAX_INPUT {
        return Err("Demande trop longue pour Claude Code.".into());
    }
    let mut runs = state.runs.lock().map_err(|_| "verrou empoisonne")?;
    if runs.contains_key(&request.run) {
        return Err("Demande déjà lancée.".into());
    }
    if runs.len() >= MAX_RUNS {
        return Err("Trop de demandes à Claude en même temps : attendez la fin d’une autre.".into());
    }
    let program = state.program()?;
    let run = request.run.clone();
    let label = window.label().to_string();

    let cwd = state.work_dir.join("vide");
    create_private_dir(&cwd)?;
    let files = RunFiles(state.work_dir.join(&run));
    create_private_dir(&files.0)?;
    let system_file = files.0.join("consignes.md");
    let system = if request.system.trim().is_empty() { DEFAULT_SYSTEM } else { request.system.as_str() };
    write_private(&system_file, system)?;

    let run_mcp = if request.tools {
        let (app, label, run) = (app.clone(), label.clone(), run.clone());
        let relay: Relay = Arc::new(move |id, body| app.emit_to(label.as_str(), EVENT, RunEvent::Mcp { run: run.clone(), id, body }).is_ok());
        let m = RunMcp::open(relay, &mcp)?;
        write_private(&files.0.join("mcp.json"), &mcp_config(m.port, &m.token))?;
        Some(m)
    } else {
        None
    };
    let mcp_file = files.0.join("mcp.json");
    let args = build_args(request.model.as_deref(), &system_file, run_mcp.as_ref().map(|_| mcp_file.as_path()))?;
    let spec = RunSpec { program: program.clone(), args, cwd, stdin: user_line(&request.prompt), limit: MAX_RUN };

    let (line_app, line_label, line_run) = (app.clone(), label.clone(), run.clone());
    let on_line = move |line: String| {
        let _ = line_app.emit_to(line_label.as_str(), EVENT, RunEvent::Line { run: line_run.clone(), line });
    };
    let all = state.runs.clone();
    let exit_run = run.clone();
    let on_exit = move |code: Option<i32>, reason: &'static str, stderr: String| {
        // Le MCP et les fichiers de la demande partent avec elle.
        drop(run_mcp);
        drop(files);
        if let Ok(mut r) = all.lock() {
            r.remove(&exit_run);
        }
        let _ = app.emit_to(label.as_str(), EVENT, RunEvent::Exit { run: exit_run.clone(), code, reason: reason.into(), stderr });
    };
    let handle = spawn_run(spec, on_line, on_exit).map_err(|e| spawn_error(&e, &program))?;
    runs.insert(run, handle);
    Ok(())
}

/// Arrete une demande (la page : bouton Arreter, delai depasse).
#[tauri::command]
pub async fn claude_cli_cancel(state: State<'_, ClaudeCli>, run: String) -> Result<(), String> {
    let handle = state.runs.lock().ok().and_then(|r| r.get(&run).cloned());
    if let Some(h) = handle {
        h.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn command_without_tools() {
        let args = strings(&build_args(Some("sonnet"), Path::new("/tmp/r/consignes.md"), None).unwrap());
        for flag in ["-p", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"] {
            assert!(args.contains(&flag.to_string()), "{flag}");
        }
        let at = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert_eq!(args[at("--input-format") + 1], "stream-json");
        assert_eq!(args[at("--output-format") + 1], "stream-json");
        assert_eq!(args[at("--permission-mode") + 1], "dontAsk");
        // Aucun outil de Claude Code ; la liste vide est suivie d'une autre option.
        assert_eq!(args[at("--tools") + 1], "");
        assert!(args[at("--tools") + 2].starts_with("--"));
        assert_eq!(args[at("--system-prompt-file") + 1], "/tmp/r/consignes.md");
        assert!(args.contains(&"--model=sonnet".to_string()));
        assert!(!args.iter().any(|a| a == "--mcp-config" || a == "--allowedTools"));
    }

    #[test]
    fn command_with_tools() {
        let args = strings(&build_args(None, Path::new("/r/c.md"), Some(Path::new("/r/mcp.json"))).unwrap());
        let at = |f: &str| args.iter().position(|a| a == f).unwrap();
        assert_eq!(args[at("--mcp-config") + 1], "/r/mcp.json");
        assert_eq!(args[at("--allowedTools") + 1], "mcp__savoire");
        // Les options a plusieurs valeurs ne mangent rien d'autre.
        assert_eq!(at("--allowedTools") + 2, args.len());
        assert!(!args.iter().any(|a| a.starts_with("--model")));
    }

    #[test]
    fn models_are_names_not_options() {
        for ok in ["sonnet", "opus", "claude-opus-4-1", "opus[1m]", "claude-3.5:latest"] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in ["--dangerously-skip-permissions", "-p", "a b", "x;rm", "", "ü"] {
            assert!(!valid_model(bad), "{bad}");
        }
        assert!(build_args(Some("--tools=default"), Path::new("/c.md"), None).is_err());
        // Vide : le modele de Claude Code.
        assert!(!strings(&build_args(Some("  "), Path::new("/c.md"), None).unwrap()).iter().any(|a| a.starts_with("--model")));
    }

    #[test]
    fn prompt_goes_by_stdin_in_one_line() {
        let line = user_line("Bonjour\n« notes »\n\"x\"");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "Bonjour\n« notes »\n\"x\"");
        // Jamais une commande de Claude Code.
        let v: serde_json::Value = serde_json::from_str(user_line("  /compact tout").trim_end()).unwrap();
        assert!(!v["message"]["content"].as_str().unwrap().trim_start().starts_with('/'));
    }

    #[test]
    fn mcp_config_points_to_the_local_server() {
        let v: serde_json::Value = serde_json::from_str(&mcp_config(41234, "abc")).unwrap();
        let s = &v["mcpServers"]["savoire"];
        assert_eq!(s["type"], "http");
        assert_eq!(s["url"], "http://127.0.0.1:41234/mcp");
        assert_eq!(s["headers"]["Authorization"], "Bearer abc");
    }

    #[test]
    fn run_ids_and_program_names() {
        assert!(valid_run_id("3f2a-99"));
        assert!(!valid_run_id("../x"));
        assert!(!valid_run_id(""));
        assert!(program_name_ok(Path::new("/usr/local/bin/claude")));
        assert!(program_name_ok(Path::new("C:/Users/a/AppData/Roaming/npm/claude.cmd")));
        assert!(program_name_ok(Path::new("/x/Claude.EXE")));
        assert!(!program_name_ok(Path::new("/bin/sh")));
        assert!(!program_name_ok(Path::new("/x/claude.sh")));
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        fn temp_dir(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("savoire-claude-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// Un faux `claude` : un script shell.
        fn fake_claude(dir: &Path, body: &str) -> PathBuf {
            let path = dir.join("claude");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        type Exit = (Option<i32>, &'static str, String);

        fn run_in(program: PathBuf, args: Vec<OsString>, cwd: PathBuf, stdin: String, limit: Duration) -> (Vec<String>, Exit) {
            run_with(program, args, cwd, stdin, limit, None)
        }

        fn run(program: PathBuf, args: Vec<OsString>, stdin: String, limit: Duration, cancel_after: Option<Duration>) -> (Vec<String>, Exit) {
            let cwd = program.parent().unwrap().to_path_buf();
            run_with(program, args, cwd, stdin, limit, cancel_after)
        }

        fn run_with(program: PathBuf, args: Vec<OsString>, cwd: PathBuf, stdin: String, limit: Duration, cancel_after: Option<Duration>) -> (Vec<String>, Exit) {
            let lines = Arc::new(Mutex::new(Vec::new()));
            let (tx, rx) = mpsc::channel::<Exit>();
            let l = lines.clone();
            // « Text file busy » : un autre test a pu lancer un programme pendant l'ecriture du script.
            let mut tries = 0;
            let handle = loop {
                let (l, tx) = (l.clone(), tx.clone());
                let spec = RunSpec { program: program.clone(), args: args.clone(), cwd: cwd.clone(), stdin: stdin.clone(), limit };
                match spawn_run(spec, move |line| l.lock().unwrap().push(line), move |c, r, e| { let _ = tx.send((c, r, e)); }) {
                    Ok(h) => break h,
                    Err(e) if e.raw_os_error() == Some(26) && tries < 20 => { tries += 1; std::thread::sleep(Duration::from_millis(50)); }
                    Err(e) => panic!("{e}"),
                }
            };
            if let Some(d) = cancel_after {
                std::thread::sleep(d);
                handle.stop();
            }
            let exit = rx.recv_timeout(limit + Duration::from_secs(20)).expect("fin du programme");
            let out = lines.lock().unwrap().clone();
            (out, exit)
        }

        #[test]
        fn stdin_stdout_stderr_and_code() {
            let dir = temp_dir("io");
            let program = fake_claude(&dir, "read -r line\necho '{\"type\":\"system\",\"subtype\":\"init\"}'\necho\nprintf '%s\\n' \"$line\"\necho \"args: $*\" >&2\nexit 3");
            let args = build_args(Some("haiku"), &dir.join("c.md"), None).unwrap();
            let (lines, (code, reason, stderr)) = run(program, args, user_line("Salut « toi »"), Duration::from_secs(10), None);
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert_eq!(lines[0], "{\"type\":\"system\",\"subtype\":\"init\"}");
            let v: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
            assert_eq!(v["message"]["content"], "Salut « toi »");
            assert_eq!((code, reason), (Some(3), "exit"));
            assert!(stderr.contains("args: -p --input-format stream-json"), "{stderr}");
            // Le message n'est jamais en argument.
            assert!(!stderr.contains("Salut"));
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn cancel_and_timeout_kill_the_program() {
            let dir = temp_dir("kill");
            let program = fake_claude(&dir, "echo debut\nexec sleep 30");
            let start = Instant::now();
            let (lines, (_, reason, _)) = run(program.clone(), vec![], String::new(), Duration::from_secs(60), Some(Duration::from_millis(300)));
            assert_eq!(reason, "cancel");
            assert_eq!(lines, vec!["debut".to_string()]);
            let (_, (_, reason, _)) = run(program, vec![], String::new(), Duration::from_millis(300), None);
            assert_eq!(reason, "timeout");
            assert!(start.elapsed() < Duration::from_secs(15));
            let _ = std::fs::remove_dir_all(dir);
        }

        /// Le vrai `claude` du poste, avec un outil de Savoire par le MCP de la
        /// demande. Compte connecte et reseau : lance a la main seulement
        /// (`cargo test --lib -- --ignored real_claude`).
        #[test]
        #[ignore = "lance le vrai programme claude (compte connecte, reseau)"]
        fn real_claude_with_a_savoire_tool() {
            let Some(program) = find_program(std::env::var_os("PATH").as_deref(), &known_dirs()) else {
                eprintln!("claude introuvable : rien a essayer");
                return;
            };
            let dir = temp_dir("real");
            let mcp = McpLocal::new(&dir);
            let (pending, _) = mcp.relay_parts();
            let calls = Arc::new(Mutex::new(Vec::<String>::new()));
            let (p, c) = (pending.clone(), calls.clone());
            // La page, jouee ici : elle repond comme mcp_local_reply.
            let relay: Relay = Arc::new(move |id, body| {
                let (pending, calls) = (p.clone(), c.clone());
                std::thread::spawn(move || {
                    let msg: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                    let method = msg["method"].as_str().unwrap_or("").to_string();
                    calls.lock().unwrap().push(method.clone());
                    let reply = match msg.get("id") {
                        None => String::new(),
                        Some(rid) => match method.as_str() {
                            "initialize" => serde_json::json!({ "jsonrpc": "2.0", "id": rid, "result": { "protocolVersion": "2025-06-18", "capabilities": { "tools": {} }, "serverInfo": { "name": "savoire", "version": "0.1.0" } } }),
                            "tools/list" => serde_json::json!({ "jsonrpc": "2.0", "id": rid, "result": { "tools": [{ "name": "search", "description": "Cherche des notes dans le vault.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } }] } }),
                            "tools/call" => serde_json::json!({ "jsonrpc": "2.0", "id": rid, "result": { "content": [{ "type": "text", "text": "Une note : [[Recettes/Crêpes]] : farine, œufs, lait." }], "isError": false } }),
                            _ => serde_json::json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "inconnue" } }),
                        }
                        .to_string(),
                    };
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(reply);
                    }
                });
                true
            });
            let run_mcp = RunMcp::open(relay, &mcp).unwrap();
            let (system, config, cwd) = (dir.join("consignes.md"), dir.join("mcp.json"), dir.join("vide"));
            std::fs::create_dir_all(&cwd).unwrap();
            write_private(&system, "Tu réponds en une phrase, en français.").unwrap();
            write_private(&config, &mcp_config(run_mcp.port, &run_mcp.token)).unwrap();
            let args = build_args(Some("haiku"), &system, Some(&config)).unwrap();
            let prompt = user_line("Cherche « crêpes » avec l'outil search, puis dis en une phrase ce que tu as trouvé.");
            let (lines, (code, reason, stderr)) = run_in(program, args, cwd, prompt, Duration::from_secs(240));
            let parsed: Vec<serde_json::Value> = lines.iter().filter_map(|l| serde_json::from_str(l).ok()).collect();
            let result = parsed.iter().find(|v| v["type"] == "result").cloned().unwrap_or_default();
            eprintln!("fin : {code:?} {reason} ; outils MCP appeles : {:?}", calls.lock().unwrap());
            eprintln!("resultat : {}", result["result"]);
            assert_eq!(reason, "exit", "{stderr}");
            assert_eq!(result["is_error"], false, "{result}");
            assert!(calls.lock().unwrap().iter().any(|m| m == "tools/call"));
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn finds_claude_on_path_then_known_dirs() {
            let dir = temp_dir("path");
            let (a, b) = (dir.join("a"), dir.join("b"));
            std::fs::create_dir_all(&a).unwrap();
            std::fs::create_dir_all(&b).unwrap();
            // Pas executable : ignore.
            std::fs::write(a.join("claude"), "x").unwrap();
            assert_eq!(find_program(Some(a.as_os_str()), &[]), None);
            let program = fake_claude(&b, "echo '2.1.0 (Claude Code)'");
            let path_var = std::env::join_paths([&a, &b]).unwrap();
            assert_eq!(find_program(Some(&path_var), &[]), Some(program.clone()));
            assert_eq!(find_program(None, &[b.clone()]), Some(program.clone()));
            let st = status_of(None, Some(&path_var), &[]);
            assert!(st.found && !st.chosen, "{st:?}");
            assert_eq!(st.version.as_deref(), Some("2.1.0 (Claude Code)"));
            let st = status_of(Some(dir.join("absent/claude")), None, &[]);
            assert!(!st.found && st.chosen && st.error.is_some());
            let st = status_of(None, Some(a.as_os_str()), &[]);
            assert!(!st.found && st.error.as_deref() == Some(NOT_FOUND));
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
