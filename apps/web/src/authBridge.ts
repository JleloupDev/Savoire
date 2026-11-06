// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Session partagee entre la fenetre principale et les fenetres de note
// (noteWindow.ts).
//
// Le fournisseur d'identite fait tourner le jeton de renouvellement : chaque
// renouvellement invalide le precedent. Deux fenetres qui renouvellent avec
// la meme copie du jeton se deconnectent l'une l'autre. Une fenetre de note
// ne renouvelle donc jamais elle-meme : elle demande le jeton d'acces a la
// fenetre qui l'a ouverte (meme origine, appel direct), et suit ses
// changements. Fermer la fenetre principale coupe la session des fenetres de
// note a l'expiration de leur jeton.
import type { AccountEntry } from './types'

export interface AuthBridge {
  token(): string | null
  accounts(): AccountEntry[]
  /** Jeton neuf a la place d'un jeton refuse (401), ou null. */
  renew(rejected: string): Promise<string | null>
  /** Prevenu a chaque nouveau jeton d'acces. */
  subscribe(cb: (token: string | null) => void): () => void
}

const KEY = '__savoireAuthBridge'
/** Pose par pinNote sur la fenetre d'incrustation : la fenetre qui l'a ouverte. */
export const HOST_KEY = '__savoireHost'

type Bag = Record<string, unknown>

function bridgeOf(w: unknown): AuthBridge | null {
  try {
    const b = w ? (w as Bag)[KEY] as AuthBridge | undefined : undefined
    return b && typeof b.token === 'function' ? b : null
  } catch {
    // Autre origine : pas d'acces.
    return null
  }
}

/** La session de la fenetre hote (opener, ou hote de la fenetre d'incrustation). */
export function findHostBridge(win: Window = window): AuthBridge | null {
  const candidates: unknown[] = []
  try { candidates.push(win.opener) } catch { /* rien */ }
  try {
    if (win.parent && win.parent !== win) {
      candidates.push((win.parent as unknown as Bag)[HOST_KEY], win.parent.opener)
    }
  } catch { /* rien */ }
  for (const c of candidates) {
    const b = bridgeOf(c)
    if (b) return b
  }
  return null
}

/** Rend la session de cette fenetre disponible aux fenetres qu'elle ouvre. */
export function exposeBridge(bridge: AuthBridge, win: Window = window): () => void {
  (win as unknown as Bag)[KEY] = bridge
  return () => {
    if ((win as unknown as Bag)[KEY] === bridge) delete (win as unknown as Bag)[KEY]
  }
}

// ── Version bureau : fenetres Tauri ─────────────────────────────────────────
//
// Deux fenetres Tauri ne partagent pas leur memoire : la session passe par
// des evenements. La fenetre principale repond aux fenetres de note.

export interface AuthEvents {
  emit(event: string, payload?: unknown): Promise<void>
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>
}

const ASK = 'savoire-auth-ask'
const RENEW = 'savoire-auth-renew'
const STATE = 'savoire-auth'

interface AuthState { token: string | null; accounts: AccountEntry[] }

/** Fenetre principale : sert sa session aux fenetres de note. Rend l'arret. */
export async function serveAuthOverEvents(bridge: AuthBridge, events: AuthEvents): Promise<() => void> {
  // Sans les jetons de renouvellement : une fenetre de note ne renouvelle jamais.
  const send = () => events.emit(STATE, {
    token: bridge.token(),
    accounts: bridge.accounts().map(a => ({ ...a, refreshToken: '' })),
  } satisfies AuthState)
  const offs = await Promise.all([
    events.listen(ASK, () => { void send() }),
    events.listen<{ rejected?: string }>(RENEW, p => {
      void bridge.renew(String(p?.rejected ?? '')).finally(() => { void send() })
    }),
  ])
  const unsub = bridge.subscribe(() => { void send() })
  return () => { unsub(); for (const off of offs) off() }
}

/**
 * Fenetre de note : la session de la fenetre principale, par evenements.
 * `ready` : la premiere reponse (ou rien apres `waitMs` : pas de session).
 */
export async function connectAuthOverEvents(events: AuthEvents, waitMs = 1500): Promise<AuthBridge & { ready: Promise<void>; close(): void }> {
  let state: AuthState = { token: null, accounts: [] }
  const listeners = new Set<(t: string | null) => void>()
  let first: () => void = () => {}
  const ready = new Promise<void>(resolve => {
    first = resolve
    setTimeout(resolve, waitMs)
  })
  const off = await events.listen<AuthState>(STATE, p => {
    state = { token: p?.token ?? null, accounts: Array.isArray(p?.accounts) ? p.accounts : [] }
    first()
    for (const cb of [...listeners]) cb(state.token)
  })
  void events.emit(ASK)
  return {
    ready,
    close: off,
    token: () => state.token,
    accounts: () => state.accounts,
    subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    renew: rejected => new Promise(resolve => {
      const done = (t: string | null) => { listeners.delete(done); clearTimeout(timer); resolve(t && t !== rejected ? t : null) }
      const timer = setTimeout(() => { listeners.delete(done); resolve(null) }, 10_000)
      listeners.add(done)
      void events.emit(RENEW, { rejected })
    }),
  }
}
