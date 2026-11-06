// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une note dans sa propre fenetre, et l'option « epingler » (toujours au
// premier plan). La fenetre charge l'application elle-meme ; la note a
// montrer lui est donnee par un script d'initialisation
// (window.__SAVOIRE_NOTE_WINDOW__, lu par apps/web/src/noteWindow.ts).
//
// Commandes asynchrones : creer une fenetre depuis une commande synchrone
// bloque sous Windows.

use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static NEXT: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Target<'a> {
    vault_id: &'a str,
    path: &'a str,
    pinned: bool,
}

/// Script qui donne a la fenetre sa note (JSON echappe : aucun code injecte).
pub fn init_script(vault_id: &str, path: &str, pinned: bool) -> Result<String, String> {
    let json = serde_json::to_string(&Target { vault_id, path, pinned }).map_err(|e| e.to_string())?;
    Ok(format!("window.__SAVOIRE_NOTE_WINDOW__ = {json};"))
}

fn title_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name).to_string()
}

/// Ouvre la note dans une nouvelle fenetre ; `pinned` : toujours au premier plan.
#[tauri::command]
pub async fn note_window_open(app: AppHandle, vault_id: String, path: String, pinned: bool) -> Result<String, String> {
    if vault_id.is_empty() || path.is_empty() || path.len() > 4096 {
        return Err("note invalide".into());
    }
    let label = format!("note-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let title = if pinned { format!("📌 {}", title_of(&path)) } else { title_of(&path) };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(760.0, 900.0)
        .always_on_top(pinned)
        .initialization_script(&init_script(&vault_id, &path, pinned)?)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Epingle (ou non) la fenetre qui appelle.
#[tauri::command]
pub async fn note_window_pin(window: WebviewWindow, pinned: bool) -> Result<(), String> {
    window.set_always_on_top(pinned).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_script_echappe_la_note() {
        let s = init_script("v1", "A/\"x\"</script>.md", true).unwrap();
        assert!(s.starts_with("window.__SAVOIRE_NOTE_WINDOW__ = {"));
        assert!(s.contains(r#""path":"A/\"x\"</script>.md""#));
        assert!(s.contains(r#""vaultId":"v1""#));
        assert!(s.contains(r#""pinned":true"#));
        assert_eq!(title_of("Bible/Genèse 1.md"), "Genèse 1");
    }
}
