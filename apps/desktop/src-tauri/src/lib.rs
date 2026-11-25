// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Savoire, version bureau. La fenetre affiche l'application web elle-meme
// (apps/web) ; ce programme ne fait que lui donner acces, au plus juste, aux
// dossiers de vault choisis par la personne.
//
// Android : serveur seulement. Pas de dossier de vault (ni boite de
// dialogue, ni surveillance du disque) : seules les commandes des serveurs
// Savoire et de leurs sessions existent.

#[cfg(desktop)]
mod board_frame;
#[cfg(desktop)]
mod claude_cli;
#[cfg(desktop)]
mod folders;
// Public : le pont de test examples/index_stdio.rs s'en sert.
#[cfg(desktop)]
pub mod index_db;
// Public : le pont stdio (main.rs, --mcp-stdio) s'en sert.
#[cfg(desktop)]
pub mod mcp_local;
#[cfg(desktop)]
mod note_window;
#[cfg(desktop)]
mod notion;
#[cfg(desktop)]
mod oauth;
#[cfg(desktop)]
mod paths;
mod servers;
#[cfg(desktop)]
mod updater;
#[cfg(desktop)]
mod vault_fs;
#[cfg(desktop)]
mod vaults;
#[cfg(desktop)]
mod watch;
#[cfg(desktop)]
mod web_fetch;

use tauri::Manager;

#[cfg(desktop)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Mises a jour : seulement si ce build a la cle publique (updater.rs).
    if let Some(updater) = updater::plugin() {
        builder = builder.plugin(updater);
    }
    builder
        // Cadre des boards, avec sa propre CSP (board_frame.rs).
        .register_uri_scheme_protocol("savoire-board", |_ctx, request| board_frame::respond(request))
        .setup(|app| {
            // ~/.config/<identifiant>/recent-vaults.json sous Linux.
            let file = app.path().app_config_dir()?.join("recent-vaults.json");
            app.manage(vaults::VaultRegistry::load(file));
            app.manage(watch::Watches::default());
            // Index SQLite des vaults ouverts (.savoire/index.sqlite).
            app.manage(index_db::IndexDbs::default());
            // Serveurs Savoire connus et leurs sessions (servers.json, server-sessions.json).
            app.manage(servers::ServerSettings::load(&app.path().app_config_dir()?));
            // Connexion a un serveur : retour du navigateur sur 127.0.0.1 (ADR-028).
            app.manage(oauth::OAuthLoopback::default());
            // Import Notion (ADR-035) : le jeton, garde cote Rust (notion-connection.json).
            app.manage(notion::NotionConnection::load(&app.path().app_config_dir()?));
            // MCP local (ADR-033) : demarre a la demande de la page (Parametres > Agents).
            app.manage(mcp_local::McpLocal::new(&app.path().app_config_dir()?));
            // Claude avec l'abonnement de la personne : le programme claude du poste.
            app.manage(claude_cli::ClaudeCli::new(&app.path().app_config_dir()?, &app.path().app_cache_dir()?));
            app.manage(updater::PendingUpdate::default());
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
            index_db::index_exec,
            index_db::index_all,
            index_db::index_batch,
            index_db::index_close,
            servers::server_list,
            servers::server_select,
            servers::server_forget,
            servers::server_session_get,
            servers::server_session_set,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::open_external,
            notion::notion_status,
            notion::notion_connect,
            notion::notion_disconnect,
            notion::notion_api,
            notion::notion_download,
            note_window::note_window_open,
            note_window::note_window_pin,
            web_fetch::web_fetch_text,
            mcp_local::mcp_local_start,
            mcp_local::mcp_local_stop,
            mcp_local::mcp_local_status,
            mcp_local::mcp_local_new_token,
            mcp_local::mcp_local_reply,
            claude_cli::claude_cli_status,
            claude_cli::claude_cli_choose,
            claude_cli::claude_cli_start,
            claude_cli::claude_cli_cancel,
            updater::update_check,
            updater::update_download,
            updater::update_restart,
        ])
        .run(tauri::generate_context!())
        .expect("echec du demarrage de Savoire");
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Serveurs Savoire connus et leurs sessions (servers.json, server-sessions.json).
            app.manage(servers::ServerSettings::load(&app.path().app_config_dir()?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            servers::server_list,
            servers::server_select,
            servers::server_forget,
            servers::server_session_get,
            servers::server_session_set,
        ])
        .run(tauri::generate_context!())
        .expect("echec du demarrage de Savoire");
}
