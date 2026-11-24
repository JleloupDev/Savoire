// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Petites aides d'ecriture, comme dans Obsidian :
// - le correcteur orthographique du navigateur ;
// - les autres occurrences du texte selectionne, surlignees ;
// - entourer la selection en tapant * _ ~ = ` " $ ( [ { ;
// - fermer seul ( [ { (donc [[ ferme ]]) ;
// - plusieurs curseurs, en option (Alt+clic, Ctrl+D) ;
// - des listes numerotees qui se renumerotent seules.

import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension, type TransactionSpec, type ChangeSpec, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, drawSelection, keymap, rectangularSelection, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { plainMatches, renderedTextRanges, setDomHighlight } from './DomHighlights'
/** Noeud de l'arbre syntaxique (@lezer/common n'est pas une dependance directe). */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

// ── Correcteur orthographique ───────────────────────────────────────────────

/** Le navigateur souligne les fautes (CodeMirror le coupe par defaut). */
export const spellcheck: Extension = EditorView.contentAttributes.of({ spellcheck: 'true' })

// ── Occurrences du texte selectionne ────────────────────────────────────────

const matchMark = Decoration.mark({ class: 'plume-selection-match' })

/** Le texte selectionne a chercher ailleurs, ou '' (vide, trop court, plusieurs lignes...). */
function selectionNeedle(state: EditorState): string {
  const sel = state.selection
  if (sel.ranges.length > 1 || sel.main.empty) return ''
  const { from, to } = sel.main
  if (to - from < 2 || to - from > 200) return ''
  const text = state.sliceDoc(from, to)
  return !text.trim() || text.includes('\n') ? '' : text
}

function selectionMatches(view: EditorView): DecorationSet {
  const { state } = view
  const text = selectionNeedle(state)
  if (!text) return Decoration.none
  const from = state.selection.main.from
  const needle = text.toLowerCase()
  const marks = []
  for (const r of view.visibleRanges) {
    const hay = state.sliceDoc(r.from, r.to).toLowerCase()
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      const at = r.from + i
      if (at !== from) marks.push(matchMark.range(at, at + needle.length))
      if (marks.length > 500) break
    }
  }
  return Decoration.set(marks, true)
}

/** Les autres endroits ou figure le texte selectionne (casse ignoree). */
export const highlightSelectionMatches: Extension = [EditorView.baseTheme({
  '.plume-selection-match': { background: 'color-mix(in srgb, var(--accent, #7c3aed) 18%, transparent)', borderRadius: '2px' },
  // Le texte rendu (paragraphes, tableaux...) : par l'API des surlignages.
  '.cm-content ::highlight(plume-selection-match)': { backgroundColor: 'color-mix(in srgb, var(--accent, #7c3aed) 22%, transparent)' },
}), ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(readonly view: EditorView) {
    this.decorations = selectionMatches(view)
    this.renderedLater()
  }
  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged || u.viewportChanged) {
      this.decorations = selectionMatches(u.view)
      this.renderedLater()
    }
  }
  /** Apres le dessin : les occurrences dans le texte rendu. */
  renderedLater() {
    this.view.requestMeasure({
      key: this,
      read: view => {
        const needle = selectionNeedle(view.state)
        return needle ? renderedTextRanges(view, plainMatches(needle, false), 500) : []
      },
      write: (ranges, view) => setDomHighlight('plume-selection-match', view, ranges),
    })
  }
  destroy() { setDomHighlight('plume-selection-match', this.view, []) }
}, { decorations: v => v.decorations })]

// ── Entourer la selection, fermer les crochets ──────────────────────────────

const WRAP: Record<string, string> = {
  '*': '*', _: '_', '~': '~', '=': '=', '`': '`', '"': '"', $: '$', '«': '»',
  '(': ')', '[': ']', '{': '}',
}
const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = new Set(Object.values(CLOSE))

/** Les fermants poses seuls : taper le meme fermant passe par-dessus. */
const addClosers = StateEffect.define<number[]>()
const autoClosers = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map(p => tr.changes.mapPos(p, 1)) : value
    for (const e of tr.effects) if (e.is(addClosers)) next = [...next, ...e.value]
    // On quitte la ligne : ils redeviennent des caracteres ordinaires.
    if (tr.selection && next.length) {
      const line = tr.state.doc.lineAt(tr.state.selection.main.head)
      next = next.filter(p => p >= line.from && p <= line.to)
    }
    return next
  },
})

function wrapOrClose(view: EditorView, from: number, to: number, text: string): boolean {
  if (view.composing || view.state.readOnly || text.length !== 1) return false
  const { state } = view
  const ranges = state.selection.ranges
  // Le texte tape remplace la selection principale : sinon, ce n'est pas une frappe simple.
  if (from !== state.selection.main.from || to !== state.selection.main.to) return false
  const close = WRAP[text]
  if (close && ranges.some(r => !r.empty) && ranges.every(r => !r.empty && state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number)) {
    // « mot » selectionne, on tape * : *mot*, toujours selectionne (un deuxieme * donne **mot**).
    const tr = state.changeByRange(r => ({
      changes: [{ from: r.from, insert: text }, { from: r.to, insert: close }],
      range: EditorSelection.range(r.anchor + text.length, r.head + text.length),
    }))
    view.dispatch(state.update(tr, { userEvent: 'input.wrap', scrollIntoView: true }))
    return true
  }
  if (!ranges.every(r => r.empty)) return false
  const closers = state.field(autoClosers, false) ?? []
  if (CLOSERS.has(text) && ranges.every(r => state.sliceDoc(r.head, r.head + 1) === text && closers.includes(r.head))) {
    // Le fermant pose seul est deja la : on passe par-dessus.
    view.dispatch({ selection: EditorSelection.create(ranges.map(r => EditorSelection.cursor(r.head + 1)), state.selection.mainIndex), userEvent: 'input' })
    return true
  }
  const closer = CLOSE[text]
  if (!closer) return false
  // Seulement devant un blanc, une fin de ligne ou un autre fermant.
  const ok = ranges.every(r => {
    const next = state.sliceDoc(r.head, r.head + 1)
    return next === '' || next === '\n' || /\s/.test(next) || CLOSERS.has(next)
  })
  if (!ok) return false
  const tr = state.changeByRange(r => ({
    changes: { from: r.head, insert: text + closer },
    range: EditorSelection.cursor(r.head + 1),
  }))
  const spec = state.update(tr, { userEvent: 'input.type', scrollIntoView: true })
  view.dispatch(spec, { effects: addClosers.of(spec.state.selection.ranges.map(r => r.head)) })
  return true
}

/** Retour arriere entre ( et ) poses ensemble : les deux partent. */
function deletePair(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly || !state.selection.ranges.every(r => r.empty)) return false
  const closers = state.field(autoClosers, false) ?? []
  const ok = state.selection.ranges.every(r => {
    const before = state.sliceDoc(r.head - 1, r.head)
    return CLOSE[before] !== undefined && state.sliceDoc(r.head, r.head + 1) === CLOSE[before] && closers.includes(r.head)
  })
  if (!ok) return false
  view.dispatch(state.update(state.changeByRange(r => ({
    changes: { from: r.head - 1, to: r.head + 1 },
    range: EditorSelection.cursor(r.head - 1),
  })), { userEvent: 'delete.backward', scrollIntoView: true }))
  return true
}

export const brackets: Extension = [
  autoClosers,
  EditorView.inputHandler.of(wrapOrClose),
  Prec.high(keymap.of([{ key: 'Backspace', run: deletePair }])),
]

// ── Plusieurs curseurs (option) ─────────────────────────────────────────────

/** Selectionne l'occurrence suivante du mot ou de la selection (Ctrl+D). */
export function selectNextOccurrence(view: EditorView): boolean {
  const { state } = view
  const main = state.selection.main
  if (main.empty) {
    const word = state.wordAt(main.head)
    if (!word) return false
    view.dispatch({ selection: EditorSelection.create(state.selection.ranges.map(r => r === main ? EditorSelection.range(word.from, word.to) : r), state.selection.mainIndex) })
    return true
  }
  const needle = state.sliceDoc(main.from, main.to)
  const text = state.doc.toString()
  const taken = (at: number) => state.selection.ranges.some(r => r.from === at)
  let at = text.indexOf(needle, main.to)
  while (at >= 0 && taken(at)) at = text.indexOf(needle, at + 1)
  if (at < 0) {
    at = text.indexOf(needle)
    while (at >= 0 && taken(at)) at = text.indexOf(needle, at + 1)
  }
  if (at < 0) return false
  view.dispatch({
    selection: state.selection.addRange(EditorSelection.range(at, at + needle.length)),
    effects: EditorView.scrollIntoView(at),
  })
  return true
}

/** Toutes les occurrences de la selection (Ctrl+Maj+L). */
export function selectAllOccurrences(view: EditorView): boolean {
  const { state } = view
  const main = state.selection.main
  const range = main.empty ? state.wordAt(main.head) : main
  if (!range || range.empty) return false
  const needle = state.sliceDoc(range.from, range.to)
  const text = state.doc.toString()
  const ranges = []
  for (let i = text.indexOf(needle); i >= 0 && ranges.length < 1000; i = text.indexOf(needle, i + needle.length)) {
    ranges.push(EditorSelection.range(i, i + needle.length))
  }
  if (ranges.length === 0) return false
  view.dispatch({ selection: EditorSelection.create(ranges, Math.max(0, ranges.findIndex(r => r.from === range.from))) })
  return true
}

const multiCursorCompartment = new Compartment()

function multiCursorExtension(on: boolean): Extension {
  if (!on) return []
  return [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    // Alt+clic : un curseur de plus. Alt+Maj+glisser : une colonne.
    EditorView.clickAddsSelectionRange.of(e => e.altKey && !e.shiftKey),
    rectangularSelection({ eventFilter: e => e.altKey && e.shiftKey }),
  ]
}

let multiCursorEnabled = false
const multiCursorViews = new Set<EditorView>()

/** Plusieurs curseurs : option de l'editeur, pour tous les editeurs ouverts. */
export function setMultipleCursors(on: boolean): void {
  if (on === multiCursorEnabled) return
  multiCursorEnabled = on
  // Coupee : les curseurs en trop disparaissent, le principal reste.
  for (const view of multiCursorViews) view.dispatch({ effects: multiCursorCompartment.reconfigure(multiCursorExtension(on)), selection: on ? undefined : view.state.selection.asSingle() })
}

export function multipleCursorsEnabled(): boolean {
  return multiCursorEnabled
}

/** A mettre dans chaque editeur : suit l'option. */
export const multipleCursors: Extension = [
  multiCursorCompartment.of([]),
  ViewPlugin.define(view => {
    multiCursorViews.add(view)
    if (multiCursorEnabled) queueMicrotask(() => view.dispatch({ effects: multiCursorCompartment.reconfigure(multiCursorExtension(true)) }))
    return { destroy: () => { multiCursorViews.delete(view) } }
  }),
]

// ── Listes numerotees renumerotees ──────────────────────────────────────────

const ORDERED_RE = /^(\s*)(\d+)([.)])(\s+)/

interface Item { line: number; indent: number; num: number; numFrom: number; numTo: number }

function orderedItem(doc: Text, n: number): Item | null {
  const line = doc.line(n)
  const m = ORDERED_RE.exec(line.text)
  if (!m) return null
  const from = line.from + m[1].length
  return { line: n, indent: m[1].length, num: Number(m[2]), numFrom: from, numTo: from + m[2].length }
}

const indentOf = (text: string): number => text.length - text.trimStart().length

/**
 * Les elements d'une meme liste numerotee autour de la ligne `n` (meme
 * retrait, meme ponctuation), sautant leurs enfants et les lignes vides.
 */
function listRun(doc: Text, n: number): Item[] {
  const at = orderedItem(doc, n)
  if (!at) return []
  const delim = ORDERED_RE.exec(doc.line(n).text)![3]
  const sameLevel = (k: number): Item | null => {
    const it = orderedItem(doc, k)
    return it && it.indent === at.indent && ORDERED_RE.exec(doc.line(k).text)![3] === delim ? it : null
  }
  // Une ligne qui reste dans la liste sans en etre un element : vide, ou plus en retrait.
  const inside = (k: number): boolean => {
    const text = doc.line(k).text
    return !text.trim() || indentOf(text) > at.indent
  }
  let first = n
  for (let k = n - 1; k >= 1; k--) {
    if (sameLevel(k)) first = k
    else if (!inside(k)) break
  }
  const items: Item[] = []
  for (let k = first; k <= doc.lines; k++) {
    const it = sameLevel(k)
    if (it) items.push(it)
    else if (!inside(k)) break
  }
  return items
}

const CODE = new Set(['FencedCode', 'CodeBlock', 'CodeText'])

function inCodeAt(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (CODE.has(n.name)) return true
  }
  return false
}

/** Changements qui renumerotent les listes touchees par `tr`. */
export function renumberChanges(tr: Transaction): ChangeSpec[] {
  const doc = tr.newDoc
  const touched = new Set<number>()
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    const a = doc.lineAt(Math.min(fromB, doc.length)).number
    const b = doc.lineAt(Math.min(toB, doc.length)).number
    for (let k = Math.max(1, a - 1); k <= Math.min(doc.lines, b + 1); k++) touched.add(k)
  })
  const inverse = tr.changes.invert(tr.startState.doc)
  const done = new Set<number>()
  const changes: ChangeSpec[] = []
  for (const k of [...touched].sort((x, y) => x - y)) {
    if (done.has(k) || !orderedItem(doc, k)) continue
    const run = listRun(doc, k)
    for (const it of run) done.add(it.line)
    if (run.length === 0) continue
    // Le numero de depart : celui que la liste avait avant (on efface le 1 : la liste commence toujours a 1).
    const before = inverse.mapPos(doc.line(run[0].line).from, -1)
    if (inCodeAt(tr.startState, Math.min(before, tr.startState.doc.length))) continue
    const oldLine = tr.startState.doc.lineAt(before).number
    const was = orderedItem(tr.startState.doc, oldLine)
    // Un element passe a un autre niveau ouvre une sous-liste : elle part de 1.
    const old = was && was.indent !== run[0].indent ? null : listRun(tr.startState.doc, oldLine)
    const start = old === null ? 1 : old.length ? old[0].num : run[0].num
    run.forEach((it, i) => {
      const want = String(start + i)
      if (String(it.num) !== want) changes.push({ from: it.numFrom, to: it.numTo, insert: want })
    })
  }
  return changes
}

/** Apres une frappe, un collage, une suppression ou un deplacement : les numeros se suivent. */
export const renumberOrderedLists: Extension = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged) return tr
  // Seulement ce que fait la personne ici, pas ce qui vient des autres ni l'annulation.
  const event = tr.annotation(Transaction.userEvent)
  if (!event || event.startsWith('undo') || event.startsWith('redo')) return tr
  const changes = renumberChanges(tr)
  if (changes.length === 0) return tr
  return [tr, { changes, sequential: true } as TransactionSpec]
})


// ── Hierarchie des listes (Tab, Maj+Tab) ────────────────────────────────────

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])(\s+)/

/**
 * L'element de liste au-dessus de la ligne `n` dont le retrait verifie
 * `wanted`, en passant les lignes vides et les suites d'elements (plus en
 * retrait). Null si la liste s'arrete avant.
 */
function itemAbove(doc: Text, n: number, wanted: (indent: number) => boolean): RegExpExecArray | null {
  for (let k = n - 1; k >= 1; k--) {
    const text = doc.line(k).text
    if (!text.trim()) continue
    const m = LIST_ITEM_RE.exec(text)
    if (m && wanted(m[1].length)) return m
    if (!m && indentOf(text) === 0) return null
  }
  return null
}

/** La ligne `n` et ses enfants : les lignes qui suivent, vides ou plus en retrait. */
function itemLines(doc: Text, n: number, indent: number): number[] {
  const lines = [n]
  for (let k = n + 1; k <= doc.lines; k++) {
    const text = doc.line(k).text
    if (text.trim() && indentOf(text) <= indent) break
    lines.push(k)
  }
  while (lines.length > 1 && !doc.line(lines[lines.length - 1]).text.trim()) lines.pop()
  return lines
}

/**
 * Changements pour passer l'element de la ligne `n` au niveau en dessous
 * (`dir` 1, Tab) ou au-dessus (-1, Maj+Tab), avec ses enfants. Le retrait
 * suit le Markdown : un enfant s'aligne sur le texte de l'element parent,
 * soit 2 espaces sous `- ` et 3 sous `1. `. Null si ce n'est pas une liste.
 */
export function listIndentChanges(doc: Text, n: number, dir: 1 | -1): ChangeSpec[] | null {
  const m = LIST_ITEM_RE.exec(doc.line(n).text)
  if (!m) return null
  const indent = m[1].length
  let target: number
  if (dir === 1) {
    // Sous le frere precedent ; le premier element n'a pas de parent ou descendre.
    const sibling = itemAbove(doc, n, i => i <= indent)
    if (!sibling || sibling[1].length !== indent) return []
    target = sibling[0].length
  } else {
    if (indent === 0) return []
    target = itemAbove(doc, n, i => i < indent)?.[1].length ?? 0
  }
  const delta = target - indent
  const changes: ChangeSpec[] = []
  for (const k of itemLines(doc, n, indent)) {
    const line = doc.line(k)
    if (!line.text.trim()) continue
    if (delta > 0) changes.push({ from: line.from, insert: ' '.repeat(delta) })
    else changes.push({ from: line.from, to: line.from + Math.min(-delta, indentOf(line.text)) })
  }
  return changes
}

function moveListItem(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  const changes = listIndentChanges(state.doc, state.doc.lineAt(state.selection.main.head).number, dir)
  if (changes === null) return false
  // Une liste garde la touche, meme sans rien changer : le focus ne part pas.
  if (changes.length) view.dispatch({ changes, userEvent: dir === 1 ? 'input.indent' : 'delete.dedent' })
  return true
}

/** Tab : l'element de liste descend d'un niveau (une liste numerotee repart de 1). */
export const indentListItem = (view: EditorView): boolean => moveListItem(view, 1)
/** Maj+Tab : l'element remonte d'un niveau. */
export const dedentListItem = (view: EditorView): boolean => moveListItem(view, -1)

// ── Entree au debut d'un titre ──────────────────────────────────────────────

/**
 * Entree au debut du texte d'un titre (curseur apres `## `) : une ligne vide
 * s'ouvre au-dessus et le titre reste un titre. Sans cela, `## ` restait seul
 * sur sa ligne et s'effacait : le texte perdait son niveau de titre.
 */
export const enterBeforeHeading: Extension = Prec.highest(keymap.of([{
  key: 'Enter',
  run(view) {
    const { state } = view
    const sel = state.selection.main
    if (!sel.empty || state.readOnly) return false
    const line = state.doc.lineAt(sel.head)
    const mark = /^ {0,3}#{1,6}[ \t]+(?=\S)/.exec(line.text)
    if (!mark || sel.head === line.from || sel.head > line.from + mark[0].length) return false
    view.dispatch({ changes: { from: line.from, insert: '\n' }, scrollIntoView: true, userEvent: 'input' })
    return true
  },
}]))

// ── Touche Debut sur une liste ou une citation ──────────────────────────────

/** Marque de debut de ligne : retrait, `>`, puce ou numero, case a cocher. */
const LINE_MARK_RE = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/

/**
 * Debut, comme dans Obsidian : sur une ligne de liste ou de citation, un
 * premier appui va au debut du texte (apres la puce), le suivant au vrai
 * debut de la ligne. Dans une longue ligne repliee a l'ecran, on va d'abord
 * au debut de la rangee. Ailleurs : le Debut habituel.
 */
function smartHome(view: EditorView, extend: boolean): boolean {
  const { state } = view
  let handled = false
  const ranges = state.selection.ranges.map(r => {
    const line = state.doc.lineAt(r.head)
    const mark = LINE_MARK_RE.exec(line.text)![0]
    // Rien qu'un retrait (ou rien) : le Debut habituel s'en charge.
    if (!mark.trim()) return r
    handled = true
    const textStart = line.from + mark.length
    // Une rangee plus bas dans une ligne repliee : d'abord son debut.
    const row = view.moveToLineBoundary(EditorSelection.cursor(r.head), false, true).head
    const target = row > textStart && row !== r.head ? row : r.head === textStart ? line.from : textStart
    return extend ? EditorSelection.range(r.anchor, target) : EditorSelection.cursor(target)
  })
  if (!handled) return false
  view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: 'select' })
  return true
}

export const listHome: Extension = Prec.high(keymap.of([{
  key: 'Home',
  mac: 'Cmd-ArrowLeft',
  run: view => smartHome(view, false),
  shift: view => smartHome(view, true),
}]))

// ── Triple clic : la ligne ───────────────────────────────────────────────────
//
// Un triple clic selectionne la ligne (celle qui porte un numero), son texte
// seulement : sans la puce, le numero, la case, le `>` ni les # d'un titre,
// et sans le retour a la ligne. Sur une ligne rendue, le navigateur
// selectionnait sinon tout le bloc affiche, et la note rien du tout.

const HEADING_MARK_RE = /^\s*#{1,6}[ \t]+/

/** Ou commence le texte d'une ligne (apres sa marque de titre, de liste ou de citation). */
export function lineTextStart(text: string): number {
  const mark = (HEADING_MARK_RE.exec(text) ?? LINE_MARK_RE.exec(text))?.[0] ?? ''
  return mark.length < text.length ? mark.length : 0
}

export const tripleClickLine: Extension = Prec.highest(EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail !== 3 || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) return false
    const line = view.state.doc.lineAt(pos)
    event.preventDefault()
    view.dispatch({
      selection: EditorSelection.range(line.from + lineTextStart(line.text), line.to),
      userEvent: 'select.pointer',
    })
    view.focus()
    return true
  },
}))
