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
    "server_list",
    "server_select",
    "server_forget",
    "server_session_get",
    "server_session_set",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("echec de la generation Tauri");
}
