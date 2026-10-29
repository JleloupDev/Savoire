// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Arborescence d'un vault, lue dans son Y.Doc.
//
// Meme schema que les clients (YMapVaultDirectory, FileSystemVaultDirectory
// dans infrastructure-sync) : carte 'vault' (id de document -> { path }) et
// carte 'folders' (chemin -> 1). On ne reprend pas leur classe : elle vit
// dans un paquet qui tire SignalR et CodeMirror. Les tests construisent
// l'arbre avec YMapVaultDirectory lui-meme pour garder les deux en accord.
import type * as Y from 'yjs'
import { withDoc } from './yjs'
import type { YjsUpdate } from './yjs'

export const VAULT_MAP = 'vault'
export const FOLDERS_MAP = 'folders'

export interface VaultTree {
  /** id de document -> chemin. */
  docs: Map<string, string>
  /** Dossiers declares (meme vides). */
  folders: string[]
}

export function readVaultTree(doc: Y.Doc): VaultTree {
  const docs = new Map<string, string>()
  doc.getMap<unknown>(VAULT_MAP).forEach((entry, id) => {
    const path = (entry as { path?: unknown } | null)?.path
    if (typeof path === 'string' && path) docs.set(id, path)
  })
  const folders: string[] = []
  doc.getMap<unknown>(FOLDERS_MAP).forEach((_v, path) => { folders.push(path) })
  folders.sort()
  return { docs, folders }
}

/** L'arborescence depuis le journal de l'arbre du vault. */
export function vaultTreeFromUpdates(updates: readonly YjsUpdate[]): VaultTree {
  return withDoc(updates, readVaultTree)
}

export interface TreeDiff {
  added: { id: string; path: string }[]
  removed: string[]
  moved: { id: string; from: string; to: string }[]
}

/** Ce qui change entre deux arborescences (par exemple : l'index et l'arbre du vault). */
export function diffTree(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): TreeDiff {
  const diff: TreeDiff = { added: [], removed: [], moved: [] }
  for (const [id, path] of after) {
    const old = before.get(id)
    if (old === undefined) diff.added.push({ id, path })
    else if (old !== path) diff.moved.push({ id, from: old, to: path })
  }
  for (const id of before.keys()) if (!after.has(id)) diff.removed.push(id)
  return diff
}
