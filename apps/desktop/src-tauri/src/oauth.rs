// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion a un serveur Savoire depuis la version bureau (ADR-028).
//
// La personne se connecte dans le navigateur du systeme, chez le fournisseur
// d'identite du serveur ; celui-ci la renvoie sur http://127.0.0.1:<port>/callback,
// ou ce module attend (RFC 8252, « loopback »). Le port est choisi par le
// systeme a chaque connexion ; seule l'adresse locale est ecoutee.
//
// Le code recu ne sert a rien sans le « code_verifier » PKCE, qui reste dans
// la page (apps/web/src/loginFlow.ts) : ce module ne fait que relayer la
// query string, il n'echange rien.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// L'ecoute en cours (une seule connexion a la fois).
#[derive(Default)]
pub struct OAuthLoopback(Mutex<Option<TcpListener>>);

/// Ecoute sur 127.0.0.1, port choisi par le systeme ; rend le port.
/// Une ecoute precedente non terminee est abandonnee.
#[tauri::command]
pub fn oauth_listen(state: tauri::State<'_, OAuthLoopback>) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("ecoute locale impossible : {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    *state.0.lock().map_err(|_| "verrou empoisonne".to_string())? = Some(listener);
    Ok(port)
}

/// Attend le retour du fournisseur ; rend la query string de /callback.
#[tauri::command]
pub async fn oauth_wait(state: tauri::State<'_, OAuthLoopback>, timeout_secs: u64) -> Result<String, String> {
    let listener = state
        .0
        .lock()
        .map_err(|_| "verrou empoisonne".to_string())?
        .take()
        .ok_or_else(|| "aucune connexion en cours".to_string())?;
    let timeout = Duration::from_secs(timeout_secs.clamp(5, 1800));
    tauri::async_runtime::spawn_blocking(move || wait_for_callback(&listener, timeout))
        .await
        .map_err(|e| e.to_string())?
}

/// Ouvre une adresse web dans le navigateur du systeme (http et https seulement).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("adresse refusee (http ou https seulement)".into());
    }
    open_in_browser(&url).map_err(|e| format!("navigateur introuvable : {e}"))
}

#[cfg(target_os = "linux")]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    // Pas de « cmd /c start » : l'adresse contient des « & ».
    Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn().map(|_| ())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn open_in_browser(_url: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(ErrorKind::Unsupported, "systeme non pris en charge"))
}

const PAGE_OK: &str = "<!doctype html><meta charset=\"utf-8\"><title>Savoire</title>\
<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5\">\
<h1>Connexion terminée</h1><p>Vous pouvez fermer cet onglet et revenir dans Savoire.</p></body>";

const PAGE_ERROR: &str = "<!doctype html><meta charset=\"utf-8\"><title>Savoire</title>\
<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5\">\
<h1>Connexion interrompue</h1><p>Revenez dans Savoire pour voir ce qui s'est passé.</p></body>";

/// Attend une requete GET /callback?... ; repond une page courte au navigateur.
/// Les autres requetes (favicon...) recoivent un 404 et l'attente continue.
pub fn wait_for_callback(listener: &TcpListener, timeout: Duration) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(query) = handle(stream) {
                    return Ok(query);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("delai depasse : la connexion n'a pas abouti".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Lit la premiere ligne de la requete ; rend la query string de /callback.
fn handle(mut stream: TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let target = head
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|rest| rest.split(' ').next())
        .unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        respond(&mut stream, "404 Not Found", "");
        return None;
    }
    let failed = query.split('&').any(|kv| kv.starts_with("error="));
    respond(&mut stream, "200 OK", if failed { PAGE_ERROR } else { PAGE_OK });
    Some(query.to_string())
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn get(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn rend_la_query_du_callback_et_ignore_le_reste() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let favicon = get(port, "/favicon.ico");
            let page = get(port, "/callback?code=abc&state=xyz");
            (favicon, page)
        });
        let query = wait_for_callback(&listener, Duration::from_secs(5)).unwrap();
        let (favicon, page) = browser.join().unwrap();
        assert_eq!(query, "code=abc&state=xyz");
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("Connexion terminée"));
    }

    #[test]
    fn une_erreur_du_fournisseur_est_relayee() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || get(port, "/callback?error=access_denied&state=xyz"));
        let query = wait_for_callback(&listener, Duration::from_secs(5)).unwrap();
        assert_eq!(query, "error=access_denied&state=xyz");
        assert!(browser.join().unwrap().contains("Connexion interrompue"));
    }

    #[test]
    fn delai_depasse() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let err = wait_for_callback(&listener, Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("delai"));
    }

    #[test]
    fn open_external_refuse_autre_chose_que_le_web() {
        assert!(open_external("file:///etc/passwd".into()).is_err());
        assert!(open_external("javascript:alert(1)".into()).is_err());
    }
}
