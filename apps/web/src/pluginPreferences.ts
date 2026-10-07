// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugins personnels desactives, memorises dans ce navigateur pour chaque
// compte. Ne suit pas d'un appareil a l'autre : a deplacer cote compte le jour
// ou ca compte.
import type { IPersonalPluginStore } from '@savoire/application'

const keyFor = (userId: string): string => `savoire.plugins.personal.${userId}`

export function personalPluginStore(getUserId: () => string | undefined): IPersonalPluginStore {
  return {
    loadDisabled(): string[] {
      const userId = getUserId()
      if (!userId) return []
      try {
        const raw = localStorage.getItem(keyFor(userId))
        const parsed: unknown = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
      } catch {
        return []
      }
    },
    saveDisabled(ids: string[]): void {
      const userId = getUserId()
      if (!userId) return
      try {
        localStorage.setItem(keyFor(userId), JSON.stringify(ids))
      } catch {
        // Stockage indisponible (navigation privee) : le choix vaut pour la session.
      }
    },
  }
}
