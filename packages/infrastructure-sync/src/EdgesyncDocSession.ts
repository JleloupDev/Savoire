// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Composition root of one edgesync-synced document: wires the app's Y.Doc,
// the user's identity and the blind-relay transport into a protocol Session.
//
// Owner rule (design decision): the vault owner holds the keys; failing an
// explicit owner, the FIRST CONNECTED peer of the room does. Concretely: an
// empty room at join time makes us key holder (Keyring.genesis + granting),
// anyone else starts empty and receives the epoch via a KEY message.
// v0 limits, accepted: the keyring is not persisted (a reopening owner mints a
// fresh epoch and re-grants), and two peers racing into an empty room may both
// self-elect (converges on content, splits the vault key — ACL work later).

import type * as Y from 'yjs'
import {
  OwnIdentity, YjsCrdt, Keyring, PeerStore, Session, randomBytes,
} from 'edgesync-protocol'
import { EdgesyncRelayTransport } from './EdgesyncRelayTransport'

export interface EdgesyncDocSessionOptions {
  vaultId: string
  docId: string
  /** 32-byte Ed25519 seed (e.g. ServerKeyProvider.exportSecret()). */
  identitySeed: Uint8Array
  /** The app's live Y.Doc (YjsCrdtAdapter.rawDoc) — synced in place. */
  doc: unknown
  serverUrl?: string
  getToken?: () => string | null
  /** Test seam: bypasses serverUrl. */
  transport?: EdgesyncRelayTransport
}

export class EdgesyncDocSession {
  private constructor(
    private readonly transport: EdgesyncRelayTransport,
    private readonly session: Session,
    /** True when this peer self-elected as key holder (first in the room). */
    readonly isOwner: boolean,
  ) {}

  static async open(o: EdgesyncDocSessionOptions): Promise<EdgesyncDocSession> {
    const transport = o.transport
      ?? new EdgesyncRelayTransport({ serverUrl: o.serverUrl, getToken: o.getToken })
    await transport.connect(o.vaultId)

    const first = transport.peers().length === 0
    const keyring = first ? Keyring.genesis(() => randomBytes(32)) : Keyring.empty()
    const session = new Session({
      identity: OwnIdentity.fromSignSeed(o.identitySeed),
      crdt: new YjsCrdt(o.doc as Y.Doc),
      keyring,
      transport,
      peers: new PeerStore(),
      resource: `${o.vaultId}/${o.docId}`,
      granting: first,
    })
    // The Session was built after connect(): replay presence so it HELLOs the
    // peers already in the room.
    transport.replayPeers()

    return new EdgesyncDocSession(transport, session, first)
  }

  dispose(): void {
    this.session.dispose()
    void this.transport.close()
  }
}
