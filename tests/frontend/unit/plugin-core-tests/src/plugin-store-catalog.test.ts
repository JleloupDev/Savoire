// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le catalogue du store decrit chaque plugin sans charger son code. Le
// manifeste du plugin reste la reference : l'entree doit le recopier, et
// annoncer exactement les extensions qu'il enregistre.
import { describe, it, expect } from 'vitest'
import type { FileTypeSpec, PluginAPI } from '@savoire/plugin-api'
import { STORE_CATALOG } from '../../../../../apps/web/src/pluginStore'

describe('catalogue du store', () => {
  for (const entry of STORE_CATALOG) {
    it(`${entry.manifest.id} : l'entree recopie le plugin`, async () => {
      const plugin = await entry.load()
      expect(entry.manifest).toEqual(plugin.manifest)

      const registered: FileTypeSpec[] = []
      await plugin.onload({ files: { register: (s: FileTypeSpec) => registered.push(s) } } as unknown as PluginAPI)
      expect(registered.map(s => s.extension).sort()).toEqual([...entry.extensions].sort())
    })
  }

  it('aucun identifiant en double', () => {
    const ids = STORE_CATALOG.map(e => e.manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
