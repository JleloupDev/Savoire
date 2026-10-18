// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Savoire, version bureau. La fenetre affiche l'application web elle-meme
// (apps/web) ; ce programme ne fait que lui donner acces, au plus juste, aux
// dossiers de vault choisis par la personne.

// Pas de console en plus sous Windows en production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod folders;
mod paths;
mod servers;
mod vault_fs;
mod vaults;
mod watch;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ~/.config/<identifiant>/recent-vaults.json sous Linux.
            let file = app.path().app_config_dir()?.join("recent-vaults.json");
            app.manage(vaults::VaultRegistry::load(file));
            app.manage(watch::Watches::default());
            // Serveurs Savoire connus et leurs sessions (servers.json, server-sessions.json).
            app.manage(servers::ServerSettings::load(&app.path().app_config_dir()?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            folders::vault_pick_folder,
            folders::vault_create_folder,
            folders::vault_recent_list,
            folders::vault_recent_open,
            folders::vault_recent_forget,
            folders::vault_recent_rename,
            vault_fs::vault_read_text,
            vault_fs::vault_read_bytes,
            vault_fs::vault_write_text,
            vault_fs::vault_write_bytes,
            vault_fs::vault_exists,
            vault_fs::vault_stat,
            vault_fs::vault_list,
            vault_fs::vault_mkdir,
            vault_fs::vault_rename,
            vault_fs::vault_remove,
            watch::vault_watch,
            watch::vault_unwatch,
            servers::server_list,
            servers::server_select,
            servers::server_forget,
            servers::server_session_get,
            servers::server_session_set,
        ])
        .run(tauri::generate_context!())
        .expect("echec du demarrage de Savoire");
}
