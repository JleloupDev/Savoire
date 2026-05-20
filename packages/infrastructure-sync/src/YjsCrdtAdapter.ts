// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import type { ICRDT } from '@savoire/plugin-api'
import type { ICollaborativeText, CrdtVersion } from '@savoire/domain-index'
import { YjsCollaborativeText } from './YjsCollaborativeText'

// TypeScript 5.9 + moduleResolution:bundler fails to follow Yjs's .js→.d.ts
// re-export chain for advanced APIs. Cast once; runtime behaviour is validated
// by infrastructure-sync integration tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

export class YjsCrdtAdapter implements ICRDT {
  private readonly ydoc: ReturnType<typeof Y_.Doc>
  private readonly ytext: ReturnType<typeof Y_.Text>
  private readonly awareness: Awareness

  constructor() {
    this.ydoc = new Y_.Doc()
    this.ytext = this.ydoc.getText('codemirror')
    this.awareness = new Awareness(this.ydoc)
  }

  onLocalOp(cb: (op: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') cb(update)
    }
    this.ydoc.on('update', handler)
    return () => this.ydoc.off('update', handler)
  }

  applyRemoteOp(op: Uint8Array): void {
    Y_.applyUpdate(this.ydoc, op, 'remote')
  }

  getSnapshot(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.ydoc) as Uint8Array
  }

  encodeLocalPresence(changedClients: number[]): Uint8Array {
    return encodeAwarenessUpdate(this.awareness, changedClients)
  }

  applyRemotePresence(bytes: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, bytes, 'server')
  }

  getRemoteCursorPositions(): number[] {
    const positions: number[] = []
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.ydoc.clientID) continue
      const anchor = (state as { cursor?: { anchor?: number } })?.cursor?.anchor
      if (typeof anchor === 'number') positions.push(anchor)
    }
    return positions
  }

  onLocalPresenceChanged(
    cb: (bytes: Uint8Array, changedClients: number[]) => void,
  ): () => void {
    const handler = (
      { added, updated }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === 'server') return
      const changed = [...added, ...updated]
      if (changed.length > 0) cb(encodeAwarenessUpdate(this.awareness, changed), changed)
    }
    this.awareness.on('change', handler)
    return () => this.awareness.off('change', handler)
  }

  onTextChange(cb: (text: ICollaborativeText, version?: CrdtVersion) => void): () => void {
    const handler = () => cb(new YjsCollaborativeText(this.ytext, this.ydoc), this.getVersion())
    this.ydoc.on('update', handler)
    return () => this.ydoc.off('update', handler)
  }

  getVersion(): CrdtVersion {
    let clock = 0
    for (const c of (Y_.decodeStateVector(Y_.encodeStateVector(this.ydoc)) as Map<number, number>).values()) clock += c
    return { clock }
  }

  dispose(): void {
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'local')
    this.awareness.destroy()
    this.ydoc.destroy()
  }
}
