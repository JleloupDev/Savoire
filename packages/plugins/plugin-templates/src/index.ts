// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin core « Modeles », simple comme celui d'Obsidian : chaque note du
// dossier des modeles (`Modèles/`, ou `Templates/` d'un vault Obsidian)
// devient une commande « /Modèle : Nom » qui insere son texte au curseur,
// variables remplacees ({{title}}, {{date}}, {{time}}, formats : voir
// renderTemplate dans plugin-api).
//
// Le texte des modeles est lu a l'avance et tenu a jour : l'insertion du
// menu / est immediate.
import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { noteTitleOf, renderTemplate, templateFolderOf } from '@savoire/plugin-api'

async function allFiles(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}

/** Les modeles d'un vault : notes Markdown de son dossier des modeles. */
export function templatePaths(files: readonly string[]): string[] {
  const folder = templateFolderOf(files)
  if (!folder) return []
  return files
    .filter(f => f.startsWith(folder) && f.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-templates',
    name: 'Modèles',
    version: '0.0.1',
    description: 'Les notes du dossier « Modèles » s\'insèrent par le menu /, avec {{title}}, {{date}} et {{time}}',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    if (!api.slash || typeof api.vault?.list !== 'function') return
    const texts = new Map<string, string>()
    let generation = 0

    const refresh = async () => {
      const mine = ++generation
      let paths: string[]
      try { paths = templatePaths(await allFiles(api)) } catch { return }
      const read = await Promise.all(paths.map(async p => {
        try { return [p, await api.vault.readDocumentByPath(p)] as const } catch { return null }
      }))
      if (mine !== generation) return
      texts.clear()
      for (const r of read) if (r) texts.set(r[0], r[1])
    }

    // Un seul item enregistre au chargement (il suit l'activation du plugin),
    // qui donne un item par modele a l'ouverture du menu.
    api.slash.register({
      id: 'templates',
      label: 'Modèle',
      category: 'Modèles',
      insert: '',
      expand: () => {
        // Relu a chaque ouverture du menu : un modele modifie a l'instant suit.
        void refresh()
        return [...texts.keys()].map(path => ({
        id: `templates:${path}`,
        label: `Modèle : ${noteTitleOf(path)}`,
        description: path,
        icon: 'layout-template',
        category: 'Modèles',
        insert: () => {
          const current = api.workspace?.getActiveDocument?.()?.path
          return renderTemplate(texts.get(path) ?? '', { title: current ? noteTitleOf(current) : '' })
        },
        }))
      },
    })

    void refresh()
    // Un modele ajoute, renomme ou modifie : la liste suit.
    api.workspace?.subscribeVaultChange?.(() => void refresh())
    api.workspace?.subscribeDocumentIndexed?.((_id: string, path: string) => {
      if (templatePaths([path]).length) void refresh()
    })
  },

  async onunload() {},
}

export default plugin
