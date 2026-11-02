// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Index local d'un vault du disque (version bureau) : SQLite natif cote Rust
// et indexeur de fond (DesktopVaultIndexer). Charge par import dynamique,
// seulement dans Tauri : ni @savoire/desktop ni ce fichier n'entrent dans le
// bundle du navigateur.
import type { IVaultSyncSession } from '@savoire/application'
import { crdtDirOf } from '@savoire/infrastructure-sync'
import { BaseRowFeeder } from '@savoire/indexer-core/local'
import { DesktopVaultIndexer, loadTauriBridge, openDesktopIndex, pathForVaultId } from '@savoire/desktop'
import { loadDesktopProfile } from './createDesktopRoot'
import type { LocalIndexBinding } from './localIndex'

/** Null : ce vault n'est pas un dossier de la machine. */
export async function openDesktopLocalIndex(session: IVaultSyncSession, vaultId: string): Promise<LocalIndexBinding | null> {
  const root = pathForVaultId(vaultId)
  if (!root) return null
  const [bridge, parts] = await Promise.all([loadTauriBridge(), loadDesktopProfile()])
  const fs = await parts.opened.fileSystemOf(vaultId)
  const index = await openDesktopIndex(bridge, root, path => fs.remove(path))
  const indexer = new DesktopVaultIndexer(index, {
    fs,
    directory: session.directory,
    readState: id => session.readDocumentState(id),
    stateDirOf: crdtDirOf,
  })
  const rows = new BaseRowFeeder(index)
  return {
    kind: 'native',
    index,
    mirror: {
      // Les notes viennent des fichiers (indexeur de fond), pas des metadonnees partagees.
      notes: () => {},
      lot: (baseId, lot, lotCount, docs) => rows.lot(baseId, lot, lotCount, docs),
      rows: (upserts, removed) => rows.rows(upserts, removed),
    },
    start: () => indexer.start(),
    noteText: (id, path, content) => indexer.noteText(id, path, content),
    dispose: async () => {
      indexer.dispose()
      await rows.whenIdle()
      await index.close()
    },
  }
}
