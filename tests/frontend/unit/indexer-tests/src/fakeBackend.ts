// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Faux backend (node:http) : l'API interne du pair indexeur telle que la
// decrit docs/Architecture/indexer-protocol.md, avec de vrais journaux Yjs
// ecrits comme les clients (arbre : cartes 'vault' et 'folders' de
// YMapVaultDirectory ; notes : texte 'codemirror' ; bases : arbre partage).
//
//  - flux : une ligne par ressource (arbre d'un vault, document), deplacee
//    en fin avec une nouvelle sequence a chaque ecriture ; vault-deleted ;
//    epoque ; filtre par instance (owner) ;
//  - jeton (401), instance inconnue (400), 404 des journaux ;
//  - pannes a la demande : backend coupe (503), latence par document.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { YjsSharedTree } from '../../../../../packages/infrastructure-sync/src/YjsSharedTree'

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

interface Row {
  seq: number
  vaultId: string
  kind: 'vault' | 'document' | 'vault-deleted'
  docId?: string
}

class Journaled {
  readonly doc = new Y.Doc()
  readonly log: string[] = []
  constructor() {
    this.doc.on('update', (u: Uint8Array) => this.log.push(b64(u)))
  }
}

interface FakeVault {
  id: string
  tree: Journaled
  docs: Map<string, Journaled>
  managed: boolean
}

export interface FakeBackendOptions {
  token: string
  instances?: string[]
  /** Proprietaire d'un vault (defaut : la premiere instance). */
  owner?: (vaultId: string) => string
}

export class FakeBackend {
  readonly vaults = new Map<string, FakeVault>()
  private rows = new Map<string, Row>()
  private seq = 0
  epoch = 'epoch-1'
  /** Backend coupe : toutes les routes repondent 503. */
  down = false
  /** Latence ajoutee a chaque lecture de document (ms). */
  docLatencyMs = 0
  /** Compteurs de requetes par route. */
  readonly hits = { vaults: 0, changes: 0, tree: 0, document: 0 }
  /** Documents lus, par id. */
  readonly docReads = new Map<string, number>()
  private server?: Server
  instances: string[]
  owner: (vaultId: string) => string

  constructor(private readonly opts: FakeBackendOptions) {
    this.instances = opts.instances ?? ['idx-a']
    this.owner = opts.owner ?? (() => this.instances[0]!)
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        const json = JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
        res.end(json)
      }
      const url = new URL(req.url ?? '/', 'http://x')
      if (this.down) return send(503, { error: { code: 'down', message: 'coupe' } })
      if (req.headers.authorization !== `Bearer ${this.opts.token}`) return send(401, { error: { code: 'unauthorized', message: '' } })
      const instance = url.searchParams.get('instance')
      const p = url.pathname
      if (p === '/internal/indexer/vaults' || p === '/internal/indexer/changes') {
        if (!instance || !this.instances.includes(instance)) return send(400, { error: { code: 'unknown_instance', message: instance ?? '' } })
      }
      if (p === '/internal/indexer/vaults') {
        this.hits.vaults++
        return send(200, { vaults: [...this.vaults.values()].filter(v => v.managed && this.owner(v.id) === instance).map(v => ({ vaultId: v.id, name: v.id })) })
      }
      if (p === '/internal/indexer/changes') {
        this.hits.changes++
        const since = Number(url.searchParams.get('since') ?? 0)
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)))
        if (since < 0) return send(400, { error: { code: 'invalid_cursor', message: '' } })
        const sorted = [...this.rows.values()].filter(r => r.seq > since).sort((a, b) => a.seq - b.seq)
        const out: Row[] = []
        let last = since
        for (const r of sorted) {
          last = r.seq
          const v = this.vaults.get(r.vaultId)
          const inScope = r.kind === 'vault-deleted' || (v?.managed ?? false)
          if (inScope && this.owner(r.vaultId) === instance) out.push(r)
          if (out.length === limit) break
        }
        return send(200, { changes: out.map(r => ({ seq: r.seq, vaultId: r.vaultId, kind: r.kind, ...(r.docId ? { docId: r.docId } : {}) })), last, epoch: this.epoch })
      }
      let m = /^\/internal\/indexer\/vaults\/([^/]+)\/tree$/.exec(p)
      if (m) {
        this.hits.tree++
        const v = this.vaults.get(decodeURIComponent(m[1]!))
        if (!v || !v.managed) return send(404, { error: { code: 'not_found', message: '' } })
        return send(200, { updates: [...v.tree.log], format: 'yjs' })
      }
      m = /^\/internal\/indexer\/vaults\/([^/]+)\/documents\/([^/]+)$/.exec(p)
      if (m) {
        this.hits.document++
        const docId = decodeURIComponent(m[2]!)
        this.docReads.set(docId, (this.docReads.get(docId) ?? 0) + 1)
        const v = this.vaults.get(decodeURIComponent(m[1]!))
        const d = v?.docs.get(docId)
        const answer = () => (!v || !v.managed || !d ? send(404, { error: { code: 'not_found', message: '' } }) : send(200, { updates: [...d.log], format: 'yjs' }))
        if (this.docLatencyMs) setTimeout(answer, this.docLatencyMs)
        else answer()
        return
      }
      send(404, { error: { code: 'not_found', message: p } })
    })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    return this
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }

  // ── Ecritures (comme le feraient les clients) ────────────────────────────

  private touch(vaultId: string, kind: Row['kind'], docId?: string): void {
    const key = kind === 'document' ? `document:${docId}` : `${kind}:${vaultId}`
    this.rows.delete(key)
    this.rows.set(key, { seq: ++this.seq, vaultId, kind, ...(docId ? { docId } : {}) })
  }

  vault(id: string): FakeVault {
    let v = this.vaults.get(id)
    if (!v) {
      v = { id, tree: new Journaled(), docs: new Map(), managed: true }
      this.vaults.set(id, v)
      this.touch(id, 'vault')
    }
    return v
  }

  private docOf(v: FakeVault, docId: string): Journaled {
    let d = v.docs.get(docId)
    if (!d) {
      d = new Journaled()
      v.docs.set(docId, d)
    }
    return d
  }

  /** Cree (ou remplace) une note : entree d'arbre si besoin, puis texte. */
  writeNote(vaultId: string, docId: string, path: string, text: string): void {
    const v = this.vault(vaultId)
    const entry = v.tree.doc.getMap('vault').get(docId) as { path?: string } | undefined
    if (entry?.path !== path) {
      v.tree.doc.getMap('vault').set(docId, { path })
      this.touch(vaultId, 'vault')
    }
    const d = this.docOf(v, docId)
    const t = d.doc.getText('codemirror')
    d.doc.transact(() => {
      t.delete(0, t.length)
      t.insert(0, text)
    })
    this.touch(vaultId, 'document', docId)
  }

  /** Une frappe : ajoute du texte a la fin. */
  type(vaultId: string, docId: string, more: string): void {
    const d = this.vaults.get(vaultId)!.docs.get(docId)!
    const t = d.doc.getText('codemirror')
    t.insert(t.length, more)
    this.touch(vaultId, 'document', docId)
  }

  rename(vaultId: string, docId: string, path: string): void {
    const v = this.vaults.get(vaultId)!
    v.tree.doc.getMap('vault').set(docId, { path })
    this.touch(vaultId, 'vault')
  }

  /** Retire le document de l'arbre (suppression definitive). */
  removeDoc(vaultId: string, docId: string): void {
    const v = this.vaults.get(vaultId)!
    v.tree.doc.getMap('vault').delete(docId)
    v.docs.delete(docId)
    this.rows.delete(`document:${docId}`)
    this.touch(vaultId, 'vault')
  }

  deleteVault(vaultId: string): void {
    this.vaults.delete(vaultId)
    for (const [k, r] of this.rows) if (r.vaultId === vaultId) this.rows.delete(k)
    this.touch(vaultId, 'vault-deleted')
  }

  /** Base recreee : sequences depuis 0, nouvelle epoque. */
  resetEpoch(epoch: string): void {
    this.epoch = epoch
    this.seq = 0
    const rows = [...this.rows.values()].filter(r => r.kind !== 'vault-deleted')
    this.rows.clear()
    for (const r of rows) this.touch(r.vaultId, r.kind, r.docId)
  }

  // ── Bases et lignes legeres (comme plugin-base) ──────────────────────────

  /** Une base (.base) et ses lignes, rangees dans les lots `<id>~lot-NNN`. */
  writeBase(vaultId: string, baseId: string, path: string, rows: { id: string; title: string; values: Record<string, unknown> }[], lotCount = 4): void {
    const v = this.vault(vaultId)
    v.tree.doc.getMap('vault').set(baseId, { path })
    this.touch(vaultId, 'vault')
    const base = this.docOf(v, baseId)
    const lots = new Map<number, typeof rows>()
    for (const r of rows) {
      const n = lotOf(r.id, lotCount)
      lots.set(n, [...(lots.get(n) ?? []), r])
    }
    new YjsSharedTree(base.doc).root.set('base', {
      kind: 'map',
      entries: { lotCount, lots: { kind: 'map', entries: Object.fromEntries([...lots.keys()].map(n => [String(n), true])) } },
    })
    this.touch(vaultId, 'document', baseId)
    for (const [n, list] of lots) {
      const lotId = `${baseId}~lot-${String(n).padStart(3, '0')}`
      const lot = this.docOf(v, lotId)
      const tree = new YjsSharedTree(lot.doc)
      tree.transact(() => {
        for (const r of list) tree.root.set(`row:${r.id}`, { kind: 'map', entries: { title: r.title, ...(r.values as Record<string, never>) } })
      })
      this.touch(vaultId, 'document', lotId)
    }
  }

  /** Change une cellule d'une ligne (son lot seulement). */
  setCell(vaultId: string, baseId: string, rowId: string, key: string, value: string | number, lotCount = 4): void {
    const lotId = `${baseId}~lot-${String(lotOf(rowId, lotCount)).padStart(3, '0')}`
    const lot = this.vaults.get(vaultId)!.docs.get(lotId)!
    const row = lot.doc.getMap('tree').get(`row:${rowId}`) as Y.Map<unknown>
    row.set(key, value)
    this.touch(vaultId, 'document', lotId)
  }

  /** Retire une ligne de son lot. */
  removeRow(vaultId: string, baseId: string, rowId: string, lotCount = 4): void {
    const lotId = `${baseId}~lot-${String(lotOf(rowId, lotCount)).padStart(3, '0')}`
    const lot = this.vaults.get(vaultId)!.docs.get(lotId)!
    lot.doc.getMap('tree').delete(`row:${rowId}`)
    this.touch(vaultId, 'document', lotId)
  }
}

function lotOf(id: string, n: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % n
}
