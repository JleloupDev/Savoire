// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Logique d'arbre d'un plan, en fonctions pures (sans CodeMirror, sans DOM).
//
// Un plan est une liste Markdown imbriquee :
//
//   - element
//     - sous-element
//     - [ ] case a cocher
//
// Chaque operation prend le texte et la position du curseur, et rend le
// nouveau texte avec la nouvelle selection (ou null quand elle ne s'applique
// pas : la touche suit alors son cours normal). La vue en tire un changement
// minimal (diffToChange) : c'est lui qui part dans le texte partage.
//
// Comportements inspires d'obsidian-outliner, de Viacheslav Slinko (MIT).
// Aucun code repris : seulement le comportement attendu.

/** Indentation par defaut d'un niveau (en espaces). */
export const INDENT_UNIT = 2

export interface OutlineLine {
  from: number
  /** Fin de la ligne, sans le saut de ligne. */
  to: number
  text: string
}

export interface OutlineItem {
  index: number
  /** Ligne de l'element (0 = premiere ligne). */
  line: number
  from: number
  to: number
  /** Indentation en colonnes (une tabulation compte pour INDENT_UNIT). */
  indent: number
  indentText: string
  bullet: string
  /** null : pas de case ; sinon cochee ou non. */
  checked: boolean | null
  /** Debut du texte de l'element, apres la puce et la case. */
  contentFrom: number
  /** Derniere ligne du sous-arbre (incluse), lignes vides de fin exclues. */
  endLine: number
  /** Fin du sous-arbre (fin de sa derniere ligne). */
  end: number
  /** Index de l'element parent, -1 a la racine. */
  parent: number
  children: number[]
  depth: number
}

export interface Outline {
  text: string
  lines: OutlineLine[]
  items: OutlineItem[]
  /** Element auquel appartient chaque ligne (-1 avant le premier element). */
  owner: number[]
  /** Element qui commence sur chaque ligne (-1 sinon). */
  itemAtLine: number[]
  roots: number[]
}

/** Nouveau texte et nouvelle selection apres une operation. */
export interface OutlineEdit {
  text: string
  anchor: number
  head: number
}

// Puce, puis soit une espace (et une case eventuelle), soit la fin de ligne.
const ITEM_RE = /^([ \t]*)([-*+])(?: (\[[ xX]\](?: |$))?|$)/

function columns(ws: string): number {
  let n = 0
  for (const c of ws) n += c === '\t' ? INDENT_UNIT : 1
  return n
}

export function parseOutline(text: string): Outline {
  const lines: OutlineLine[] = []
  let from = 0
  for (const t of text.split('\n')) {
    lines.push({ from, to: from + t.length, text: t })
    from += t.length + 1
  }
  const items: OutlineItem[] = []
  const owner: number[] = []
  const itemAtLine: number[] = []
  const roots: number[] = []
  const stack: number[] = []

  const close = (idx: number, lastLine: number) => {
    const it = items[idx]
    let end = Math.max(it.line, lastLine)
    while (end > it.line && lines[end].text.trim() === '') end--
    it.endLine = end
    it.end = lines[end].to
  }

  lines.forEach((l, i) => {
    const m = ITEM_RE.exec(l.text)
    if (!m) {
      owner.push(items.length - 1)
      itemAtLine.push(-1)
      return
    }
    const indent = columns(m[1])
    while (stack.length && items[stack[stack.length - 1]].indent >= indent) {
      close(stack.pop()!, i - 1)
    }
    const index = items.length
    const parent = stack.length ? stack[stack.length - 1] : -1
    items.push({
      index, line: i, from: l.from, to: l.to, indent, indentText: m[1], bullet: m[2],
      checked: m[3] ? m[3][1] !== ' ' : null,
      contentFrom: l.from + m[0].length,
      endLine: i, end: l.to, parent, children: [], depth: stack.length,
    })
    if (parent >= 0) items[parent].children.push(index)
    else roots.push(index)
    stack.push(index)
    owner.push(index)
    itemAtLine.push(index)
  })
  while (stack.length) close(stack.pop()!, lines.length - 1)
  return { text, lines, items, owner, itemAtLine, roots }
}

/** Ligne qui contient une position. */
export function lineOf(o: Outline, pos: number): number {
  let lo = 0
  let hi = o.lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (o.lines[mid].from <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Element qui commence sur la ligne de cette position, ou null. */
export function itemOnLine(o: Outline, pos: number): OutlineItem | null {
  const idx = o.itemAtLine[lineOf(o, pos)]
  return idx >= 0 ? o.items[idx] : null
}

/** Element auquel appartient la ligne de cette position (ligne de suite comprise). */
export function itemOwning(o: Outline, pos: number): OutlineItem | null {
  const idx = o.owner[lineOf(o, pos)]
  return idx >= 0 ? o.items[idx] : null
}

function siblingsOf(o: Outline, it: OutlineItem): number[] {
  return it.parent >= 0 ? o.items[it.parent].children : o.roots
}

/** Texte de l'element, sans puce ni case. */
export function itemLabel(o: Outline, it: OutlineItem): string {
  return o.text.slice(it.contentFrom, it.to).trim()
}

/** Debut de ligne d'un element : indentation, puce, case vide s'il en a une. */
function prefixOf(it: OutlineItem): string {
  return it.indentText + it.bullet + ' ' + (it.checked !== null ? '[ ] ' : '')
}

// ── Reconstruction ligne a ligne ────────────────────────────────────────────

function joinLines(lines: string[]): string {
  return lines.join('\n')
}

function offsetOf(lines: string[], line: number, col: number): number {
  let off = 0
  for (let i = 0; i < line; i++) off += lines[i].length + 1
  return off + Math.max(0, Math.min(col, lines[line].length))
}

function caret(lines: string[], line: number, col: number): OutlineEdit {
  const pos = offsetOf(lines, line, col)
  return { text: joinLines(lines), anchor: pos, head: pos }
}

/** Retire jusqu'a `cols` colonnes d'indentation ; rend la ligne et les caracteres retires. */
function stripColumns(line: string, cols: number): [string, number] {
  let i = 0
  let n = 0
  while (i < line.length && n < cols && (line[i] === ' ' || line[i] === '\t')) {
    n += line[i] === '\t' ? INDENT_UNIT : 1
    i++
  }
  return [line.slice(i), i]
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Indente l'element du curseur avec ses enfants : il devient le dernier
 * enfant de son frere precedent. null s'il n'a pas de frere avant lui.
 */
export function indentItem(text: string, pos: number): OutlineEdit | null {
  const o = parseOutline(text)
  const li = lineOf(o, pos)
  const it = itemOwning(o, pos)
  if (!it) return null
  const sibs = siblingsOf(o, it)
  const k = sibs.indexOf(it.index)
  if (k <= 0) return null
  const prev = o.items[sibs[k - 1]]
  const unit = prev.children.length ? o.items[prev.children[0]].indent - prev.indent : INDENT_UNIT
  const pad = ' '.repeat(unit > 0 ? unit : INDENT_UNIT)
  const lines = o.lines.map(l => l.text)
  for (let i = it.line; i <= it.endLine; i++) {
    if (lines[i].trim() !== '') lines[i] = pad + lines[i]
  }
  const col = pos - o.lines[li].from
  const moved = li <= it.endLine && o.lines[li].text.trim() !== ''
  return caret(lines, li, col + (moved ? pad.length : 0))
}

/**
 * Desindente l'element du curseur avec ses enfants : il se place juste apres
 * le sous-arbre de son parent (ses freres suivants restent sous le parent).
 * null a la racine.
 */
export function dedentItem(text: string, pos: number): OutlineEdit | null {
  const o = parseOutline(text)
  const li = lineOf(o, pos)
  const it = itemOwning(o, pos)
  if (!it || it.parent < 0) return null
  const parent = o.items[it.parent]
  const delta = it.indent - parent.indent
  const lines = o.lines.map(l => l.text)
  let removedOnCursorLine = 0
  const block: string[] = []
  for (let i = it.line; i <= it.endLine; i++) {
    const [s, removed] = stripColumns(lines[i], delta)
    block.push(s)
    if (i === li) removedOnCursorLine = removed
  }
  const before = lines.slice(0, it.line)
  const middle = lines.slice(it.endLine + 1, parent.endLine + 1)
  const after = lines.slice(parent.endLine + 1)
  const out = [...before, ...middle, ...block, ...after]
  const cursorLine = li <= it.endLine ? before.length + middle.length + (li - it.line) : li
  const col = pos - o.lines[li].from - (li <= it.endLine ? removedOnCursorLine : 0)
  return caret(out, cursorLine, col)
}

/**
 * Echange l'element du curseur (avec ses enfants) avec son frere precedent
 * ou suivant. null s'il n'y en a pas.
 */
export function moveItem(text: string, pos: number, dir: 'up' | 'down'): OutlineEdit | null {
  const o = parseOutline(text)
  const li = lineOf(o, pos)
  const it = itemOwning(o, pos)
  if (!it) return null
  const sibs = siblingsOf(o, it)
  const k = sibs.indexOf(it.index)
  const other = dir === 'up' ? sibs[k - 1] : sibs[k + 1]
  if (other === undefined) return null
  const [first, second] = dir === 'up' ? [o.items[other], it] : [it, o.items[other]]
  const lines = o.lines.map(l => l.text)
  const a = lines.slice(first.line, first.endLine + 1)
  const gap = lines.slice(first.endLine + 1, second.line)
  const b = lines.slice(second.line, second.endLine + 1)
  const out = [...lines.slice(0, first.line), ...b, ...gap, ...a, ...lines.slice(second.endLine + 1)]
  const col = pos - o.lines[li].from
  const rel = li - it.line
  const newLine = dir === 'up' ? first.line + rel : first.line + b.length + gap.length + rel
  return caret(out, newLine, col)
}

export interface EnterOptions {
  /** Vrai si les enfants de l'element de cette ligne sont plies. */
  isFolded?(line: number): boolean
  /** Vrai si le nouvel element doit etre un enfant (racine d'un zoom). */
  forceChild?(line: number): boolean
}

/**
 * Entree sur un element :
 *  - element vide : le remonte d'un niveau (rien a la racine) ;
 *  - curseur au debut d'un element non vide : nouvel element vide au-dessus ;
 *  - sinon : coupe a la position du curseur. La suite part dans un nouvel
 *    element, premier enfant si l'element a des enfants deplies, frere
 *    suivant sinon.
 * null hors d'une ligne d'element.
 */
export function enterItem(text: string, pos: number, opts: EnterOptions = {}): OutlineEdit | null {
  const o = parseOutline(text)
  const it = itemOnLine(o, pos)
  if (!it) return null
  const content = text.slice(it.contentFrom, it.to)
  if (content.trim() === '') {
    if (it.parent >= 0) return dedentItem(text, pos)
    return { text, anchor: pos, head: pos }
  }
  const p = Math.max(pos, it.contentFrom)
  if (p === it.contentFrom) {
    const prefix = prefixOf(it)
    const out = text.slice(0, it.from) + prefix + '\n' + text.slice(it.from)
    const at = p + prefix.length + 1
    return { text: out, anchor: at, head: at }
  }
  const forceChild = !!opts.forceChild?.(it.line)
  const openChildren = it.children.length > 0 && (forceChild || !opts.isFolded?.(it.line))
  const prefix = openChildren
    ? prefixOf(o.items[it.children[0]])
    : forceChild ? ' '.repeat(INDENT_UNIT) + prefixOf(it) : prefixOf(it)
  // Un nouvel enfant se place avant le premier enfant, donc apres les notes.
  const at = openChildren
    ? o.lines[o.items[it.children[0]].line - 1].to
    : forceChild ? lastNoteEnd(o, it) : it.end
  const rest = text.slice(p, it.to)
  const out = text.slice(0, p) + text.slice(it.to, at) + '\n' + prefix + rest + text.slice(at)
  const cursor = p + (at - it.to) + 1 + prefix.length
  return { text: out, anchor: cursor, head: cursor }
}

/** Fin de la ligne de l'element ou de sa derniere note. */
function lastNoteEnd(o: Outline, it: OutlineItem): number {
  let k = it.line
  while (k + 1 < o.lines.length && o.itemAtLine[k + 1] < 0 && o.lines[k + 1].text.trim() !== '') k++
  return o.lines[k].to
}

export interface BackspaceOptions {
  /** Vrai si cette ligne est masquee (pliee, ou hors du zoom). */
  isHidden?(line: number): boolean
}

/**
 * Retour arriere au tout debut du texte d'un element : l'element est
 * supprime et son texte rejoint la fin de la ligne visible precedente.
 * null si le curseur n'est pas au debut du texte d'un element.
 */
export function backspaceItem(text: string, pos: number, opts: BackspaceOptions = {}): OutlineEdit | null {
  const o = parseOutline(text)
  const it = itemOnLine(o, pos)
  if (!it || pos !== it.contentFrom) return null
  let target = it.line - 1
  while (target >= 0 && opts.isHidden?.(target)) target--
  if (target < 0) return { text, anchor: pos, head: pos }
  const lines = o.lines.map(l => l.text)
  const col = lines[target].length
  lines[target] += text.slice(it.contentFrom, it.to)
  lines.splice(it.line, 1)
  return caret(lines, target, col)
}

/**
 * Ctrl+A : selectionne le texte de l'element ; si c'est deja fait,
 * selectionne toute la portee (le document, ou le sous-arbre zoome).
 */
export function selectItem(
  text: string, anchor: number, head: number, scope?: { from: number; to: number },
): { anchor: number; head: number } {
  const o = parseOutline(text)
  const all = scope ?? { from: 0, to: text.length }
  const it = itemOwning(o, head)
  if (!it) return { anchor: all.from, head: all.to }
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  const done = it.contentFrom === it.to || (from === it.contentFrom && to === it.to)
  return done ? { anchor: all.from, head: all.to } : { anchor: it.contentFrom, head: it.to }
}

/**
 * Note d'element (Maj+Entree) : une ligne sous l'element, sans puce, plus
 * discrete. Depuis l'element, la note s'ajoute apres ses notes existantes ;
 * depuis une note, une nouvelle ligne de note s'ouvre au curseur.
 */
export function addNote(text: string, pos: number): OutlineEdit | null {
  const o = parseOutline(text)
  const li = lineOf(o, pos)
  const idx = o.owner[li]
  if (idx < 0) return null
  const it = o.items[idx]
  const pad = ' '.repeat(it.indent + INDENT_UNIT)
  const at = o.itemAtLine[li] >= 0 ? lastNoteEnd(o, it) : pos
  const out = text.slice(0, at) + '\n' + pad + text.slice(at)
  const cursor = at + 1 + pad.length
  return { text: out, anchor: cursor, head: cursor }
}

/**
 * Entree dans une note : on quitte la note, un nouvel element suit (comme
 * Entree au bout de l'element). Maj+Entree (addNote) ajoute une ligne de note.
 */
export function enterNote(text: string, pos: number, opts: EnterOptions = {}): OutlineEdit | null {
  const o = parseOutline(text)
  const li = lineOf(o, pos)
  if (o.itemAtLine[li] >= 0 || o.owner[li] < 0) return null
  const it = o.items[o.owner[li]]
  if (text.slice(it.contentFrom, it.to).trim() === '') return { text, anchor: pos, head: pos }
  return enterItem(text, it.to, opts)
}

/** Ce qu'affiche un zoom sur l'element du curseur : son sous-arbre. */
export function zoomRange(text: string, pos: number): { from: number; to: number; line: number } | null {
  const o = parseOutline(text)
  const it = itemOwning(o, pos)
  return it ? { from: it.from, to: it.end, line: it.line } : null
}

/** Fil d'Ariane d'un element : ses ancetres, de la racine au parent. */
export function ancestors(o: Outline, it: OutlineItem): OutlineItem[] {
  const out: OutlineItem[] = []
  for (let p = it.parent; p >= 0; p = o.items[p].parent) out.unshift(o.items[p])
  return out
}

/** Coche ou decoche la case de l'element de cette ligne. */
export function toggleChecked(text: string, pos: number): OutlineEdit | null {
  const o = parseOutline(text)
  const it = itemOnLine(o, pos)
  if (!it || it.checked === null) return null
  const box = it.from + it.indentText.length + 3
  const out = text.slice(0, box) + (it.checked ? ' ' : 'x') + text.slice(box + 1)
  return { text: out, anchor: pos, head: pos }
}

/** Changement minimal qui mene de `a` a `b` (prefixe et suffixe communs). */
export function diffToChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++
  let s = 0
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) }
}

export interface TextChange { from: number; to: number; insert: string }

/**
 * Changements minimaux, ligne par ligne, qui menent de `a` a `b` : un
 * indentage devient une insertion d'espaces par ligne, et non le
 * remplacement du bloc (ce qui ecraserait ce qu'un autre membre tape dans
 * ces lignes au meme moment). Positions dans `a`, triees, disjointes.
 */
export function diffToChanges(a: string, b: string): TextChange[] {
  if (a === b) return []
  const la = a.split('\n')
  const lb = b.split('\n')
  if (la.length !== lb.length) {
    // Lignes ajoutees ou retirees : un seul changement, prefixe et suffixe
    // communs retires.
    const c = diffToChange(a, b)
    return c ? [c] : []
  }
  let p = 0
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++
  let s = 0
  while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++
  let off = 0
  for (let i = 0; i < p; i++) off += la[i].length + 1
  const out: TextChange[] = []
  for (let i = p; i < la.length - s; i++) {
    const c = diffToChange(la[i], lb[i])
    if (c) out.push({ from: off + c.from, to: off + c.to, insert: c.insert })
    off += la[i].length + 1
  }
  return out
}
