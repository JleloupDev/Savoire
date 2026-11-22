// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Blocs d'une note ─────────────────────────────────────────────────────
//
// Une note decoupee en BLOCS : un titre, un paragraphe, une liste, une
// citation, un tableau, un bloc de code... Chaque bloc a sa place dans le
// texte et une EMPREINTE de son contenu : si le texte du bloc change, son
// empreinte change. On sait donc, sans rien relire, ce qui a bouge depuis une
// version vue (derniere visite, relecture d'un agent...).
//
// Fonction pure, la meme partout : l'index (pouvoir `blocks`), l'editeur
// (blocs en direct), les plugins (liens vers un bloc), les agents en veille.
//
// Regles :
//  - une ligne vide separe deux blocs ;
//  - un titre est un bloc a lui seul ;
//  - un bloc de code (``` ou ~~~) ou de formule ($$) est un seul bloc, lignes
//    vides comprises ;
//  - le frontmatter du debut est un bloc ;
//  - « ^id » en fin de ligne donne son identifiant au bloc (lien
//    [[note#^id]]) ; « ^id » seul sur sa ligne le donne au bloc d'avant ;
//  - l'empreinte ne tient compte ni de l'identifiant « ^id », ni des espaces
//    en fin de ligne.

export type NoteBlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'callout'
  | 'table'
  | 'code'
  | 'math'
  | 'rule'
  | 'other'

export interface NoteBlock {
  /** Rang du bloc dans la note (0, 1, 2...). */
  index: number
  kind: NoteBlockKind
  /** Debut du bloc dans le texte (unites JS). */
  from: number
  /** Fin du bloc (fin de sa derniere ligne, sans le retour a la ligne). */
  to: number
  /** Texte brut du bloc. */
  text: string
  /** Empreinte du contenu (16 caracteres hexadecimaux). */
  hash: string
  /** Niveau d'un titre (1 a 6). */
  level?: number
  /** Identifiant « ^id » du bloc, s'il en a un. */
  blockId?: string
  /** Titre de la section ou il se trouve. */
  section?: string
}

/** Les blocs ou il y a du texte a lire (relecture, extrait, lien). */
export const PROSE_BLOCK_KINDS: ReadonlySet<NoteBlockKind> = new Set(['heading', 'paragraph', 'list', 'quote', 'callout', 'table'])

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const MATH_RE = /^ {0,3}\$\$/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const COLUMNS_RE = /^ {0,3}:{3,}/
const LIST_RE = /^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)/
const BLOCK_ID_RE = /[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/
const BLOCK_ID_ONLY_RE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/

/**
 * Empreinte courte d'un texte : deux FNV-1a 32 bits de bases differentes,
 * 64 bits en hexadecimal. Pas cryptographique : elle dit si un texte a change.
 */
export function textFingerprint(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x0100019d)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** Empreinte d'un bloc : sans « ^id », sans espaces de fin de ligne. */
export function blockFingerprint(text: string): string {
  const lines = text.split('\n').map(l => l.replace(/[ \t]+$/, ''))
  while (lines.length && BLOCK_ID_ONLY_RE.test(lines[lines.length - 1])) lines.pop()
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(BLOCK_ID_RE, '')
  return textFingerprint(lines.join('\n').trim())
}

/** Le texte d'un titre, sans « ^id » ni mise en forme legere. */
function headingText(raw: string): string {
  return raw.replace(BLOCK_ID_RE, '').replace(/[*_`~=]/g, '').trim()
}

function kindOf(firstLine: string): NoteBlockKind {
  const t = firstLine.trimStart()
  if (LIST_RE.test(firstLine)) return 'list'
  if (t.startsWith('>')) return /^>\s*\[!/.test(t) ? 'callout' : 'quote'
  if (t.startsWith('|')) return 'table'
  return 'paragraph'
}

interface Line { text: string; from: number }

/** Decoupe une note (Markdown, frontmatter compris) en blocs. */
export function splitNoteBlocks(markdown: string): NoteBlock[] {
  const lines: Line[] = []
  {
    let pos = 0
    for (const raw of markdown.split('\n')) {
      // Un \r de fin de ligne (fichier Windows) ne fait pas partie du texte du bloc.
      lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, from: pos })
      pos += raw.length + 1
    }
  }
  const out: NoteBlock[] = []
  let section: string | undefined

  const emit = (kind: NoteBlockKind, first: number, last: number, extra: Partial<NoteBlock> = {}): void => {
    const from = lines[first].from
    const to = lines[last].from + lines[last].text.length
    const text = markdown.slice(from, to).replace(/\r$/gm, '')
    const id = kind === 'frontmatter' || kind === 'code' || kind === 'math' ? undefined : text.match(BLOCK_ID_RE)?.[1]
    out.push({
      index: out.length, kind, from, to, text, hash: blockFingerprint(text),
      ...(id ? { blockId: id } : {}),
      ...(section !== undefined && kind !== 'heading' ? { section } : {}),
      ...extra,
    })
  }

  let i = 0
  // Frontmatter : « --- » en premiere ligne, jusqu'au « --- » (ou « ... ») suivant.
  if (lines.length && lines[0].text.trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].text.trim()
      if (t === '---' || t === '...') { emit('frontmatter', 0, j); i = j + 1; break }
    }
  }

  let start = -1 // debut du bloc de texte en cours
  const flush = (end: number): void => {
    if (start < 0) return
    emit(kindOf(lines[start].text), start, end)
    start = -1
  }

  for (; i < lines.length; i++) {
    const text = lines[i].text
    if (!text.trim()) { flush(i - 1); continue }

    const fence = text.match(FENCE_RE)
    if (fence || MATH_RE.test(text)) {
      flush(i - 1)
      const open = i
      const marker = fence?.[1]
      // Une formule sur une seule ligne : $$ x $$.
      const oneLine = !marker && text.trim().length > 2 && text.trim().endsWith('$$')
      let j = i
      if (!oneLine) {
        for (j = i + 1; j < lines.length; j++) {
          const t = lines[j].text
          if (marker ? (t.trimStart().startsWith(marker[0].repeat(marker.length)) && !t.trim().replace(/^[`~]+/, '').trim()) : MATH_RE.test(t)) break
        }
        if (j >= lines.length) j = lines.length - 1
      }
      emit(marker ? 'code' : 'math', open, j)
      i = j
      continue
    }

    const heading = text.match(HEADING_RE)
    if (heading) {
      flush(i - 1)
      const title = headingText(heading[2] ?? '')
      emit('heading', i, i, { level: heading[1].length })
      section = title || undefined
      continue
    }

    const idOnly = text.match(BLOCK_ID_ONLY_RE)
    if (idOnly) {
      // Le bloc en cours, sinon celui d'avant, prend l'identifiant.
      if (start >= 0) { flush(i); continue }
      const prev = out[out.length - 1]
      if (prev && prev.kind !== 'frontmatter') prev.blockId = idOnly[1]
      continue
    }

    if (start < 0 && (RULE_RE.test(text) || COLUMNS_RE.test(text))) {
      emit(COLUMNS_RE.test(text) ? 'other' : 'rule', i, i)
      continue
    }

    if (start < 0) start = i
  }
  flush(lines.length - 1)
  return out
}

/** Le bloc qui contient la position `pos` (ou le premier qui commence apres). */
export function blockAt(blocks: readonly NoteBlock[], pos: number): NoteBlock | null {
  for (const b of blocks) {
    if (pos <= b.to) return pos >= b.from ? b : null
  }
  return null
}

/** Identifiant de bloc nouveau, absent de la note : 6 caracteres [a-z0-9]. */
export function newBlockId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken)
  for (;;) {
    let id = ''
    for (let k = 0; k < 6; k++) id += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]
    if (!used.has(id)) return id
  }
}

/**
 * Ou ecrire « ^id » pour donner un identifiant a ce bloc : en fin de sa
 * derniere ligne (paragraphe, element de liste), ou sur une ligne a lui sous
 * un tableau, une citation, un bloc de code. Rend l'insertion a faire.
 */
export function blockIdInsertion(block: NoteBlock, id: string): { at: number; insert: string } {
  const ownLine = block.kind === 'table' || block.kind === 'quote' || block.kind === 'callout' || block.kind === 'code' || block.kind === 'math'
  return ownLine ? { at: block.to, insert: `\n^${id}` } : { at: block.to, insert: ` ^${id}` }
}
