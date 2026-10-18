// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Front de la version bureau : charge par l'application web UNIQUEMENT quand
// elle tourne dans Tauri (import dynamique), jamais dans le bundle web.
export * from './bridge'
export * from './TauriVaultFileSystem'
export * from './recentVaults'
export * from './desktopHost'
