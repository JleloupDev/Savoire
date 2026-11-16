// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire une page web pour un plugin (api.network, voir
// packages/plugin-api/src/network.ts). La page de l'application ne le peut
// pas elle-meme : les sites visés n'autorisent pas les autres origines (CORS).
//
// Seuls les sites de ALLOWED_HOSTS sont lus, en https, sans redirection ni
// identifiants. Le droit du plugin (network:<site>) est verifie dans la page ;
// cette liste en est le second verrou, cote natif.
//
// Le telechargement passe par le `curl` du systeme (present sur Windows 10 et
// plus, macOS, Linux) : pas de pile TLS a embarquer. Pas de shell : l'adresse
// est un argument, jamais interpretee.

use std::process::Command;

/// Sites lisibles par les plugins.
const ALLOWED_HOSTS: &[&str] = &["wol.jw.org"];
/// Une page de plus est refusee.
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TIMEOUT_SECS: u32 = 30;

/// L'adresse est-elle lisible ? https, un site de la liste, caracteres d'URL seulement.
fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if !ALLOWED_HOSTS.contains(&host) {
        return false;
    }
    url.len() <= 2048
        && url.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~:/?#[]@!$&'()*+,;=%".contains(&b))
}

#[tauri::command]
pub async fn web_fetch_text(url: String) -> Result<String, String> {
    if !allowed(&url) {
        return Err(format!("adresse refusee : {url}"));
    }
    tauri::async_runtime::spawn_blocking(move || fetch(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch(url: &str) -> Result<String, String> {
    let mut cmd = Command::new("curl");
    cmd.args([
        "--silent", "--show-error", "--fail",
        "--proto", "=https", "--max-redirs", "0",
        "--max-time", &TIMEOUT_SECS.to_string(),
        "--max-filesize", &MAX_BYTES.to_string(),
        "--user-agent", "Savoire",
        "--url", url,
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Pas de fenetre de console qui clignote.
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("curl introuvable : {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("lecture impossible : {}", err.trim()));
    }
    if out.stdout.len() as u64 > MAX_BYTES {
        return Err("page trop grande".into());
    }
    String::from_utf8(out.stdout).map_err(|_| "page illisible (pas de l'UTF-8)".into())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn seulement_les_sites_de_la_liste_en_https() {
        assert!(allowed("https://wol.jw.org/fr/wol/b/r30/lp-f/nwt/1/1"));
        assert!(!allowed("http://wol.jw.org/fr/wol/b/r30/lp-f/nwt/1/1"));
        assert!(!allowed("https://wol.jw.org.evil.example/x"));
        assert!(!allowed("https://user@wol.jw.org/x"));
        assert!(!allowed("https://example.org/"));
        assert!(!allowed("https://wol.jw.org/a b"));
        assert!(!allowed("https://wol.jw.org/a\n-o/tmp/x"));
        assert!(!allowed("file:///etc/passwd"));
    }
}
