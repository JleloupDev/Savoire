// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// One vault-scoped CRDT channel per index namespace (wikilinks, headings,
// hashtags, graph, backlinks, metadata, filename — NOT fulltext, deliberately
// excluded for now: MiniSearch's own snapshot isn't dictionary-shaped and
// stays on the server-sequenced op-log path). Unlike EdgesyncAwarenessChannel,
// this goes through the REAL edgesync protocol (Session/Keyring/HELLO/KEY/
// SyncReq/SyncResp, wired by EdgesyncVaultSession.openIndex) — an index isn't
// ephemeral: a peer who opens it late still needs the full current state, not
// just future updates, exactly like a document.
//
// Backed by a plain Y.Map<entryId, value>. Every contributor examined
// (wikilinks/headings/hashtags/graph/backlinks/metadata/filename) already
// does, locally, "delete then recompute this key's entry/entries" — per-key,
// idempotent, independent of other keys' state. That's exactly Y.Map's own
// semantics (last-write-wins per key, keys never conflict with each other),
// so this requires zero changes to poc/edgesync-protocol: YjsCrdt already
// syncs a whole Y.Doc generically, whatever shared type lives inside it
// (Y.Text today for documents, Y.Map here).
//
// Vault-scoped and access-gated by construction: EdgesyncVaultSession derives
// the resource as `${vaultId}/index/${namespace}` and grants its key exactly
// like a document channel — vault membership (K_vault) is index access, no
// separate ACL needed. Namespaces are deliberately separate channels/Sessions
// (not one shared blob) so a client only ever syncs the indexes its loaded
// plugins actually care about.
import * as Y from 'yjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

export class EdgesyncIndexChannel {
  private readonly doc: Y.Doc
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly map: any

  constructor(doc: Y.Doc = new Y_.Doc()) {
    this.doc = doc
    this.map = (doc as ReturnType<typeof Y_.Doc>).getMap('entries')
  }

  /** Underlying Y.Doc — wrapped by EdgesyncVaultSession in a protocol YjsCrdt,
   *  the same "two views, one state" pattern as YjsCrdtAdapter.rawDoc. */
  get rawDoc(): unknown {
    return this.doc
  }

  /** Whole-value replace for this key — idempotent, no merge with the previous value. */
  set(id: string, value: unknown): void {
    this.map.set(id, value)
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  get(id: string): unknown {
    return this.map.get(id)
  }

  getAll(): { id: string; value: unknown }[] {
    return [...this.map.entries()].map(([id, value]) => ({ id, value }))
  }

  /** Fires with the ids that were added/updated/removed in one change (local or remote). */
  onChange(cb: (changedIds: string[]) => void): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (event: any) => cb([...event.changes.keys.keys()])
    this.map.observe(handler)
    return () => this.map.unobserve(handler)
  }
}
