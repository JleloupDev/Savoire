// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le cote Worker de l'index local du navigateur : SQLite WebAssembly, le
// VaultIndex du noyau et la table des sources, servis par messages
// (local/rpc.ts). Le module du Worker (apps/web) importe serveWasmIndex de
// l'entree /wasm et l'appelle sur son contexte global : serveWasmIndex(self).
import { DirectLocalIndex } from '../local/LocalIndex'
import { serveLocalIndex } from '../local/rpc'
import type { LocalOpenRequest, MessagePortLike } from '../local/rpc'
import { openWasmDatabase, removeWasmDatabase } from './open'

/** Ouvre l'index d'un vault (OPFS si possible). Un fichier illisible est efface puis refait. */
export async function openWasmLocalIndex(request: LocalOpenRequest): Promise<DirectLocalIndex> {
  const open = async () => {
    const db = await openWasmDatabase(request.name, request.persistence)
    try {
      return await DirectLocalIndex.open(db.driver, {
        persistence: db.persistence,
        ...(db.note ? { note: db.note } : {}),
        ...(request.schema ? { schema: request.schema } : {}),
      })
    } catch (err) {
      await db.driver.close().catch(() => undefined)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { persistence: db.persistence })
    }
  }
  try {
    return await open()
  } catch (err) {
    if ((err as { persistence?: string }).persistence !== 'opfs') throw err
    // L'index est derive : un fichier corrompu ou d'un autre format se refait.
    console.warn('[index local] index illisible, reconstruction', err)
    await removeWasmDatabase(request.name)
    return open()
  }
}

export function serveWasmIndex(port: MessagePortLike): void {
  serveLocalIndex(port, openWasmLocalIndex)
}
