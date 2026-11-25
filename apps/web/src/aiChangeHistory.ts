// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'historique des modifications de l'IA d'une note (panneau Revision,
// AiChangesSection) : l'ouvrir sur un point, depuis n'importe ou.
//
// Deux portes, la meme chose derriere :
//  - showAiChange(docId, changeId), pour le code de l'appli ;
//  - l'evenement de fenetre « savoire:show-ai-change », pour le code qui
//    n'importe pas l'appli (la carte d'un surlignage dans l'editeur) :
//      window.dispatchEvent(new CustomEvent('savoire:show-ai-change', { detail: { docId, changeId } }))
//
// `changeId` : l'id d'un point montre (AiChangeInfo.id) ou d'un point range
// (un de ses `parts`, ou un id recu de onAiChangesChange). Absent, ou plus
// connu (compacte depuis) : la section s'ouvre, sans point mis en avant.
// `docId` absent : la note active.
//
// Ici, pas de React : l'evenement, le point en attente, et le texte des
// lignes (teste sans navigateur).
import type { AiChangeInfo } from '@savoire/plugin-api'

export const SHOW_AI_CHANGE_EVENT = 'savoire:show-ai-change'

export interface ShowAiChangeDetail {
  /** La note du point. Absent : la note active. */
  docId?: string
  /** Le point a mettre en avant. Absent : la section seulement. */
  changeId?: string
}

/** Un point a montrer, et quand on l'a demande. */
export interface AiChangeFocus extends ShowAiChangeDetail {
  at: number
}

/** Une demande reste valable ce temps-la (le panneau s'ouvre, la note arrive). */
const FOCUS_TTL_MS = 10_000

let pending: AiChangeFocus | null = null
const listeners = new Set<(focus: AiChangeFocus) => void>()

/** Ouvre la Revision sur l'historique des modifications de l'IA de cette note, a ce point. */
export function showAiChange(docId?: string, changeId?: string): void {
  window.dispatchEvent(new CustomEvent<ShowAiChangeDetail>(SHOW_AI_CHANGE_EVENT, {
    detail: { ...(docId ? { docId } : {}), ...(changeId ? { changeId } : {}) },
  }))
}

const INSTALLED = '__savoireShowAiChange'

/**
 * Ecoute les demandes (au demarrage de l'appli). `openPanel` ouvre le panneau
 * Revision s'il ne l'est pas. Rend de quoi arreter. Une seule ecoute par
 * cible : rappeler remplace la precedente (rechargement a chaud).
 */
export function installAiChangeHistory(openPanel: () => void, target: EventTarget = window): () => void {
  const slot = target as unknown as Record<string, EventListener | undefined>
  if (slot[INSTALLED]) target.removeEventListener(SHOW_AI_CHANGE_EVENT, slot[INSTALLED])
  const listener: EventListener = event => {
    const d = (event as CustomEvent<ShowAiChangeDetail | undefined>).detail
    const focus: AiChangeFocus = {
      ...(typeof d?.docId === 'string' && d.docId ? { docId: d.docId } : {}),
      ...(typeof d?.changeId === 'string' && d.changeId ? { changeId: d.changeId } : {}),
      at: Date.now(),
    }
    // Garde ici si la section n'est pas encore montee (panneau ferme) : elle le prendra.
    pending = focus
    try { openPanel() } catch { /* le panneau ne s'ouvre pas : la demande attend */ }
    for (const cb of [...listeners]) cb(focus)
  }
  slot[INSTALLED] = listener
  target.addEventListener(SHOW_AI_CHANGE_EVENT, listener)
  return () => {
    target.removeEventListener(SHOW_AI_CHANGE_EVENT, listener)
    if (slot[INSTALLED] === listener) delete slot[INSTALLED]
  }
}

/** La section montee ecoute les demandes qui arrivent. */
export function onAiChangeFocus(cb: (focus: AiChangeFocus) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * La demande en attente pour cette note, s'il y en a une (elle est alors
 * prise : rendue une seule fois). Une demande pour une autre note attend que
 * cette note soit affichee ; une demande trop vieille est oubliee.
 */
export function takeAiChangeFocus(docId: string, now = Date.now()): AiChangeFocus | null {
  const focus = pending
  if (!focus) return null
  if (now - focus.at > FOCUS_TTL_MS) { pending = null; return null }
  if (focus.docId && focus.docId !== docId) return null
  pending = null
  return focus
}

/** Le point montre qui correspond a cet id : le sien, ou celui d'un des points ranges qu'il regroupe. */
export function findAiChange(list: readonly AiChangeInfo[], changeId: string | undefined): AiChangeInfo | undefined {
  if (!changeId) return undefined
  return list.find(c => c.id === changeId) ?? list.find(c => c.parts.includes(changeId))
}

// ── Le texte d'une ligne ─────────────────────────────────────────────────────

/** « passage remplacé », ou « 3 modifications : passage remplacé ×2, 1 retouche ». */
export function describeAiChange(c: Pick<AiChangeInfo, 'count' | 'summaries'>): string {
  if (c.count <= 1) return c.summaries[0] ?? '1 modification'
  const counts = new Map<string, number>()
  for (const s of c.summaries) counts.set(s, (counts.get(s) ?? 0) + 1)
  const detail = [...counts].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(', ')
  return `${c.count} modifications${detail ? ` : ${detail}` : ''}`
}

/** « +120 / −8 caractères ». */
export function describeAiChangeSize(c: Pick<AiChangeInfo, 'inserted' | 'deleted'>): string {
  return `+${c.inserted} / −${c.deleted} caractère${Math.max(c.inserted, c.deleted) > 1 ? 's' : ''}`
}

/** « 25/11/2026 10:02 », ou « 25/11/2026 10:02 → 10:05 » pour un point compacte. */
export function describeAiChangeTime(c: Pick<AiChangeInfo, 'at' | 'last'>, locale?: string): string {
  const first = new Date(c.at)
  const start = first.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
  if (!c.last || c.last === c.at) return start
  const last = new Date(c.last)
  const sameDay = first.toDateString() === last.toDateString()
  const end = sameDay ? last.toLocaleTimeString(locale, { timeStyle: 'short' }) : last.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
  return end === first.toLocaleTimeString(locale, { timeStyle: 'short' }) && sameDay ? start : `${start} → ${end}`
}
