// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le store contient TOUS les plugins du projet. Pour un plugin non
// preinstalle, l'entree recopie son manifeste (afficher sans charger le
// code) : la copie doit rester fidele, extensions comprises.
// En .dom : certains plugins (Excalidraw, Mind Map) demandent un DOM pour s'importer.
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { FileTypeSpec, PluginAPI } from '@savoire/plugin-api'
import { STORE_CATALOG } from '../../../../../apps/web/src/pluginStore'

// Excalidraw est remplace par un bouchon (vitest.config) : il charge ses morceaux depuis le web.
// Son plugin dessine aussi (Path2D, absent de happy-dom).
globalThis.Path2D ??= class {} as unknown as typeof Path2D
// mind-elixir lit, a son chargement, une balise <script> de la page.
document.head.appendChild(document.createElement('script'))

const PLUGINS_DIR = path.resolve(__dirname, '../../../../../packages/plugins')

describe('catalogue du store', () => {
  it('tous les plugins du projet sont au store', () => {
    const local = readdirSync(PLUGINS_DIR).filter(d => d.startsWith('plugin-')).sort()
    expect(STORE_CATALOG.map(e => e.id).sort()).toEqual(local)
  })

  it('aucun identifiant en double', () => {
    const ids = STORE_CATALOG.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('un plugin non preinstalle a de quoi s\'afficher sans charger son code', () => {
    for (const entry of STORE_CATALOG.filter(e => !e.preinstalled)) {
      expect(entry.manifest?.id, entry.id).toBe(entry.id)
      expect(entry.extensions, entry.id).toBeDefined()
    }
  })

  for (const entry of STORE_CATALOG.filter(e => e.manifest)) {
    it(`${entry.id} : l'entree recopie le plugin`, async () => {
      const plugin = await entry.load({ vaultBrowserRefs: {} as never, setGraphContributor: () => {} })
      expect(entry.manifest).toEqual(plugin.manifest)

      const registered: FileTypeSpec[] = []
      // Seuls les types de fichiers comptent ici ; le reste de l'API ne fait rien.
      const noop = { register: () => () => {} }
      await plugin.onload({ files: { register: (s: FileTypeSpec) => registered.push(s) }, blocks: noop } as unknown as PluginAPI)
      expect(registered.map(s => s.extension).sort()).toEqual([...(entry.extensions ?? [])].sort())
    })
  }
})
