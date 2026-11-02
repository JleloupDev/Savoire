// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'index SQLite natif d'un vault du disque (ADR-027, etape 6) :
// `<vault>/.savoire/index.sqlite`, ouvert par les commandes Rust
// (src-tauri/src/index_db.rs) ; le noyau d'indexation tourne dans la page.
import { DirectLocalIndex } from '@savoire/indexer-core/local'
import { TauriSqlDriver } from '@savoire/indexer-core/tauri'
import type { TauriBridge } from './bridge'

/** Fichiers de l'index, relatifs a la racine du vault. */
export const INDEX_FILES = ['.savoire/index.sqlite', '.savoire/index.sqlite-wal', '.savoire/index.sqlite-shm'] as const

/**
 * Ouvre l'index d'un vault ouvert. Un index illisible (fichier abime, autre
 * format) est efface puis refait : il est derive des notes.
 */
export async function openDesktopIndex(
  bridge: TauriBridge,
  root: string,
  remove: (path: string) => Promise<void>,
): Promise<DirectLocalIndex> {
  const open = () => DirectLocalIndex.open(
    new TauriSqlDriver((cmd, args) => bridge.invoke(cmd, args), root),
    { persistence: 'disk' },
  )
  try {
    return await open()
  } catch (err) {
    console.warn('[index du bureau] index illisible, reconstruction', err)
    await bridge.invoke('index_close', { root }).catch(() => undefined)
    for (const f of INDEX_FILES) await remove(f).catch(() => undefined)
    return open()
  }
}
