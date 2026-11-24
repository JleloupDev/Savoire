// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les plugins d'un document affiche seul (lien de partage, module integre) :
// seulement ceux dont il a besoin. Celui de son type de fichier d'abord ; puis,
// quand son texte arrive (il vient du CRDT, apres l'ouverture) et a chaque
// changement, ceux dont il porte une trace (```mermaid, > [!note]...) ou qu'il
// declare (`plugins:`). Les blocs apparaissent sans rouvrir le document.
import { EditorCore } from '@savoire/editor-core'
import type { PluginLoader } from '@savoire/plugin-runtime'
import type { ICRDT, VaultPlugin } from '@savoire/plugin-api'

/** Les plugins dont un document a besoin, d'apres son chemin et son texte. `editing` : les outils d'edition aussi. */
export type NeededPluginLoader = (path: string, text: string, editing: boolean) => Promise<{ editor: VaultPlugin[]; fileTypes: VaultPlugin[] }>

export interface NeededPlugins {
  /** Les plugins actifs partout, a donner a DocumentView ; la liste grandit avec le texte. */
  defaultPlugins: VaultPlugin[]
  /** Suit le texte du document ; rend de quoi arreter. */
  follow(crdt: Pick<ICRDT, 'onTextChange'>): () => void
}

export async function startNeededPlugins(opts: {
  path: string
  editing: boolean
  load: NeededPluginLoader
  loader: Pick<PluginLoader, 'loadInternal'>
  api: Parameters<PluginLoader['loadInternal']>[1]
  /** Toujours la (liens [[...]]). */
  base: VaultPlugin[]
  cancelled(): boolean
}): Promise<NeededPlugins> {
  const defaultPlugins = [...opts.base]
  const loaded = new Set<string>()
  for (const p of opts.base) { loaded.add(p.manifest.id); await opts.loader.loadInternal(p, opts.api) }
  let queue = Promise.resolve()

  const take = async (text: string): Promise<boolean> => {
    const plugins = await opts.load(opts.path, text, opts.editing)
    let added = false
    for (const p of [...plugins.fileTypes, ...plugins.editor]) {
      if (opts.cancelled() || loaded.has(p.manifest.id)) continue
      loaded.add(p.manifest.id)
      await opts.loader.loadInternal(p, opts.api)
      if (plugins.editor.includes(p)) { defaultPlugins.push(p); added = true }
    }
    console.debug('[plugins] pour ce document :', [...loaded].join(', '))
    return added
  }

  await take('')
  return {
    defaultPlugins,
    follow(crdt) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = crdt.onTextChange(text => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          // Un chargement a la fois : deux textes proches ne chargent pas deux fois.
          queue = queue.then(() => take(text.toString())).then(added => {
            if (added && !opts.cancelled()) EditorCore.refreshAll?.()
          }).catch(err => console.error('[plugins] chargement impossible', err))
        }, 150)
      })
      return () => { if (timer) clearTimeout(timer); off() }
    },
  }
}
