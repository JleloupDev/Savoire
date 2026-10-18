// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil serveur : etat complet des documents (lecture, fusion), flush, et un
// vault copie dans les deux sens entre le serveur et une session locale. Le
// faux serveur imite VaultHub (repertoire, registre, index) et SyncHub
// (documents CRDT) : il garde les ops et les rediffuse aux autres connexions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'

type Handler = (...args: unknown[]) => void

const server = vi.hoisted(() => ({
  vaultOps: new Map<string, string[]>(),
  indexOps: new Map<string, string[]>(),
  docOps: new Map<string, string[]>(),
  /** docId -> vaultId : le registre « document -> vault ». */
  registry: new Map<string, string>(),
  connections: new Set<{ url: string; fire(event: string, ...args: unknown[]): void; groups: Set<string> }>(),
  /** Coupe les envois du hub du vault (pour tester flush). */
  dropVaultPushes: false,
}))

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connected: 'Connected' }
  class FakeConnection {
    state = HubConnectionState.Disconnected
    readonly groups = new Set<string>()
    private readonly handlers = new Map<string, Handler[]>()
    constructor(readonly url: string) {}
    on(event: string, cb: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]) }
    off(event: string, cb?: Handler) { this.handlers.set(event, (this.handlers.get(event) ?? []).filter(h => cb && h !== cb)) }
    onreconnected() {}
    onclose() {}
    fire(event: string, ...args: unknown[]) { for (const h of this.handlers.get(event) ?? []) h(...args) }
    async start() { this.state = HubConnectionState.Connected; server.connections.add(this) }
    async stop() { this.state = HubConnectionState.Disconnected; server.connections.delete(this) }
    private others(group: string, event: string, ...args: unknown[]) {
      for (const c of server.connections) if (c !== this && c.groups.has(group)) c.fire(event, ...args)
    }
    async invoke(method: string, ...args: unknown[]): Promise<unknown> {
      const vaultId = args[0] as string
      switch (method) {
        case 'JoinVault':
          this.groups.add(`vault:${vaultId}`)
          this.fire('InitVault', vaultId, server.vaultOps.get(vaultId) ?? [])
          return undefined
        case 'PushVaultOperation': {
          if (server.dropVaultPushes) throw new Error('hub coupe')
          const op = args[1] as string
          server.vaultOps.set(vaultId, [...(server.vaultOps.get(vaultId) ?? []), op])
          this.others(`vault:${vaultId}`, 'VaultOperationReceived', vaultId, op)
          return undefined
        }
        case 'RegisterDocuments': {
          const ids = args[1] as string[]
          const rejected = ids.filter(id => (server.registry.get(id) ?? vaultId) !== vaultId)
          for (const id of ids) if (!rejected.includes(id)) server.registry.set(id, vaultId)
          return rejected
        }
        case 'JoinIndex': {
          const ns = args[1] as string
          this.groups.add(`index:${vaultId}:${ns}`)
          return server.indexOps.get(`${vaultId}:${ns}`) ?? []
        }
        case 'PushIndexUpdate': {
          const ns = args[1] as string
          const key = `${vaultId}:${ns}`
          server.indexOps.set(key, [...(server.indexOps.get(key) ?? []), args[2] as string])
          this.others(`index:${key}`, 'IndexUpdateReceived', vaultId, ns, args[2])
          return undefined
        }
        case 'JoinDocument': {
          const docId = args[1] as string
          if (server.registry.get(docId) !== vaultId) throw new Error('document-not-found')
          this.groups.add(`doc:${docId}`)
          this.fire('InitDocument', docId, server.docOps.get(docId) ?? [])
          return undefined
        }
        case 'LeaveDocument':
          this.groups.delete(`doc:${args[1] as string}`)
          return undefined
        case 'PushOperation': {
          const [, docId, clientId, op] = args as string[]
          if (server.registry.get(docId) !== vaultId) throw new Error('document-not-found')
          server.docOps.set(docId, [...(server.docOps.get(docId) ?? []), op])
          this.others(`doc:${docId}`, 'ReceiveOperation', docId, clientId, op)
          return undefined
        }
        default:
          return undefined
      }
    }
  }
  class HubConnectionBuilder {
    private url = ''
    withUrl(url: string) { this.url = url; return this }
    configureLogging() { return this }
    withAutomaticReconnect() { return this }
    build() { return new FakeConnection(this.url) }
  }
  return { HubConnectionBuilder, HubConnectionState, LogLevel: { None: 6 } }
})

const { SavoireServerVaultSession, InProcessPeerBus, LocalPeerVaultSessionFactory } = await import('@savoire/infrastructure-sync')
const { transferVault } = await import('@savoire/application')
type Session = Awaited<ReturnType<typeof SavoireServerVaultSession.open>>

const identity = {
  init: async () => {},
  getPublicKey: () => new Uint8Array(32).fill(7),
  sign: async () => new Uint8Array(64).fill(9),
}

const opened: { dispose(): Promise<void> }[] = []
async function openServer(vaultId: string, userId = 'alice'): Promise<Session> {
  const s = await SavoireServerVaultSession.open({
    vaultId, token: 't', userId, identity, onChanged: () => {}, getToken: () => 't', serverUrl: '',
  })
  opened.push(s)
  return s
}
async function openLocal(vaultId: string) {
  const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: 5 })
  const s = await factory.open({ vaultId, token: '', userId: 'alice', onChanged: () => {} })
  opened.push(s)
  return s
}
const settle = () => new Promise(r => setTimeout(r, 20))

function insert(crdt: unknown, text: string): void {
  (crdt as { rawDoc: { getText(n: string): { insert(i: number, t: string): void } } }).rawDoc.getText('codemirror').insert(0, text)
}
function textOf(crdt: unknown): string {
  return (crdt as { rawDoc: { getText(n: string): { toString(): string } } }).rawDoc.getText('codemirror').toString()
}

beforeEach(() => {
  server.vaultOps.clear(); server.indexOps.clear(); server.docOps.clear(); server.registry.clear()
  server.connections.clear(); server.dropVaultPushes = false
})
afterEach(async () => { for (const s of opened.splice(0)) await s.dispose() })

describe('SavoireServerVaultSession — etat complet', () => {
  it('lit l\'etat persiste d\'un document sans l\'ouvrir, et le fusionne comme une op signee', async () => {
    const a = await openServer('v1')
    await a.registerDocuments(['d1', 'd2'])
    insert(a.openDocument('d1'), 'bonjour')
    await settle()

    const b = await openServer('v1', 'bob')
    const state = await b.readDocumentState('d1')
    await b.mergeDocumentState('d2', state)

    // L'op poussee porte la signature, comme celles de l'editeur.
    const pushed = server.docOps.get('d2')!
    expect(pushed).toHaveLength(1)
    const bytes = Uint8Array.from(atob(pushed[0]), c => c.charCodeAt(0))
    expect([...bytes.slice(-32)]).toEqual(new Array(32).fill(7))
    const view = a.openDocument('d2')
    await settle()
    expect(textOf(view)).toBe('bonjour')
  })

  it('une fusion refusee par le serveur rejette (pas de perte silencieuse)', async () => {
    const a = await openServer('v1')
    await expect(a.mergeDocumentState('jamais-inscrit', new Uint8Array([0, 0]))).rejects.toThrow('document-not-found')
  })

  it('flush renvoie l\'etat du repertoire quand des envois se sont perdus', async () => {
    const a = await openServer('v1')
    server.dropVaultPushes = true
    a.directory.add({ id: 'n1', path: 'note.md' })
    await settle()
    await expect(a.flush()).rejects.toThrow('hub coupe')
    server.dropVaultPushes = false
    a.directory.add({ id: 'n2', path: 'autre.md' })
    await a.flush()
    const b = await openServer('v1', 'bob')
    expect(b.directory.getAll().map(d => d.id).sort()).toEqual(['n1', 'n2'])
  })
})

describe('transferVault — serveur <-> local', () => {
  it('telecharge un vault du serveur, puis le renvoie dans un nouveau vault', async () => {
    // Un vault sur le serveur.
    const remote = await openServer('v1')
    await remote.registerDocuments(['n1', 'n2'])
    remote.directory.add({ id: 'n1', path: 'Projet.md' })
    remote.directory.add({ id: 'n2', path: '.trash/Vieux.md' })
    remote.directory.addFolder('Vide/')
    insert(remote.openDocument('n1'), '# Projet')
    insert(remote.openDocument('n2'), 'jete')
    remote.openSharedMap('review').set('c1', { id: 'c1', docId: 'n1', text: 'A voir' })
    await remote.flush()
    await settle()

    // Telechargement : une session neuve sur le serveur -> une copie locale.
    const source = await openServer('v1', 'bob')
    const local = await openLocal('copie')
    const down = await transferVault(source, local)
    expect(down.errors).toEqual([])
    expect(local.directory.getAll().map(d => `${d.id}:${d.path}`).sort()).toEqual(['n1:Projet.md', 'n2:.trash/Vieux.md'])
    expect(local.directory.getFolders()).toEqual(['Vide/'])
    expect(await local.readDocument('n1', 'crdt')).toBe('# Projet')
    expect(local.openSharedMap('review').getAll()).toHaveLength(1)

    // Envoi dans un nouveau vault : les ids sont deja inscrits dans v1, ils changent.
    const fresh = await openServer('v2')
    const up = await transferVault(local, fresh)
    expect(up.errors).toEqual([])
    const n1 = up.renamedIds.n1
    expect(n1).toBeDefined()
    expect(server.registry.get(n1)).toBe('v2')

    // Ce que garde le serveur, vu d'une session neuve.
    const check = await openServer('v2', 'carol')
    expect(check.directory.getAll().map(d => d.path).sort()).toEqual(['.trash/Vieux.md', 'Projet.md'])
    expect(check.directory.getFolders()).toEqual(['Vide/'])
    expect(await check.readDocument(n1, 'crdt')).toBe('# Projet')
    const review = check.openSharedMap('review')
    await review.loaded
    expect(review.getAll()[0].value).toMatchObject({ docId: n1, text: 'A voir' })
  })
})
