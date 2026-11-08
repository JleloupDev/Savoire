// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Cadre des boards (.board) dans la version bureau.
//
// Dans le navigateur, un board tourne dans une iframe `srcdoc`. Une telle
// iframe HERITE de la politique de securite (CSP) de la page qui la contient.
// Celle de la fenetre Tauri interdit le JavaScript en ligne : le code du
// board ne s'executait pas (chiffres a « … », cadre integre tout petit).
//
// Ici, le cadre est une vraie page, servie par le protocole `savoire-board`,
// avec SA propre CSP : JavaScript et styles en ligne permis, aucun reseau.
// La page attend le document du board, envoye par Savoire (postMessage),
// puis l'ecrit. L'iframe reste isolee (sandbox="allow-scripts", origine
// opaque) : rien ne change pour la securite du reste de l'appli.

use tauri::http::{Request, Response};

/// Meme politique que le document du board (plugin-board, frame.ts : BOARD_CSP).
const BOARD_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

/// La page vide : signale qu'elle est prete, recoit le document, l'ecrit.
const SHELL: &str = r#"<!doctype html><html><head><meta charset="utf-8"><script>
(function(){
  function boot(e){
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.t !== 'savoire-board-boot' || typeof m.html !== 'string') return;
    removeEventListener('message', boot);
    document.open(); document.write(m.html); document.close();
  }
  addEventListener('message', boot);
  parent.postMessage({ t: 'savoire-board-ready' }, '*');
})();
</script></head><body></body></html>"#;

pub fn respond(_request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", BOARD_CSP)
        .header("Cache-Control", "no-store")
        .body(SHELL.as_bytes().to_vec())
        .expect("reponse du cadre de board")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_page_porte_sa_propre_politique() {
        let r = respond(Request::builder().uri("savoire-board://localhost/").body(Vec::new()).unwrap());
        let csp = r.headers().get("Content-Security-Policy").unwrap().to_str().unwrap();
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("script-src 'unsafe-inline'"));
        assert!(!csp.contains("connect-src"));
        let body = String::from_utf8(r.body().clone()).unwrap();
        assert!(body.contains("savoire-board-ready"));
    }
}
