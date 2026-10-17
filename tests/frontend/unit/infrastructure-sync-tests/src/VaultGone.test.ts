// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vault disparu pendant qu'il est ouvert (profil serveur). Le faux hub imite
// le filtre d'erreurs du serveur : un vault supprime rend
// « HubException: vault-not-found » a chaque appel. La session doit le
// reconnaitre, arreter ses reessais et reconnexions, et prevenir une fois.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (...args: unknown[]) => void

const hub = vi.hoisted(() => ({
  goneVaults: new Set<string>(),
  /** Documents absents du registre : code distinct, le vault reste ouvert. */
  unregisteredDocs: new Set<string>(),
  invocations: [] as { url: string; method: string; args: unknown[] }[],
  connections: [] as unknown[],
}))

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connected: 'Connected' }
  const serverError = (method: string, code: string) =>
    new Error(`An unexpected error occurred invoking '${method}' on the server. HubException: ${code}`)
  class FakeConnection {
    state = HubConnectionState.Disconnected
    readonly handlers = new Map<string, Handler>()
    reconnected: (() => Promise<void> | void) | null = null
    closed: ((err?: Error) => void) | null = null
    constructor(readonly url: string) { hub.connections.push(this) }
    on(event: string, cb: Handler) { this.handlers.set(event, cb) }
    off() {}
    onreconnected(cb: () => Promise<void>) { this.reconnected = cb }
    onclose(cb: (err?: Error) => void) { this.closed = cb }
    async start() { this.state = HubConnectionState.Connected }
    async stop() {
      if (this.state === HubConnectionState.Disconnected) return
      this.state = HubConnectionState.Disconnected
      this.closed?.()
    }
    async invoke(method: string, ...args: unknown[]): Promise<unknown> {
      hub.invocations.push({ url: this.url, method, args })
      const vaultId = args[0] as string
      if (method === 'LeaveRoom' || method === 'LeaveDocument') return undefined
      if (hub.goneVaults.has(vaultId)) throw serverError(method, 'vault-not-found')
      if (method === 'JoinDocument' && hub.unregisteredDocs.has(args[1] as string))
        throw serverError(method, 'document-not-in-vault')
      if (method === 'JoinVault') { this.handlers.get('InitVault')?.(vaultId, []); return undefined }
      if (method === 'RegisterDocuments' || method === 'JoinIndex') return []
      if (method === 'JoinRoom') { this.handlers.get('RoomJoined')?.(args[1], null); return undefined }
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

const { SavoireServerVaultSession, isVaultGoneError, VaultGoneSignal } = await import('@savoire/infrastructure-sync')
const { VaultGoneError } = await import('@savoire/application')

interface FakeConn { url: string; state: string; reconnected: (() => Promise<void> | void) | null }

const identity = {
  getPublicKey: () => new Uint8Array(32),
  sign: async () => new Uint8Array(64),
  verify: async () => true,
} as never

const open = (onVaultGone = vi.fn(), onConnectionChange = vi.fn()) => SavoireServerVaultSession.open({
  vaultId: 'v1', token: 't', userId: 'u1', onChanged: () => {}, getToken: () => 't', serverUrl: '',
  identity, onVaultGone, onConnectionChange,
})

const settle = () => new Promise(r => setTimeout(r, 10))
const calls = (method: string) => hub.invocations.filter(i => i.method === method).length
const vaultHub = () => (hub.connections as FakeConn[]).find(c => c.url.includes('/hubs/vault'))!

describe('isVaultGoneError', () => {
  it('reconnait le code du serveur', () => {
    expect(isVaultGoneError(new Error("An unexpected error occurred invoking 'RegisterDocuments' on the server. HubException: vault-not-found"))).toBe(true)
    expect(isVaultGoneError(new VaultGoneError('v1'))).toBe(true)
  })

  it('ne confond pas un document absent, un refus ou un alea reseau', () => {
    expect(isVaultGoneError(new Error('An unexpected error occurred invoking \'JoinDocument\' on the server. HubException: document-not-in-vault'))).toBe(false)
    expect(isVaultGoneError(new Error('An unexpected error occurred invoking \'PushSnapshot\' on the server. HubException: access-denied'))).toBe(false)
    expect(isVaultGoneError(new Error("An unexpected error occurred invoking 'JoinVault' on the server."))).toBe(false)
    expect(isVaultGoneError(new Error('WebSocket closed with status code: 1006'))).toBe(false)
    expect(isVaultGoneError(undefined)).toBe(false)
  })
})

describe('VaultGoneSignal', () => {
  it('ne se declenche qu\'une fois, et seulement sur le bon code', () => {
    const signal = new VaultGoneSignal('v1')
    const cb = vi.fn()
    signal.onGone(cb)
    expect(signal.check(new Error('reseau'))).toBe(false)
    expect(signal.gone).toBe(false)
    expect(signal.check(new Error('HubException: vault-not-found'))).toBe(true)
    expect(signal.check(new Error('HubException: vault-not-found'))).toBe(true)
    expect(signal.gone).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('SavoireServerVaultSession — vault disparu', () => {
  beforeEach(() => {
    hub.goneVaults.clear()
    hub.unregisteredDocs.clear()
    hub.invocations.length = 0
    hub.connections.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('vault deja perdu a l\'ouverture : open() rejette avec VaultGoneError, sans prevenir', async () => {
    hub.goneVaults.add('v1')
    const onVaultGone = vi.fn()
    await expect(open(onVaultGone)).rejects.toBeInstanceOf(VaultGoneError)
    expect(onVaultGone).not.toHaveBeenCalled()
    expect(calls('JoinVault')).toBe(1)
    expect(vaultHub().state).toBe('Disconnected')
  })

  it('perdu en cours de route : previent une fois, puis plus aucun appel au hub', async () => {
    const onVaultGone = vi.fn()
    const onConnectionChange = vi.fn()
    const session = await open(onVaultGone, onConnectionChange)
    hub.goneVaults.add('v1')

    await expect(session.registerDocuments(['d1'])).rejects.toBeInstanceOf(VaultGoneError)
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    expect(vaultHub().state).toBe('Disconnected')
    expect(session.getState()).toBe('disconnected')
    // La session previent deja : pas de « deconnecte » en plus.
    expect(onConnectionChange).not.toHaveBeenCalledWith('disconnected')

    const before = hub.invocations.length
    await expect(session.registerDocuments(['d2'])).rejects.toBeInstanceOf(VaultGoneError)
    session.openIndex('backlinks')
    await session.locks!.acquire('d1')
    await settle()
    expect(hub.invocations.length).toBe(before)
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    await session.dispose()
  })

  it('le serveur annonce un changement d\'acces : la verification refusee ferme le vault', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    const conn = vaultHub() as FakeConn & { handlers: Map<string, Handler> }
    // Changement qui ne nous concerne pas : rien ne se passe.
    conn.handlers.get('VaultAccessChanged')?.('v1')
    await settle()
    expect(calls('CheckVaultAccess')).toBe(1)
    expect(onVaultGone).not.toHaveBeenCalled()

    hub.goneVaults.add('v1')
    conn.handlers.get('VaultAccessChanged')?.('v1')
    await settle()
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    expect(conn.state).toBe('Disconnected')
    await session.dispose()
  })

  it('une reconnexion apres la perte ne rejoint pas le vault', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    const conn = vaultHub()
    hub.goneVaults.add('v1')

    // Reconnexion automatique : le serveur refuse JoinVault.
    await conn.reconnected?.()
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    expect(conn.state).toBe('Disconnected')

    const joins = calls('JoinVault')
    await conn.reconnected?.()
    expect(calls('JoinVault')).toBe(joins)
    await session.dispose()
  })

  it('un document refuse avec vault-not-found arrete aussi le vault', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    hub.goneVaults.add('v1')
    session.openDocument('d1')
    await settle()
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    expect(vaultHub().state).toBe('Disconnected')
    await session.dispose()
  })

  it('un document non inscrit ne ferme pas le vault', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    hub.unregisteredDocs.add('d1')
    session.openDocument('d1')
    await settle()
    expect(onVaultGone).not.toHaveBeenCalled()
    expect(session.getState()).toBe('connected')
    await session.dispose()
  })

  it('une room snapshot refusee avec vault-not-found previent la session', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    hub.goneVaults.add('v1')
    session.openSnapshot('s1')
    await settle()
    expect(onVaultGone).toHaveBeenCalledTimes(1)
    const rooms = calls('JoinRoom')
    session.openSnapshot('s2')
    await settle()
    expect(calls('JoinRoom')).toBe(rooms)
    await session.dispose()
  })

  it('fermee avant la perte : ne previent plus personne', async () => {
    const onVaultGone = vi.fn()
    const session = await open(onVaultGone)
    await session.dispose()
    hub.goneVaults.add('v1')
    await vaultHub().reconnected?.()
    expect(onVaultGone).not.toHaveBeenCalled()
  })
})
