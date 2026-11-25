// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent n'ecrit jamais dans le paragraphe ou la personne tape.
//
// L'editeur dit ou elle a tape (aiContext : `typingAt` dans le contexte de
// l'editeur, envoye de temps en temps pendant la frappe). Avant une ecriture
// directe, l'outil demande a son hote ou elle tape (AgentToolHost.typing) :
//  - dans l'appli, l'hote lit l'editeur ;
//  - sur le pair, le serveur joint sa derniere entree a tools.call.
// Si une retouche touche ce bloc, et qu'elle y a tape il y a moins de 8 s,
// l'outil refuse : attendre, ou deposer une proposition.
//
// Ici, le calcul seulement (pur) : le bloc ou elle tape, et si une retouche
// le touche.
import { locateByQuote } from './editorContext'
import { HostError, type AgentToolHost } from './host'
import { refBlocks } from './noteRefs'
import type { TextChange } from './text'

/** Tant qu'elle a tape il y a moins de ce delai, on n'ecrit pas dans son paragraphe. */
export const TYPING_GUARD_MS = 8000

/** Ou la personne tape, tel que l'hote le sait. */
export interface TypingSpot {
  docId: string
  /** Il y a combien de millisecondes elle a tape la. */
  ageMs: number
  /** Empreinte du bloc ou elle tapait. */
  blockHash?: string
  /** L'endroit du curseur : positions relatives (base64), et le texte autour. */
  anchor?: { start?: string; end?: string; prefix?: string; suffix?: string }
}

/** Le paragraphe ou elle tape, dans le texte d'aujourd'hui ; `cursor` : l'endroit exact, s'il est connu. */
export interface TypingZone {
  from: number
  to: number
  cursor?: number
}

/** Le refus rendu a l'IA. `hint` : comment proposer avec cet outil. */
export function typingRefusal(hint = ''): string {
  return `La personne écrit dans ce paragraphe en ce moment : rien n’a été écrit. Attendez quelques secondes, ou déposez la modification en proposition${hint ? ` (${hint})` : ''}.`
}

/** Lit ce que le serveur joint a tools.call. Null : rien, ou mal forme. */
export function parseTypingSpot(raw: unknown): TypingSpot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.docId !== 'string' || !o.docId || typeof o.ageMs !== 'number' || !Number.isFinite(o.ageMs)) return null
  const a = o.anchor && typeof o.anchor === 'object' ? o.anchor as Record<string, unknown> : null
  const s = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)
  const start = a ? s(a.start, 2000) : undefined
  const end = a ? s(a.end, 2000) : undefined
  const prefix = a ? s(a.prefix, 400) : undefined
  const suffix = a ? s(a.suffix, 400) : undefined
  const blockHash = s(o.blockHash, 64)
  return {
    docId: o.docId, ageMs: Math.max(0, o.ageMs),
    ...(blockHash ? { blockHash } : {}),
    ...(a ? { anchor: { ...(start ? { start } : {}), ...(end ? { end } : {}), ...(prefix !== undefined ? { prefix } : {}), ...(suffix !== undefined ? { suffix } : {}) } } : {}),
  }
}

/**
 * Le paragraphe ou elle tape. Le curseur d'abord (`relative` : ses positions
 * relatives resolues par l'hote ; sinon le texte autour), puis l'empreinte du
 * bloc. Entre deux blocs : le curseur seul. Null : on ne sait plus ou.
 */
export function typingZone(content: string, spot: TypingSpot, relative?: { from: number; to: number } | null): TypingZone | null {
  const blocks = refBlocks(content)
  let cursor: number | null = relative && relative.from >= 0 && relative.from <= content.length ? relative.from : null
  if (cursor === null && spot.anchor && (spot.anchor.prefix || spot.anchor.suffix)) {
    cursor = locateByQuote(content, { quote: '', prefix: spot.anchor.prefix ?? '', suffix: spot.anchor.suffix ?? '' })?.from ?? null
  }
  if (cursor !== null) {
    const at = cursor
    const block = blocks.find(b => at >= b.from && at <= b.end)
    return block ? { from: block.from, to: block.end, cursor: at } : { from: at, to: at, cursor: at }
  }
  const byHash = spot.blockHash ? blocks.find(b => b.hash === spot.blockHash) : undefined
  return byHash ? { from: byHash.from, to: byHash.end } : null
}

/**
 * La retouche touche-t-elle ce paragraphe ? Remplacer ou supprimer : des
 * qu'elle le recouvre. Inserer : dedans, a sa fin (la ou l'on tape le plus
 * souvent), ou a l'endroit meme du curseur. Inserer juste avant ne le touche pas.
 */
export function touchesTyping(change: TextChange, zone: TypingZone): boolean {
  if (change.to > change.from) return change.from < zone.to && change.to > zone.from
  return (change.from > zone.from && change.from <= zone.to) || change.from === zone.cursor
}

/**
 * A appeler avant une ecriture directe dans `content` (le texte lu par
 * l'outil). Leve (HostError 'busy') si une retouche touche le paragraphe ou la
 * personne tape. Un hote qui ne sait pas, ou qui echoue : on ecrit.
 */
export async function guardTyping(
  host: Pick<AgentToolHost, 'typing' | 'resolveRelative'>, docId: string, content: string, changes: readonly TextChange[], hint = '',
): Promise<void> {
  if (!host.typing || !changes.length) return
  let spot: TypingSpot | null = null
  try { spot = await host.typing(docId) } catch { return }
  if (!spot || spot.docId !== docId || !(spot.ageMs < TYPING_GUARD_MS)) return
  const start = spot.anchor?.start
  const relative = start && host.resolveRelative
    ? await host.resolveRelative(docId, start, spot.anchor?.end || start).catch(() => null)
    : null
  const zone = typingZone(content, spot, relative)
  if (zone && changes.some(c => touchesTyping(c, zone))) throw new HostError(typingRefusal(hint), 'busy')
}
