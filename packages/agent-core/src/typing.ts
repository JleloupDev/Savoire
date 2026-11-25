// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Effet de frappe (ADR-033) : un long texte ecrit par un agent arrive par
// morceaux de quelques mots, en ecritures successives, pour que les editeurs
// ouverts le voient s'ecrire. Ici : le decoupage (pur), et de quoi le derouler
// dans un texte partage vivant. L'hote l'applique a son CRDT.
import type { TextDelta } from '@savoire/plugin-api'
import type { TextChange } from './text'

/** En dessous, un texte s'ecrit d'un coup. */
export const TYPING_MIN_CHARS = 80
const WORDS_PER_CHUNK = 3

export interface TypingOptions {
  /** Duree totale visee, au plus (ms). */
  budgetMs: number
  /** Nombre d'ecritures au plus (la premiere comprise). */
  maxWrites: number
  /** Pause la plus longue entre deux morceaux (ms). */
  maxDelayMs?: number
}

export interface TypingPlan {
  /** La premiere ecriture : tous les changements, les longs textes reduits a leur premier morceau. */
  first: TextChange[]
  /** La suite de chaque long texte : `at` est sa place dans le texte APRES `first`. */
  tails: { at: number; chunks: string[] }[]
  /** Pause entre deux morceaux. */
  delayMs: number
}

/** Coupe un texte en morceaux de quelques mots (au plus `max` morceaux) ; recolles, ils redonnent le texte. */
export function typingChunks(text: string, max: number): string[] {
  const words = text.match(/\s*\S+\s*/g)
  if (!words || words.length < 2 || max < 2) return [text]
  const per = Math.max(WORDS_PER_CHUNK, Math.ceil(words.length / max))
  const out: string[] = []
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(''))
  return out
}

/**
 * Le plan d'ecriture de `changes` (plages disjointes, positions dans le texte
 * d'avant, dans l'ordre) : une premiere ecriture qui fait tout sauf la suite
 * des longs textes, puis cette suite, morceau par morceau.
 */
export function planTyping(changes: readonly TextChange[], o: TypingOptions): TypingPlan {
  const long = changes.filter(c => c.text.length > TYPING_MIN_CHARS)
  const total = long.reduce((n, c) => n + c.text.length, 0)
  const spare = Math.max(0, o.maxWrites - 1)
  if (!long.length || !spare) return { first: [...changes], tails: [], delayMs: 0 }
  const first: TextChange[] = []
  const tails: TypingPlan['tails'] = []
  let shift = 0 // ce que `first` a deja ajoute ou retire avant la position courante
  for (const c of changes) {
    if (c.text.length <= TYPING_MIN_CHARS) {
      first.push(c)
      shift += c.text.length - (c.to - c.from)
      continue
    }
    const chunks = typingChunks(c.text, Math.max(2, Math.round(spare * c.text.length / total) + 1))
    first.push({ from: c.from, to: c.to, text: chunks[0]! })
    if (chunks.length > 1) tails.push({ at: c.from + shift + chunks[0]!.length, chunks: chunks.slice(1) })
    shift += chunks[0]!.length - (c.to - c.from)
  }
  const steps = tails.reduce((n, t) => n + t.chunks.length, 0)
  return { first, tails, delayMs: steps ? Math.max(0, Math.min(o.maxDelayMs ?? 150, Math.floor(o.budgetMs / steps))) : 0 }
}

/** Un texte partage ou derouler un plan : celui de l'appli (ISharedText et ses positions relatives). */
export interface TypingTarget<R> {
  /** Applique un delta (retain, delete, insert) en une seule modification. */
  applyDelta(delta: TextDelta): void
  /** Une position qui suit les modifications, collee au caractere qui la precede. */
  createRelPos(index: number, assoc: -1): R
  resolveRelPos(rp: R): number | null
}

/** Des changements (plages disjointes, dans l'ordre) en un seul delta. */
export function changesDelta(changes: readonly TextChange[]): TextDelta {
  const delta: TextDelta = []
  let at = 0
  for (const c of changes) {
    if (c.from > at) delta.push({ retain: c.from - at })
    if (c.to > c.from) delta.push({ delete: c.to - c.from })
    if (c.text) delta.push({ insert: c.text })
    at = c.to
  }
  return delta
}

/**
 * Deroule un plan dans un texte partage vivant : la premiere ecriture, puis
 * chaque morceau apres le precedent. Sa place est une position relative : si
 * quelqu'un ecrit ailleurs entre deux morceaux, la suite arrive au bon endroit.
 */
export async function typeInto<R>(target: TypingTarget<R>, plan: TypingPlan, sleep: (ms: number) => Promise<void>): Promise<void> {
  target.applyDelta(changesDelta(plan.first))
  const marks = plan.tails.map(t => target.createRelPos(t.at, -1))
  for (const [i, tail] of plan.tails.entries()) {
    for (const chunk of tail.chunks) {
      await sleep(plan.delayMs)
      const at = target.resolveRelPos(marks[i]!)
      if (at === null) break // le debut du texte a disparu : on n'ecrit pas la suite au hasard
      target.applyDelta([...(at > 0 ? [{ retain: at }] : []), { insert: chunk }])
      marks[i] = target.createRelPos(at + chunk.length, -1)
    }
  }
}
