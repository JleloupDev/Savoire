// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le contexte de l'editeur, pour l'IA : la note ouverte, ce qui y est
// selectionne (ou l'endroit du curseur), la section, et de quoi retrouver le
// passage plus tard (une ancre). L'application le construit a chaque
// selection ; ChatGPT, Claude et l'assistant le lisent par l'outil
// get_context quand la personne dit « ici », « ce passage », « ca ».
//
// Tout est pur ici (pas d'editeur, pas de CRDT) : l'appelant donne le texte,
// la selection et de quoi coder une position relative.
import { blockAt, splitNoteBlocks, type NoteBlock } from '@savoire/plugin-api'

/**
 * L'ancre d'un passage. start / end : position relative Yjs
 * (Y.encodeRelativePosition, en base64) dans le texte de la note ; pour un
 * curseur, end = start. quote : le texte du passage ('' pour un curseur).
 * prefix / suffix : 32 caracteres au plus, juste avant et juste apres.
 * (Meme forme que l'ancre des outils d'ecriture : a reunir avec anchor.ts.)
 */
export interface EditorAnchor {
  docId: string
  start: string
  end: string
  quote: string
  prefix: string
  suffix: string
  /**
   * Un passage d'un PDF (pas de positions relatives : start = end = '') : sa
   * page et sa place, et, si c'est une marque de la Revision, son nom court
   * (lien [[Rapport.pdf#^ref]]).
   */
  pdf?: PdfAnchorInfo
}

/** Ou, dans un PDF (voir plugin-api/pdf.ts). */
export interface PdfAnchorInfo {
  page: number
  pages: number
  /** Rectangles de la page (fractions, x, y, largeur, hauteur) ; vide : la page. */
  rects: [number, number, number, number][]
  ref?: string
  mark?: 'highlight' | 'anchor'
  color?: string
  label?: string
  /** Le commentaire du fil de la marque. */
  comment?: string
  /** Texte reconnu par l'OCR (page scannee). */
  ocr?: boolean
}

export interface EditorContextEntry {
  vaultId: string
  docId: string
  path: string
  /** Texte selectionne ; vide : un curseur. */
  selection: string
  /** La selection depassait la borne : seul son debut est la. */
  selectionTruncated?: boolean
  anchor: EditorAnchor
  /** Une dizaine de mots avant et apres. */
  before: string
  after: string
  /** Les titres au-dessus du passage, du plus haut au plus proche (« MCP > Bases »). */
  headingPath: string[]
  /** Empreinte du bloc ou commence le passage ('' : entre deux blocs). */
  blockHash: string
  /** Quand (millisecondes, horloge de l'appareil). */
  at: number
  /** L'onglet ou l'appareil. */
  tabId: string
  /**
   * La personne a tape ici, a cette heure (millisecondes, horloge de
   * l'appareil). Absent : elle a seulement selectionne ou deplace le curseur.
   * Un agent n'ecrit pas dans ce paragraphe tant que c'est recent (typingGuard.ts).
   */
  typingAt?: number
}

/** Une marque pour l'IA : epingle nommee, ou passage surligne. Personnelle, hors de la note. */
export interface AiMark {
  id: string
  vaultId: string
  docId: string
  kind: 'pin' | 'highlight'
  label: string
  path: string
  anchor: EditorAnchor
  createdAt: string
}

export const MAX_CONTEXT_SELECTION = 4000
export const ANCHOR_SIDE_CHARS = 32
export const CONTEXT_WORDS = 10
/** Au-dela, l'IA demande a la personne de confirmer avant d'agir. */
export const CONTEXT_STALE_SECONDS = 120
export const CONTEXT_RING_SECONDS = 60

/**
 * Code la position `index` du texte en position relative (base64).
 * assoc 0 : collee au caractere qui suit ; -1 : a celui qui precede.
 */
export type RelativePositionEncoder = (index: number, assoc: 0 | -1) => string

const HEADING_MARKS_RE = /^ {0,3}#{1,6}[ \t]*|[ \t]+#+[ \t]*$/g
const BLOCK_ID_RE = /[ \t]*\^[A-Za-z0-9-]+[ \t]*$/

function headingTitle(block: NoteBlock): string {
  return block.text.replace(HEADING_MARKS_RE, '').replace(BLOCK_ID_RE, '').replace(/[*_`~=]/g, '').trim()
}

/** Les titres sous lesquels se trouve `pos` : ['MCP', 'Bases']. Un titre compte pour lui-meme. */
export function headingPathAt(blocks: readonly NoteBlock[], pos: number): string[] {
  const stack: { level: number; title: string }[] = []
  for (const b of blocks) {
    if (b.from > pos) break
    if (b.kind !== 'heading') continue
    const level = b.level ?? 1
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, title: headingTitle(b) })
  }
  return stack.map(h => h.title).filter(t => t !== '')
}

function clampRange(text: string, from: number, to: number): { from: number; to: number } {
  const a = Math.max(0, Math.min(text.length, Math.min(from, to)))
  const b = Math.max(a, Math.min(text.length, Math.max(from, to)))
  return { from: a, to: b }
}

/** Les `count` mots juste avant `pos`. */
export function wordsBefore(text: string, pos: number, count = CONTEXT_WORDS): string {
  const words = text.slice(Math.max(0, pos - 400), pos).split(/\s+/).filter(Boolean)
  return words.slice(-count).join(' ').slice(-300)
}

/** Les `count` mots juste apres `pos`. */
export function wordsAfter(text: string, pos: number, count = CONTEXT_WORDS): string {
  const words = text.slice(pos, pos + 400).split(/\s+/).filter(Boolean)
  return words.slice(0, count).join(' ').slice(0, 300)
}

/** L'ancre du passage [from, to) : positions relatives, texte, et ce qui l'entoure. */
export function buildAnchor(p: { docId: string; text: string; from: number; to: number; encode: RelativePositionEncoder }): EditorAnchor {
  const { from, to } = clampRange(p.text, p.from, p.to)
  // Debut colle au caractere qui suit, fin a celui qui precede : ce qu'on
  // ajoute juste avant ou juste apres n'entre pas dans le passage.
  const start = p.encode(from, 0)
  return {
    docId: p.docId,
    start,
    end: to > from ? p.encode(to, -1) : start,
    quote: p.text.slice(from, Math.min(to, from + MAX_CONTEXT_SELECTION)),
    prefix: p.text.slice(Math.max(0, from - ANCHOR_SIDE_CHARS), from),
    suffix: p.text.slice(to, to + ANCHOR_SIDE_CHARS),
  }
}

/**
 * Retrouve un passage par son texte, quand ses positions relatives ne
 * menent plus nulle part (note reecrite d'un bloc, restauree...). L'endroit
 * ou le texte d'avant et d'apres collent, sinon la seule occurrence. Null :
 * introuvable, ou plusieurs endroits possibles.
 */
export function locateByQuote(text: string, anchor: Pick<EditorAnchor, 'quote' | 'prefix' | 'suffix'>): { from: number; to: number } | null {
  const { quote, prefix, suffix } = anchor
  if (quote === '') {
    // Un curseur : entre ce qui le precedait et ce qui le suivait.
    if (prefix === '' && suffix === '') return null
    const at = text.indexOf(prefix + suffix)
    if (at < 0 || text.indexOf(prefix + suffix, at + 1) >= 0) return null
    return { from: at + prefix.length, to: at + prefix.length }
  }
  const found: number[] = []
  for (let i = text.indexOf(quote); i >= 0 && found.length < 50; i = text.indexOf(quote, i + 1)) found.push(i)
  if (!found.length) return null
  const exact = found.filter(i => text.slice(Math.max(0, i - prefix.length), i) === prefix && text.slice(i + quote.length, i + quote.length + suffix.length) === suffix)
  const at = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null
  return at === null ? null : { from: at, to: at + quote.length }
}

export interface EditorContextInput {
  vaultId: string
  docId: string
  path: string
  /** Le texte de la note (celui du CRDT : memes positions). */
  text: string
  /** La selection ; from = to : un curseur. */
  from: number
  to: number
  tabId: string
  at: number
  encode: RelativePositionEncoder
  /** Les blocs de la note, s'ils sont deja calcules. */
  blocks?: readonly NoteBlock[]
  /** Heure de la derniere frappe, si la personne a tape depuis l'entree precedente. */
  typingAt?: number
}

/** Une entree de contexte pour la selection (ou le curseur) donnee. */
export function buildEditorContext(p: EditorContextInput): EditorContextEntry {
  const { from, to } = clampRange(p.text, p.from, p.to)
  const blocks = p.blocks ?? splitNoteBlocks(p.text)
  const anchor = buildAnchor({ docId: p.docId, text: p.text, from, to, encode: p.encode })
  return {
    vaultId: p.vaultId,
    docId: p.docId,
    path: p.path,
    selection: anchor.quote,
    ...(to - from > MAX_CONTEXT_SELECTION ? { selectionTruncated: true } : {}),
    anchor,
    before: wordsBefore(p.text, from),
    after: wordsAfter(p.text, to),
    headingPath: headingPathAt(blocks, from),
    blockHash: blockAt(blocks, from)?.hash ?? '',
    at: p.at,
    tabId: p.tabId,
    ...(p.typingAt ? { typingAt: p.typingAt } : {}),
  }
}

/** Ce qu'une vue de document (un PDF) dit regarder : voir DocumentContextReport de plugin-api. */
export interface DocumentContextInput {
  vaultId: string
  docId: string
  path: string
  selection: string
  before: string
  after: string
  pdf?: PdfAnchorInfo
  tabId: string
  at: number
}

/**
 * L'entree de contexte d'un passage d'un PDF (ou d'une page seule). Pas de
 * positions relatives : l'ancre porte la page et la place (anchor.pdf), et
 * le texte cite pour le retrouver.
 */
export function buildDocumentContext(p: DocumentContextInput): EditorContextEntry {
  const quote = p.selection.slice(0, MAX_CONTEXT_SELECTION)
  const pdf = p.pdf ? { ...p.pdf, rects: p.pdf.rects.slice(0, 64) } : undefined
  return {
    vaultId: p.vaultId,
    docId: p.docId,
    path: p.path,
    selection: quote,
    ...(p.selection.length > MAX_CONTEXT_SELECTION ? { selectionTruncated: true } : {}),
    anchor: {
      docId: p.docId, start: '', end: '', quote,
      prefix: p.before.slice(-ANCHOR_SIDE_CHARS), suffix: p.after.slice(0, ANCHOR_SIDE_CHARS),
      ...(pdf ? { pdf } : {}),
    },
    before: p.before.slice(-300),
    after: p.after.slice(0, 300),
    headingPath: pdf ? [`Page ${pdf.page}`] : [],
    blockHash: '',
    at: p.at,
    tabId: p.tabId,
  }
}

/** La ligne qui dit ou l'on est dans un PDF (get_context) : « PDF, page 3 sur 12, surlignage jaune ... ». */
export function describePdfContext(pdf: PdfAnchorInfo, linkTarget: string): string {
  const parts = [`PDF, page ${pdf.page} sur ${pdf.pages}`]
  if (pdf.ocr) parts.push('texte reconnu par OCR (page scannée)')
  if (pdf.mark === 'highlight') parts.push(`surlignage${pdf.color ? ` ${pdf.color}` : ''}`)
  if (pdf.mark === 'anchor') parts.push(`ancre${pdf.label ? ` « ${pdf.label} »` : ''}`)
  if (pdf.ref) parts.push(`lien : [[${linkTarget}#^${pdf.ref}]]`)
  else parts.push(`lien de la page : [[${linkTarget}#page=${pdf.page}]]`)
  return parts.join(', ')
}

/** Deux entrees disent-elles la meme chose ? (meme note, meme passage, meme texte autour) */
export function sameEditorContext(a: EditorContextEntry | null, b: EditorContextEntry | null): boolean {
  if (!a || !b) return a === b
  return a.vaultId === b.vaultId && a.docId === b.docId && a.path === b.path
    && a.anchor.start === b.anchor.start && a.anchor.end === b.anchor.end
    && a.selection === b.selection && a.before === b.before && a.after === b.after
    && JSON.stringify(a.anchor.pdf ?? null) === JSON.stringify(b.anchor.pdf ?? null)
}

/**
 * La memoire courte du contexte : environ une minute, et toujours la
 * derniere entree (la personne est partie parler a l'IA dans une autre
 * fenetre). Le serveur tient la meme pour les IA externes.
 */
export class EditorContextRing {
  private entries: EditorContextEntry[] = []

  constructor(private readonly seconds = CONTEXT_RING_SECONDS, private readonly max = 64) {}

  push(entry: EditorContextEntry): void {
    this.entries.push(entry)
    while (this.entries.length > 1 && (this.entries.length > this.max || entry.at - this.entries[0].at > this.seconds * 1000)) this.entries.shift()
  }

  /**
   * Ou etait la personne il y a `secondsAgo` secondes : la derniere entree
   * d'avant ce moment, sinon la plus ancienne gardee. Avec son age.
   */
  at(secondsAgo: number, now: number): { entry: EditorContextEntry; ageSeconds: number } | null {
    if (!this.entries.length) return null
    const target = now - Math.max(0, secondsAgo) * 1000
    let found = this.entries[0]
    for (const e of this.entries) if (e.at <= target) found = e
    return { entry: found, ageSeconds: Math.max(0, Math.round((now - found.at) / 1000)) }
  }

  last(): EditorContextEntry | null {
    return this.entries[this.entries.length - 1] ?? null
  }

  /** La derniere entree ou la personne tapait. Null : elle n'a pas tape depuis une minute. */
  lastTyped(): EditorContextEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.typingAt) return this.entries[i]!
    return null
  }

  clear(): void {
    this.entries = []
  }
}
