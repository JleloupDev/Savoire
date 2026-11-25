// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire une note par morceaux, et dire ce qui a change (ADR-033).
//
// Une IA ne relit ni ne reecrit jamais une note entiere :
//  - chaque bloc rendu porte une REFERENCE courte : son « ^id » s'il en a
//    un, sinon le debut de son empreinte (8 caracteres ; « ~2 » pour le
//    deuxieme bloc de meme empreinte). Une ecriture la vise (patch_note) ;
//  - une SECTION se lit par son titre, ou par un chemin « MCP > Bases » ;
//  - une VERSION est la liste des empreintes des blocs : deux versions se
//    comparent sans garder le texte.
//
// Fonctions pures : memes resultats dans l'appli et sur le pair.
import { splitNoteBlocks, textFingerprint, type NoteBlock } from '@savoire/plugin-api'

const REF_LEN = 8
const ID_LINE_AFTER = /^(?:[ \t]*\r?\n)+[ \t]*\^([A-Za-z0-9-]+)[ \t]*(?=\r?\n|$)/
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const BLOCK_ID_END = /[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/

export interface RefBlock extends NoteBlock {
  /** Reference courte : « ^id », ou debut d'empreinte (« a1b2c3d4 », « a1b2c3d4~2 »). */
  ref: string
  /** Premiere et derniere ligne du bloc (a partir de 1). */
  line: number
  lastLine: number
  /** Fin du bloc, ligne « ^id » seule comprise (sinon = to). */
  end: number
}

/** La reference d'un bloc parmi ceux d'avant lui (meme regle pour une version gardee). */
function refsOf(blocks: readonly { hash: string; blockId?: string }[]): string[] {
  const ids = new Set<string>()
  const seen = new Map<string, number>()
  return blocks.map(b => {
    const prefix = b.hash.slice(0, REF_LEN)
    const n = (seen.get(prefix) ?? 0) + 1
    seen.set(prefix, n)
    if (b.blockId && !ids.has(b.blockId)) {
      ids.add(b.blockId)
      return `^${b.blockId}`
    }
    return n > 1 ? `${prefix}~${n}` : prefix
  })
}

/** Les blocs d'une note, chacun avec sa reference et ses lignes. */
export function refBlocks(content: string): RefBlock[] {
  const blocks = splitNoteBlocks(content)
  const refs = refsOf(blocks)
  // Debuts de ligne, pour passer d'une position a un numero de ligne.
  const starts = [0]
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) starts.push(i + 1)
  const lineAt = (pos: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  return blocks.map((b, i) => {
    let end = b.to
    if (b.blockId) {
      // « ^id » seul sur sa ligne, sous le bloc : il part et reste avec lui.
      const m = ID_LINE_AFTER.exec(content.slice(b.to, blocks[i + 1]?.from ?? content.length))
      if (m && m[1] === b.blockId) end = b.to + m[0].length
    }
    return { ...b, ref: refs[i]!, line: lineAt(b.from), lastLine: lineAt(b.to), end }
  })
}

/** Ecrit une reference comme l'IA la voit : ‹a1b2c3d4›. */
export const showRef = (ref: string): string => `‹${ref}›`

/** Une reference telle qu'une IA la rend : avec ou sans ‹ ›, crochets, espaces. */
function cleanRef(raw: string): string {
  return raw.trim().replace(/^[‹<[(]+|[›>\])]+$/g, '').trim()
}

/**
 * Le bloc que designe une reference, dans la note d'aujourd'hui. `byHash` :
 * trouve par son empreinte (il n'a donc pas change). Null : aucun.
 */
export function findBlock<B extends { hash: string; blockId?: string }>(blocks: readonly B[], raw: string): { block: B; byHash: boolean } | null {
  const ref = cleanRef(raw)
  if (!ref) return null
  const byId = (id: string): { block: B; byHash: boolean } | null => {
    const block = blocks.find(b => b.blockId === id)
    return block ? { block, byHash: false } : null
  }
  if (ref.startsWith('^')) return byId(ref.slice(1))
  const m = /^([0-9a-f]{6,16})(?:~(\d+))?$/i.exec(ref)
  if (m) {
    const prefix = m[1]!.toLowerCase()
    const nth = m[2] ? Number(m[2]) : 1
    const block = blocks.filter(b => b.hash.startsWith(prefix))[nth - 1]
    if (block) return { block, byHash: true }
  }
  // Un « ^id » donne sans son accent.
  return byId(ref)
}

// ── Sections ───────────────────────────────────────────────────────────────

export interface NoteSection {
  title: string
  level: number
  /** Les titres au-dessus, du plus haut au plus proche, puis le sien. */
  path: string[]
  /** Rang du bloc du titre, et du dernier bloc de la section (sous-sections comprises). */
  first: number
  last: number
}

/** Le texte d'un titre, sans « # », « ^id » ni mise en forme legere. */
export function headingTitle(text: string): string {
  const m = HEADING.exec(text.split('\n')[0] ?? '')
  return (m?.[1] ?? '').replace(BLOCK_ID_END, '').replace(/[*_`~=]/g, '').trim()
}

/** Les sections d'une note, dans l'ordre. */
export function noteSections(blocks: readonly RefBlock[]): NoteSection[] {
  const out: NoteSection[] = []
  const open: NoteSection[] = []
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading') return
    const level = b.level ?? 1
    while (open.length && open[open.length - 1]!.level >= level) open.pop()!.last = i - 1
    const s: NoteSection = { title: headingTitle(b.text), level, path: [...open.map(o => o.title), headingTitle(b.text)], first: i, last: blocks.length - 1 }
    out.push(s)
    open.push(s)
  })
  return out
}

const fold = (s: string): string => s.normalize('NFC').replace(/[*_`~=#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Les sections que designe `query` : un titre, ou un chemin « A > B » (B sous
 * A, a n'importe quelle profondeur). La casse et la mise en forme ne comptent pas.
 */
export function findSections(sections: readonly NoteSection[], query: string): NoteSection[] {
  const whole = fold(query)
  if (!whole) return []
  const exact = sections.filter(s => fold(s.title) === whole)
  if (exact.length) return exact
  const parts = query.split('>').map(fold).filter(Boolean)
  if (parts.length < 2) return []
  const last = parts[parts.length - 1]!
  return sections.filter(s => {
    if (fold(s.title) !== last) return false
    let k = 0
    for (const t of s.path.slice(0, -1)) if (k < parts.length - 1 && fold(t) === parts[k]) k++
    return k === parts.length - 1
  })
}

/** « 10-40 », « 10 », « 10- », « -40 » : lignes a partir de 1, bornes comprises. Null : illisible. */
export function parseLines(raw: string): { from: number; to: number } | null {
  const m = /^\s*(\d+)?\s*(?:(-|–|:|\.\.|,)\s*(\d+)?)?\s*$/.exec(raw)
  if (!m || (m[1] === undefined && m[3] === undefined)) return null
  const from = m[1] !== undefined ? Math.max(1, Number(m[1])) : 1
  const to = m[3] !== undefined ? Number(m[3]) : m[2] ? Number.MAX_SAFE_INTEGER : from
  return to < from ? null : { from, to }
}

/**
 * Le texte des blocs [first, last], chacun sous sa reference. Le texte entre
 * deux blocs est rendu tel quel : sans les lignes ‹...›, c'est la note.
 */
export function renderBlocks(content: string, blocks: readonly RefBlock[], first: number, last: number): string {
  const out: string[] = []
  for (let i = first; i <= last && i < blocks.length; i++) {
    const b = blocks[i]!
    const until = i < last && blocks[i + 1] ? blocks[i + 1]!.from : b.end
    out.push(`${showRef(b.ref)}\n${content.slice(b.from, until).replace(/\r/g, '')}`)
  }
  return out.join('').trimEnd()
}

/** Retire les lignes de reference d'un texte recopie par une IA. */
export function stripRefLines(text: string): string {
  return text.replace(/^‹[^›\n]{1,80}›\n/gm, '')
}

// ── Versions ───────────────────────────────────────────────────────────────

export interface NoteSnapshot {
  docId: string
  /** Jeton court de cette version (« v3f9a1c20b4 »). */
  token: string
  /** Empreinte et « ^id » de chaque bloc, dans l'ordre. */
  blocks: { hash: string; blockId?: string }[]
}

/** La version d'une note : son jeton ne depend que de la note et de son texte. */
export function snapshotOf(docId: string, content: string, blocks: readonly NoteBlock[] = splitNoteBlocks(content)): NoteSnapshot {
  return {
    docId,
    token: `v${textFingerprint(`${docId}\n${content}`).slice(0, 10)}`,
    blocks: blocks.map(b => (b.blockId ? { hash: b.hash, blockId: b.blockId } : { hash: b.hash })),
  }
}

/** Les references des blocs d'une version gardee (les memes qu'a sa lecture). */
export function snapshotRefs(s: NoteSnapshot): string[] {
  return refsOf(s.blocks)
}

export interface BlockChange {
  kind: 'changed' | 'added' | 'removed'
  /** Le bloc d'aujourd'hui (absent pour un bloc supprime). */
  block?: RefBlock
  /** La reference d'avant (bloc modifie ou supprime). */
  was?: string
  /** Rang, dans la note d'aujourd'hui, du bloc (ou de celui qui suit un bloc supprime). */
  index: number
}

const MAX_LCS_CELLS = 1_000_000

/**
 * Aligne deux listes de blocs par empreinte : les paires (rang d'avant, rang
 * d'aujourd'hui) des blocs inchanges, dans l'ordre, puis la paire de fin
 * (longueur d'avant, longueur d'aujourd'hui). Entre deux paires : des blocs
 * partis, des blocs nouveaux.
 */
export function alignBlocks(a: readonly { hash: string }[], b: readonly { hash: string }[]): [number, number][] {
  let head = 0
  while (head < a.length && head < b.length && a[head]!.hash === b[head]!.hash) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.hash === b[b.length - 1 - tail]!.hash) tail++
  const n = a.length - head - tail
  const m = b.length - head - tail
  const pairs: [number, number][] = []
  for (let k = 0; k < head; k++) pairs.push([k, k])
  if (n > 0 && m > 0 && n * m <= MAX_LCS_CELLS) {
    // Plus longue sous-suite commune, sur le milieu seulement.
    const w = m + 1
    const t = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[head + i]!.hash === b[head + j]!.hash ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[head + i]!.hash === b[head + j]!.hash) { pairs.push([head + i, head + j]); i++; j++ } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++
      else j++
    }
  } else if (n > 0 && m > 0) {
    // Trop gros pour comparer finement : un bloc dont l'empreinte existe encore plus loin est inchange.
    const left = new Map<string, number[]>()
    for (let i = head; i < head + n; i++) {
      const list = left.get(a[i]!.hash)
      if (list) list.push(i)
      else left.set(a[i]!.hash, [i])
    }
    let floor = -1
    for (let j = head; j < head + m; j++) {
      const i = left.get(b[j]!.hash)?.find(x => x > floor)
      if (i !== undefined) { pairs.push([i, j]); floor = i }
    }
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k])
  pairs.push([a.length, b.length])
  return pairs
}

/**
 * Ce qui a change entre une version gardee et la note d'aujourd'hui, par
 * empreinte de bloc : blocs modifies, ajoutes, supprimes, dans l'ordre de la note.
 */
export function diffBlocks(old: NoteSnapshot, blocks: readonly RefBlock[]): BlockChange[] {
  const a = old.blocks
  const b = blocks
  const oldRefs = snapshotRefs(old)
  const out: BlockChange[] = []
  let i0 = 0
  let j0 = 0
  for (const [i1, j1] of alignBlocks(a, b)) {
    // Entre deux blocs inchanges : des blocs d'avant [i0, i1) et d'aujourd'hui [j0, j1).
    const gone = Array.from({ length: i1 - i0 }, (_, k) => i0 + k)
    const fresh = Array.from({ length: j1 - j0 }, (_, k) => j0 + k)
    const pairs = new Map<number, number>()
    const taken = new Set<number>()
    // Meme « ^id » des deux cotes : le meme bloc, modifie.
    const goneById = new Map<string, number>()
    for (const i of gone) if (a[i]!.blockId && !goneById.has(a[i]!.blockId!)) goneById.set(a[i]!.blockId!, i)
    for (const j of fresh) {
      const i = b[j]!.blockId ? goneById.get(b[j]!.blockId!) : undefined
      if (i !== undefined && !taken.has(i)) { pairs.set(j, i); taken.add(i) }
    }
    // Les autres, dans l'ordre : un bloc d'avant et un bloc d'aujourd'hui a la meme place.
    const freeGone = gone.filter(x => !taken.has(x))
    let next = 0
    for (const j of fresh) if (!pairs.has(j) && next < freeGone.length) pairs.set(j, freeGone[next++]!)
    for (const j of fresh) {
      const i = pairs.get(j)
      out.push(i === undefined ? { kind: 'added', block: b[j]!, index: j } : { kind: 'changed', block: b[j]!, was: oldRefs[i]!, index: j })
    }
    for (const i of freeGone.slice(next)) out.push({ kind: 'removed', was: oldRefs[i]!, index: j1 })
    i0 = i1 + 1
    j0 = j1 + 1
  }
  return out
}

/**
 * Ce que l'agent connait apres avoir recu les blocs [first, last] de la note
 * d'aujourd'hui : sa version d'avant, ou cette partie est remplacee. Le reste
 * ne bouge pas : ce qui y a change lui sera encore signale. `last` < `first` :
 * rien de recu, seulement des blocs retires a cet endroit.
 */
export function mergeSnapshot(old: NoteSnapshot, cur: NoteSnapshot, first: number, last: number): NoteSnapshot {
  if (first <= 0 && last >= cur.blocks.length - 1) return cur
  let i0 = 0
  let start = -1
  let end = -1
  for (const [i, j] of alignBlocks(old.blocks, cur.blocks)) {
    if (start < 0 && j >= first) start = i0
    if (end < 0 && j >= last + 1) end = j === last + 1 ? i : i0
    i0 = i + 1
  }
  if (start < 0 || end < start) return old
  const blocks = [...old.blocks.slice(0, start), ...cur.blocks.slice(first, last + 1), ...old.blocks.slice(end)]
  const same = blocks.length === cur.blocks.length && blocks.every((x, k) => x.hash === cur.blocks[k]!.hash)
  // Sans jeton : ce n'est la version d'aucun moment, seulement ce que l'agent a vu.
  return same ? cur : { docId: cur.docId, token: '', blocks }
}

/** Les changements, en texte pour l'IA : chaque bloc sous sa reference. */
export function renderChanges(changes: readonly BlockChange[], blocks: readonly RefBlock[]): string {
  return changes.map(c => {
    if (c.kind === 'removed') {
      const before = blocks[c.index - 1]
      return `${showRef(c.was!)} supprimé${before ? ` (était après ${showRef(before.ref)})` : ' (était au début)'}`
    }
    const b = c.block!
    const where = b.line === b.lastLine ? `ligne ${b.line}` : `lignes ${b.line}-${b.lastLine}`
    const what = c.kind === 'changed' ? `modifié (était ${showRef(c.was!)})` : 'ajouté'
    return `${showRef(b.ref)} ${what}, ${where}${b.section ? `, section « ${b.section} »` : ''}\n${b.text}`
  }).join('\n\n')
}
