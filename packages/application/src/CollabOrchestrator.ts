// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import type { ICRDT, ITransport, IIdentityProvider } from '@savoire/plugin-api'
import { encodeSignedOp } from '@savoire/plugin-api'

const COMPACT_THRESHOLD = 100

export class CollabOrchestrator {
  private readonly cleanups: Array<() => void> = []

  constructor(crdt: ICRDT, transport: ITransport, identity: IIdentityProvider) {
    // Une op faite avant que le document soit branche (ouvert juste avant
    // d'ecrire : une cellule de base, un lot de lignes) peut etre jetee par
    // le transport. On la garde, et on la renvoie quand l'etat initial
    // arrive (le transport est alors branche). Renvoyer une op deja recue ne
    // change rien : les mises a jour CRDT sont idempotentes.
    const early: Uint8Array[] = []
    const pushOp = async (op: Uint8Array) => {
      if (transport.getState() !== 'connected') early.push(op)
      try {
        const signature = await identity.sign(op)
        await transport.push(encodeSignedOp(op, signature, identity.getPublicKey()))
      } catch (e) {
        console.error('[CollabOrchestrator] Failed to sign/push op:', e)
      }
    }

    this.cleanups.push(
      crdt.onLocalOp((op) => void pushOp(op)),
      crdt.onLocalPresenceChanged((bytes) => void transport.pushPresence(bytes)),
      transport.onInit((ops) => {
        ops.forEach((op) => crdt.applyRemoteOp(op))
        if (ops.length > COMPACT_THRESHOLD) {
          void transport.pushSnapshot(crdt.getSnapshot())
        }
        for (const op of early.splice(0)) void pushOp(op)
      }),
      transport.onRemoteOp((op) => crdt.applyRemoteOp(op)),
      transport.onRemotePresence((bytes) => crdt.applyRemotePresence(bytes)),
    )
  }

  dispose(): void {
    this.cleanups.forEach((fn) => fn())
  }
}
