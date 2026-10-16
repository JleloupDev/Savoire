// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un plan, a la Workflowy : un editeur CodeMirror 6 propre au plugin,
// habille pour ne pas ressembler a un editeur de code.
//
//  - les puces « - » deviennent des points (avec un halo quand l'element est
//    plie) ; une petite fleche de pliage apparait au survol, a gauche ;
//  - entrer dans un element (clic sur la puce) est l'action centrale :
//    l'element devient le titre de la page, ses enfants la liste en dessous,
//    et un fil d'Ariane permet de remonter (Echap aussi) ;
//  - les lignes sans puce sous un element sont ses notes (plus petites) ;
//  - pliage et zoom ne changent que la vue : rien n'est ecrit dans le fichier.
//
// La vue ne gere aucune touche elle-meme : toutes les actions sont des
// commandes du moteur de raccourcis (outlineActions, enregistrees par
// index.ts), qui agissent sur le plan qui a le focus.
//
// Comportements inspires d'obsidian-outliner, de Viacheslav Slinko (MIT).
import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import type { ISharedText } from '@savoire/plugin-api'
import { remoteChange, sharedTextBinding } from './binding'
import {
  addNote,
  ancestors,
  backspaceItem,
  dedentItem,
  diffToChanges,
  enterItem,
  enterNote,
  indentItem,
  itemLabel,
  itemOnLine,
  itemOwning,
  moveItem,
  parseOutline,
  selectItem,
  toggleChecked,
  type Outline,
  type OutlineEdit,
  type OutlineItem,
} from './outline'

// ── Etat de la vue : arbre, pliage, zoom ────────────────────────────────────

const outlineField = StateField.define<Outline>({
  create: state => parseOutline(state.doc.toString()),
  update: (o, tr) => (tr.docChanged ? parseOutline(tr.newDoc.toString()) : o),
})

/** Plie (true), deplie (false) ou bascule (null) l'element qui commence a `pos`. */
const foldEffect = StateEffect.define<{ pos: number; fold: boolean | null }>()

/** Debuts de ligne des elements plies. Local a la vue. */
const foldField = StateField.define<readonly number[]>({
  create: () => [],
  update(folds, tr) {
    let out = tr.docChanged ? folds.map(p => tr.changes.mapPos(p, 1)) : folds
    for (const e of tr.effects) {
      if (!e.is(foldEffect)) continue
      const has = out.includes(e.value.pos)
      const want = e.value.fold ?? !has
      if (want && !has) out = [...out, e.value.pos]
      else if (!want && has) out = out.filter(p => p !== e.value.pos)
    }
    return out === folds ? folds : [...new Set(out)]
  },
})

/** Zoom sur l'element qui commence a cette position (null : tout le plan). */
const zoomEffect = StateEffect.define<number | null>()

const zoomField = StateField.define<number | null>({
  create: () => null,
  update(zoom, tr) {
    let out = zoom !== null && tr.docChanged ? tr.changes.mapPos(zoom, 1) : zoom
    for (const e of tr.effects) if (e.is(zoomEffect)) out = e.value
    return out
  },
})

interface Layout {
  outline: Outline
  hidden: boolean[]
  folded: Set<number>
  zoom: OutlineItem | null
  decorations: DecorationSet
}

// Dimensions (px) : marge gauche (place de la fleche), largeur d'un niveau,
// place de la puce, place d'une case.
const BASE = 24
const LEVEL = 26
const BULLET = 24
const CHECKBOX = 22

const layoutCache = new WeakMap<Outline, { folds: readonly number[]; zoom: number | null; layout: Layout }>()

function layoutOf(state: EditorState): Layout {
  const outline = state.field(outlineField)
  const folds = state.field(foldField)
  const zoomPos = state.field(zoomField)
  const cached = layoutCache.get(outline)
  if (cached && cached.folds === folds && cached.zoom === zoomPos) return cached.layout
  const layout = buildLayout(outline, folds, zoomPos)
  layoutCache.set(outline, { folds, zoom: zoomPos, layout })
  return layout
}

function buildLayout(o: Outline, folds: readonly number[], zoomPos: number | null): Layout {
  const zoom = zoomPos !== null && zoomPos <= o.text.length ? itemOwning(o, zoomPos) : null
  const folded = new Set<number>()
  for (const p of folds) {
    if (p > o.text.length) continue
    const it = itemOnLine(o, p)
    if (it && it.children.length && it !== zoom) folded.add(it.index)
  }
  const hidden = o.lines.map(() => false)
  if (zoom) {
    for (let i = 0; i < hidden.length; i++) if (i < zoom.line || i > zoom.endLine) hidden[i] = true
  }
  for (const idx of folded) {
    const it = o.items[idx]
    for (let i = it.line + 1; i <= it.endLine; i++) hidden[i] = true
  }

  const decos: Range<Decoration>[] = []
  // Les enfants de l'element zoome passent au premier niveau.
  const base = zoom ? zoom.depth + 1 : 0
  for (let i = 0; i < o.lines.length; i++) {
    const line = o.lines[i]
    if (hidden[i]) {
      let j = i
      while (j + 1 < o.lines.length && hidden[j + 1]) j++
      decos.push(Decoration.replace({ block: true }).range(line.from, o.lines[j].to))
      i = j
      continue
    }
    const idx = o.itemAtLine[i]
    if (idx >= 0) {
      const it = o.items[idx]
      if (it === zoom) {
        // L'element zoome est le titre de la page : ni puce ni retrait.
        decos.push(Decoration.line({ class: 'cm-outline-title' }).range(line.from))
        decos.push(Decoration.replace({}).range(line.from, it.contentFrom))
        continue
      }
      const width = BULLET + (it.checked !== null ? CHECKBOX : 0)
      decos.push(Decoration.line({
        class: 'cm-outline-item' + (it.checked ? ' cm-outline-checked' : ''),
        attributes: { style: lineStyle(it.depth - base, width) },
      }).range(line.from))
      decos.push(Decoration.replace({
        widget: new PrefixWidget(it.children.length > 0, folded.has(idx), it.checked),
      }).range(line.from, it.contentFrom))
      continue
    }
    const owner = o.owner[i]
    if (owner < 0) continue
    // Note d'un element : sans puce, alignee sur son texte, plus discrete.
    const it = o.items[owner]
    const isTitle = it === zoom
    const width = isTitle ? 0 : BULLET + (it.checked !== null ? CHECKBOX : 0)
    decos.push(Decoration.line({
      class: isTitle ? 'cm-outline-note cm-outline-title-note' : 'cm-outline-note',
      attributes: { style: isTitle ? `padding-left:${BASE}px` : lineStyle(it.depth - base, width, true) },
    }).range(line.from))
    const ws = /^[ \t]*/.exec(line.text)![0].length
    if (ws > 0) decos.push(Decoration.replace({}).range(line.from, line.from + ws))
  }
  return { outline: o, hidden, folded, zoom, decorations: Decoration.set(decos, true) }
}

/** Retrait du texte et lignes guides (une par ancetre), en style de ligne. */
function lineStyle(depth: number, width: number, note = false): string {
  const left = BASE + depth * LEVEL + width
  const guides: string[] = []
  const pos: string[] = []
  for (let k = 0; k < depth; k++) {
    guides.push('linear-gradient(var(--outline-guide),var(--outline-guide))')
    pos.push(`${BASE + k * LEVEL + BULLET / 2}px 0`)
  }
  return `padding-left:${left}px;text-indent:${note ? 0 : -width}px;`
    + (guides.length
      ? `background-image:${guides.join(',')};background-position:${pos.join(',')};`
        + 'background-size:1px 100%;background-repeat:no-repeat;'
      : '')
}

class PrefixWidget extends WidgetType {
  constructor(
    readonly hasChildren: boolean,
    readonly folded: boolean,
    readonly checked: boolean | null,
  ) {
    super()
  }

  eq(other: PrefixWidget): boolean {
    return other.hasChildren === this.hasChildren && other.folded === this.folded && other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-outline-prefix'
    const at = () => view.posAtDOM(wrap)
    if (this.hasChildren) {
      const arrow = document.createElement('span')
      arrow.className = 'cm-outline-arrow' + (this.folded ? ' cm-outline-arrow-folded' : '')
      arrow.dataset.testid = 'outline-chevron'
      arrow.title = this.folded ? 'Déplier' : 'Plier'
      arrow.addEventListener('mousedown', e => {
        e.preventDefault()
        toggleFoldAt(view, at(), null)
      })
      wrap.appendChild(arrow)
    }
    const bullet = document.createElement('span')
    bullet.className = 'cm-outline-bullet' + (this.folded ? ' cm-outline-bullet-folded' : '')
    bullet.dataset.testid = 'outline-bullet'
    bullet.title = 'Entrer dans cet élément'
    bullet.addEventListener('mousedown', e => {
      e.preventDefault()
      zoomTo(view, at())
      view.focus()
    })
    wrap.appendChild(bullet)
    if (this.checked !== null) {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'cm-outline-checkbox'
      box.checked = this.checked
      box.addEventListener('mousedown', e => {
        e.preventDefault()
        if (view.state.readOnly) return
        const edit = toggleChecked(view.state.doc.toString(), at())
        if (edit) applyEdit(view, edit, false)
      })
      wrap.appendChild(box)
    }
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ── Actions sur une vue ─────────────────────────────────────────────────────

/** Applique le resultat d'une operation en changements minimaux. */
function applyEdit(view: EditorView, edit: OutlineEdit, select = true): void {
  view.dispatch({
    changes: diffToChanges(view.state.doc.toString(), edit.text),
    ...(select ? { selection: EditorSelection.single(edit.anchor, edit.head) } : {}),
    userEvent: 'input',
    scrollIntoView: true,
  })
}

function toggleFoldAt(view: EditorView, pos: number, fold: boolean | null): boolean {
  const { outline, folded, zoom } = layoutOf(view.state)
  const it = itemOnLine(outline, pos)
  if (!it || !it.children.length || it === zoom) return false
  const willFold = fold ?? !folded.has(it.index)
  const head = view.state.selection.main.head
  // Le curseur ne reste pas dans des lignes masquees.
  const inside = head > it.to && head <= it.end
  view.dispatch({
    effects: foldEffect.of({ pos: it.from, fold }),
    ...(willFold && inside ? { selection: { anchor: it.to } } : {}),
  })
  return true
}

function zoomTo(view: EditorView, pos: number | null): void {
  const { outline, zoom } = layoutOf(view.state)
  if (pos === null) {
    const back = zoom ? zoom.to : view.state.selection.main.head
    view.dispatch({ effects: zoomEffect.of(null), selection: { anchor: back }, scrollIntoView: true })
    return
  }
  const it = itemOwning(outline, pos)
  if (!it) return
  const head = view.state.selection.main.head
  const inside = head >= it.contentFrom && head <= it.end
  // On entre dans l'element : il est deplie, le curseur au bout du titre
  // (ou la ou il etait, s'il y etait deja).
  view.dispatch({
    effects: [zoomEffect.of(it.from), foldEffect.of({ pos: it.from, fold: false })],
    selection: { anchor: inside ? head : it.to },
    scrollIntoView: true,
  })
}

/** Portee courante : le sous-arbre zoome, ou tout le document. */
function scopeOf(state: EditorState): { from: number; to: number } {
  const { zoom } = layoutOf(state)
  return zoom ? { from: zoom.contentFrom, to: zoom.end } : { from: 0, to: state.doc.length }
}

/** Element du curseur (celui de sa ligne, ou celui dont c'est une note). */
function current(state: EditorState): OutlineItem | null {
  return itemOwning(layoutOf(state).outline, state.selection.main.head)
}

/**
 * L'element du curseur peut-il changer de place ? Pas la racine du zoom
 * (il sortirait de la vue), ni, pour un desindentage, un de ses enfants
 * directs.
 */
function movable(state: EditorState, dedent = false): boolean {
  const { zoom } = layoutOf(state)
  if (!zoom) return true
  const it = current(state)
  if (!it || it.index === zoom.index) return false
  return !(dedent && it.parent === zoom.index)
}

function runOp(view: EditorView, op: (text: string, pos: number) => OutlineEdit | null): void {
  const edit = op(view.state.doc.toString(), view.state.selection.main.head)
  if (edit) applyEdit(view, edit)
}

const editable = (v: EditorView) => !v.state.readOnly
const inItem = (v: EditorView) => current(v.state) !== null

function onEnter(view: EditorView): void {
  const sel = view.state.selection.main
  const doc = view.state.doc.toString()
  const { outline, folded, zoom } = layoutOf(view.state)
  const owner = itemOwning(outline, sel.from)
  if (!owner) return
  const isFolded = (line: number) => {
    const idx = outline.itemAtLine[line]
    return sel.empty && idx >= 0 && folded.has(idx)
  }
  // Sur le titre (racine du zoom), tout nouvel element en est un enfant.
  const onTitle = owner === zoom
  const it = itemOnLine(outline, sel.from)
  if (!it) {
    // Dans une note : on en sort, un nouvel element suit.
    const edit = enterNote(doc, sel.from, { isFolded, forceChild: () => onTitle })
    if (edit) applyEdit(view, edit)
    return
  }
  // Element vide enfant direct de la racine du zoom : il en sortirait.
  if (zoom && it.parent === zoom.index && doc.slice(it.contentFrom, it.to).trim() === '') return
  if (onTitle && sel.from <= it.contentFrom) return
  const base = doc.slice(0, sel.from) + doc.slice(sel.to)
  const edit = enterItem(base, sel.from, { isFolded, forceChild: () => onTitle })
  if (edit) applyEdit(view, edit)
}

/** Curseur (sans selection) au tout debut du texte d'un element. */
function atItemStart(state: EditorState): boolean {
  const sel = state.selection.main
  if (!sel.empty) return false
  const it = itemOnLine(layoutOf(state).outline, sel.head)
  return !!it && sel.head === it.contentFrom
}

function onBackspace(view: EditorView): void {
  const { hidden } = layoutOf(view.state)
  const edit = backspaceItem(view.state.doc.toString(), view.state.selection.main.head, {
    isHidden: line => hidden[line],
  })
  if (edit) applyEdit(view, edit)
}

function moveWithFold(view: EditorView, dir: 'up' | 'down'): void {
  if (!movable(view.state)) return
  const { folded } = layoutOf(view.state)
  const it = current(view.state)
  const edit = moveItem(view.state.doc.toString(), view.state.selection.main.head, dir)
  if (!it || !edit) return
  const wasFolded = folded.has(it.index)
  applyEdit(view, edit)
  // Le deplacement remplace un bloc de texte : on reporte le pliage.
  if (wasFolded) {
    const moved = current(view.state)
    if (moved) view.dispatch({ effects: foldEffect.of({ pos: moved.from, fold: true }) })
  }
}

/** Une action : quand elle s'applique, et ce qu'elle fait. */
export interface OutlineAction {
  /** Faux : la touche suit son cours normal (frappe, deplacement du curseur). */
  available(view: EditorView): boolean
  run(view: EditorView): void
}

export type OutlineActionName =
  | 'enter' | 'backspace' | 'indent' | 'dedent' | 'addNote'
  | 'moveUp' | 'moveDown' | 'fold' | 'unfold' | 'toggleFold'
  | 'zoomIn' | 'zoomOut' | 'selectItem'

const hasChildren = (v: EditorView) => {
  const it = current(v.state)
  return !!it && it.children.length > 0 && it !== layoutOf(v.state).zoom
}

export const outlineActions: Record<OutlineActionName, OutlineAction> = {
  enter: {
    available: v => editable(v) && inItem(v),
    run: onEnter,
  },
  backspace: {
    // Seulement au debut d'un element : ailleurs, c'est de la frappe.
    available: v => editable(v) && atItemStart(v.state),
    run: onBackspace,
  },
  // Tab garde la main dans un element, meme quand il ne peut pas bouger :
  // sinon le focus quitterait l'editeur.
  indent: {
    available: v => editable(v) && inItem(v),
    run: v => { if (movable(v.state)) runOp(v, indentItem) },
  },
  dedent: {
    available: v => editable(v) && inItem(v),
    run: v => { if (movable(v.state, true)) runOp(v, dedentItem) },
  },
  addNote: {
    available: v => editable(v) && inItem(v),
    run: v => runOp(v, addNote),
  },
  moveUp: { available: v => editable(v) && inItem(v), run: v => moveWithFold(v, 'up') },
  moveDown: { available: v => editable(v) && inItem(v), run: v => moveWithFold(v, 'down') },
  fold: { available: hasChildren, run: v => { toggleFoldAt(v, current(v.state)!.from, true) } },
  unfold: { available: hasChildren, run: v => { toggleFoldAt(v, current(v.state)!.from, false) } },
  toggleFold: { available: hasChildren, run: v => { toggleFoldAt(v, current(v.state)!.from, null) } },
  zoomIn: {
    available: v => inItem(v) && current(v.state) !== layoutOf(v.state).zoom,
    run: v => zoomTo(v, v.state.selection.main.head),
  },
  zoomOut: {
    available: v => layoutOf(v.state).zoom !== null,
    run: v => {
      const { outline, zoom } = layoutOf(v.state)
      if (!zoom) return
      const parent = zoom.parent >= 0 ? outline.items[zoom.parent] : null
      zoomTo(v, parent ? parent.from : null)
      // On remonte avec le curseur sur l'element qu'on quitte.
      v.dispatch({ selection: { anchor: zoom.to } })
    },
  },
  selectItem: {
    available: () => true,
    run: v => {
      const sel = v.state.selection.main
      const next = selectItem(v.state.doc.toString(), sel.anchor, sel.head, scopeOf(v.state))
      v.dispatch({ selection: EditorSelection.single(next.anchor, next.head) })
    },
  },
}

// Le curseur ne s'arrete pas dans la puce masquee : il va au debut du texte,
// ou a la fin de la ligne visible precedente quand on recule.
const PREFIX_RE = /^[ \t]*[-*+](?: (?:\[[ xX]\](?: |$))?|$)/

const clampSelection = EditorState.transactionFilter.of(tr => {
  if (!tr.selection || tr.annotation(remoteChange)) return tr
  const sel = tr.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return tr
  const head = sel.main.head
  const line = tr.newDoc.lineAt(head)
  const m = PREFIX_RE.exec(line.text)
  if (!m) return tr
  const contentFrom = line.from + m[0].length
  if (head >= contentFrom) return tr
  let target = contentFrom
  const prev = tr.startState.selection.main
  if (!tr.docChanged && prev.empty && prev.head === contentFrom && head < prev.head) {
    const { hidden } = layoutOf(tr.startState)
    let n = line.number - 1
    while (n >= 1 && hidden[n - 1]) n--
    if (n >= 1) target = tr.newDoc.line(n).to
  }
  return [tr, { selection: EditorSelection.cursor(target), sequential: true }]
})

// Markdown inline lisible : les marques (**, _, `, ~~) sont masquees hors
// de la ligne du curseur, comme dans Plume ; le texte garde son style.
const MARKS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark'])

function markDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = []
  const { doc, selection } = view.state
  const active = new Set(selection.ranges.map(r => doc.lineAt(r.head).number))
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: node => {
        if (!MARKS.has(node.name) || node.from === node.to) return
        if (active.has(doc.lineAt(node.from).number)) return
        decos.push(Decoration.replace({}).range(node.from, node.to))
      },
    })
  }
  return Decoration.set(decos, true)
}

const hideMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = markDecorations(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = markDecorations(u.view)
    }
  }
}, { decorations: v => v.decorations })

// Taper sur une ligne vide cree un element : un plan vide (ou une ligne
// vide entre deux elements) n'oblige pas a ecrire « - » a la main.
const typeOnEmptyLine = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.includes('\n') || view.state.readOnly) return false
  const line = view.state.doc.lineAt(from)
  if (line.length !== 0) return false
  view.dispatch({
    changes: { from, insert: '- ' + text },
    selection: { anchor: from + 2 + text.length },
    userEvent: 'input.type',
  })
  return true
})

// Les regles globales de l'app visent .cm-content avec !important (police
// de Plume) : il faut le meme poids pour garder la police de l'interface.
const outlineTheme = EditorView.theme({
  '&': { height: '100%', '--outline-guide': 'var(--border, #e2e8f0)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-ui, sans-serif)' },
  '& .cm-content': {
    fontFamily: 'var(--font-ui, sans-serif) !important',
    fontSize: '15px',
    maxWidth: '760px !important',
    padding: '0 24px 40vh !important',
    caretColor: 'var(--text, #0f172a)',
  },
  '& .cm-line.cm-outline-item': { lineHeight: '1.6', padding: '3px 8px 3px 0' },
  '& .cm-line.cm-outline-note': {
    color: 'var(--text-muted, #64748b)', fontSize: '0.86em', lineHeight: '1.5', padding: '0 8px 2px 0',
  },
  '& .cm-line.cm-outline-title': {
    fontSize: '1.75em', fontWeight: '700', lineHeight: '1.3',
    padding: `6px 8px 10px ${BASE}px`, color: 'var(--text, #0f172a)',
  },
  '& .cm-line.cm-outline-title-note': { fontSize: '0.95em', paddingBottom: '10px' },
  '.cm-outline-checked': { color: 'var(--text-faint, #94a3b8)', textDecoration: 'line-through' },
  '.cm-outline-prefix': {
    display: 'inline-flex', alignItems: 'center', position: 'relative',
    textIndent: '0', verticalAlign: 'top', height: '1.6em',
  },
  '.cm-outline-bullet': {
    display: 'inline-block', width: `${BULLET}px`, height: '1.6em', cursor: 'pointer', position: 'relative',
  },
  // Le point, et son halo : visible quand l'element plie cache des enfants,
  // et au survol (on peut entrer dans l'element).
  '.cm-outline-bullet::before': {
    content: '""', position: 'absolute', left: '50%', top: '50%', width: '18px', height: '18px',
    margin: '-9px 0 0 -9px', borderRadius: '50%', background: 'transparent', transition: 'background .12s',
  },
  '.cm-outline-bullet::after': {
    content: '""', position: 'absolute', left: '50%', top: '50%', width: '6px', height: '6px',
    margin: '-3px 0 0 -3px', borderRadius: '50%', background: 'var(--text, #334155)', opacity: '0.75',
  },
  '.cm-outline-bullet-folded::before': { background: 'var(--bg-hover, #e2e8f0)' },
  '.cm-outline-bullet:hover::before': { background: 'var(--border, #cbd5e1)' },
  '.cm-outline-arrow': {
    position: 'absolute', left: '-20px', top: '50%', width: '16px', height: '16px', marginTop: '-8px',
    cursor: 'pointer', opacity: '0', transition: 'opacity .12s, transform .12s',
  },
  '.cm-outline-arrow::after': {
    content: '""', position: 'absolute', left: '5px', top: '4px',
    borderStyle: 'solid', borderWidth: '4px 0 4px 6px',
    borderColor: 'transparent transparent transparent var(--text-muted, #64748b)',
    transform: 'rotate(90deg)', transition: 'transform .12s',
  },
  '.cm-outline-arrow-folded::after': { transform: 'none' },
  '.cm-line:hover .cm-outline-arrow': { opacity: '1' },
  '.cm-outline-checkbox': { margin: '0 8px 0 0', cursor: 'pointer', width: '14px' },
})

// ── Editeur ─────────────────────────────────────────────────────────────────

export interface OutlineEditorOptions {
  parent: HTMLElement
  /** Texte partage du document. Sans lui, la vue reste en lecture seule. */
  text?: ISharedText
  initial?: string
  readOnly?: boolean
  /** Nom de la page (le fichier) : premier maillon du fil d'Ariane. */
  title?: string
  /**
   * Toute touche pressee passe d'abord ici (moteur de raccourcis). Vrai =
   * prise par une commande ; sinon elle suit son cours normal.
   */
  onKeyDown?(event: KeyboardEvent, editor: OutlineEditor): boolean
  /** Le texte a change (local ou distant). */
  onChange?(doc: string): void
  /** Le zoom a change : libelle de l'element zoome, ou null. */
  onZoomChange?(label: string | null): void
}

/** Editeur de plan qui a le focus : la cible des commandes. */
let focused: OutlineEditor | null = null

export function focusedOutline(): OutlineEditor | null {
  return focused && focused.view.hasFocus ? focused : null
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export class OutlineEditor {
  readonly view: EditorView
  readonly dom: HTMLElement
  private readonly readOnlyConf = new Compartment()
  private readonly header: HTMLElement
  private readonly detach: () => void
  private lastHeader = ''

  constructor(private readonly opts: OutlineEditorOptions) {
    this.dom = document.createElement('div')
    this.dom.className = 'savoire-outline'
    this.dom.dataset.testid = 'outline-view'
    this.dom.style.cssText = 'height:100%;display:flex;flex-direction:column;background:var(--bg-base,#f8fafc);color:var(--text,#0f172a);font-family:var(--font-ui,sans-serif)'
    this.header = document.createElement('div')
    this.header.dataset.testid = 'outline-header'
    this.header.style.cssText = 'width:100%;max-width:760px;margin:0 auto;padding:28px 24px 6px;box-sizing:border-box'
    const host = document.createElement('div')
    host.style.cssText = 'flex:1;min-height:0'
    this.dom.append(this.header, host)
    opts.parent.appendChild(this.dom)

    const binding = opts.text ? sharedTextBinding(opts.text) : null
    const readOnly = !!opts.readOnly || !opts.text
    const extensions: Extension[] = [
      // Toutes les touches passent par le moteur de raccourcis d'abord.
      Prec.highest(EditorView.domEventHandlers({
        keydown: event => opts.onKeyDown?.(event, this) ?? false,
        focus: () => { focused = this },
        blur: () => { if (focused === this) focused = null },
      })),
      // Edition de base (curseur, frappe, annuler) : pas d'action de plan ici.
      keymap.of([...defaultKeymap, ...historyKeymap]),
      history(),
      outlineField,
      foldField,
      zoomField,
      EditorView.decorations.compute([outlineField, foldField, zoomField], s => layoutOf(s).decorations),
      EditorView.atomicRanges.of(v => layoutOf(v.state).decorations),
      clampSelection,
      typeOnEmptyLine,
      hideMarks,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      outlineTheme,
      this.readOnlyConf.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of(update => {
        if (update.docChanged) opts.onChange?.(update.state.doc.toString())
        const zoomChanged = update.startState.field(zoomField) !== update.state.field(zoomField)
        if (update.docChanged || zoomChanged) this.renderHeader()
        if (zoomChanged) this.animateZoom()
      }),
      ...(binding ? [binding.extension] : []),
    ]
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: opts.text?.toString() ?? opts.initial ?? '', extensions }),
    })
    this.detach = binding ? binding.attach(this.view) : () => {}
    this.renderHeader()
  }

  /** Lecture seule (verrou, droits). Sans texte partage, la vue y reste. */
  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({
      effects: this.readOnlyConf.reconfigure(EditorState.readOnly.of(readOnly || !this.opts.text)),
    })
  }

  /** Remplace le contenu affiche (vue sans texte partage). */
  setContent(doc: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: doc },
      annotations: remoteChange.of(true),
    })
  }

  /** Element zoome (debut de sa ligne), ou null. */
  get zoom(): number | null {
    return layoutOf(this.view.state).zoom?.from ?? null
  }

  /** Lignes masquees (pliage et zoom), pour les tests. */
  hiddenLines(): number[] {
    return layoutOf(this.view.state).hidden.flatMap((h, i) => (h ? [i] : []))
  }

  zoomTo(pos: number | null): void {
    zoomTo(this.view, pos)
  }

  toggleFold(pos: number, fold: boolean | null = null): boolean {
    return toggleFoldAt(this.view, pos, fold)
  }

  /** Fil d'Ariane (zoome) ou titre de la page (a la racine). */
  private renderHeader(): void {
    const { outline, zoom } = layoutOf(this.view.state)
    const path = zoom ? ancestors(outline, zoom) : []
    const home = this.opts.title || 'Plan'
    const key = (zoom ? `z${zoom.from}:${itemLabel(outline, zoom)}|` : '')
      + path.map(it => `${it.from}:${itemLabel(outline, it)}`).join('|')
    if (key === this.lastHeader && this.header.childElementCount) return
    this.lastHeader = key
    if (!zoom) {
      const h = document.createElement('div')
      h.dataset.testid = 'outline-page-title'
      h.textContent = home
      h.style.cssText = 'font-size:1.75em;font-weight:700;line-height:1.3;padding:6px 0 10px 24px;color:var(--text,#0f172a)'
      this.header.replaceChildren(h)
      this.opts.onZoomChange?.(null)
      return
    }
    const crumbs = document.createElement('nav')
    crumbs.dataset.testid = 'outline-breadcrumbs'
    crumbs.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-left:24px;font-size:13px;color:var(--text-muted,#64748b)'
    const link = (label: string, pos: number | null) => {
      const a = document.createElement('button')
      a.type = 'button'
      a.dataset.testid = 'outline-crumb'
      a.textContent = label || '…'
      a.style.cssText = 'border:none;background:none;padding:2px 0;font:inherit;color:inherit;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      a.addEventListener('mouseenter', () => { a.style.color = 'var(--text,#0f172a)' })
      a.addEventListener('mouseleave', () => { a.style.color = 'inherit' })
      a.addEventListener('click', () => { zoomTo(this.view, pos); this.view.focus() })
      return a
    }
    const sep = () => {
      const s = document.createElement('span')
      s.textContent = '›'
      s.style.opacity = '0.6'
      return s
    }
    const parts: HTMLElement[] = [link(home, null)]
    for (const it of path) parts.push(sep(), link(itemLabel(outline, it), it.from))
    crumbs.replaceChildren(...parts)
    this.header.replaceChildren(crumbs)
    this.opts.onZoomChange?.(itemLabel(outline, zoom))
  }

  /** Transition legere quand on entre dans un element ou qu'on en sort. */
  private animateZoom(): void {
    const el = this.view.contentDOM
    if (reducedMotion() || typeof el.animate !== 'function') return
    el.animate(
      [{ opacity: 0.2, transform: 'translateX(14px)' }, { opacity: 1, transform: 'none' }],
      { duration: 170, easing: 'ease-out' },
    )
  }

  destroy(): void {
    this.detach()
    if (focused === this) focused = null
    this.view.destroy()
    this.dom.remove()
  }
}
