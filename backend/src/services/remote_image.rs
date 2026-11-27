// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecharger une image donnee par une IA (outil MCP add_image) : ChatGPT
// passe un fichier joint a la discussion sous forme d'adresse temporaire
// (download_url), une autre IA peut donner l'adresse d'une image du web.
//
// Le serveur va chercher une adresse choisie par quelqu'un d'autre : il ne
// doit jamais atteindre son propre reseau. Donc :
//  - https seulement, port 443, sans identifiants dans l'adresse ;
//  - le nom est resolu ici, et toute adresse IP non publique est refusee ;
//    la connexion part vers l'IP verifiee (pas de seconde resolution) ;
//  - les redirections sont suivies a la main (3 au plus), chacune reverifiee ;
//  - taille bornee, delai borne ;
//  - le contenu doit etre une image reconnue par ses premiers octets (le
//    type annonce par le site ne suffit pas).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

/// Taille maximale d'une image recue d'une IA.
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(20);

pub struct RemoteImage {
    pub bytes: Vec<u8>,
    /// Extension deduite du contenu : png, jpg, gif, webp, avif.
    pub ext: &'static str,
    pub content_type: &'static str,
    /// Dernier segment de l'adresse (nom propose quand l'IA n'en donne pas).
    pub url_name: Option<String>,
}

/// Le type d'image d'apres ses premiers octets. None : pas une image acceptee.
pub fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(("png", "image/png"));
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("jpg", "image/jpeg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("gif", "image/gif"));
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("webp", "image/webp"));
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        return Some(("avif", "image/avif"));
    }
    None
}

/// Vrai si l'adresse est joignable sur Internet (ni locale, ni privee, ni reservee).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // lien local
                || (s[0] == 0x64 && s[1] == 0xff9b) // NAT64 : vise une IPv4 cachee
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || s[0..6] == [0, 0, 0, 0, 0, 0]) // ancien format compatible IPv4
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15
        || o[0] >= 240)
}

/// Une adresse https acceptable ; Err : message pour l'IA.
fn check_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw.trim()).map_err(|_| "Adresse illisible.".to_string())?;
    if u.scheme() != "https" {
        return Err("L'adresse doit commencer par https://.".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("Adresse refusée (identifiants dans l'adresse).".into());
    }
    if u.port().is_some_and(|p| p != 443) {
        return Err("Adresse refusée (port autre que 443).".into());
    }
    match u.host() {
        Some(url::Host::Domain(_)) => {}
        Some(url::Host::Ipv4(ip)) if is_public_v4(ip) => {}
        Some(url::Host::Ipv6(ip)) if is_public(IpAddr::V6(ip)) => {}
        _ => return Err("Adresse refusée (adresse non publique).".into()),
    }
    Ok(u)
}

/// Resout le nom ; refuse si UNE des adresses n'est pas publique.
async fn resolve_public(u: &url::Url) -> Result<SocketAddr, String> {
    let host = u.host_str().ok_or("Adresse sans nom de site.")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, 443)).await.map_err(|_| "Site introuvable.".to_string())?.collect();
    if addrs.is_empty() {
        return Err("Site introuvable.".into());
    }
    if addrs.iter().any(|a| !is_public(a.ip())) {
        return Err("Adresse refusée (adresse non publique).".into());
    }
    Ok(addrs[0])
}

fn url_name(u: &url::Url) -> Option<String> {
    let last = u.path_segments()?.next_back()?.to_string();
    let decoded = urlencoding::decode(&last).ok()?.into_owned();
    let t = decoded.trim();
    (!t.is_empty() && t.len() <= 255).then(|| t.to_string())
}

/// Un fichier quelconque recu d'une IA (outil MCP add_file).
pub struct RemoteFile {
    pub bytes: Vec<u8>,
    /// Dernier segment de l'adresse (nom propose quand l'IA n'en donne pas).
    pub url_name: Option<String>,
}

/// Telecharge une adresse publique (memes protections que les images). Err : message pour l'IA.
async fn download(raw_url: &str, max_bytes: usize, what: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let mut u = check_url(raw_url)?;
    let max_mb = max_bytes / (1024 * 1024);
    for _ in 0..=MAX_REDIRECTS {
        let addr = resolve_public(&u).await?;
        let host = u.host_str().unwrap_or_default().to_string();
        // Un client par saut : la connexion va a l'IP verifiee, sans resolution de plus.
        let client = reqwest::Client::builder()
            .user_agent("savoire-server")
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "Téléchargement impossible.".to_string())?;
        let mut res = client.get(u.clone()).send().await.map_err(|_| format!("{what} injoignable."))?;
        let status = res.status();
        if status.is_redirection() {
            let next = res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or("Redirection sans adresse.")?;
            let joined = u.join(next).map_err(|_| "Redirection illisible.".to_string())?;
            u = check_url(joined.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("{what} injoignable (statut {}). Une adresse de ChatGPT expire vite : renvoyez le fichier.", status.as_u16()));
        }
        if res.content_length().is_some_and(|n| n as usize > max_bytes) {
            return Err(format!("{what} trop lourd(e) ({max_mb} Mo au plus)."));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|_| "Téléchargement interrompu.".to_string())? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err(format!("{what} trop lourd(e) ({max_mb} Mo au plus)."));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((bytes, url_name(&u)));
    }
    Err("Trop de redirections.".into())
}

/// Telecharge et verifie l'image. Err : message lisible, rendu tel quel a l'IA.
pub async fn fetch(raw_url: &str) -> Result<RemoteImage, String> {
    let (bytes, url_name) = download(raw_url, MAX_IMAGE_BYTES, "Image").await?;
    let (ext, content_type) = sniff(&bytes).ok_or("Ce fichier n'est pas une image acceptée (PNG, JPEG, GIF, WebP, AVIF).")?;
    Ok(RemoteImage { bytes, ext, content_type, url_name })
}

/// Telecharge un fichier quelconque (bibliotheque, donnees, document...).
pub async fn fetch_file(raw_url: &str, max_bytes: usize) -> Result<RemoteFile, String> {
    let (bytes, url_name) = download(raw_url, max_bytes, "Fichier").await?;
    Ok(RemoteFile { bytes, url_name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_addresses_only() {
        for bad in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "::a00:1"] {
            assert!(!is_public(bad.parse().unwrap()), "{bad}");
        }
        for good in ["93.184.216.34", "2606:4700::1111"] {
            assert!(is_public(good.parse().unwrap()), "{good}");
        }
    }

    #[test]
    fn urls() {
        assert!(check_url("http://exemple.org/a.png").is_err());
        assert!(check_url("https://user:pw@exemple.org/a.png").is_err());
        assert!(check_url("https://exemple.org:8080/a.png").is_err());
        assert!(check_url("https://127.0.0.1/a.png").is_err());
        assert!(check_url("https://[::1]/a.png").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("https://files.oaiusercontent.com/file-abc?sig=1").is_ok());
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]).map(|s| s.0), Some("png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).map(|s| s.0), Some("jpg"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 ").map(|s| s.0), Some("webp"));
        assert!(sniff(b"<svg xmlns=").is_none());
        assert!(sniff(b"<html>").is_none());
    }

    #[test]
    fn names() {
        assert_eq!(url_name(&url::Url::parse("https://x.org/a/Mon%20image.png?x=1").unwrap()).as_deref(), Some("Mon image.png"));
    }
}
