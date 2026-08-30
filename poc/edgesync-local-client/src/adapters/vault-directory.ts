// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vault directory channel: Y.Map<docId, {path}>, implementing edgesync's ICrdt
// port exactly like adapters/yjs-crdt.ts does for a document's Y.Text — a
// Session can drive it the same way (see spec §5.2). docId is a UUID v4 minted
// at creation (not derived from path), so a rename never changes channel identity.
import * as Y from 'yjs'
import type { ICrdt } from 'edgesync-protocol/node'

// Same TS 5.9 + moduleResolution:bundler workaround as edgesync-protocol's
// adapters/yjs-crdt.ts: the .js -> .d.ts re-export chain doesn't resolve
// across package boundaries under this tsconfig. Runtime behaviour is tested.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

const REMOTE = 'remote'

export interface DocMeta {
  path: string
}

export interface DocEntry extends DocMeta {
  id: string
}

export class VaultDirectory implements ICrdt {
  readonly doc: Y.Doc

  constructor(doc: Y.Doc = new Y_.Doc()) {
    this.doc = doc
  }

  private map(): Y.Map<DocMeta> {
    return this.doc.getMap('directory')
  }

  add(id: string, meta: DocMeta): void {
    this.map().set(id, meta)
  }

  rename(id: string, path: string): void {
    const existing = this.map().get(id)
    if (!existing) return
    this.map().set(id, { ...existing, path })
  }

  remove(id: string): void {
    this.map().delete(id)
  }

  list(): DocEntry[] {
    return [...this.map().entries()].map(([id, meta]) => ({ id, ...meta }))
  }

  /** Business-level observer: fires on any change to the directory, local or
   *  remote — unlike onLocalUpdate() below, which the protocol uses and which
   *  deliberately ignores remote-origin updates. */
  onChange(cb: () => void): () => void {
    const handler = () => cb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = this.map() as any
    m.observe(handler)
    return () => m.unobserve(handler)
  }

  // ── ICrdt ──────────────────────────────────────────────────────────────
  onLocalUpdate(cb: (update: Uint8Array) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return
      cb(update)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = this.doc as any
    doc.on('update', handler)
    return () => doc.off('update', handler)
  }

  applyRemote(update: Uint8Array): void {
    Y_.applyUpdate(this.doc, update, REMOTE)
  }

  snapshot(): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc) as Uint8Array
  }

  stateVector(): Uint8Array {
    return Y_.encodeStateVector(this.doc) as Uint8Array
  }

  diffSince(stateVector: Uint8Array): Uint8Array {
    return Y_.encodeStateAsUpdate(this.doc, stateVector) as Uint8Array
  }
}
