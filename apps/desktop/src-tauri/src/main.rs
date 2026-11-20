// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Point d'entree de la version bureau. Le programme est dans lib.rs, partage
// avec Android (point d'entree mobile).

// Pas de console en plus sous Windows en production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Pont MCP pour les clients qui ne parlent que stdio (Claude Desktop) :
    // pas de fenetre, seulement un relais vers l'appli ouverte.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if std::env::args().any(|a| a == "--mcp-stdio") {
        std::process::exit(savoire_desktop_lib::mcp_local::stdio_bridge("org.savoire.desktop"));
    }
    savoire_desktop_lib::run()
}
