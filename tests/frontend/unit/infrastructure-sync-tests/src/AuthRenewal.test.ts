// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Jeton d'acces refuse (401) : un renouvellement, puis un seul rejeu.
// Et les hubs SignalR relisent le jeton a chaque (re)connexion.
import { describe, it, expect, vi, afterEach } from 'vitest'

const hub = vi.hoisted(() => ({ factories: [] as (() => string | Promise<string>)[] }))

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connected: 'Connected' }
  class HubConnectionBuilder {
    withUrl(_url: string, options?: { accessTokenFactory?: () => string | Promise<string> }) {
      if (options?.accessTokenFactory) hub.factories.push(options.accessTokenFactory)
      return this
    }
    configureLogging() { return this }
    withAutomaticReconnect() { return this }
    build() {
      return {
        state: HubConnectionState.Disconnected,
        on() {}, off() {}, onreconnected() {}, onclose() {},
        async start() {}, async stop() {}, async invoke() { return undefined }, async send() {},
      }
    }
  }
  return { HubConnectionBuilder, HubConnectionState, LogLevel: { None: 6 } }
})

import {
  HttpClient, HttpVaultsBackend, RestVaultStorage, SignalRTransport,
  fetchWithRenewal, setAccessTokenRenewer,
} from '@savoire/infrastructure-sync'

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => '',
    blob: async () => new Blob(['x']),
  } as unknown as Response
}

/** fetch simule : 401 pour tout jeton autre que `valid`. */
function serverAccepting(valid: string) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    return auth === `Bearer ${valid}` ? response(200, { ok: true }) : response(401)
  })
}

function authOf(call: unknown[]): string | undefined {
  return ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization
}

afterEach(() => {
  setAccessTokenRenewer(null)
  hub.factories.length = 0
})

describe('fetchWithRenewal', () => {
  it('sur un 401, renouvelle une fois puis rejoue une fois avec le jeton neuf', async () => {
    const fetchFn = serverAccepting('neuf')
    const renewer = vi.fn(async () => 'neuf')
    setAccessTokenRenewer(renewer)

    const res = await fetchWithRenewal(fetchFn as unknown as typeof fetch, '/api/v1/users/u/vaults', {
      headers: { Authorization: 'Bearer vieux' },
    })

    expect(res.status).toBe(200)
    expect(renewer).toHaveBeenCalledTimes(1)
    expect(renewer).toHaveBeenCalledWith('vieux')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(authOf(fetchFn.mock.calls[1])).toBe('Bearer neuf')
  })

  it('pas de boucle : un second 401 est rendu tel quel', async () => {
    const fetchFn = vi.fn(async () => response(401))
    const renewer = vi.fn(async () => 'neuf')
    setAccessTokenRenewer(renewer)

    const res = await fetchWithRenewal(fetchFn as unknown as typeof fetch, '/api/v1/vaults/v', {
      headers: { Authorization: 'Bearer vieux' },
    })

    expect(res.status).toBe(401)
    expect(renewer).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('pas de rejeu sur les routes /api/v1/auth/*', async () => {
    const fetchFn = vi.fn(async () => response(401))
    const renewer = vi.fn(async () => 'neuf')
    setAccessTokenRenewer(renewer)

    const res = await fetchWithRenewal(fetchFn as unknown as typeof fetch, 'https://srv/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Authorization: 'Bearer vieux' },
    })

    expect(res.status).toBe(401)
    expect(renewer).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('renouvellement impossible : le 401 est rendu, sans rejeu', async () => {
    const fetchFn = vi.fn(async () => response(401))
    setAccessTokenRenewer(async () => null)

    const res = await fetchWithRenewal(fetchFn as unknown as typeof fetch, '/api/v1/vaults/v', {
      headers: { Authorization: 'Bearer vieux' },
    })

    expect(res.status).toBe(401)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sans jeton dans la requete : pas de renouvellement', async () => {
    const fetchFn = vi.fn(async () => response(401))
    const renewer = vi.fn(async () => 'neuf')
    setAccessTokenRenewer(renewer)

    await fetchWithRenewal(fetchFn as unknown as typeof fetch, '/api/v1/share/x/access', {})

    expect(renewer).not.toHaveBeenCalled()
  })
})

describe('clients REST : rejeu apres 401', () => {
  it('HttpVaultsBackend (liste des vaults)', async () => {
    const fetchFn = serverAccepting('neuf')
    setAccessTokenRenewer(async () => 'neuf')
    const backend = new HttpVaultsBackend({ fetchFn: fetchFn as unknown as typeof fetch })

    await expect(backend.listVaults('u1', 'vieux')).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('RestVaultStorage (telechargement d\'une piece jointe)', async () => {
    const fetchFn = serverAccepting('neuf')
    setAccessTokenRenewer(async () => 'neuf')
    const storage = new RestVaultStorage({ fetchFn: fetchFn as unknown as typeof fetch })

    await expect(storage.fetchAttachment('v1', 'img.png', 'vieux')).resolves.toBeInstanceOf(Blob)
    expect(authOf(fetchFn.mock.calls[1])).toBe('Bearer neuf')
  })

  it('HttpClient lit getToken et rejoue avec le jeton renouvele', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      return auth === 'Bearer neuf' ? response(200, { id: 'x' }) : response(401)
    })
    setAccessTokenRenewer(async () => 'neuf')
    const client = new HttpClient({ fetchFn: fetchFn as unknown as typeof fetch, getToken: () => 'vieux' })

    await expect(client.getJson('/api/v1/vaults/v')).resolves.toEqual({ id: 'x' })
  })
})

describe('SignalR : le jeton est relu a chaque connexion', () => {
  it('apres un renouvellement, la reconnexion prend le jeton neuf', async () => {
    let token = 'vieux'
    new SignalRTransport({ serverUrl: '', getToken: () => token })
    const factory = hub.factories.at(-1)!
    expect(await factory()).toBe('vieux')

    token = 'neuf'
    expect(await factory()).toBe('neuf')
  })
})
