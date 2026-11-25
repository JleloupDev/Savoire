// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecrire dans une note par retouches (patch_note, ADR-033). Une operation vise :
//  - un bloc, par sa reference : inserer avant ou apres, remplacer, supprimer ;
//  - un passage DANS un bloc : la reference du bloc et un court texte `find` ;
//  - une ancre de l'editeur (`at`, voir anchor.ts).
//
// Ici, le calcul seulement (pur) : de chaque operation, la plage a remplacer
// et son texte. L'hote applique le tout a son CRDT, en une ecriture.
import { parseAnchor, type NoteAnchor, type TextRange } from './anchor'
import { HostError } from './host'
import { showRef, type RefBlock } from './noteRefs'
import { countOccurrences, type TextChange } from './text'

export const PATCH_OPS = ['insert_before', 'insert_after', 'replace', 'delete'] as const
export type PatchOpKind = typeof PATCH_OPS[number]

export interface PatchOp {
  op: PatchOpKind
  /** Reference du bloc vise. */
  ref?: string
  /** Passage vise dans ce bloc, recopie a l'identique. */
  find?: string
  /** Ou : ancre de l'editeur. */
  at?: NoteAnchor
  text: string
}

export const MAX_PATCH_OPS = 20

/** Lit les operations recues d'une IA. Leve si l'une est mal formee. */
export function parsePatchOps(raw: unknown): PatchOp[] {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { throw new HostError('ops : liste d’opérations attendue.') }
  }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list]
  if (!Array.isArray(list) || !list.length) throw new HostError('ops : au moins une opération.')
  if (list.length > MAX_PATCH_OPS) throw new HostError(`ops : ${MAX_PATCH_OPS} opérations au plus par appel.`)
  return list.map((v, i) => {
    const n = `Opération ${i + 1}`
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HostError(`${n} : objet attendu.`)
    const o = v as Record<string, unknown>
    const op = typeof o.op === 'string' ? o.op.trim().toLowerCase() : ''
    if (!(PATCH_OPS as readonly string[]).includes(op)) throw new HostError(`${n} : op doit être ${PATCH_OPS.join(', ')}.`)
    const ref = typeof o.ref === 'string' && o.ref.trim() ? o.ref.trim() : undefined
    const at = o.at === undefined || o.at === null || o.at === '' ? undefined : parseAnchor(o.at)
    if (!ref === !at) throw new HostError(`${n} : donner ref (un bloc) ou at (une ancre), l’un des deux.`)
    const find = typeof o.find === 'string' && o.find ? o.find : undefined
    if (find && !ref) throw new HostError(`${n} : find va avec ref.`)
    if (find && find.length > 20_000) throw new HostError(`${n} : find trop long.`)
    const text = typeof o.text === 'string' ? o.text : ''
    if (text.length > 200_000) throw new HostError(`${n} : text trop long.`)
    if ((op === 'insert_before' || op === 'insert_after') && !text.trim()) throw new HostError(`${n} : text est vide.`)
    return { op: op as PatchOpKind, ...(ref ? { ref } : {}), ...(find ? { find } : {}), ...(at ? { at } : {}), text }
  })
}

/** Nombre de retours a la ligne entre deux positions : 2 ou plus, une ligne vide les separe. */
function newlines(content: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (content[i] === '\n') n++
  return n
}

/**
 * Le changement d'une operation qui vise un bloc (ou un passage dans ce bloc).
 * Un bloc insere est separe de ses voisins par une ligne vide ; un bloc
 * supprime part avec la ligne vide qui le suit ; un bloc remplace garde son « ^id ».
 */
export function blockChange(content: string, blocks: readonly RefBlock[], block: RefBlock, op: PatchOp): TextChange {
  if (op.find) {
    const own = content.slice(block.from, block.to)
    const n = countOccurrences(own, op.find)
    if (n === 0) throw new HostError(`Passage introuvable dans le bloc ${showRef(block.ref)} : recopiez-le à l’identique. Le bloc aujourd’hui :\n${block.text}`)
    if (n > 1) throw new HostError(`Ce passage revient ${n} fois dans le bloc ${showRef(block.ref)} : allongez find.`)
    const at = block.from + own.indexOf(op.find)
    return rangeChange({ from: at, to: at + op.find.length }, op)
  }
  const prev = blocks[block.index - 1]
  const next = blocks[block.index + 1]
  const body = op.text.replace(/^(?:[ \t]*\r?\n)+|\s+$/g, '')
  switch (op.op) {
    case 'insert_before': {
      if (block.kind === 'frontmatter') throw new HostError('Rien ne s’insère avant le frontmatter.')
      const tight = prev && newlines(content, prev.end, block.from) < 2
      return { from: block.from, to: block.from, text: `${tight ? '\n' : ''}${body}\n\n` }
    }
    case 'insert_after': {
      const tight = next && newlines(content, block.end, next.from) < 2
      return { from: block.end, to: block.end, text: `\n\n${body}${tight ? '\n' : ''}` }
    }
    case 'replace': {
      if (!body) return blockChange(content, blocks, block, { ...op, op: 'delete' })
      let text = body
      // Le « ^id » ecrit dans le bloc suit le nouveau texte : les liens vers ce bloc tiennent.
      if (block.blockId && block.end === block.to && !new RegExp(`\\^${block.blockId}[ \\t]*$`).test(text) && new RegExp(`\\^${block.blockId}[ \\t]*$`).test(block.text)) {
        text += /(^|\n)[ \t]*\^[A-Za-z0-9-]+[ \t]*$/.test(block.text) ? `\n^${block.blockId}` : ` ^${block.blockId}`
      }
      return { from: block.from, to: block.to, text }
    }
    case 'delete':
      if (next) return { from: block.from, to: next.from, text: '' }
      if (prev) return { from: prev.end, to: block.end, text: '' }
      return { from: block.from, to: block.end, text: '' }
  }
}

/** Le changement d'une operation qui vise une plage (ancre, ou passage trouve). */
export function rangeChange(range: TextRange, op: Pick<PatchOp, 'op' | 'text'>): TextChange {
  switch (op.op) {
    case 'insert_before': return { from: range.from, to: range.from, text: op.text }
    case 'insert_after': return { from: range.to, to: range.to, text: op.text }
    case 'replace': return { from: range.from, to: range.to, text: op.text }
    case 'delete': return { from: range.from, to: range.to, text: '' }
  }
}

/**
 * Range les changements dans l'ordre du texte (a la meme place, un ajout
 * passe avant un remplacement) et retire ceux qui ne changent rien. Leve si
 * deux changements se chevauchent.
 */
export function orderChanges(content: string, changes: readonly TextChange[]): TextChange[] {
  const real = changes.filter(c => content.slice(c.from, c.to) !== c.text)
  const sorted = real.map((c, i) => ({ c, i })).sort((a, b) =>
    a.c.from - b.c.from || Number(a.c.to > a.c.from) - Number(b.c.to > b.c.from) || a.i - b.i).map(x => x.c)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.from < sorted[i - 1]!.to) throw new HostError('Deux opérations touchent le même passage : faites-les en deux appels.')
  }
  return sorted
}

/** Le texte apres ces changements (plages disjointes, dans l'ordre). */
export function applyTextChanges(content: string, changes: readonly TextChange[]): string {
  let out = ''
  let at = 0
  for (const c of changes) {
    out += content.slice(at, c.from) + c.text
    at = c.to
  }
  return out + content.slice(at)
}
