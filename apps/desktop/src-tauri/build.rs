// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les commandes de l'application sont declarees ici : Tauri genere pour
// chacune une permission (allow-<commande>), et seules celles accordees par
// capabilities/default.json sont appelables depuis la page.
const COMMANDS: &[&str] = &[
    "vault_pick_folder",
    "vault_create_folder",
    "vault_recent_list",
    "vault_recent_open",
    "vault_recent_forget",
    "vault_recent_rename",
    "vault_read_text",
    "vault_read_bytes",
    "vault_write_text",
    "vault_write_bytes",
    "vault_exists",
    "vault_stat",
    "vault_list",
    "vault_mkdir",
    "vault_rename",
    "vault_remove",
    "vault_watch",
    "vault_unwatch",
    "index_exec",
    "index_all",
    "index_batch",
    "index_close",
    "server_list",
    "server_select",
    "server_forget",
    "server_session_get",
    "server_session_set",
    "oauth_listen",
    "oauth_wait",
    "open_external",
    "note_window_open",
    "note_window_pin",
    "web_fetch_text",
    "mcp_local_start",
    "mcp_local_stop",
    "mcp_local_status",
    "mcp_local_new_token",
    "mcp_local_reply",
    "claude_cli_status",
    "claude_cli_choose",
    "claude_cli_start",
    "claude_cli_cancel",
    "update_check",
    "update_download",
    "update_restart",
];

fn main() {
    // La cle publique des mises a jour est lue au build (src/updater.rs).
    println!("cargo:rerun-if-env-changed=SAVOIRE_UPDATER_PUBKEY");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("echec de la generation Tauri");
}
