// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Compaction d'un canal d'index (profil serveur, etape 8 de l'ADR-027).
//
// Le faux hub imite VaultHub : JoinIndex rend le journal et retient, pour
// CETTE connexion, les trames rendues ; SnapshotIndex remplace exactement ces
// trames-la par l'etat compacte. Une trame arrivee entre-temps reste.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'

type Handler = (...args: unknown[]) => void
interface StoredOp { id: number; b64: string }

const server = vi.hoisted(() => ({
  indexOps: new Map<string, { id: number; b64: string }[]>(),
  nextId: 1,
  snapshotCalls: 0,
  /** Retient SnapshotIndex jusqu'a ce qu'on le libere (pour glisser une ecriture avant). */
  gate: null as Promise<void> | null,
  connections: new Set<{ fire(event: string, ...args: unknown[]): void; groups: Set<string> }>(),
  /** Toutes les connexions creees, pour simuler une coupure. */
  all: [] as { cut(): void; reconnect(): Promise<void> }[],
}))

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connected: 'Connected' }
  class FakeConnection {
    state = HubConnectionState.Disconnected
    readonly groups = new Set<string>()
    private readonly handlers = new Map<string, Handler[]>()
    /** Trames rendues a JoinIndex, par canal : ce que SnapshotIndex peut remplacer. */
    private readonly joined = new Map<string, number[]>()
    constructor(readonly url: string) {}
    on(event: string, cb: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]) }
    off() {}
    private reconnected: (() => Promise<void> | void) | null = null
    onreconnected(cb: () => Promise<void> | void) { this.reconnected = cb }
    onclose() {}
    /** Coupure : la connexion sort des groupes et ne recoit plus rien. */
    cut() { this.groups.clear(); server.connections.delete(this) }
    /** Reconnexion automatique de SignalR : nouvelle connexion, hors des groupes. */
    async reconnect() { server.connections.add(this); await this.reconnected?.() }
    fire(event: string, ...args: unknown[]) { for (const h of this.handlers.get(event) ?? []) h(...args) }
    async start() { this.state = HubConnectionState.Connected; server.connections.add(this) }
    async stop() { this.state = HubConnectionState.Disconnected; server.connections.delete(this) }
    async invoke(method: string, ...args: unknown[]): Promise<unknown> {
      const vaultId = args[0] as string
      switch (method) {
        case 'JoinVault':
          this.fire('InitVault', vaultId, [])
          return undefined
        case 'JoinIndex': {
          const key = `${vaultId}:${args[1] as string}`
          const ops = server.indexOps.get(key) ?? []
          this.joined.set(key, ops.map(o => o.id))
          this.groups.add(`index:${key}`)
          return ops.map(o => o.b64)
        }
        case 'PushIndexUpdate': {
          const key = `${vaultId}:${args[1] as string}`
          server.indexOps.set(key, [...(server.indexOps.get(key) ?? []), { id: server.nextId++, b64: args[2] as string }])
          for (const c of server.connections)
            if (c !== this && c.groups.has(`index:${key}`)) c.fire('IndexUpdateReceived', vaultId, args[1], args[2])
          return undefined
        }
        case 'SnapshotIndex': {
          server.snapshotCalls++
          if (server.gate) await server.gate
          const key = `${vaultId}:${args[1] as string}`
          const covered = new Set(this.joined.get(key) ?? [])
          this.joined.delete(key)
          if (covered.size === 0) return undefined
          const current = server.indexOps.get(key) ?? []
          const kept = current.filter(o => !covered.has(o.id))
          // Comme EfCrdtOpRepository.ReplaceAsync : plus rien a remplacer
          // (une autre compaction est passee), rien n'est ecrit.
          if (kept.length === current.length) return undefined
          server.indexOps.set(key, [...kept, { id: server.nextId++, b64: args[2] as string }])
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
    build() { const c = new FakeConnection(this.url); server.all.push(c); return c }
  }
  return { HubConnectionBuilder, HubConnectionState, LogLevel: { None: 6 } }
})

const { SavoireServerVaultSession, INDEX_COMPACT_THRESHOLD, bytesToBase64 } = await import('@savoire/infrastructure-sync')
type Session = Awaited<ReturnType<typeof SavoireServerVaultSession.open>>

const identity = {
  init: async () => {},
  getPublicKey: () => new Uint8Array(32).fill(7),
  sign: async () => new Uint8Array(64).fill(9),
}

const VAULT = 'v-idx'
const NS = 'metadata'
const KEY = `${VAULT}:${NS}`

const opened: Session[] = []
async function open(): Promise<Session> {
  const s = await SavoireServerVaultSession.open({
    vaultId: VAULT, token: 't', userId: 'alice', identity, onChanged: () => {}, getToken: () => 't', serverUrl: '',
  })
  opened.push(s)
  return s
}
const settle = () => new Promise(r => setTimeout(r, 20))

/** Remplit le journal du serveur avec `count` trames, une entree par trame, comme des editeurs successifs. */
function seedJournal(count: number): void {
  const doc = new Y.Doc()
  const map = doc.getMap('entries')
  const ops: StoredOp[] = []
  doc.on('update', (u: Uint8Array) => { ops.push({ id: server.nextId++, b64: bytesToBase64(u) }) })
  for (let i = 0; i < count; i++) map.set(`doc-${i}`, { title: `Note ${i}`, n: i })
  server.indexOps.set(KEY, ops)
}

function entriesOf(session: Session): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { id, value } of session.openIndex(NS).getAll()) out[id] = value
  return out
}

beforeEach(() => {
  server.indexOps.clear(); server.nextId = 1; server.snapshotCalls = 0; server.gate = null
  server.connections.clear(); server.all.length = 0
})
afterEach(async () => {
  for (const s of opened.splice(0)) await s.dispose()
})

describe('SavoireServerVaultSession — compaction d\'un canal d\'index', () => {
  it('sous le seuil, le journal reste tel quel', async () => {
    seedJournal(INDEX_COMPACT_THRESHOLD)
    const a = await open()
    await a.openIndex(NS).loaded
    await settle()
    expect(server.snapshotCalls).toBe(0)
    expect(server.indexOps.get(KEY)).toHaveLength(INDEX_COMPACT_THRESHOLD)
  })

  it('au-dela du seuil, le journal est remplace par un etat, et rejoindre apres donne le meme etat', async () => {
    seedJournal(INDEX_COMPACT_THRESHOLD + 50)
    const a = await open()
    await a.openIndex(NS).loaded
    await settle()
    const before = entriesOf(a)
    expect(Object.keys(before)).toHaveLength(INDEX_COMPACT_THRESHOLD + 50)

    expect(server.snapshotCalls).toBe(1)
    expect(server.indexOps.get(KEY)).toHaveLength(1)

    const b = await open()
    await b.openIndex(NS).loaded
    expect(entriesOf(b)).toEqual(before)
  })

  it('une ecriture arrivee pendant la compaction n\'est pas perdue', async () => {
    seedJournal(INDEX_COMPACT_THRESHOLD + 10)
    let release!: () => void
    server.gate = new Promise<void>(r => { release = r })

    // B est deja la : il ecrit pendant que A compacte.
    const b = await open()
    const bIndex = b.openIndex(NS)
    await bIndex.loaded
    expect(server.snapshotCalls).toBe(1)

    const a = await open()
    await a.openIndex(NS).loaded
    bIndex.set('nouvelle', { title: 'Ecrite pendant la compaction' })
    await settle()
    release()
    await settle()

    const c = await open()
    await c.openIndex(NS).loaded
    const entries = entriesOf(c)
    expect(entries['nouvelle']).toEqual({ title: 'Ecrite pendant la compaction' })
    expect(Object.keys(entries)).toHaveLength(INDEX_COMPACT_THRESHOLD + 11)
  })

  it('deux compactions concurrentes ne perdent rien et n\'empilent pas deux etats', async () => {
    seedJournal(INDEX_COMPACT_THRESHOLD + 20)
    let release!: () => void
    server.gate = new Promise<void>(r => { release = r })

    const a = await open()
    const b = await open()
    await Promise.all([a.openIndex(NS).loaded, b.openIndex(NS).loaded])
    // Chacun ajoute sa propre entree avant que les compactions passent.
    a.openIndex(NS).set('de-a', { by: 'a' })
    b.openIndex(NS).set('de-b', { by: 'b' })
    await settle()
    expect(server.snapshotCalls).toBe(2)
    release()
    await settle()

    // Les trames d'origine sont remplacees par le premier etat ; le second ne
    // trouve plus rien a remplacer. Restent cet etat et les deux ecritures.
    expect(server.indexOps.get(KEY)).toHaveLength(3)

    const c = await open()
    await c.openIndex(NS).loaded
    const entries = entriesOf(c)
    expect(Object.keys(entries)).toHaveLength(INDEX_COMPACT_THRESHOLD + 22)
    expect(entries['de-a']).toEqual({ by: 'a' })
    expect(entries['de-b']).toEqual({ by: 'b' })
  })
})

describe('SavoireServerVaultSession — canal d\'index apres une reconnexion', () => {
  it('rejoint le canal, rattrape ce qui a ete manque, et recoit la suite', async () => {
    const a = await open()
    const b = await open()
    const aIndex = a.openIndex(NS)
    const bIndex = b.openIndex(NS)
    await Promise.all([aIndex.loaded, bIndex.loaded])
    const bConnection = server.all[1]

    bConnection.cut()
    aIndex.set('pendant', { title: 'Ecrite pendant la coupure' })
    await settle()
    expect(entriesOf(b)['pendant']).toBeUndefined()

    await bConnection.reconnect()
    await settle()
    expect(entriesOf(b)['pendant']).toEqual({ title: 'Ecrite pendant la coupure' })

    aIndex.set('apres', { title: 'Ecrite apres' })
    await settle()
    expect(entriesOf(b)['apres']).toEqual({ title: 'Ecrite apres' })
  })
})
