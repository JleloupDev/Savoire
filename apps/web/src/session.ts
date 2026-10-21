// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Renouvellement du jeton d'acces du compte actif.
//
// Le jeton d'acces vit 15 minutes, le jeton de renouvellement 7 jours. Le
// serveur fait tourner ce dernier : chaque renouvellement en rend un neuf et
// invalide l'ancien. Le reutiliser revoque toutes les sessions du compte.
// D'ou trois regles :
// - un seul renouvellement a la fois par jeton (single-flight) ;
// - le jeton neuf est garde aussitot (sessionStorage, ou server-sessions.json
//   en version bureau, via getAccountStorage) ;
// - on renouvelle avant l'expiration, et on verifie au reveil (le minuteur a
//   pu dormir pendant la veille).
//
// Sans React, pour etre teste. AuthContext.tsx le branche.

import type { AccountEntry } from './types'
import { getAccountStorage } from './accountStorage'
import { isNetworkError } from './serverErrors'

/** Marge avant l'expiration du jeton d'acces. */
export const RENEW_BEFORE_MS = 60_000
/** Serveur injoignable : nouvel essai apres ce delai. */
export const RETRY_AFTER_MS = 30_000

export const SESSION_EXPIRED_MESSAGE = 'Votre session a expiré, reconnectez-vous'

/**
 * Expiration d'un JWT (champ `exp`), en millisecondes ; null si illisible.
 * Le jeton n'est pas verifie : seul le serveur le fait.
 */
export function jwtExpiresAt(token: string): number | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown }
    return typeof json.exp === 'number' ? json.exp * 1000 : null
  } catch {
    return null
  }
}

export interface RefreshedTokens {
  accessToken: string
  refreshToken: string
}

// Renouvellements en cours, par jeton de renouvellement.
const inFlight = new Map<string, Promise<RefreshedTokens>>()

/**
 * Renouvelle avec `refreshToken`. Deux appels avec le meme jeton pendant le
 * meme renouvellement attendent la meme reponse : le second ne part pas.
 */
export function refreshOnce(
  refresh: (refreshToken: string) => Promise<RefreshedTokens>,
  refreshToken: string,
): Promise<RefreshedTokens> {
  const pending = inFlight.get(refreshToken)
  if (pending) return pending
  const p = refresh(refreshToken).finally(() => { inFlight.delete(refreshToken) })
  inFlight.set(refreshToken, p)
  return p
}

export interface SessionRenewalDeps {
  refresh(refreshToken: string): Promise<RefreshedTokens>
  /** Nouveau jeton d'acces du compte actif ; `accounts` : les comptes gardes. */
  onRenewed(accessToken: string, accounts: AccountEntry[]): void
  /** Session perdue (jeton de renouvellement refuse) : le compte est deja retire. */
  onExpired(accounts: AccountEntry[]): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SessionRenewal {
  /** Le jeton d'acces courant (null : personne) ; programme le renouvellement. */
  setToken(token: string | null): void
  /** Renouvelle maintenant (un seul a la fois). Rend le jeton neuf, ou null. */
  renew(): Promise<string | null>
  /** Jeton neuf a la place d'un jeton refuse (401), ou null si ce n'est pas le notre. */
  renewRejected(rejected: string): Promise<string | null>
  /** Au reveil, au retour du focus : renouvelle si l'echeance est passee. */
  check(): void
  stop(): void
}

export function createSessionRenewal(deps: SessionRenewalDeps): SessionRenewal {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let token: string | null = null
  // Jetons rendus par cette session : un 401 avec un autre jeton (lien de
  // partage, compte local de la version bureau) n'est pas le notre.
  const issued = new Set<string>()
  let timer: unknown = null
  let dueAt: number | null = null
  let current: Promise<string | null> | null = null

  function remember(t: string) {
    issued.add(t)
    if (issued.size > 8) issued.delete(issued.values().next().value as string)
  }

  function schedule(at: number | null) {
    if (timer !== null) { clearTimer(timer); timer = null }
    dueAt = at
    if (at === null) return
    timer = setTimer(() => { timer = null; void renew() }, Math.max(0, at - now()))
  }

  function setToken(next: string | null) {
    if (next === token) return
    token = next
    if (!next) { schedule(null); return }
    remember(next)
    const exp = jwtExpiresAt(next)
    schedule(exp === null ? null : exp - RENEW_BEFORE_MS)
  }

  async function run(): Promise<string | null> {
    const storage = getAccountStorage()
    const active = storage.load().find(a => a.isActive)
    if (!active) { setToken(null); return null }
    let res: RefreshedTokens
    try {
      res = await refreshOnce(deps.refresh, active.refreshToken)
    } catch (err) {
      if (isNetworkError(err)) {
        // Serveur injoignable : le compte reste garde, on reessaie plus tard.
        schedule(now() + RETRY_AFTER_MS)
        return null
      }
      // Jeton de renouvellement refuse (expire, revoque) : la session est finie.
      const remaining = storage.load().filter(a => a.userId !== active.userId)
      storage.save(remaining)
      token = null
      schedule(null)
      deps.onExpired(remaining)
      return null
    }
    // Le jeton neuf est garde meme si l'on a change de compte entre-temps :
    // l'ancien ne vaut plus rien.
    const accounts = storage.load().map(a =>
      a.userId === active.userId ? { ...a, refreshToken: res.refreshToken } : a)
    storage.save(accounts)
    if (!accounts.find(a => a.userId === active.userId)?.isActive) return null
    setToken(res.accessToken)
    deps.onRenewed(res.accessToken, accounts)
    return res.accessToken
  }

  function renew(): Promise<string | null> {
    current ??= run().finally(() => { current = null })
    return current
  }

  async function renewRejected(rejected: string): Promise<string | null> {
    if (!issued.has(rejected)) return null
    // Deja renouvele par un autre appel : le jeton courant suffit.
    if (token && token !== rejected) return token
    return renew()
  }

  function check() {
    if (current || dueAt === null) return
    if (now() >= dueAt) void renew()
  }

  function stop() {
    schedule(null)
    token = null
  }

  return { setToken, renew, renewRejected, check, stop }
}
