// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Bus du connecteur local : diffuse des messages entre pairs, sans serveur.
// Deux implementations : en memoire (tests) et BroadcastChannel (onglets d'un
// meme navigateur). Le bus ne garantit rien de plus qu'un vrai reseau P2P :
// pas d'ordre global, pas de persistance, pas d'arbitre.
import type { DocumentRoomPresence } from '@savoire/plugin-api'

/** Horodatage d'une ecriture snapshot : le plus grand gagne. */
export interface SnapshotStamp {
  clock: number
  peer: string
}

export type LocalPeerPayload =
  | { t: 'hello' }
  | { t: 'dir'; update: Uint8Array }
  | { t: 'doc-open'; docId: string }
  | { t: 'doc'; docId: string; update: Uint8Array }
  | { t: 'awareness'; docId: string; bytes: Uint8Array }
  | { t: 'index-open'; namespace: string }
  | { t: 'index'; namespace: string; update: Uint8Array }
  | { t: 'snapshot-open'; docId: string }
  | { t: 'snapshot'; docId: string; content: string; stamp: SnapshotStamp }
  | { t: 'presence'; docId: string; presence: DocumentRoomPresence }
  | { t: 'file'; storagePath: string; fileName: string; type: string; bytes: Uint8Array }

export type LocalPeerMessage = LocalPeerPayload & {
  vaultId: string
  /** Pair emetteur. */
  from: string
  /** Compte de l'emetteur. */
  userId: string
  /** Destinataire unique (reponse a une demande). Absent = tout le monde. */
  to?: string
}

export interface ILocalPeerBus {
  post(msg: LocalPeerMessage): void
  /** Recoit les messages du bus. Un pair ignore les siens grace au champ `from`. */
  subscribe(cb: (msg: LocalPeerMessage) => void): () => void
}

/**
 * Bus en memoire, pour les tests. Livraison asynchrone, comme un reseau :
 * un message n'arrive jamais pendant l'appel qui l'emet.
 */
export class InProcessPeerBus implements ILocalPeerBus {
  private readonly subscribers = new Set<(msg: LocalPeerMessage) => void>()

  post(msg: LocalPeerMessage): void {
    for (const cb of [...this.subscribers]) {
      queueMicrotask(() => { if (this.subscribers.has(cb)) cb(msg) })
    }
  }

  subscribe(cb: (msg: LocalPeerMessage) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }
}

/** Bus entre onglets d'un meme navigateur. Un onglet ne recoit pas ses propres messages. */
export class BroadcastChannelPeerBus implements ILocalPeerBus {
  private readonly channel: BroadcastChannel

  constructor(name = 'savoire-local-peers') {
    this.channel = new BroadcastChannel(name)
  }

  post(msg: LocalPeerMessage): void {
    this.channel.postMessage(msg)
  }

  subscribe(cb: (msg: LocalPeerMessage) => void): () => void {
    const handler = (event: MessageEvent<LocalPeerMessage>): void => cb(event.data)
    this.channel.addEventListener('message', handler)
    return () => this.channel.removeEventListener('message', handler)
  }
}
