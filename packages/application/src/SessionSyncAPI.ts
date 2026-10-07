// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'API `sync.openRoom` des plugins (Excalidraw, mindmap, table), servie par
// la session du vault actif. Le plugin garde son API ; le transport, lui,
// passe desormais par le port, comme tout le contenu du vault.
//
// Sans session (document partage isole, fonction propre au serveur), on
// retombe sur `fallback`.
import type { DocumentRoom, SyncAPI } from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

export class SessionSyncAPI implements SyncAPI {
  constructor(
    private readonly getSession: () => IVaultSyncSession | undefined,
    private readonly fallback?: SyncAPI,
  ) {}

  async openRoom(vaultId: string, docId: string, userId: string): Promise<DocumentRoom> {
    const session = this.getSession()
    if (!session) {
      if (this.fallback) return this.fallback.openRoom(vaultId, docId, userId)
      throw new Error('aucune session de vault active')
    }

    const doc = session.openSnapshot(docId)
    // Comme l'ancienne room : rendue une fois le document rejoint.
    await doc.load()

    let closed = false
    const unsubs: (() => void)[] = []
    const track = (unsub: () => void): (() => void) => { unsubs.push(unsub); return unsub }

    return {
      pushSnapshot: async (json) => { if (!closed) await doc.write(json) },
      updatePresence: async (presence) => { if (!closed) await doc.updatePresence(presence) },
      onSnapshot: (cb) => track(doc.onRemoteWrite(cb)),
      onPresence: (cb) => track(doc.onPresence(cb)),
      close: async () => {
        if (closed) return
        closed = true
        for (const unsub of unsubs) unsub()
        session.closeSnapshot(docId)
      },
    }
  }
}
