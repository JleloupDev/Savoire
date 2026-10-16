// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Raccourcis clavier personnalises, memorises dans ce navigateur pour chaque
// compte (comme les plugins personnels). Ne suit pas d'un appareil a
// l'autre : a deplacer cote compte le jour ou ca compte.
import type { Hotkey } from '@savoire/plugin-api'
import { sanitizeCustomHotkeys } from '@savoire/plugin-runtime'

const keyFor = (userId: string): string => `savoire.hotkeys.${userId}`

export function loadCustomHotkeys(userId: string): Record<string, Hotkey[]> {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    return sanitizeCustomHotkeys(raw ? JSON.parse(raw) : null)
  } catch {
    return {}
  }
}

export function saveCustomHotkeys(userId: string, custom: Record<string, Hotkey[]>): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(custom))
  } catch {
    // Stockage indisponible (navigation privee) : le choix vaut pour la session.
  }
}
