// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils communs des tests : un index SQLite en memoire (node:sqlite).
import { VaultIndex, makeRecord } from '@savoire/indexer-core'
import type { NoteRecord, VaultIndexOptions } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import type { IndexedDoc } from '@savoire/plugin-runtime'

export function memoryIndex(options?: VaultIndexOptions): Promise<VaultIndex> {
  return VaultIndex.open(NodeSqliteDriver.open(':memory:'), options)
}

/** Une note du moteur de reference -> enregistrement de l'index. */
export function recordOf(d: IndexedDoc): NoteRecord {
  return makeRecord({
    id: d.id, path: d.path, title: d.title, props: d.props, text: d.text,
    ...(d.base !== undefined ? { base: d.base } : {}),
    ...(d.created ? { created: d.created } : {}),
    ...(d.modified ? { modified: d.modified } : {}),
  })
}
