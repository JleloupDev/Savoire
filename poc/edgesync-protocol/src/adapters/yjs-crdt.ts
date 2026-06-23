// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Yjs adapter for the ICrdt port. The protocol core never imports Yjs.
import * as Y from 'yjs'
import type { ICrdt } from '../ports/crdt'

const REMOTE = 'remote'

export class YjsCrdt implements ICrdt {
  readonly doc: Y.Doc

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc
  }

  /** The shared text field used by the POC. */
  text(): Y.Text {
    return this.doc.getText('message')
  }

  onLocalUpdate(cb: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return // do not re-broadcast remote updates
      cb(update)
    }
    this.doc.on('update', handler)
    return () => this.doc.off('update', handler)
  }

  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE)
  }

  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }

  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc)
  }

  diffSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector)
  }
}
