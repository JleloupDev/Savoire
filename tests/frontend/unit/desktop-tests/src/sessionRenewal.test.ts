// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Renouvellement du jeton d'acces (apps/web/src/session.ts) : avant
// l'expiration, un seul a la fois, echec propre, compte garde hors ligne,
// jeton memorise en version bureau (server-sessions.json).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSessionRenewal, jwtExpiresAt, refreshOnce, RENEW_BEFORE_MS, RETRY_AFTER_MS,
  type RefreshedTokens,
} from '../../../../../apps/web/src/session'
import { persistedAccounts, setAccountStorage, type AccountStorage } from '../../../../../apps/web/src/accountStorage'
import type { AccountEntry } from '../../../../../apps/web/src/types'

/** JWT non signe, juste lisible : seul `exp` compte ici. */
function jwt(expSeconds: number, tag = 'a'): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ exp: expSeconds, tag })}.sig`
}

function account(userId: string, refreshToken: string, isActive: boolean): AccountEntry {
  return { userId, email: `${userId}@x`, displayName: userId, refreshToken, isActive }
}

function memoryStorage(initial: AccountEntry[]): AccountStorage & { accounts: AccountEntry[] } {
  const s = {
    accounts: initial,
    load: () => s.accounts,
    save: (a: AccountEntry[]) => { s.accounts = a },
  }
  return s
}

/** Erreur reseau, comme fetch : TypeError. */
const networkError = () => new TypeError('Failed to fetch')

let now = 1_000_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
  setAccountStorage(null)
})

function setup(storage: AccountStorage, refresh: (rt: string) => Promise<RefreshedTokens>) {
  const onRenewed = vi.fn()
  const onExpired = vi.fn()
  const renewal = createSessionRenewal({ refresh, onRenewed, onExpired })
  setAccountStorage(storage)
  return { renewal, onRenewed, onExpired }
}

describe('jwtExpiresAt', () => {
  it('lit exp (secondes) et rend des millisecondes', () => {
    expect(jwtExpiresAt(jwt(1234))).toBe(1_234_000)
  })
  it('null pour un jeton illisible', () => {
    expect(jwtExpiresAt('pas-un-jwt')).toBeNull()
    expect(jwtExpiresAt('a.b.c')).toBeNull()
  })
})

describe('renouvellement proactif', () => {
  it('renouvelle une minute avant l\'expiration, et garde le jeton de renouvellement neuf', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    const refresh = vi.fn(async () => ({ accessToken: jwt(now / 1000 + 1800, 'b'), refreshToken: 'r2' }))
    const { renewal, onRenewed } = setup(storage, refresh)

    renewal.setToken(jwt(now / 1000 + 900))
    await vi.advanceTimersByTimeAsync(900_000 - RENEW_BEFORE_MS - 1)
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledWith('r1')
    expect(storage.accounts[0].refreshToken).toBe('r2')
    expect(onRenewed).toHaveBeenCalledWith(jwt(now / 1000 + 1800, 'b'), storage.accounts)
  })

  it('au reveil (minuteur endormi), check() renouvelle si l\'echeance est passee', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    const refresh = vi.fn(async () => ({ accessToken: jwt(now / 1000 + 5000), refreshToken: 'r2' }))
    const { renewal } = setup(storage, refresh)

    renewal.setToken(jwt(now / 1000 + 900))
    renewal.check()
    expect(refresh).not.toHaveBeenCalled()

    // L'horloge avance sans que le minuteur ne se declenche (veille).
    vi.setSystemTime(now + 20 * 60_000)
    renewal.check()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('navigateur, plusieurs comptes : seul le compte actif est renouvele', async () => {
    const storage = memoryStorage([account('u1', 'r1', false), account('u2', 'r2', true)])
    const refresh = vi.fn(async () => ({ accessToken: jwt(now / 1000 + 900), refreshToken: 'r2b' }))
    const { renewal } = setup(storage, refresh)

    await renewal.renew()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('r2')
    expect(storage.accounts.map(a => a.refreshToken)).toEqual(['r1', 'r2b'])
  })
})

describe('un seul renouvellement a la fois', () => {
  it('appels concurrents : une seule requete, tous recoivent le meme jeton', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    let release!: (v: RefreshedTokens) => void
    const refresh = vi.fn(() => new Promise<RefreshedTokens>(r => { release = r }))
    const { renewal } = setup(storage, refresh)
    const old = jwt(now / 1000 + 900)
    renewal.setToken(old)

    const results = Promise.all([renewal.renew(), renewal.renewRejected(old), renewal.renewRejected(old), renewal.renew()])
    release({ accessToken: 'neuf', refreshToken: 'r2' })

    expect(await results).toEqual(['neuf', 'neuf', 'neuf', 'neuf'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('un 401 avec un jeton deja remplace rend le jeton courant, sans renouveler', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    const refresh = vi.fn(async () => ({ accessToken: 'neuf', refreshToken: 'r2' }))
    const { renewal } = setup(storage, refresh)
    const old = jwt(now / 1000 + 900)
    renewal.setToken(old)
    await renewal.renew()

    expect(await renewal.renewRejected(old)).toBe('neuf')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('un jeton qui n\'est pas celui de la session (lien de partage) : rien', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    const refresh = vi.fn(async () => ({ accessToken: 'neuf', refreshToken: 'r2' }))
    const { renewal } = setup(storage, refresh)
    renewal.setToken(jwt(now / 1000 + 900))

    expect(await renewal.renewRejected('jeton-de-partage')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshOnce partage la requete entre la restauration et le renouvellement', async () => {
    let release!: (v: RefreshedTokens) => void
    const refresh = vi.fn(() => new Promise<RefreshedTokens>(r => { release = r }))
    const a = refreshOnce(refresh, 'r1')
    const b = refreshOnce(refresh, 'r1')
    release({ accessToken: 't', refreshToken: 'r2' })
    expect(await a).toBe(await b)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('echec du renouvellement', () => {
  it('jeton de renouvellement refuse : compte retire, un seul avis, plus d\'essai', async () => {
    const storage = memoryStorage([account('u1', 'r1', false), account('u2', 'r2', true)])
    const refresh = vi.fn(async () => { throw new Error('401') })
    const { renewal, onExpired, onRenewed } = setup(storage, refresh)
    const old = jwt(now / 1000 + 900)
    renewal.setToken(old)

    // Plusieurs requetes refusees en meme temps.
    const results = await Promise.all([renewal.renewRejected(old), renewal.renewRejected(old), renewal.renew()])

    expect(results).toEqual([null, null, null])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(onExpired).toHaveBeenCalledWith([account('u1', 'r1', false)])
    expect(onRenewed).not.toHaveBeenCalled()
    expect(storage.accounts).toEqual([account('u1', 'r1', false)])

    // Plus rien ensuite : ni minuteur, ni nouvel avis.
    expect(await renewal.renewRejected(old)).toBeNull()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('erreur reseau : le compte reste garde, nouvel essai plus tard', async () => {
    const storage = memoryStorage([account('u1', 'r1', true)])
    const refresh = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ accessToken: jwt(now / 1000 + 5000), refreshToken: 'r2' })
    const { renewal, onExpired, onRenewed } = setup(storage, refresh)

    expect(await renewal.renew()).toBeNull()
    expect(onExpired).not.toHaveBeenCalled()
    expect(storage.accounts).toEqual([account('u1', 'r1', true)])

    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onRenewed).toHaveBeenCalledTimes(1)
    expect(storage.accounts[0].refreshToken).toBe('r2')
  })
})

describe('version bureau', () => {
  it('le jeton renouvele est memorise dans la session du serveur (server-sessions.json)', async () => {
    const persist = vi.fn()
    const storage = persistedAccounts([account('u1', 'r1', true)], persist)
    const refresh = vi.fn(async () => ({ accessToken: jwt(now / 1000 + 900), refreshToken: 'r2' }))
    const { renewal } = setup(storage, refresh)

    await renewal.renew()

    expect(persist).toHaveBeenLastCalledWith([account('u1', 'r2', true)])
    expect(storage.load()).toEqual([account('u1', 'r2', true)])
  })
})
