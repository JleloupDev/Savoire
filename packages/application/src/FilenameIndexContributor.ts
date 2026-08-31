// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IndexContributor, SharedIndexEntry } from '@savoire/plugin-api'

// Contributeur integre, enregistre par l'application elle-meme (pas un plugin).
// Indexe le radical des documents pour que [[PageName]] se resolve en chemin.
//
// Migre au contrat partage : plus de snapshot, de restore ni de processedSeq.
// Il declare ce qu'un document produit ; le runtime possede la carte CRDT et
// lui rend l'etat complet a chaque changement, local ou distant.
interface FilenameValue { path: string; stem: string }

export class FilenameIndexContributor implements IndexContributor {
  readonly namespace = 'filename'

  private readonly index = new Map<string, FilenameValue>()

  computeEntries(_docId: string, path: string, _markdown: string): SharedIndexEntry[] {
    const basename = path.split('/').pop() ?? path
    const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename
    return [{ key: 'name', value: { path, stem } satisfies FilenameValue }]
  }

  onEntriesChanged(byDoc: ReadonlyMap<string, SharedIndexEntry[]>): void {
    this.index.clear()
    for (const [docId, entries] of byDoc) {
      const entry = entries.find(e => e.key === 'name')
      if (entry) this.index.set(docId, entry.value as FilenameValue)
    }
  }

  resolveByName(name: string): string | undefined {
    for (const { path, stem } of this.index.values()) {
      if (stem === name || path === name) return path
    }
    return undefined
  }
}
