// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugins personnels installes ou desactives, memorises dans ce navigateur
// pour chaque compte. Ne suit pas d'un appareil a l'autre : a deplacer cote
// compte le jour ou ca compte.
import type { IPersonalPluginStore, PersonalPluginState } from '@savoire/application'

const keyFor = (userId: string): string => `savoire.plugins.personal.${userId}`

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export function personalPluginStore(getUserId: () => string | undefined): IPersonalPluginStore {
  return {
    load(): PersonalPluginState {
      const userId = getUserId()
      if (!userId) return { installed: [], removed: [], disabled: [] }
      try {
        const raw = localStorage.getItem(keyFor(userId))
        const parsed: unknown = raw ? JSON.parse(raw) : null
        // Premier format : un simple tableau des plugins desactives.
        if (Array.isArray(parsed)) return { installed: [], removed: [], disabled: strings(parsed) }
        const state = (parsed ?? {}) as Partial<Record<keyof PersonalPluginState, unknown>>
        return { installed: strings(state.installed), removed: strings(state.removed), disabled: strings(state.disabled) }
      } catch {
        return { installed: [], removed: [], disabled: [] }
      }
    },
    save(state: PersonalPluginState): void {
      const userId = getUserId()
      if (!userId) return
      try {
        localStorage.setItem(keyFor(userId), JSON.stringify(state))
      } catch {
        // Stockage indisponible (navigation privee) : le choix vaut pour la session.
      }
    },
  }
}
