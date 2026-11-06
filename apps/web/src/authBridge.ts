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
