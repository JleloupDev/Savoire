// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Choisir, creer et retrouver les dossiers de vault.
//
// La boite de dialogue s'ouvre ICI, cote Rust : c'est ce qui garantit qu'un
// dossier n'est autorise que si la personne l'a choisi. Le front ne recoit
// que le resultat.

use crate::paths;
use crate::vaults::{RecentVault, RecentVaultView, VaultRegistry};
use std::fs;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

fn pick_folder(app: &AppHandle, title: &str) -> Result<Option<std::path::PathBuf>, String> {
    let mut dialog = app.dialog().file().set_title(title);
    // Rattachee a la fenetre : modale, et au-dessus d'elle.
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    match dialog.blocking_pick_folder() {
        Some(choice) => choice.into_path().map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// « Ouvrir un dossier… » : un vault Obsidian existant ou un dossier vide.
/// None si la personne annule.
#[tauri::command]
pub async fn vault_pick_folder(app: AppHandle, reg: State<'_, VaultRegistry>) -> Result<Option<RecentVault>, String> {
    match pick_folder(&app, "Ouvrir un dossier comme vault")? {
        Some(dir) => reg.admit(&dir, None).map(Some),
        None => Ok(None),
    }
}

/// « Nouveau vault… » : la personne choisit OU le creer, le dossier porte le nom donne.
#[tauri::command]
pub async fn vault_create_folder(
    app: AppHandle,
    reg: State<'_, VaultRegistry>,
    name: String,
) -> Result<Option<RecentVault>, String> {
    let name = paths::validate_folder_name(&name)?;
    let Some(parent) = pick_folder(&app, &format!("Où créer le vault « {name} » ?"))? else {
        return Ok(None);
    };
    let dir = parent.join(&name);
    if dir.exists() {
        let empty = fs::read_dir(&dir).map_err(|e| e.to_string())?.next().is_none();
        if !empty {
            return Err(format!("le dossier {} existe deja et n'est pas vide", dir.display()));
        }
    } else {
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
    }
    reg.admit(&dir, Some(&name)).map(Some)
}

#[tauri::command]
pub fn vault_recent_list(reg: State<'_, VaultRegistry>) -> Vec<RecentVaultView> {
    reg.list()
}

#[tauri::command]
pub fn vault_recent_open(reg: State<'_, VaultRegistry>, path: String) -> Result<RecentVault, String> {
    reg.reopen(&path)
}

/// Retire un vault de la liste. Le dossier, lui, n'est jamais touche.
#[tauri::command]
pub fn vault_recent_forget(reg: State<'_, VaultRegistry>, path: String) -> Result<(), String> {
    reg.forget(&path)
}

/// Change le nom affiche d'un vault. Le dossier garde son nom.
#[tauri::command]
pub fn vault_recent_rename(reg: State<'_, VaultRegistry>, path: String, name: String) -> Result<(), String> {
    reg.rename(&path, &name)
}
