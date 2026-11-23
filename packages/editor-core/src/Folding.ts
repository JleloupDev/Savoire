// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Replier un bloc de Plume : un titre (tout ce qui le suit jusqu'au titre
// suivant de meme niveau ou plus haut) ou un element de liste (ses lignes
// suivantes, sous-liste comprise). Une fleche dans la gouttiere, ou les
// commandes « Replier / deplier le bloc », « Replier tous les titres »,
// « Tout deplier ».
//
// Le repli de CodeMirror cache le texte derriere un remplacement en ligne,
// qui se marie mal avec les blocs rendus de l'apercu. Ici le rendu
// (LivePreview) cache les lignes repliees d'un seul bloc vide.
//
// Les blocs replies d'une note sont retenus sur l'appareil : l'editeur est
// recree a chaque changement d'onglet ou de mode.
import { EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type ViewUpdate } from '@codemirror/view'
import { EditorSelection, Facet, StateEffect, StateField, type EditorState, type Transaction } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { findColumnsBlocks } from './Columns'
import { frontmatterEnd } from './PropertiesPanel'

type Tree = ReturnType<typeof syntaxTree>
type SyntaxNode = Tree['topNode']

/** Un bloc repliable : sa ligne de tete (`anchor`, debut de ligne) et les lignes qu'il cache. */
export interface Foldable {
  kind: 'heading' | 'list'
  anchor: number
  /** Debut de la premiere ligne cachee. */
  from: number
  /** Fin de la derniere ligne cachee. */
  to: number
}

export interface FoldableIndex {
  list: readonly Foldable[]
  byAnchor: ReadonlyMap<number, Foldable>
}

const HEADING_RE = /^(?:ATX|Setext)Heading(\d)$/

function headingLevel(node: SyntaxNode): number | null {
  const m = HEADING_RE.exec(node.name)
  return m ? Number(m[1]) : null
}

const isList = (node: SyntaxNode): boolean => node.name === 'BulletList' || node.name === 'OrderedList'

/** Les blocs repliables de la note, d'apres l'arbre syntaxique. */
export function computeFoldables(state: EditorState, tree: Tree = syntaxTree(state)): FoldableIndex {
  const doc = state.doc
  const fmEnd = frontmatterEnd(state)
  // Un titre ou une liste dans des colonnes appartient a la colonne.
  const columns = findColumnsBlocks(doc)
  const inColumns = (pos: number) => columns.some(b => pos >= b.from && pos <= b.to)
  const list: Foldable[] = []

  const top: SyntaxNode[] = []
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    if (n.from >= fmEnd && !inColumns(n.from)) top.push(n)
  }

  // Titres : jusqu'au titre suivant de meme niveau ou plus haut.
  top.forEach((node, i) => {
    const level = headingLevel(node)
    if (level === null) return
    let last: SyntaxNode = node
    for (let j = i + 1; j < top.length; j++) {
      const next = headingLevel(top[j])
      if (next !== null && next <= level) break
      last = top[j]
    }
    if (last === node) return
    const headEnd = doc.lineAt(node.to)
    if (headEnd.number >= doc.lines) return
    const from = doc.line(headEnd.number + 1).from
    const to = doc.lineAt(last.to).to
    if (to >= from) list.push({ kind: 'heading', anchor: doc.lineAt(node.from).from, from, to })
  })

  // Elements de liste sur plusieurs lignes (sous-liste, suite du texte).
  const walk = (node: SyntaxNode): void => {
    for (let item = node.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue
      const first = doc.lineAt(item.from)
      let last = doc.lineAt(Math.min(item.to, doc.length))
      while (last.number > first.number && !last.text.trim()) last = doc.line(last.number - 1)
      if (last.number > first.number) {
        list.push({ kind: 'list', anchor: first.from, from: doc.line(first.number + 1).from, to: last.to })
      }
      for (let c = item.firstChild; c; c = c.nextSibling) if (isList(c)) walk(c)
    }
  }
  for (const node of top) if (isList(node)) walk(node)

  list.sort((a, b) => a.anchor - b.anchor)
  return { list, byAnchor: new Map(list.map(f => [f.anchor, f])) }
}

export const foldablesField = StateField.define<FoldableIndex>({
  create: state => computeFoldables(state),
  update(value, tr) {
    return tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? computeFoldables(tr.state) : value
  },
})

// ── Etat : les blocs replies ────────────────────────────────────────────────

/** Ou retenir les blocs replies de cette note (null : nulle part). */
export const foldStorage = Facet.define<string | null, string | null>({
  combine: values => values.find(v => !!v) ?? null,
})

const foldEffect = StateEffect.define<{ anchor: number; fold: boolean }>({
  map: (v, mapping) => ({ ...v, anchor: mapping.mapPos(v.anchor, -1) }),
})
const setFoldsEffect = StateEffect.define<readonly number[]>()

export interface FoldState {
  anchors: readonly number[]
  /** Blocs replies retenus, en attente du texte de la note (il arrive apres, par la synchro). */
  pending: readonly string[] | null
}

const STORAGE_PREFIX = 'plume:folds:'

function loadFolds(key: string): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key)
    const value = raw ? JSON.parse(raw) : null
    return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : null
  } catch {
    return null
  }
}

function saveFolds(key: string, keys: string[]): void {
  try {
    if (keys.length) globalThis.localStorage?.setItem(STORAGE_PREFIX + key, JSON.stringify(keys))
    else globalThis.localStorage?.removeItem(STORAGE_PREFIX + key)
  } catch {
    // Stockage plein ou interdit : le repli reste le temps de la session.
  }
}

/**
 * Un bloc replie, retenu par le texte de sa ligne de tete (et son rang parmi
 * les lignes identiques) : les positions changent d'une visite a l'autre.
 */
function keysOf(state: EditorState, anchors: readonly number[], index: FoldableIndex): string[] {
  const keys: string[] = []
  const seen = new Map<string, number>()
  for (const f of index.list) {
    const text = `${f.kind}|${state.doc.lineAt(f.anchor).text.trim()}`
    const n = seen.get(text) ?? 0
    seen.set(text, n + 1)
    if (anchors.includes(f.anchor)) keys.push(`${n}|${text}`)
  }
  return keys
}

function resolveKeys(state: EditorState, keys: readonly string[]): number[] {
  // Toute la note, pas seulement ce que l'analyse a deja lu.
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  const index = computeFoldables(state, tree)
  const wanted = new Set(keys)
  const seen = new Map<string, number>()
  const anchors: number[] = []
  for (const f of index.list) {
    const text = `${f.kind}|${state.doc.lineAt(f.anchor).text.trim()}`
    const n = seen.get(text) ?? 0
    seen.set(text, n + 1)
    if (wanted.has(`${n}|${text}`)) anchors.push(f.anchor)
  }
  return anchors
}

const sameAnchors = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])

export const foldedField = StateField.define<FoldState>({
  create(state) {
    const key = state.facet(foldStorage)
    const pending = key ? loadFolds(key) : null
    if (pending && state.doc.length > 0) return { anchors: resolveKeys(state, pending), pending: null }
    return { anchors: [], pending }
  },
  update(value, tr) {
    let anchors = tr.docChanged ? value.anchors.map(a => tr.changes.mapPos(a, -1)) : value.anchors
    let pending = value.pending
    let byUser = false
    for (const e of tr.effects) {
      if (e.is(foldEffect)) {
        byUser = true
        const { anchor, fold } = e.value
        anchors = fold ? (anchors.includes(anchor) ? anchors : [...anchors, anchor]) : anchors.filter(a => a !== anchor)
      } else if (e.is(setFoldsEffect)) {
        byUser = true
        anchors = e.value
      }
    }
    // Le texte de la note est arrive : les blocs retenus se replient.
    if (pending && tr.state.doc.length > 0) {
      anchors = [...new Set([...anchors, ...resolveKeys(tr.state, pending)])]
      pending = null
    }
    const index = tr.state.field(foldablesField)
    // Un bloc qui n'est plus repliable (titre efface, contenu vide) s'oublie,
    // sauf plus loin que ce que l'analyse a deja lu.
    if (tr.docChanged && anchors.length) {
      const parsed = syntaxTree(tr.state).length
      anchors = anchors.filter(a => index.byAnchor.has(a) || a >= parsed)
    }
    // Le curseur entre dans un bloc replie (recherche, lien, effacement) : il s'ouvre.
    if (tr.selection && !byUser && anchors.length) {
      const head = tr.state.selection.main.head
      anchors = anchors.filter(a => {
        const f = index.byAnchor.get(a)
        return !f || head < f.from || head > f.to
      })
    }
    if (pending === value.pending && sameAnchors(anchors, value.anchors)) return value
    return { anchors, pending }
  },
})

/**
 * Les lignes cachees, en bout de chaine : un bloc replie dans un autre bloc
 * replie ne compte pas.
 */
export function hiddenRanges(state: EditorState): Foldable[] {
  const folded = state.field(foldedField, false)
  if (!folded?.anchors.length) return []
  const index = state.field(foldablesField)
  const ranges = folded.anchors.map(a => index.byAnchor.get(a)).filter((f): f is Foldable => !!f).sort((a, b) => a.from - b.from)
  const out: Foldable[] = []
  for (const f of ranges) {
    const prev = out[out.length - 1]
    if (prev && f.from <= prev.to) continue
    out.push(f)
  }
  return out
}

export function hiddenAt(state: EditorState, pos: number): Foldable | null {
  return hiddenRanges(state).find(f => pos >= f.from && pos <= f.to) ?? null
}

export function isFoldEffect(e: StateEffect<unknown>): boolean {
  return e.is(foldEffect) || e.is(setFoldsEffect)
}

// ── Actions ─────────────────────────────────────────────────────────────────

function isFolded(state: EditorState, anchor: number): boolean {
  return state.field(foldedField, false)?.anchors.includes(anchor) ?? false
}

/** Replie ou deplie le bloc dont la ligne de tete commence a `anchor`. */
export function toggleFold(view: EditorView, anchor: number): boolean {
  const f = view.state.field(foldablesField, false)?.byAnchor.get(anchor)
  if (!f) return false
  const fold = !isFolded(view.state, anchor)
  const head = view.state.selection.main.head
  // Le curseur etait dans ce qui se cache : il remonte au bout de la ligne de tete.
  const selection = fold && head >= f.from && head <= f.to ? EditorSelection.cursor(view.state.doc.lineAt(anchor).to) : undefined
  view.dispatch({ effects: foldEffect.of({ anchor, fold }), selection })
  return true
}

/**
 * Le bloc du curseur : celui dont il est sur la ligne de tete, sinon le plus
 * proche qui le contient (element de liste, puis section du titre).
 */
export function toggleFoldAtCursor(view: EditorView): boolean {
  const { state } = view
  const index = state.field(foldablesField, false)
  if (!index) return false
  const line = state.doc.lineAt(state.selection.main.head)
  const own = index.byAnchor.get(line.from)
  if (own) return toggleFold(view, own.anchor)
  let best: Foldable | null = null
  for (const f of index.list) {
    if (line.from >= f.from && line.from <= f.to && (!best || f.from >= best.from)) best = f
  }
  return best ? toggleFold(view, best.anchor) : false
}

export function foldAllHeadings(view: EditorView): boolean {
  const index = view.state.field(foldablesField, false)
  if (!index) return false
  const anchors = index.list.filter(f => f.kind === 'heading').map(f => f.anchor)
  const head = view.state.selection.main.head
  const around = index.list.filter(f => f.kind === 'heading' && head >= f.from && head <= f.to).sort((a, b) => a.anchor - b.anchor)[0]
  view.dispatch({ effects: setFoldsEffect.of(anchors), selection: around ? EditorSelection.cursor(view.state.doc.lineAt(around.anchor).to) : undefined })
  return true
}

export function unfoldAll(view: EditorView): boolean {
  if (!view.state.field(foldedField, false)) return false
  view.dispatch({ effects: setFoldsEffect.of([]) })
  return true
}

/**
 * Fleches gauche et droite : sauter les lignes cachees plutot que d'y
 * entrer (ce qui deplierait le bloc).
 */
export function skipFold(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  for (const f of hiddenRanges(state)) {
    if (dir === 1 && sel.head === f.from - 1) {
      if (f.to + 1 > state.doc.length) return true
      view.dispatch({ selection: EditorSelection.cursor(f.to + 1), scrollIntoView: true })
      return true
    }
    if (dir === -1 && sel.head === f.to + 1) {
      view.dispatch({ selection: EditorSelection.cursor(f.from - 1), scrollIntoView: true })
      return true
    }
  }
  return false
}

// ── Affichage ───────────────────────────────────────────────────────────────

/** Ce qui remplace les lignes repliees : rien de visible. */
export class FoldedGap extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'plume-folded-gap'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  get estimatedHeight(): number { return 0 }
  ignoreEvent(): boolean { return true }
}

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'

class FoldMarker extends GutterMarker {
  constructor(private readonly folded: boolean, private readonly lineHeight: number | null) { super() }
  eq(other: FoldMarker): boolean { return other.folded === this.folded && other.lineHeight === this.lineHeight }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = this.folded ? 'plume-fold-toggle is-folded' : 'plume-fold-toggle'
    el.title = this.folded ? 'Déplier' : 'Replier'
    el.dataset.testid = 'fold-toggle'
    el.innerHTML = CHEVRON
    // Titre : au milieu de sa ligne. Liste : sur sa premiere ligne.
    el.style.height = this.lineHeight ? `${this.lineHeight}px` : '100%'
    return el
  }
}

class FoldSpacer extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'plume-fold-toggle'
    el.style.visibility = 'hidden'
    el.innerHTML = CHEVRON
    return el
  }
}

function markerAt(view: EditorView, from: number, to: number): FoldMarker | null {
  const f = view.state.field(foldablesField, false)?.byAnchor.get(from)
  if (!f) return null
  const doc = view.state.doc
  // Un bloc rendu d'un tenant (liste avec du code...) ne se replie pas par ligne.
  if (f.kind === 'list' && doc.lineAt(to).number !== doc.lineAt(from).number) return null
  return new FoldMarker(isFolded(view.state, from), f.kind === 'list' ? view.defaultLineHeight : null)
}

const foldGutter = gutter({
  class: 'plume-fold-gutter',
  lineMarker: (view, line) => markerAt(view, line.from, line.to),
  // Un widget pose entre deux lignes (espace avant un titre) n'a pas de chevron : sa ligne l'a.
  widgetMarker: (view, widget, block) => (widget instanceof FoldedGap || block.from === block.to ? null : markerAt(view, block.from, block.to)),
  lineMarkerChange: (u: ViewUpdate) =>
    u.startState.field(foldedField, false) !== u.state.field(foldedField, false)
    || u.startState.field(foldablesField, false) !== u.state.field(foldablesField, false),
  initialSpacer: () => new FoldSpacer(),
  domEventHandlers: {
    mousedown(view, line, event) {
      if ((event as MouseEvent).button !== 0) return false
      if (!toggleFold(view, line.from)) return false
      event.preventDefault()
      return true
    },
  },
})

/** Les blocs replies de la note, retenus sur l'appareil. */
const persistFolds = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly view: EditorView) {}
  update(u: ViewUpdate): void {
    const key = u.state.facet(foldStorage)
    const folded = u.state.field(foldedField)
    if (!key || folded.pending || folded === u.startState.field(foldedField)) return
    const byUser = u.transactions.some((tr: Transaction) => tr.effects.some(isFoldEffect))
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const { state } = this.view
      saveFolds(key, keysOf(state, state.field(foldedField).anchors, state.field(foldablesField)))
    }, byUser ? 0 : 1000)
  }
  destroy(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    const key = this.view.state.facet(foldStorage)
    const { state } = this.view
    if (key && !state.field(foldedField).pending) saveFolds(key, keysOf(state, state.field(foldedField).anchors, state.field(foldablesField)))
  }
})

const foldTheme = EditorView.baseTheme({
  '.plume-fold-gutter .cm-gutterElement': { padding: '0 2px', cursor: 'default' },
  '.plume-fold-toggle': {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '16px',
    color: 'var(--text-faint, #6c7086)', opacity: '0', cursor: 'pointer', transition: 'opacity 120ms',
  },
  '.plume-fold-toggle svg': { transition: 'transform 120ms' },
  '.plume-fold-toggle.is-folded svg': { transform: 'rotate(-90deg)' },
  '&:hover .plume-fold-toggle, .plume-fold-toggle.is-folded': { opacity: '0.7' },
  '.plume-fold-toggle:hover': { opacity: '1 !important', color: 'var(--accent, #7c3aed)' },
  '@media (hover: none)': { '.plume-fold-toggle': { opacity: '0.5' } },
  '.plume-folded-gap': { height: '0', overflow: 'hidden' },
  // Un bloc replie : « … » au bout de sa ligne de tete.
  '.plume-folded h1::after, .plume-folded h2::after, .plume-folded h3::after, .plume-folded h4::after, .plume-folded h5::after, .plume-folded h6::after, .cm-line.plume-folded::after, .plume-folded.vault-line-block::after': {
    content: '"…"', display: 'inline-block', marginLeft: '0.5em', padding: '0 0.4em', borderRadius: '4px',
    fontSize: '0.75em', fontWeight: 'normal', lineHeight: '1.4', verticalAlign: 'middle',
    background: 'var(--bg-elevated, rgba(127,127,127,0.15))', color: 'var(--text-faint, #6c7086)',
  },
})

/** Repli des titres et des listes (gouttiere, etat, memoire de la note). */
export function foldingExtension() {
  return [foldablesField, foldedField, foldGutter, persistFolds, foldTheme]
}
