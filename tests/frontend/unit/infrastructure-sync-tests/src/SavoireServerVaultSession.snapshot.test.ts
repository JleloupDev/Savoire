// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Profil serveur : les documents snapshot passent par la room SignalR, et
// l'etat initial vient du RoomJoined (dernier snapshot persiste). Le faux hub
// imite DocumentRoomHub : JoinRoom renvoie le snapshot a l'appelant,
// PushSnapshot persiste et rediffuse aux AUTRES membres de la room.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (...args: unknown[]) => void

const hub = vi.hoisted(() => ({
  snapshots: new Map<string, string>(),
  rooms: new Map<string, Set<{ fire(event: string, ...args: unknown[]): void }>>(),
  sendRoomJoined: true,
}))

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connected: 'Connected' }
  class FakeConnection {
    state = HubConnectionState.Disconnected
    private readonly handlers = new Map<string, Handler>()
    constructor(private readonly url: string) {}
    on(event: string, cb: Handler) { this.handlers.set(event, cb) }
    onreconnected() {}
    onclose() {}
    fire(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args) }
    async start() { this.state = HubConnectionState.Connected }
    async stop() { this.state = HubConnectionState.Disconnected }
    async invoke(method: string, ...args: unknown[]): Promise<unknown> {
      if (!this.url.includes('/hubs/room')) return undefined
      const docId = args[1] as string
      if (method === 'JoinRoom') {
        if (!hub.rooms.has(docId)) hub.rooms.set(docId, new Set())
        hub.rooms.get(docId)!.add(this)
        if (hub.sendRoomJoined) this.fire('RoomJoined', docId, hub.snapshots.get(docId) ?? null)
      } else if (method === 'LeaveRoom') {
        hub.rooms.get(docId)?.delete(this)
        // Le serveur repond apres un aller-retour reseau.
        await new Promise(r => setTimeout(r, 5))
      } else if (method === 'PushSnapshot') {
        hub.snapshots.set(docId, args[2] as string)
        for (const member of hub.rooms.get(docId) ?? []) {
          if (member !== this) member.fire('SnapshotReceived', docId, 'user-of-' + this.url, args[2])
        }
      }
      return undefined
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

const { SavoireServerVaultSession } = await import('@savoire/infrastructure-sync')

const openSession = (userId: string) => SavoireServerVaultSession.open({
  vaultId: 'v1', token: 't', userId, onChanged: () => {}, getToken: () => 't', serverUrl: '',
})

const settle = () => new Promise(r => setTimeout(r, 10))

describe('SavoireServerVaultSession — documents snapshot', () => {
  beforeEach(() => {
    hub.snapshots.clear()
    hub.rooms.clear()
    hub.sendRoomJoined = true
  })

  it('charge le snapshot persiste par le serveur', async () => {
    hub.snapshots.set('d1', '{"elements":[1]}')
    const s = await openSession('alice')
    expect(await s.openSnapshot('d1').load()).toBe('{"elements":[1]}')
    expect(await s.readDocument('d1', 'snapshot')).toBe('{"elements":[1]}')
    await s.dispose()
  })

  it('un document jamais ecrit se charge a null', async () => {
    const s = await openSession('alice')
    expect(await s.openSnapshot('d1').load()).toBeNull()
    await s.dispose()
  })

  it('sans RoomJoined (serveur ancien), le chargement ne bloque pas', async () => {
    hub.sendRoomJoined = false
    hub.snapshots.set('d1', 'ignore')
    const s = await openSession('alice')
    expect(await s.openSnapshot('d1').load()).toBeNull()
    await s.dispose()
  })

  it('une ecriture est persistee et arrive chez l\'autre pair', async () => {
    const a = await openSession('alice')
    const b = await openSession('bob')
    const docA = a.openSnapshot('d1')
    const docB = b.openSnapshot('d1')
    await Promise.all([docA.load(), docB.load()])
    const received: string[] = []
    docB.onRemoteWrite(content => received.push(content))
    await docA.write('v1')
    await settle()
    expect(hub.snapshots.get('d1')).toBe('v1')
    expect(received).toEqual(['v1'])
    expect(await docB.load()).toBe('v1')
    await a.dispose()
    await b.dispose()
  })

  it('lire puis rouvrir aussitot (chargement d\'une vue) garde une room vivante', async () => {
    const a = await openSession('alice')
    const b = await openSession('bob')
    const docB = b.openSnapshot('d1')
    await docB.load()
    const received: string[] = []
    docB.onRemoteWrite(content => received.push(content))
    // Excalidraw : lecture initiale par vault.readDocumentByPath, puis sync.openRoom.
    await a.readDocument('d1', 'snapshot')
    const docA = a.openSnapshot('d1')
    await docA.load()
    await docA.write('apres reouverture')
    await settle()
    expect(received).toEqual(['apres reouverture'])
    await a.dispose()
    await b.dispose()
  })

  it('fermer la derniere ouverture quitte la room', async () => {
    const s = await openSession('alice')
    await s.openSnapshot('d1').load()
    expect(hub.rooms.get('d1')?.size).toBe(1)
    s.closeSnapshot('d1')
    await settle()
    expect(hub.rooms.get('d1')?.size).toBe(0)
    await s.dispose()
  })
})
