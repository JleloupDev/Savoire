// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adresse du serveur : resolution des URL du client (avec et sans base),
// saisie de l'adresse, memorisation du serveur choisi et de sa session,
// messages d'erreur de connexion. Le pont Tauri est simule.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HttpAuthBackend, HttpVaultsBackend, RestVaultStorage, ServerAddressError,
  getServerBaseUrl, normalizeServerAddress, serverUrl, setServerBaseUrl,
} from '@savoire/infrastructure-sync'
import { createServerSettings } from '@savoire/desktop'
import {
  chooseServer, defaultServerFor, forgetServer, getServerChoice, installDesktopServers,
  type ServerSettingsPort,
} from '../../../../../apps/web/src/serverConnection'
import { getAccountStorage, parseAccounts, setAccountStorage } from '../../../../../apps/web/src/accountStorage'
import { classifyLoginError, describeLoginError } from '../../../../../apps/web/src/serverErrors'
import { FakeBridge } from './fakeBridge'

afterEach(() => {
  setServerBaseUrl('')
  setAccountStorage(null)
})

describe('resolution des URL du serveur', () => {
  it('sans base, les URL restent relatives (navigateur)', () => {
    expect(getServerBaseUrl()).toBe('')
    expect(serverUrl('/api/v1/auth/login')).toBe('/api/v1/auth/login')
    expect(serverUrl('/hubs/vault')).toBe('/hubs/vault')
  })

  it('avec une base commune, tout part vers le serveur choisi', () => {
    setServerBaseUrl('https://savoire.exemple.fr/')
    expect(serverUrl('/api/v1/auth/login')).toBe('https://savoire.exemple.fr/api/v1/auth/login')
    expect(serverUrl('hubs/vault')).toBe('https://savoire.exemple.fr/hubs/vault')
  })

  it('une base propre au client l\'emporte sur la base commune', () => {
    setServerBaseUrl('https://a.exemple')
    expect(serverUrl('/api/x', 'http://b.exemple:5000')).toBe('http://b.exemple:5000/api/x')
    // Vide : la base commune (c'est le cas des clients construits avec serverUrl: '').
    expect(serverUrl('/api/x', '')).toBe('https://a.exemple/api/x')
  })

  it('les clients REST lisent la base a chaque appel', async () => {
    const urls: string[] = []
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url))
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const vaults = new HttpVaultsBackend({ fetchFn })
    const storage = new RestVaultStorage({ fetchFn })
    await vaults.listVaults('u1', 't')
    setServerBaseUrl('http://192.168.1.10:5000')
    await vaults.listVaults('u1', 't')
    await storage.listDocuments('v1', 't')
    expect(urls[0]).toBe('/api/v1/users/u1/vaults')
    expect(urls[1]).toBe('http://192.168.1.10:5000/api/v1/users/u1/vaults')
    expect(urls[2]).toBe('http://192.168.1.10:5000/api/v1/vaults/v1/documents')
    expect(storage.resolveFileUrl('v1', 'a.png')).toBe('http://192.168.1.10:5000/api/v1/vaults/v1/attachments/a.png')
  })

  it('la connexion passe par la base (fetch global)', async () => {
    setServerBaseUrl('https://savoire.exemple.fr')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await new HttpAuthBackend().login('a@b.c', 'x')
    expect(String(spy.mock.calls[0][0])).toBe('https://savoire.exemple.fr/api/v1/auth/login')
    spy.mockRestore()
  })
})

describe('saisie de l\'adresse', () => {
  it('normalise', () => {
    expect(normalizeServerAddress(' https://savoire.exemple.fr/ ')).toBe('https://savoire.exemple.fr')
    expect(normalizeServerAddress('http://192.168.1.10:5000')).toBe('http://192.168.1.10:5000')
    expect(normalizeServerAddress('savoire.exemple.fr')).toBe('https://savoire.exemple.fr')
    expect(normalizeServerAddress('HTTPS://Savoire.Exemple.FR/notes/')).toBe('https://savoire.exemple.fr/notes')
  })

  it('refuse avec un message lisible', () => {
    for (const bad of ['', '   ', 'ftp://x.fr', 'https://u:p@x.fr', 'https://x.fr/?a=1', 'https://x.fr/#a', 'http://']) {
      expect(() => normalizeServerAddress(bad), bad).toThrow(ServerAddressError)
    }
  })
})

/** Reglages de serveurs en memoire, comme les garde Rust. */
class MemorySettings implements ServerSettingsPort {
  servers: string[] = []
  current: string | null = null
  sessions = new Map<string, string>()
  async list() { return { servers: [...this.servers], current: this.current } }
  async select(url: string) {
    this.servers = [url, ...this.servers.filter(s => s !== url)]
    this.current = url
    return this.list()
  }
  async forget(url: string) {
    this.servers = this.servers.filter(s => s !== url)
    if (this.current === url) this.current = null
    this.sessions.delete(url)
    return this.list()
  }
  async loadSession(url: string) { return this.sessions.get(url) ?? null }
  async saveSession(url: string, data: string | null) {
    if (data === null) this.sessions.delete(url)
    else this.sessions.set(url, data)
  }
}

const packaged = { protocol: 'tauri:', hostname: 'localhost', origin: 'tauri://localhost' }
const windows = { protocol: 'http:', hostname: 'tauri.localhost', origin: 'http://tauri.localhost' }
const dev = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:3002' }
const account = (userId: string) => ({ userId, email: `${userId}@x`, displayName: userId, refreshToken: `r-${userId}`, isActive: true })

describe('serveur choisi dans la version bureau', () => {
  it('par defaut : le Vite en dev, aucun dans le paquet installe', () => {
    expect(defaultServerFor(dev)).toBe('http://127.0.0.1:3002')
    expect(defaultServerFor(packaged)).toBeNull()
    expect(defaultServerFor(windows)).toBeNull()
  })

  it('premier lancement du paquet : aucun serveur, URL relatives', async () => {
    const choice = await installDesktopServers(new MemorySettings(), packaged)
    expect(choice).toEqual({ configurable: true, servers: [], current: null })
    expect(getServerBaseUrl()).toBe('')
  })

  it('en dev, le proxy est propose et choisi', async () => {
    const choice = await installDesktopServers(new MemorySettings(), dev)
    expect(choice.current).toBe('http://127.0.0.1:3002')
    expect(choice.servers).toEqual(['http://127.0.0.1:3002'])
    expect(serverUrl('/hubs/vault')).toBe('http://127.0.0.1:3002/hubs/vault')
  })

  it('memorise le serveur et sa session, rendus au lancement suivant', async () => {
    const settings = new MemorySettings()
    await installDesktopServers(settings, packaged)
    expect(await chooseServer('http://127.0.0.1:5000/')).toBe('http://127.0.0.1:5000')
    expect(getServerBaseUrl()).toBe('http://127.0.0.1:5000')
    // Connexion : les comptes partent vers la session du serveur.
    getAccountStorage().save([account('u1')])
    await vi.waitFor(() => expect(settings.sessions.has('http://127.0.0.1:5000')).toBe(true))

    // Redemarrage : meme reglages, nouvelle page.
    setServerBaseUrl('')
    setAccountStorage(null)
    const again = await installDesktopServers(settings, packaged)
    expect(again.current).toBe('http://127.0.0.1:5000')
    expect(getServerBaseUrl()).toBe('http://127.0.0.1:5000')
    expect(getAccountStorage().load().map(a => a.userId)).toEqual(['u1'])

    // Deconnexion : plus de session gardee.
    getAccountStorage().save([])
    await vi.waitFor(() => expect(settings.sessions.has('http://127.0.0.1:5000')).toBe(false))
  })

  it('changer de serveur change les comptes, plusieurs serveurs gardes', async () => {
    const settings = new MemorySettings()
    settings.sessions.set('https://b.exemple', JSON.stringify([account('ub')]))
    await installDesktopServers(settings, packaged)
    await chooseServer('https://a.exemple')
    getAccountStorage().save([account('ua')])
    await chooseServer('https://b.exemple')
    expect(getAccountStorage().load().map(a => a.userId)).toEqual(['ub'])
    expect(getServerChoice().servers).toEqual(['https://b.exemple', 'https://a.exemple'])
    await chooseServer('https://a.exemple')
    expect(getAccountStorage().load().map(a => a.userId)).toEqual(['ua'])

    await forgetServer('https://a.exemple')
    expect(getServerChoice().current).toBeNull()
    expect(getServerChoice().servers).toEqual(['https://b.exemple'])
    expect(getServerBaseUrl()).toBe('')
    expect(settings.sessions.has('https://a.exemple')).toBe(false)
  })

  it('une adresse invalide ne change rien', async () => {
    const settings = new MemorySettings()
    await installDesktopServers(settings, packaged)
    await expect(chooseServer('ftp://x')).rejects.toThrow(ServerAddressError)
    expect(settings.servers).toEqual([])
    expect(getServerBaseUrl()).toBe('')
  })

  it('une session gardee illisible donne zero compte', () => {
    expect(parseAccounts('pas du json')).toEqual([])
    expect(parseAccounts('{"a":1}')).toEqual([])
    expect(parseAccounts(JSON.stringify([account('u'), { userId: 3 }])).map(a => a.userId)).toEqual(['u'])
  })
})

describe('reglages de serveurs, cote pont Tauri', () => {
  it('appelle les commandes Rust', async () => {
    const bridge = new FakeBridge()
      .on('server_list', () => ({ servers: ['https://a'], current: 'https://a' }))
      .on('server_select', (args) => ({ servers: [(args as { url: string }).url], current: (args as { url: string }).url }))
      .on('server_session_get', () => null)
    const s = createServerSettings(bridge)
    expect(await s.list()).toEqual({ servers: ['https://a'], current: 'https://a' })
    expect((await s.select('https://b')).current).toBe('https://b')
    expect(await s.loadSession('https://b')).toBeNull()
    await s.saveSession('https://b', '[]')
    await s.saveSession('https://b', null)
    expect(bridge.calls.map(c => c.cmd)).toEqual([
      'server_list', 'server_select', 'server_session_get', 'server_session_set', 'server_session_set',
    ])
    expect(bridge.calls[3].args).toEqual({ url: 'https://b', data: '[]' })
    expect(bridge.calls[4].args).toEqual({ url: 'https://b', data: null })
  })
})

describe('erreurs de connexion lisibles', () => {
  const credentials = 'Identifiants incorrects'
  it('serveur injoignable, certificat refuse, CORS : erreur reseau', () => {
    const err = new TypeError('Load failed')
    expect(classifyLoginError(err)).toBe('unreachable')
    const msg = describeLoginError(err, { server: 'https://x.fr', credentials })
    expect(msg).toContain('Impossible de joindre le serveur https://x.fr')
    expect(msg).toContain('certificat')
  })
  it('mauvaise adresse : ce n\'est pas un serveur Savoire', () => {
    expect(classifyLoginError(new Error('404'))).toBe('not-savoire')
    expect(classifyLoginError(new SyntaxError('Unexpected token <'))).toBe('not-savoire')
    expect(describeLoginError(new Error('405'), { server: 'https://x.fr', credentials })).toContain('pas un serveur Savoire')
  })
  it('identifiants et erreurs serveur', () => {
    expect(describeLoginError(new Error('401'), { credentials })).toBe(credentials)
    expect(describeLoginError(new Error('502'), { server: 'https://x.fr', credentials })).toContain('502')
  })
})
