// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Point d'entree de la version bureau. Le programme est dans lib.rs, partage
// avec Android (point d'entree mobile).

// Pas de console en plus sous Windows en production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    savoire_desktop_lib::run()
}
