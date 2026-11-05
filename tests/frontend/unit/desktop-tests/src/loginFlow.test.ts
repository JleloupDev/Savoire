// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion par le fournisseur d'identite (ADR-028) : le client OIDC
// (HttpAuthBackend, code + PKCE) et les deux facons d'y aller (loginFlow.ts).
import { describe, it, expect, vi } from 'vitest'
import { AuthService, type AppAuthResponse, type IAuthAPI, type PendingLogin } from '@savoire/application'
import { HttpAuthBackend } from '@savoire/infrastructure-sync'
import {
  CALLBACK_PATH, PENDING_KEY, describeAuthError, loopbackLoginDriver, readLoginCallback, redirectLoginDriver,
} from '../../../../../apps/web/src/loginFlow'

const SERVER = 'https://savoire.test'
const ISSUER = 'https://auth.test'

/** Un serveur Savoire et son fournisseur d'identite, en memoire. */
function fakeNetwork(opts: { refreshError?: { status: number; body: unknown } } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === `${SERVER}/api/v1/auth/config`) {
      return json({ issuer: ISSUER, webClientId: 'web-id', desktopClientId: 'desk-id', scopes: 'openid profile email offline_access' })
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        revocation_endpoint: `${ISSUER}/revoke`,
        end_session_endpoint: `${ISSUER}/end`,
      })
    }
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('grant_type') === 'refresh_token' && opts.refreshError) return json(opts.refreshError.body, opts.refreshError.status)
      return json({ access_token: `at-${form.get('grant_type')}`, refresh_token: 'rt-new', expires_in: 3600 })
    }
    if (url === `${SERVER}/api/v1/auth/me`) {
      return json({ id: 'sub-1', displayName: 'Alice', email: 'alice@test', isAdmin: false })
    }
    if (url === `${ISSUER}/revoke`) return new Response(null, { status: 200 })
    return new Response('not found', { status: 404 })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

async function sha256Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Buffer.from(digest).toString('base64url')
}

describe('HttpAuthBackend (OpenID Connect, code + PKCE)', () => {
  it('beginLogin : adresse d\'autorisation avec PKCE (S256), etat et appli web', async () => {
    const { fetchImpl } = fakeNetwork()
    const auth = new HttpAuthBackend(SERVER, 'web', fetchImpl)
    const { url, pending } = await auth.beginLogin(`https://app.test${CALLBACK_PATH}`, 'create')
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe(`${ISSUER}/authorize`)
    expect(u.searchParams.get('client_id')).toBe('web-id')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('prompt')).toBe('create')
    expect(u.searchParams.get('scope')).toContain('offline_access')
    expect(u.searchParams.get('state')).toBe(pending.state)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toBe(await sha256Url(pending.codeVerifier))
    expect(pending.codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  it('bureau : l\'appli native declaree chez le fournisseur', async () => {
    const { fetchImpl } = fakeNetwork()
    const { url } = await new HttpAuthBackend(SERVER, 'desktop', fetchImpl).beginLogin('http://127.0.0.1:5123/callback')
    expect(new URL(url).searchParams.get('client_id')).toBe('desk-id')
  })

  it('completeLogin : echange le code (verifier compris) puis lit le compte', async () => {
    const { fetchImpl, calls } = fakeNetwork()
    const auth = new HttpAuthBackend(SERVER, 'web', fetchImpl)
    const { pending } = await auth.beginLogin('https://app.test/auth/callback')
    const res = await auth.completeLogin(pending, new URLSearchParams({ code: 'the-code', state: pending.state }))
    expect(res).toEqual({ accessToken: 'at-authorization_code', refreshToken: 'rt-new', expiresIn: 3600, user: { id: 'sub-1', displayName: 'Alice', email: 'alice@test', isAdmin: false } })
    const token = calls.find(c => c.url === `${ISSUER}/token`)!
    const form = new URLSearchParams(String(token.init?.body))
    expect(form.get('code')).toBe('the-code')
    expect(form.get('code_verifier')).toBe(pending.codeVerifier)
    expect(form.get('redirect_uri')).toBe('https://app.test/auth/callback')
    const me = calls.find(c => c.url === `${SERVER}/api/v1/auth/me`)!
    expect((me.init?.headers as Record<string, string>).Authorization).toBe('Bearer at-authorization_code')
  })

  it('completeLogin : un etat different est refuse (aucun echange de code)', async () => {
    const { fetchImpl, calls } = fakeNetwork()
    const auth = new HttpAuthBackend(SERVER, 'web', fetchImpl)
    const { pending } = await auth.beginLogin('https://app.test/auth/callback')
    await expect(auth.completeLogin(pending, new URLSearchParams({ code: 'c', state: 'autre' }))).rejects.toThrow(/etat/)
    expect(calls.some(c => c.url === `${ISSUER}/token`)).toBe(false)
  })

  it('completeLogin : l\'erreur du fournisseur (annulation) est rendue avec son code', async () => {
    const { fetchImpl } = fakeNetwork()
    const auth = new HttpAuthBackend(SERVER, 'web', fetchImpl)
    const { pending } = await auth.beginLogin('https://app.test/auth/callback')
    const err = await auth.completeLogin(pending, new URLSearchParams({ error: 'access_denied', state: pending.state })).catch(e => e)
    expect(err.code).toBe('access_denied')
    expect(describeAuthError(err)).toBe('Connexion annulée.')
  })

  it('refresh : jeton de renouvellement refuse (invalid_grant) = 401, la session est finie', async () => {
    const { fetchImpl } = fakeNetwork({ refreshError: { status: 400, body: { error: 'invalid_grant' } } })
    const err = await new HttpAuthBackend(SERVER, 'web', fetchImpl).refresh('rt-old').catch(e => e)
    expect(err.status).toBe(401)
  })

  it('refresh : fournisseur en panne = 5xx (le compte reste garde, voir session.ts)', async () => {
    const { fetchImpl } = fakeNetwork({ refreshError: { status: 503, body: {} } })
    const err = await new HttpAuthBackend(SERVER, 'web', fetchImpl).refresh('rt-old').catch(e => e)
    expect(err.status).toBe(503)
  })

  it('logout : revoque le jeton de renouvellement chez le fournisseur', async () => {
    const { fetchImpl, calls } = fakeNetwork()
    await new HttpAuthBackend(SERVER, 'web', fetchImpl).logout('at', 'rt-x')
    const revoke = calls.find(c => c.url === `${ISSUER}/revoke`)!
    const form = new URLSearchParams(String(revoke.init?.body))
    expect(form.get('token')).toBe('rt-x')
    expect(form.get('client_id')).toBe('web-id')
  })

  it('la configuration est gardee par serveur, et un echec ne reste pas en cache', async () => {
    let fail = true
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ issuer: ISSUER, webClientId: 'w', desktopClientId: null, scopes: 'openid' }), { status: 200 })
    }) as unknown as typeof fetch
    const auth = new HttpAuthBackend(SERVER, 'web', fetchImpl)
    await expect(auth.config()).rejects.toBeInstanceOf(TypeError)
    fail = false
    expect((await auth.config()).webClientId).toBe('w')
    await auth.config()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

const RESPONSE: AppAuthResponse = { accessToken: 'at', refreshToken: 'rt', expiresIn: 60, user: { id: 'u', displayName: 'U', email: 'u@x', isAdmin: false } }
const PENDING: PendingLogin = { issuer: ISSUER, clientId: 'web-id', redirectUri: 'https://app.test/auth/callback', state: 'st', codeVerifier: 'v', tokenEndpoint: `${ISSUER}/token` }

function fakeAuth(): IAuthAPI {
  return {
    config: vi.fn(),
    beginLogin: vi.fn(async (redirectUri: string) => ({ url: `${ISSUER}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`, pending: { ...PENDING, redirectUri } })),
    completeLogin: vi.fn(async () => RESPONSE),
    refresh: vi.fn(),
    logout: vi.fn(),
    endSessionUrl: vi.fn(async (back: string) => `${ISSUER}/end?post_logout_redirect_uri=${encodeURIComponent(back)}`),
  }
}

function memoryPort() {
  const store = new Map<string, string>()
  const port = {
    origin: 'https://app.test',
    assigned: [] as string[],
    replaced: [] as string[],
    assign(url: string) { port.assigned.push(url) },
    replace(path: string) { port.replaced.push(path) },
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } },
  }
  return { port, store }
}

describe('navigateur : redirection et retour sur /auth/callback', () => {
  it('start : garde l\'etat PKCE et part chez le fournisseur', async () => {
    const { port, store } = memoryPort()
    const auth = fakeAuth()
    expect(await redirectLoginDriver(port).start(auth, 'create')).toBeNull()
    expect(auth.beginLogin).toHaveBeenCalledWith('https://app.test/auth/callback', 'create')
    expect(port.assigned[0]).toContain(`${ISSUER}/authorize`)
    expect(JSON.parse(store.get(PENDING_KEY)!).redirectUri).toBe('https://app.test/auth/callback')
  })

  it('complete : reprend l\'etat (une seule fois) et efface l\'adresse de retour', async () => {
    const { port, store } = memoryPort()
    store.set(PENDING_KEY, JSON.stringify(PENDING))
    const auth = fakeAuth()
    const params = new URLSearchParams({ code: 'c', state: 'st' })
    expect(await redirectLoginDriver(port).complete(auth, params)).toBe(RESPONSE)
    expect(auth.completeLogin).toHaveBeenCalledWith(PENDING, params)
    expect(store.has(PENDING_KEY)).toBe(false)
    expect(port.replaced).toEqual(['/'])
  })

  it('complete sans etat garde (onglet rouvert, retour rejoue) : erreur claire', async () => {
    const { port } = memoryPort()
    await expect(redirectLoginDriver(port).complete(fakeAuth(), new URLSearchParams({ code: 'c' }))).rejects.toThrow(/recommencez/)
  })

  it('fin de session : chez le fournisseur, retour a l\'accueil, session designee par le jeton d\'identite', async () => {
    const { port } = memoryPort()
    const auth = fakeAuth()
    await redirectLoginDriver(port).endSession!(auth, 'id-token-1')
    expect(auth.endSessionUrl).toHaveBeenCalledWith('https://app.test/', 'id-token-1')
    expect(port.assigned[0]).toBe(`${ISSUER}/end?post_logout_redirect_uri=${encodeURIComponent('https://app.test/')}`)
  })

  it('readLoginCallback : seulement sur /auth/callback', () => {
    expect(readLoginCallback({ pathname: '/auth/callback', search: '?code=c&state=s' })?.get('code')).toBe('c')
    expect(readLoginCallback({ pathname: '/', search: '?code=c' })).toBeNull()
  })
})

describe('bureau : navigateur du systeme, retour sur 127.0.0.1', () => {
  it('ecoute, ouvre le navigateur, attend le retour, echange le code', async () => {
    const log: string[] = []
    const bridge = {
      listen: async () => { log.push('listen'); return 51234 },
      open: async (url: string) => { log.push(`open ${new URL(url).searchParams.get('redirect_uri')}`) },
      wait: async (secs: number) => { log.push(`wait ${secs}`); return 'code=c&state=st' },
    }
    const auth = fakeAuth()
    expect(await loopbackLoginDriver(bridge).start(auth)).toBe(RESPONSE)
    expect(log).toEqual(['listen', 'open http://127.0.0.1:51234/callback', 'wait 600'])
    // Le navigateur peut deja etre connecte avec un autre compte : on propose d'en choisir un.
    expect(auth.beginLogin).toHaveBeenCalledWith('http://127.0.0.1:51234/callback', 'select_account')
    expect(vi.mocked(auth.completeLogin).mock.calls[0][1].get('code')).toBe('c')
  })

  it('le service d\'application reste un simple relais', async () => {
    const backend = fakeAuth()
    const svc = new AuthService(backend)
    await svc.endSessionUrl('https://app.test/')
    expect(backend.endSessionUrl).toHaveBeenCalledWith('https://app.test/', undefined)
  })
})
