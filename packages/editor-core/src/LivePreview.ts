// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Live preview extension — renders Markdown blocks as HTML widgets in CodeMirror.
// see ADR-005

import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, keymap, gutter, GutterMarker } from '@codemirror/view'
import { StateField, StateEffect, EditorState, EditorSelection, Range, Prec, type Transaction } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
// Type des noeuds de l'arbre syntaxique (@lezer/common n'est pas une
// dependance directe).
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

// see ADR-005
export const setRemoteCursorPositions = StateEffect.define<number[]>()

const remoteCursorPositionsField = StateField.define<number[]>({
  create: () => [],
  update(positions, tr) {
    for (const e of tr.effects) {
      if (e.is(setRemoteCursorPositions)) return e.value
    }
    return positions
  },
})

import { marked } from 'marked'
import { BLOCK_DESTROY_EVENT, BLOCK_ENTER_EVENT, sanitizeHtml } from '@savoire/plugin-api'
import type { BlockRegistry, BlockContext, BlockEditContext, BlockEnterDetail, BlockLine, BlockLineMarker, BlockMenuItem, BlockSpec, HookRegistry } from '@savoire/plugin-api'
import { BLOCK_NODES, COLUMNS_CSS, columnContent, columnsElement, withMarkdown, type FragmentOptions } from './NoteFragment'
import { findColumnsBlocks } from './Columns'
import {
  ObjectWidget, SourceDoneWidget, closeBlockMenu, closeSource, editContext, editableColumns, editableTable,
  isClassicEffect, locateInColumns, tableCellItems, tableGrips, objectEpochField, openSource, showBlockMenu, sourceDecorations, sourceOpenField, type BlockRange,
} from './ClassicMode'
import { blockDragExtension } from './BlockDrag'
import { COLOR_EMOJI_SOURCE, colorOfEmoji, plumeColorTheme } from './PlumeMarkdown'
import { frontmatterEnd, isPropertiesEffect, propertiesDecorations } from './PropertiesPanel'
import { lineColorOf } from './FormattingService'
import { newTableRowBelow, tableAt } from './TableRows'
import { applyTableWidths, tableResizers, withTableWidths, withoutTableWidths } from './TableWidths'
import { highlightedRanges, isHighlightsEffect } from './Highlights'
import { FoldedGap, foldablesField, foldedField, foldingExtension, hiddenAt, hiddenRanges, skipFold } from './Folding'

// Dispatching this effect after plugins load triggers a full decoration rebuild.
export const pluginsLoadedEffect = StateEffect.define<void>()

export { BLOCK_NODES }

/** Rendu en direct : « power » (la source sous le curseur) ou « classic » (des objets). */
export type PreviewMode = 'power' | 'classic'

/** Ligne faite d'une seule integration `![[...]]`. */
const EMBED_LINE_RE = /^\s*!\[\[[^\]]+\]\]\s*$/

// see ADR-005
const HEADING_LINE_CLASSES: Partial<Record<string, string>> = {
  'ATXHeading1': 'vault-h1-live',
  'ATXHeading2': 'vault-h2-live',
  'ATXHeading3': 'vault-h3-live',
  'ATXHeading4': 'vault-h4-live',
  'ATXHeading5': 'vault-h5-live',
  'ATXHeading6': 'vault-h6-live',
}

// ─── Frontmatter hiding ───────────────────────────────────────────────────
// see ADR-005

class FrontmatterBadge extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.textContent = '···'
    span.style.cssText = [
      'display:inline-block',
      'font-size:10px',
      'color:var(--text-faint,#555)',
      'background:var(--bg-surface,#252535)',
      'border:1px solid var(--border,#3d3d5c)',
      'border-radius:4px',
      'padding:1px 6px',
      'margin:2px 0',
      'cursor:text',
      'user-select:none',
    ].join(';')
    return span
  }
  eq(): boolean { return true }
  ignoreEvent(): boolean { return false }
}

// ── Un clic ne fait pas bouger la note ──────────────────────────────────────
//
// Le curseur qui quitte un bloc (code, tableau, callout, liste...) le fait
// repasser en rendu, et sa hauteur change : tout ce qui est dessous glisse.
// Si cela arrive entre l'appui et le relachement, le clic tombe une ou deux
// lignes plus bas, et un glisser selectionne autre chose que ce qu'on vise.
// Pendant l'appui, les endroits en texte brut le restent (« tenus ») ; la
// ligne visee passe en texte brut AVANT que CodeMirror ne calcule la position
// du clic, qui tombe alors sur le caractere vise. Ils se referment un peu
// apres le relachement, une fois passe le temps d'un double clic.

/** Positions tenues en texte brut pendant un clic (null : aucun clic). */
const setPointerHold = StateEffect.define<number[] | null>()

const pointerHoldField = StateField.define<number[] | null>({
  create: () => null,
  update(held, tr) {
    let next = held && tr.docChanged ? held.map(p => tr.changes.mapPos(p)) : held
    for (const e of tr.effects) if (e.is(setPointerHold)) next = e.value
    // Un glisser : les lignes qu'il traverse restent ouvertes jusqu'au bout.
    if (next && tr.selection) {
      const doc = tr.state.doc
      const p = tr.state.selection.main.from
      const line = doc.lineAt(p).number
      if (!next.some(q => doc.lineAt(Math.min(q, doc.length)).number === line)) next = [...next, p]
    }
    return next
  },
})

/** Le temps d'un double clic (celui de CodeMirror) avant de refermer. */
const POINTER_RELEASE_MS = 450

/**
 * Le bloc rendu sous le clic, a ouvrir avant que CodeMirror ne place le
 * curseur. Pas un lien ni un bouton, ni un bloc dont le rendu ne ressemble
 * pas au texte (tableau, code, integration...), ni un objet du mode classique.
 */
function blockToReveal(view: EditorView, target: EventTarget | null): number | null {
  const el = target as Element | null
  const block = el?.closest?.('.vault-rendered-block')
  if (!block || !view.contentDOM.contains(block)) return null
  if (el!.closest('a, input, button, select, textarea, iframe, .plume-object')) return null
  if (block.querySelector('table, pre, iframe, img, .note-embed, .base-q, .board-embed')) return null
  try { return view.posAtDOM(block) } catch { return null }
}

const pointerHold = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pressed = false

  constructor(private readonly view: EditorView) {
    // Ecoute directe : CodeMirror ne transmet pas le survol de ses widgets
    // (ignoreEvent), et il faut passer avant lui.
    view.contentDOM.addEventListener('mousemove', this.move)
  }

  press(event: MouseEvent): void {
    if (event.button !== 0) return
    const { view } = this
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pressed = true
    // Un double clic garde ce que le premier clic tenait deja.
    const held = [...(view.state.field(pointerHoldField, false) ?? []), view.state.selection.main.from]
    this.hold(held, blockToReveal(view, event.target))
    window.addEventListener('mouseup', this.up, true)
    window.addEventListener('dragend', this.up, true)
  }

  /**
   * Un glisser passe sur une ligne rendue : elle s'ouvre avant que
   * CodeMirror ne lise la souris (il ecoute plus haut, sur le document).
   * La selection peut alors s'arreter au milieu de la ligne.
   */
  readonly move = (event: MouseEvent): void => {
    if (!this.pressed || (event.buttons & 1) === 0) return
    const reveal = blockToReveal(this.view, event.target)
    if (reveal !== null) this.hold(this.view.state.field(pointerHoldField, false) ?? [], reveal)
  }

  private hold(held: number[], reveal: number | null): void {
    const { view } = this
    view.dispatch({ effects: setPointerHold.of(reveal === null ? held : [...held, reveal]) })
    // La ligne ouverte a change le DOM : CodeMirror doit le mesurer avant de
    // calculer la position (sinon il se fie a des hauteurs estimees).
    if (reveal !== null) (view as unknown as { measure?: () => void }).measure?.()
  }

  readonly up = (): void => {
    this.pressed = false
    window.removeEventListener('mouseup', this.up, true)
    window.removeEventListener('dragend', this.up, true)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.view.state.field(pointerHoldField, false)) this.view.dispatch({ effects: setPointerHold.of(null) })
    }, POINTER_RELEASE_MS)
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer)
    this.view.contentDOM.removeEventListener('mousemove', this.move)
    window.removeEventListener('mouseup', this.up, true)
    window.removeEventListener('dragend', this.up, true)
  }
}, {
  eventHandlers: {
    mousedown(event) {
      this.press(event)
      return false
    },
  },
})

// Sans panneau de proprietes (editeur seul), le bloc se replie en « ··· ».
function buildFrontmatterDecoration(endPos: number, live: readonly number[]): Range<Decoration> | null {
  if (endPos === 0) return null
  // Reveal when cursor is inside frontmatter block
  if (live.some(p => p <= endPos)) return null
  return Decoration.replace({
    widget: new FrontmatterBadge(),
    block: true,
  }).range(0, endPos)
}

/**
 * Rendu d'un plugin, construit seulement quand l'editeur l'affiche : les
 * decorations sont recalculees a chaque frappe, et un rendu qui suit des
 * donnees en direct ne doit pas etre lance pour rien. Retire de l'editeur,
 * l'element recoit BLOCK_DESTROY_EVENT.
 */
class PluginWidget extends WidgetType {
  constructor(
    private readonly render: () => HTMLElement,
    private readonly contentText: string,
    private readonly fallback: () => HTMLElement,
  ) {
    super()
  }

  eq(other: PluginWidget): boolean {
    return this.contentText === other.contentText
  }

  toDOM(): HTMLElement {
    try {
      return this.render()
    } catch (err) {
      console.debug('[LivePreview] plugin render error:', err)
      return this.fallback()
    }
  }

  destroy(dom: HTMLElement): void {
    dom.dispatchEvent(new CustomEvent(BLOCK_DESTROY_EVENT))
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== 'click' && e.type !== 'mousedown'
  }
}

class MarkdownWidget extends WidgetType {
  constructor(private readonly html: string, private readonly extraClass = '') {
    super()
  }

  eq(other: MarkdownWidget): boolean {
    return this.html === other.html && this.extraClass === other.extraClass
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = this.extraClass ? `vault-rendered-block ${this.extraClass}` : 'vault-rendered-block'
    // Le texte vient d'une note (d'autres membres) : jamais de HTML brut.
    div.innerHTML = sanitizeHtml(this.html)
    return div
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== 'click' && e.type !== 'mousedown'
  }
}

/**
 * Tableau Markdown rendu, avec « + Nouvelle ligne » dessous (comme Notion).
 * Le bouton retrouve le tableau par sa position dans l'editeur au moment du
 * clic : le widget n'a pas a connaitre ses bornes.
 */
class TableWidget extends MarkdownWidget {
  constructor(html: string, private readonly text: string) {
    super(html)
  }

  eq(other: MarkdownWidget): boolean {
    // La largeur des colonnes ne change pas le HTML : le texte compte.
    return other instanceof TableWidget && other.text === this.text && super.eq(other)
  }

  toDOM(view?: EditorView): HTMLElement {
    const div = super.toDOM()
    applyTableWidths(div, this.text)
    if (!view || view.state.readOnly) return div
    div.classList.add('plume-table-box')
    tableResizers(div, percents => {
      let pos: number
      try { pos = view.posAtDOM(div) } catch { return }
      const t = tableAt(view.state, pos)
      if (!t) return
      const src = view.state.sliceDoc(t.from, t.to)
      const next = percents ? withTableWidths(src, percents) : withoutTableWidths(src)
      if (next !== src) view.dispatch({ changes: { from: t.from, to: t.to, insert: next }, userEvent: 'input' })
    })
    // Poignees de ligne et de colonne, sur le tableau tel qu'il est dans la note.
    const posOf = (): number | null => { try { return view.posAtDOM(div) } catch { return null } }
    tableGrips(view, div, editContext(view, { editorView: view }, () => {
      const pos = posOf()
      return pos === null ? null : tableAt(view.state, pos)
    }), () => null)
    return div
  }
}

/** Repli quand le rendu d'un plugin echoue : le Markdown du bloc. */
function markdownElement(text: string, hooks: HookRegistry | undefined, extraClass = ''): HTMLElement {
  try {
    const html = marked.parse(hooks ? hooks.runBeforeParseSync(text) : text, { breaks: true }) as string
    return new MarkdownWidget(html, extraClass).toDOM()
  } catch {
    const pre = document.createElement('pre')
    pre.textContent = text
    return pre
  }
}

/** Une ligne rendue a part (liste, citation). Construite a la demande. */
class LineWidget extends WidgetType {
  constructor(private readonly key: string, private readonly build: () => HTMLElement) {
    super()
  }

  eq(other: LineWidget): boolean {
    return this.key === other.key
  }

  toDOM(): HTMLElement {
    return this.build()
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== 'click' && e.type !== 'mousedown'
  }
}

// ── Listes et citations, ligne par ligne ────────────────────────────────────
//
// Comme dans Obsidian : chaque ligne d'une liste ou d'une citation est rendue
// a part, et seule la ligne du curseur passe en edition. Un plugin peut
// fournir son propre rendu de ligne (BlockSpec.renderLine) ; sinon c'est le
// rendu ci-dessous. Une liste qui contient un vrai bloc (code, tableau...)
// reste rendue d'un seul tenant.

const LINE_BLOCKS = new Set(['BulletList', 'OrderedList', 'Blockquote'])

const NOT_LINE_RENDERABLE = new Set([
  'FencedCode', 'CodeBlock', 'Table', 'HTMLBlock', 'HorizontalRule', 'LinkReference',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
])

function containsAny(node: SyntaxNode, names: Set<string>, extra: string[]): boolean {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (names.has(c.name) || extra.includes(c.name) || containsAny(c, names, extra)) return true
  }
  return false
}

function isLineRenderable(node: SyntaxNode): boolean {
  const extra = node.name === 'Blockquote' ? ['BulletList', 'OrderedList'] : ['Blockquote']
  return !containsAny(node, NOT_LINE_RENDERABLE, extra)
}

const LIST_ITEM_LINE_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(?:\[([ xX])\]\s+)?(.*)$/
const QUOTE_LINE_RE = /^\s*((?:>\s?)+)(.*)$/
const BULLETS = ['•', '◦', '▪']

/** Profondeur d'une ligne de liste : 0 au premier niveau. */
function listDepth(state: EditorState, pos: number): number {
  let depth = 0
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'ListItem') depth++
  }
  return Math.max(0, depth - 1)
}

function inlineHtml(text: string, hooks?: HookRegistry): string {
  const pre = hooks ? hooks.runBeforeParseSync(text) : text
  return sanitizeHtml(marked.parseInline(pre) as string)
}

/** Rendu par defaut d'une ligne de liste ou de citation. */
function renderCoreLine(text: string, depth: number, from: number, hooks?: HookRegistry, ctx?: BlockContext): HTMLElement {
  const quote = QUOTE_LINE_RE.exec(text)
  if (quote) {
    const levels = (quote[1].match(/>/g) ?? []).length
    const root = document.createElement('div')
    root.className = 'vault-rendered-block vault-line-block'
    let inner = root
    for (let i = 0; i < levels; i++) {
      const q = document.createElement('div')
      q.className = 'vault-quote-line'
      inner.appendChild(q)
      inner = q
    }
    inner.innerHTML = inlineHtml(quote[2], hooks) || '&nbsp;'
    return root
  }

  const div = document.createElement('div')
  div.className = 'vault-rendered-block vault-line-block vault-list-line'
  const item = LIST_ITEM_LINE_RE.exec(text)
  if (!item) {
    // Suite d'un element (texte sur plusieurs lignes) : aligne sur son texte.
    div.style.paddingLeft = `${depth * 1.5 + 1.5}em`
    div.innerHTML = inlineHtml(text.trim(), hooks)
    return div
  }
  div.style.paddingLeft = `${depth * 1.5}em`
  const task = item[4]
  if (task !== undefined && task !== ' ') div.classList.add('vault-task-done')
  const content = document.createElement('span')
  content.className = 'vault-list-content'
  content.innerHTML = inlineHtml(item[5], hooks)
  div.append(coreListMarker(item, depth, from, ctx), content)
  return div
}

/** La puce, le numero ou la case a cocher d'une ligne de liste. */
function coreListMarker(item: RegExpExecArray, depth: number, from: number, ctx?: BlockContext): HTMLElement {
  const [, indent, marker, space, task] = item
  const mark = document.createElement('span')
  mark.className = 'vault-list-marker'
  if (task !== undefined) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = task !== ' '
    box.className = 'vault-task-checkbox'
    const at = from + indent.length + marker.length + space.length + 1
    box.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      ctx?.edit?.(at, at + 1, box.checked ? ' ' : 'x')
    })
    mark.appendChild(box)
  } else {
    mark.textContent = /\d/.test(marker) ? marker : BULLETS[depth % BULLETS.length]
  }
  return mark
}

/** Le marqueur de la ligne en edition, pour le rendu par defaut. */
function coreLineMarker(line: BlockLine, ctx?: BlockContext): BlockLineMarker | null {
  const item = LIST_ITEM_LINE_RE.exec(line.text)
  if (!item) return null
  const el = coreListMarker(item, line.depth, line.from, ctx)
  el.classList.add('vault-list-marker-live')
  return { indent: `${line.depth * 1.5}em`, el, width: '1.5em' }
}

// ── Surlignage et couleur sur les lignes en edition ─────────────────────────

const HIGHLIGHT_SPAN_RE = new RegExp(`==(?!=)(${COLOR_EMOJI_SOURCE})?([^\\n]*?[^\\s=]|)==(?!=)`, 'gu')
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText'])

function inCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true
  }
  return false
}

/** Montre surlignage et couleur sur le texte brut, marqueurs compris. */
function rawLineMarks(state: EditorState, fromPos: number, out: Range<Decoration>[]): void {
  for (let n = state.doc.lineAt(fromPos).number; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const text = line.text
    if (!text.includes('==') && !text.includes('`')) continue
    if (inCode(state, line.from + (text.length - text.trimStart().length))) continue
    for (const m of text.matchAll(HIGHLIGHT_SPAN_RE)) {
      const start = line.from + (m.index ?? 0)
      const color = m[1] ? colorOfEmoji(m[1]) : undefined
      out.push(Decoration.mark({ class: color ? `plume-hl plume-hl-${color}` : 'plume-hl' }).range(start, start + m[0].length))
    }
    const c = lineColorOf(text)
    if (c && line.from + c.to < line.to) {
      out.push(Decoration.mark({ class: `plume-color-${c.color}` }).range(line.from + c.to, line.to))
    }
  }
}

// ── Marques du gras, de l'italique... sur les lignes en texte brut ──────────
//
// Sur la ligne du curseur, les ** d'un mot en gras ne se montrent que si le
// curseur est dans ce mot (ou la selection le touche). Ailleurs sur la
// ligne, le gras est rendu sans ses marques. Idem pour l'italique, le barre,
// le code, le surligne et les liens.

/** Une portion mise en forme et ses marques, a cacher si le curseur n'y est pas. */
interface InlineSpan { from: number; to: number; marks: { from: number; to: number }[]; text?: { from: number; to: number; cls: string } }

const MARKED_NODES: Record<string, string> = {
  Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark',
}

function inlineSpans(state: EditorState, from: number, to: number): InlineSpan[] {
  const spans: InlineSpan[] = []
  syntaxTree(state).iterate({
    from, to,
    enter(node) {
      const name = node.type.name
      if (CODE_NODES.has(name) && name !== 'InlineCode') return false
      if (name === 'Image' || name === 'HTMLBlock') return false
      const markName = MARKED_NODES[name]
      if (markName) {
        const marks: { from: number; to: number }[] = []
        for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === markName) marks.push({ from: c.from, to: c.to })
        if (marks.length < 2) return name !== 'InlineCode'
        // Le code garde son allure de code sans ses `.
        const text = name === 'InlineCode' ? { from: marks[0].to, to: marks[marks.length - 1].from, cls: 'plume-md-code' } : undefined
        spans.push({ from: node.from, to: node.to, marks, text })
        return name !== 'InlineCode'
      }
      if (name === 'Link') {
        const kids: { name: string; from: number; to: number }[] = []
        for (let c = node.node.firstChild; c; c = c.nextSibling) kids.push({ name: c.name, from: c.from, to: c.to })
        const marks = kids.filter(k => k.name === 'LinkMark')
        // [texte](adresse) : tout sauf le texte se cache. Pas [texte] seul (reference).
        if (marks.length < 4 || state.sliceDoc(marks[1].from, marks[2].to) !== '](') return undefined
        spans.push({
          from: node.from, to: node.to,
          marks: [{ from: marks[0].from, to: marks[0].to }, { from: marks[1].from, to: node.to }],
          text: { from: marks[0].to, to: marks[1].from, cls: 'plume-md-link' },
        })
      }
      return undefined
    },
  })
  return spans
}

function hideInlineMarks(state: EditorState, fmEnd: number, out: Range<Decoration>[]): void {
  // Les lignes deja rendues (remplacees par un bloc) n'ont rien a cacher.
  const covered = out
    .filter(d => d.from < d.to && (d.value.spec as { block?: boolean }).block)
    .map(d => ({ from: d.from, to: d.to }))
    .sort((a, b) => a.from - b.from)
  const isCovered = (pos: number): boolean => {
    let lo = 0, hi = covered.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const c = covered[mid]
      if (pos < c.from) hi = mid - 1
      else if (pos > c.to) lo = mid + 1
      else return true
    }
    return false
  }
  const ranges = state.selection.ranges
  const touched = (from: number, to: number): boolean => ranges.some(r => r.from <= to && r.to >= from)
  const start = Math.min(fmEnd, state.doc.length)
  let line = state.doc.lineAt(start)
  for (;;) {
    if (line.length > 0 && !isCovered(line.from)) {
      const spans = inlineSpans(state, Math.max(line.from, start), line.to)
      // Le surligne ==...== (avec sa couleur) n'est pas dans l'arbre Markdown.
      if (line.text.includes('==')) {
        for (const m of line.text.matchAll(HIGHLIGHT_SPAN_RE)) {
          const from = line.from + (m.index ?? 0)
          if (inCode(state, from)) continue
          const open = 2 + (m[1]?.length ?? 0)
          spans.push({ from, to: from + m[0].length, marks: [{ from, to: from + open }, { from: from + m[0].length - 2, to: from + m[0].length }] })
        }
      }
      for (const span of spans) {
        if (span.to > line.to || touched(span.from, span.to)) continue
        for (const mark of span.marks) if (mark.to > mark.from) out.push(Decoration.replace({}).range(mark.from, mark.to))
        if (span.text && span.text.to > span.text.from) out.push(Decoration.mark({ class: span.text.cls }).range(span.text.from, span.text.to))
      }
    }
    if (line.number >= state.doc.lines) break
    line = state.doc.line(line.number + 1)
  }
}

/** Ce dont le calcul des decorations a besoin, hors de l'etat. */
interface PreviewEnv {
  registry?: BlockRegistry
  hooks?: HookRegistry
  ctx?: BlockContext
  getActiveScopeIds?: () => Set<string> | null
  mode: PreviewMode
  /** Bornes de l'objet rendu par `dom` (mode classique). */
  rangeOf: (view: EditorView, dom: HTMLElement) => BlockRange | null
}

interface PreviewDecorations {
  decorations: DecorationSet
  /** Objets du mode classique : le curseur les saute d'un bloc. */
  objects: DecorationSet
  /** Marques cachees du mode classique (les # d'un titre) : le curseur ne s'y arrete pas. */
  hidden: DecorationSet
}

const HEADING_LABELS: Record<string, string> = {
  ATXHeading1: 'Titre 1', ATXHeading2: 'Titre 2', ATXHeading3: 'Titre 3',
  ATXHeading4: 'Titre 4', ATXHeading5: 'Titre 5', ATXHeading6: 'Titre 6',
}

/** Titre vide en mode classique : son nom en filigrane. */
class HeadingPlaceholder extends WidgetType {
  constructor(private readonly label: string) { super() }
  eq(other: HeadingPlaceholder): boolean { return other.label === this.label }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'plume-heading-placeholder'
    span.textContent = this.label
    return span
  }
}

function overlaps(a: { from: number; to: number }, from: number, to: number): boolean {
  return a.from <= to && a.to >= from
}

function buildDecorations(state: EditorState, env: PreviewEnv): PreviewDecorations {
  const { registry, hooks, ctx, getActiveScopeIds } = env
  const classic = env.mode === 'classic'
  const decorations: Range<Decoration>[] = []
  const objects: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  // Endroits en texte brut : le curseur, et pendant un clic ce qui est tenu.
  const live = [...state.selection.ranges.map(r => r.from), ...(state.field(pointerHoldField, false) ?? [])]
    .map(p => Math.min(p, state.doc.length))
  const liveLines = new Set(live.map(p => state.doc.lineAt(p).number))
  const liveIn = (from: number, to: number): boolean => live.some(p => p >= from && p <= to)
  // Blocs replies : leur ligne de tete porte « … », leurs lignes sont cachees (en fin de calcul).
  const folds = hiddenRanges(state)
  const foldedAnchors = new Set(folds.map(f => f.anchor))
  const folded = (pos: number): boolean => foldedAnchors.has(state.doc.lineAt(pos).from)
  const remoteCursors = state.field(remoteCursorPositionsField, false) ?? []
  // Passages surlignes par la revision : leurs lignes restent en texte brut.
  const reviewed = highlightedRanges(state)
  const underReview = (from: number, to: number): boolean => reviewed.some(r => r.from <= to && r.to >= from)
  // Mode classique : blocs ouverts par « Modifier la source ».
  const opened = classic ? state.field(sourceOpenField, false) ?? [] : []
  const isOpened = (from: number, to: number): boolean => opened.some(r => overlaps(r, from, to))
  for (const r of opened) if (r.to <= state.doc.length) sourceDecorations(state, r, decorations)
  const epochs = classic ? state.field(objectEpochField, false) ?? [] : []
  const epochAt = (from: number): number => epochs.find(e => e.pos === from)?.n ?? 0

  // Zone du frontmatter : le panneau des proprietes s'il est branche, sinon
  // le badge replie (null si le curseur y est, ou sans frontmatter).
  const fmEnd = frontmatterEnd(state)
  const panelDecos = propertiesDecorations(state, fmEnd)
  const fmDeco = panelDecos ? null : buildFrontmatterDecoration(fmEnd, live)

  const detect = (text: string): { type: string; spec: BlockSpec } | null => {
    if (!registry || !ctx) return null
    const ids = getActiveScopeIds?.() ?? null
    return registry.detectActive ? registry.detectActive(text, ids) : registry.detectBlock(text)
  }
  // Le contexte des plugins, avec le rendu du Markdown (corps d'un callout).
  const pluginCtx = ctx ? withMarkdown(ctx, { registry, hooks, activeIds: getActiveScopeIds?.() ?? null }) : undefined
  const claimedByPlugin = (text: string): boolean => !!detect(text)

  // ── Objets du mode classique ──
  const pushObject = (
    from: number,
    to: number,
    key: string,
    build: (view: EditorView, edit: BlockEditContext) => HTMLElement,
    fallback: () => HTMLElement,
  ): void => {
    const widget = new ObjectWidget(key, epochAt(from), (view) => {
      let root: HTMLElement | null = null
      const edit = editContext(view, pluginCtx ?? { editorView: view }, () => (root ? env.rangeOf(view, root) : null))
      root = build(view, edit)
      return root
    }, fallback)
    const deco = Decoration.replace({ widget, block: true })
    decorations.push(deco.range(from, to))
    objects.push(deco.range(from, to))
  }

  const pluginObject = (from: number, to: number, text: string, spec: BlockSpec): void => {
    pushObject(from, to, `${spec.type}|${text}`, (_view, edit) => {
      const data = spec.deserialize(text)
      return spec.renderEditable && !edit.readOnly ? spec.renderEditable(data, edit) : spec.renderClient(data, pluginCtx!)
    }, () => markdownElement(text, hooks))
  }

  // Les blocs rendus dans une colonne n'ecrivent pas dans la note par leur
  // ligne : elle serait celle du bloc de colonnes.
  // Elles ecrivent dans leur bloc de la colonne (redimensionner une image).
  const innerCtx: BlockContext = {
    get editorView() { return ctx?.editorView ?? null },
    edit: ctx?.edit,
    locate: (el: HTMLElement) => {
      const view = ctx?.editorView as EditorView | null | undefined
      return view instanceof EditorView ? locateInColumns(view, el) : null
    },
  }
  const fragmentOptions = (): FragmentOptions => ({ registry, hooks, activeIds: getActiveScopeIds?.() ?? null, ctx: innerCtx })

  // ── Colonnes ──
  const columnsBlocks = findColumnsBlocks(state.doc).filter(b => b.from >= fmEnd)
  const inColumns = (from: number, to: number): boolean => columnsBlocks.some(b => overlaps(b, from, to))
  for (const block of columnsBlocks) {
    const text = state.doc.sliceString(block.from, block.to)
    if (classic) {
      if (isOpened(block.from, block.to)) continue
      pushObject(block.from, block.to, `columns|${text}`, (view, edit) => editableColumns(view, block, edit, fragmentOptions()),
        () => markdownElement(text, hooks))
      continue
    }
    if (liveIn(block.from, block.to)) continue
    if (remoteCursors.some(p => p >= block.from && p <= block.to)) continue
    if (underReview(block.from, block.to)) continue
    decorations.push(Decoration.replace({
      widget: new LineWidget(`columns|${text}`, () => columnsElement(block, t => columnContent(t, fragmentOptions()))),
      block: true,
    }).range(block.from, block.to))
  }

  const renderParagraphLines = (firstLine: number, lastLine: number): void => {
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (inColumns(line.from, line.to)) continue
      const lineText = state.doc.sliceString(line.from, line.to)
      // Une ligne d'integration seule (une image `![[x.png]]` collee entre
      // deux lignes de texte) garde le rendu de son plugin.
      const own = EMBED_LINE_RE.test(lineText) ? detect(lineText) : null
      // Mode classique : l'image reste une image, meme sous le curseur.
      if (own && classic) {
        if (isOpened(line.from, line.to) || underReview(line.from, line.to)) continue
        pluginObject(line.from, line.to, lineText, own.spec)
        continue
      }
      if (liveLines.has(n)) continue
      if (remoteCursors.some(p => p >= line.from && p <= line.to)) continue
      if (underReview(line.from, line.to)) continue
      if (own) {
        const render = () => own.spec.renderClient(own.spec.deserialize(lineText), pluginCtx!)
        decorations.push(Decoration.replace({ widget: new PluginWidget(render, lineText, () => markdownElement(lineText, hooks, 'vault-paragraph-line')), block: true }).range(line.from, line.to))
        continue
      }
      try {
        const preprocessed = hooks ? hooks.runBeforeParseSync(lineText) : lineText
        const html = marked.parse(preprocessed, { breaks: true }) as string
        decorations.push(
          Decoration.replace({ widget: new MarkdownWidget(html, 'vault-paragraph-line'), block: true }).range(line.from, line.to),
        )
      } catch {
        // Ligne laissee en texte brut si le rendu echoue
      }
    }
  }

  const renderBlockLines = (firstLine: number, lastLine: number, spec?: BlockSpec): void => {
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.trim()) continue
      const text = line.text
      const indent = text.length - text.trimStart().length
      const isQuote = /^\s*>/.test(text)
      const depth = isQuote
        ? Math.max(0, (/^\s*((?:>\s?)+)/.exec(text)![1].match(/>/g) ?? []).length - 1)
        : listDepth(state, line.from + indent)
      if (liveLines.has(n)) {
        if (isQuote) {
          // Citation en edition : les barres a la place des `>`, au meme
          // retrait que le rendu. Les `>` reviennent si le curseur y entre.
          const m = QUOTE_LINE_RE.exec(text)!
          const levels = (m[1].match(/>/g) ?? []).length
          const bodyAt = line.from + text.length - m[2].length
          const inMarker = state.selection.ranges.some(r => [r.anchor, r.head].some(p => p > line.from && p < bodyAt))
          if (!inMarker && bodyAt > line.from) {
            const bars = Array.from({ length: levels }, (_, k) => `linear-gradient(var(--plume-quote-bar), var(--plume-quote-bar)) calc(6px + ${k} * (3px + 1em)) 0 / 3px 100% no-repeat`)
            decorations.push(Decoration.line({
              class: `plume-quote-live${folded(line.from) ? ' plume-folded' : ''}`,
              attributes: { style: `padding-left: calc(6px + ${levels} * (3px + 1em)); background: ${bars.join(', ')}` },
            }).range(line.from))
            decorations.push(Decoration.replace({}).range(line.from, bodyAt))
          }
          continue
        }
        {
          const cls = folded(line.from) ? 'plume-folded' : undefined
          // La puce reste une puce, a sa place : le texte ne bouge pas quand
          // la ligne passe en edition. Le `- ` brut revient si le curseur
          // entre dans le marqueur.
          const item = LIST_ITEM_LINE_RE.exec(text)
          const bodyAt = item ? line.from + text.length - item[5].length : -1
          const inMarker = state.selection.ranges.some(r => [r.anchor, r.head].some(p => p > line.from && p < bodyAt))
          const lineInfo: BlockLine = { text, depth, from: line.from }
          const makeMarker = (): BlockLineMarker | null => {
            try {
              return spec?.renderLine ? spec.renderLineMarker?.(lineInfo, ctx!) ?? null : coreLineMarker(lineInfo, ctx)
            } catch (err) {
              console.debug(`[LivePreview] plugin line marker error (${spec?.type}):`, err)
              return null
            }
          }
          const marker = item && !inMarker && bodyAt > line.from ? makeMarker() : null
          if (marker) {
            // Retrait suspendu : la suite d'une ligne trop longue passe sous le texte.
            const style = marker.width
              ? `padding-left: calc(${marker.indent} + ${marker.width}); text-indent: calc(-1 * ${marker.width})`
              : `padding-left: ${marker.indent}`
            decorations.push(Decoration.line({ class: cls, attributes: { style } }).range(line.from))
            decorations.push(Decoration.replace({
              widget: new LineWidget(`marker|${spec?.type ?? ''}|${depth}|${line.from}|${text.slice(0, bodyAt - line.from)}`, () => makeMarker()?.el ?? document.createElement('span')),
            }).range(line.from, bodyAt))
          } else {
            // Le tiret brut tombe a la place de la puce.
            const pad = spec?.renderLine ? 2 * depth + 2 : depth * 1.5
            decorations.push(Decoration.line({ class: cls, attributes: { style: `padding-left: calc(${pad}em + 4px)` } }).range(line.from))
          }
        }
        continue
      }
      if (remoteCursors.some(p => p >= line.from && p <= line.to)) continue
      if (underReview(line.from, line.to)) continue
      const from = line.from
      const isFolded = folded(from)
      const render = (): HTMLElement => {
        try {
          const el = spec?.renderLine?.({ text, depth, from }, ctx!)
          if (el) return el
        } catch (err) {
          console.debug(`[LivePreview] plugin line render error (${spec?.type}):`, err)
        }
        return renderCoreLine(text, depth, from, hooks, ctx)
      }
      const build = (): HTMLElement => {
        const el = render()
        if (isFolded) el.classList.add('plume-folded', 'vault-line-block')
        return el
      }
      decorations.push(
        Decoration.replace({ widget: new LineWidget(`${spec?.type ?? ''}|${depth}|${from}|${isFolded ? 'folded|' : ''}${text}`, build), block: true })
          .range(line.from, line.to),
      )
    }
  }

  syntaxTree(state).iterate({
    enter(node) {
      if (!BLOCK_NODES.has(node.type.name)) return
      // Skip nodes inside collapsed frontmatter to avoid overlapping decorations
      // (et le YAML source du panneau reste du texte brut).
      if ((fmDeco || panelDecos) && node.from < fmEnd) return false

      // Un bloc de colonnes a son propre rendu. Un paragraphe qui deborde
      // du bloc (pas de ligne vide apres `:::`) garde ses lignes du dehors.
      if (inColumns(node.from, node.to)) {
        if (node.type.name === 'Paragraph') {
          renderParagraphLines(state.doc.lineAt(node.from).number, state.doc.lineAt(Math.min(node.to, state.doc.length)).number)
        }
        return false
      }
      // Bloc ouvert en texte brut : rien a rendre.
      if (isOpened(node.from, node.to)) return false

      // Listes et citations : ligne par ligne, sauf si un plugin revendique
      // le bloc sans savoir le rendre ligne par ligne (callout, par exemple).
      if (LINE_BLOCKS.has(node.type.name) && isLineRenderable(node.node)) {
        const detected = detect(state.doc.sliceString(node.from, node.to))
        if (!detected || detected.spec.renderLine) {
          renderBlockLines(
            state.doc.lineAt(node.from).number,
            state.doc.lineAt(Math.min(node.to, state.doc.length)).number,
            detected?.spec,
          )
          return false
        }
      }

      const blockStartLine = state.doc.lineAt(node.from).number
      const blockEndLine   = state.doc.lineAt(Math.min(node.to, state.doc.length)).number
      const isSingleLine   = blockStartLine === blockEndLine
      const text = state.doc.sliceString(node.from, node.to)

      // Mode classique : un bloc (plugin, tableau, code, separateur) reste
      // un objet ; titres et paragraphes restent du texte.
      if (classic && !underReview(node.from, node.to)) {
        const detected = detect(text)
        if (detected) {
          pluginObject(node.from, node.to, text, detected.spec)
          return false
        }
        if (node.type.name === 'Table') {
          tableObject(node.from, node.to, text)
          return false
        }
        if (node.type.name === 'FencedCode' || node.type.name === 'HorizontalRule') {
          pushObject(node.from, node.to, `md|${text}`, () => markdownElement(text, hooks), () => markdownElement(text, hooks))
          return false
        }
      }

      // Cursor check — show raw text when editing this block.
      // For single-line blocks (@[[]], ![[]], callouts): raw only when cursor is on the same line.
      // This lets the widget appear after pressing Enter once (cursor moves to next line).
      // For multi-line blocks (blockquote, list…): raw when cursor is anywhere in the block.
      // EXCEPTION: ATX headings on the cursor line get a Decoration.line() class for live
      // heading styling — so the font/size updates as you type without replacing the text.
      if (isSingleLine && liveLines.has(blockStartLine)) {
        const headingClass = HEADING_LINE_CLASSES[node.type.name]
        if (headingClass) {
          // Line decoration for line-height on the cm-line wrapper.
          const lineStart = state.doc.lineAt(node.from).from
          decorations.push(Decoration.line({ class: folded(lineStart) ? `${headingClass} plume-folded` : headingClass }).range(lineStart))
          // Mode classique : pas de # sous le curseur, le titre reste un titre.
          const mark = classic ? /^(#{1,6})(?:[ \t]+|$)/.exec(state.doc.lineAt(node.from).text) : null
          if (mark && mark[0].length > 0) {
            const hide = Decoration.replace({}).range(lineStart, lineStart + mark[0].length)
            decorations.push(hide)
            hidden.push(hide)
            if (lineStart + mark[0].length === state.doc.lineAt(node.from).to) {
              decorations.push(Decoration.widget({ widget: new HeadingPlaceholder(HEADING_LABELS[node.type.name] ?? 'Titre'), side: 1 }).range(lineStart + mark[0].length))
            }
          }
        }
        return false
      } else if (!isSingleLine) {
        // Un paragraphe n'est qu'une suite de lignes : il est rendu LIGNE PAR
        // LIGNE, et seule la ligne du curseur passe en edition. Chaque ligne
        // garde aussi son numero dans la gouttiere (1, 2, 3) au lieu d'un
        // bloc [1–3]. Un vrai bloc (callout, code, liste, citation...) passe,
        // lui, entierement en edition des qu'on y entre.
        // Exception : si un plugin revendique le paragraphe, c'est son bloc.
        if (node.type.name === 'Paragraph' && !claimedByPlugin(text)) {
          renderParagraphLines(blockStartLine, blockEndLine)
          return false
        }
        if (liveIn(node.from, node.to)) return false
      }

      const hasRemoteCursor = remoteCursors.some(p => p >= node.from && p <= node.to)
      if (hasRemoteCursor) return false
      if (underReview(node.from, node.to)) return false

      // Level 1: ask the plugin BlockRegistry first (scope-filtered when available)
      const detected = detect(text)
      if (detected) {
        const render = () => detected.spec.renderClient(detected.spec.deserialize(text), pluginCtx!)
        decorations.push(
          Decoration.replace({
            widget: new PluginWidget(render, text, () => markdownElement(text, hooks)),
            block: true,
          }).range(node.from, node.to),
        )
        return false
      }

      // Level 2: fallback — render with marked (run beforeParse hooks first, e.g. wikilinks)

      try {
        const preprocessed = hooks ? hooks.runBeforeParseSync(text) : text
        // breaks : un retour a la ligne simple reste un retour a la ligne,
        // comme pendant la saisie. Sans lui, trois lignes collees se
        // fondaient en une seule des que le curseur quittait le paragraphe.
        const html = marked.parse(preprocessed, { breaks: true }) as string
        decorations.push(
          Decoration.replace({
            widget: node.type.name === 'Table' ? new TableWidget(html, text) : new MarkdownWidget(html, folded(node.from) ? 'plume-folded' : ''),
            block: true,
          }).range(node.from, node.to),
        )
      } catch {
        // Leave block as plain text on parse error
      }

      return false
    },
  })

  // Tableau du mode classique : cases modifiables, « + » ligne et colonne.
  function tableObject(from: number, to: number, text: string): void {
    pushObject(from, to, `table|${text}`, (view, edit) => {
      const html = marked.parse(hooks ? hooks.runBeforeParseSync(text) : text, { breaks: true }) as string
      return editableTable(view, html, edit, hooks, text)
    }, () => markdownElement(text, hooks))
  }

  rawLineMarks(state, fmEnd, decorations)
  hideInlineMarks(state, fmEnd, decorations)

  if (fmDeco) decorations.unshift(fmDeco)
  if (panelDecos) decorations.unshift(...panelDecos)

  // Lignes repliees : un seul bloc vide a leur place, rien d'autre dedans.
  let shown = decorations
  let shownObjects = objects
  let shownHidden = hidden
  for (const f of folds) {
    // Un bloc rendu d'un tenant a cheval sur le repli : pas de repli ici.
    if (shown.some(d => (d.from < f.from && d.to > f.from) || (d.from <= f.to && d.to > f.to))) continue
    const outside = (d: Range<Decoration>) => d.from < f.from || d.from > f.to
    shown = shown.filter(outside)
    shownObjects = shownObjects.filter(outside)
    shownHidden = shownHidden.filter(outside)
    shown.push(Decoration.replace({ widget: new FoldedGap(), block: true }).range(f.from, f.to))
  }

  return { decorations: Decoration.set(shown, true), objects: Decoration.set(shownObjects, true), hidden: Decoration.set(shownHidden, true) }
}

// see ADR-005
class SingleLineNumberMarker extends GutterMarker {
  constructor(private readonly n: number) { super() }
  eq(other: SingleLineNumberMarker): boolean { return this.n === other.n }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.textContent = String(this.n)
    return span
  }
}

/** Numero d'un titre : centre sur sa ligne, plus haute que les autres. */
class HeadingLineNumberMarker extends SingleLineNumberMarker {
  elementClass = 'plume-gutter-heading'
}

function isHeadingLine(state: EditorState, from: number): boolean {
  const name = syntaxTree(state).resolveInner(from, 1)
  for (let n: SyntaxNode | null = name; n; n = n.parent) {
    if (HEADING_LINE_CLASSES[n.name]) return true
  }
  return false
}

function lineNumberMarker(state: EditorState, from: number): SingleLineNumberMarker {
  const n = state.doc.lineAt(from).number
  return isHeadingLine(state, from) ? new HeadingLineNumberMarker(n) : new SingleLineNumberMarker(n)
}

class BlockLineNumberMarker extends GutterMarker {
  constructor(private readonly first: number, private readonly last: number) { super() }
  eq(other: BlockLineNumberMarker): boolean {
    return this.first === other.first && this.last === other.last
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'height:100%;display:flex;align-items:center;justify-content:flex-end'
    const label = document.createElement('span')
    label.style.cssText = 'font-size:0.7em;opacity:0.55;white-space:nowrap;line-height:1'
    label.textContent = this.last > this.first ? `[${this.first}–${this.last}]` : String(this.first)
    wrap.appendChild(label)
    return wrap
  }
}

const blockAwareLineNumbers = gutter({
  class: 'cm-lineNumbers',
  // Called for each visible TEXT line.
  lineMarker(view, line) {
    return lineNumberMarker(view.state, line.from)
  },
  // Called for each replaced block widget (Decoration.replace({ block: true })).
  widgetMarker(view, widget, block) {
    if (widget instanceof SourceDoneWidget || widget instanceof FoldedGap) return null
    const { state } = view
    const first = state.doc.lineAt(block.from).number
    const last  = state.doc.lineAt(Math.max(block.from, block.to - 1)).number
    // Un widget d'une seule ligne garde le style d'un numero ordinaire.
    return first === last ? lineNumberMarker(state, block.from) : new BlockLineNumberMarker(first, last)
  },
  initialSpacer(view) {
    return new SingleLineNumberMarker(view.state.doc.lines)
  },
})

/** La ligne `prev` est dans une citation (callout compris) ou un tableau. */
function inLazyBlock(state: EditorState, prev: { to: number }): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(prev.to, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return false
    if (n.name === 'Blockquote' || n.name === 'Table') return true
  }
  return false
}

/**
 * Ecrire sur la ligne vide juste sous un callout, une citation ou un
 * tableau : en Markdown, ce texte s'y ajouterait (ils continuent sur la
 * ligne suivante). Une ligne vide les separe d'abord. `>` et `|` gardent,
 * eux, la suite du bloc.
 */
const typingAfterBlock = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || from !== to || !text || text.includes('\n') || /^[>|]/.test(text)) return false
  const { state } = view
  const line = state.doc.lineAt(from)
  if (line.length > 0 || line.number === 1) return false
  const prev = state.doc.line(line.number - 1)
  if (!prev.text.trim() || !inLazyBlock(state, prev)) return false
  view.dispatch({ changes: { from, insert: `\n${text}` }, selection: { anchor: from + 1 + text.length }, userEvent: 'input.type' })
  return true
})

const blockquoteExitKeymap = Prec.highest(
  keymap.of([
    {
      // Entree sur une ligne de tableau en texte brut : une nouvelle ligne du tableau.
      key: 'Enter',
      run(view) {
        const sel = view.state.selection.main
        if (!sel.empty || view.state.readOnly) return false
        const tr = newTableRowBelow(view.state, sel.head)
        if (!tr) return false
        view.dispatch(tr)
        return true
      },
    },
    {
      key: 'Enter',
      run(view) {
        const { from, to } = view.state.selection.main
        if (from !== to) return false
        const line = view.state.doc.lineAt(from)
        if (/^>\s*$/.test(line.text)) {
          // Replace the "> " with a plain newline — exits the blockquote
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: '\n' },
            selection: { anchor: line.from + 1 },
          })
          return true
        }
        return false
      },
    },
  ]),
)


/**
 * La cible est dans un element interactif DE L'OBJET. Pas plus haut : la
 * zone de l'editeur elle-meme est contenteditable.
 */
function insideObject(target: EventTarget | null, root: HTMLElement, selector: string): boolean {
  const hit = (target as Element | null)?.closest?.(selector)
  return !!hit && root.contains(hit)
}

/** Les regles des colonnes, une fois par page (elles servent aussi a l'export). */
function ensureColumnsStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('plume-columns-style')) return
  const style = document.createElement('style')
  style.id = 'plume-columns-style'
  style.textContent = COLUMNS_CSS
  document.head.appendChild(style)
}

// ── Mode classique : clavier, menu, poignees ────────────────────────────────

const CODE_FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/

/**
 * « Retirer le callout », « Retirer le bloc de code »... : le cadre part, le
 * contenu reste dans la note en Markdown ordinaire. Le plugin du bloc dit
 * quoi garder (BlockSpec.unwrap) ; colonnes et code sans plugin, l'editeur.
 */
function unwrapOf(state: EditorState, r: BlockRange, text: string, spec?: BlockSpec): { label: string; content: string } | null {
  if (spec) {
    if (!spec.unwrap) return null
    try {
      return { label: spec.unwrap.label, content: spec.unwrap.content(spec.deserialize(text)) }
    } catch (err) {
      console.debug('[LivePreview] unwrap error:', err)
      return null
    }
  }
  const columns = findColumnsBlocks(state.doc).find(b => b.from === r.from)
  if (columns) {
    const parts = columns.columns.map(c => state.sliceDoc(c.from, c.to).trim()).filter(Boolean)
    return { label: 'Retirer les colonnes', content: parts.join('\n\n') }
  }
  const lines = text.split('\n')
  const open = CODE_FENCE_LINE_RE.exec(lines[0] ?? '')
  if (open && lines.length >= 2 && lines[lines.length - 1].trim().startsWith(open[1])) {
    return { label: 'Retirer le bloc de code', content: lines.slice(1, -1).join('\n') }
  }
  return null
}

function classicExtensions(
  env: PreviewEnv,
  objectsOf: (state: EditorState) => DecorationSet,
) {
  const detect = (text: string): { type: string; spec: BlockSpec } | null => {
    if (!env.registry) return null
    const ids = env.getActiveScopeIds?.() ?? null
    return env.registry.detectActive ? env.registry.detectActive(text, ids) : env.registry.detectBlock(text)
  }
  const objectStartingAt = (state: EditorState, pos: number): BlockRange | null => {
    let found: BlockRange | null = null
    objectsOf(state).between(pos, pos, (from, to) => { if (from === pos) { found = { from, to }; return false } return undefined })
    return found
  }
  const objectEndingAt = (state: EditorState, pos: number): BlockRange | null => {
    let found: BlockRange | null = null
    objectsOf(state).between(pos, pos, (from, to) => { if (to === pos) { found = { from, to }; return false } return undefined })
    return found
  }

  /** Les lignes entieres d'un bloc, retour a la ligne compris. */
  const wholeLines = (state: EditorState, r: BlockRange): BlockRange => {
    const from = state.doc.lineAt(r.from).from
    const to = state.doc.lineAt(r.to).to
    return to < state.doc.length ? { from, to: to + 1 } : { from: Math.max(0, from - 1), to }
  }

  const blockMenu = (view: EditorView, r: BlockRange, isObject: boolean): BlockMenuItem[] => {
    const text = view.state.sliceDoc(r.from, r.to)
    const items: BlockMenuItem[] = []
    if (isObject) {
      const detected = detect(text)
      const edit = editContext(view, env.ctx ?? { editorView: view }, () => r)
      try {
        items.push(...(detected?.spec.menu?.(detected.spec.deserialize(text), edit) ?? []))
      } catch (err) {
        console.debug('[LivePreview] block menu error:', err)
      }
      const unwrap = unwrapOf(view.state, r, text, detected?.spec)
      if (unwrap) {
        items.push({ id: 'unwrap', label: unwrap.label, separatorBefore: items.length > 0, run: () => edit.replace(unwrap.content) })
      }
      items.push({ id: 'source', label: 'Modifier la source', separatorBefore: !unwrap && items.length > 0, run: () => openSource(view, r) })
    }
    items.push({
      id: 'duplicate',
      label: 'Dupliquer',
      separatorBefore: !isObject ? false : undefined,
      run: () => {
        const end = view.state.doc.lineAt(r.to).to
        // Un bloc garde une ligne vide entre lui et sa copie (deux tableaux colles n'en font qu'un).
        view.dispatch({ changes: { from: end, insert: (isObject ? '\n\n' : '\n') + view.state.sliceDoc(view.state.doc.lineAt(r.from).from, end) }, userEvent: 'input' })
      },
    })
    items.push({
      id: 'delete',
      label: 'Supprimer',
      run: () => view.dispatch({ changes: { ...wholeLines(view.state, r), insert: '' }, userEvent: 'delete' }),
    })
    return items
  }

  const menu = (view: EditorView, r: BlockRange, isObject: boolean, x: number, y: number, first: BlockMenuItem[] = []) => {
    if (view.state.readOnly) return
    const rest = blockMenu(view, r, isObject)
    if (first.length && rest.length) rest[0] = { ...rest[0], separatorBefore: true }
    showBlockMenu([...first, ...rest], x, y)
  }

  const objectOf = (view: EditorView, target: EventTarget | null): { dom: HTMLElement; range: BlockRange } | null => {
    const dom = (target as Element | null)?.closest?.('.plume-object') as HTMLElement | null
    if (!dom || !view.contentDOM.contains(dom)) return null
    const range = env.rangeOf(view, dom)
    return range ? { dom, range } : null
  }

  const pointer = ViewPlugin.define(view => {
    const contextmenu = (e: MouseEvent) => {
      if (view.state.readOnly) return
      const hit = objectOf(view, e.target)
      if (!hit) return
      // Le menu du navigateur reste dans une zone de texte (correcteur).
      if (insideObject(e.target, hit.dom, 'textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]')) return
      e.preventDefault()
      // Dans une case d'un tableau : d'abord sa ligne et sa colonne.
      const cell = (e.target as Element | null)?.closest?.('.plume-table-cell') as HTMLElement | null
      const first = cell && hit.dom.classList.contains('plume-table-object') && hit.dom.contains(cell)
        ? tableCellItems(view, editContext(view, env.ctx ?? { editorView: view }, () => hit.range), Number(cell.dataset.row), Number(cell.dataset.col), hit.range.from)
        : []
      menu(view, hit.range, true, e.clientX, e.clientY, first)
    }
    const dblclick = (e: MouseEvent) => {
      if (view.state.readOnly) return
      const hit = objectOf(view, e.target)
      if (!hit) return
      if (insideObject(e.target, hit.dom, 'a, button, input, select, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .plume-columns, .plume-table-object')) return
      // Un objet sans edition propre : double clic, sa source.
      const detected = detect(view.state.sliceDoc(hit.range.from, hit.range.to))
      if (detected?.spec.renderEditable) return
      e.preventDefault()
      openSource(view, hit.range)
    }
    view.dom.addEventListener('contextmenu', contextmenu)
    view.dom.addEventListener('dblclick', dblclick)
    return {
      destroy() {
        view.dom.removeEventListener('contextmenu', contextmenu)
        view.dom.removeEventListener('dblclick', dblclick)
        closeBlockMenu()
      },
    }
  })

  // Ecrire juste avant ou juste apres un objet ouvre une ligne : le texte
  // ne se colle pas a la source cachee du bloc.
  const typingBesideObject = EditorView.inputHandler.of((view, from, to, text) => {
    if (from !== to || text.includes('\n')) return false
    const after = objectEndingAt(view.state, from)
    const before = after ? null : objectStartingAt(view.state, from)
    if (!after && !before) return false
    const insert = after ? `\n${text}` : `${text}\n`
    view.dispatch({ changes: { from, insert }, selection: { anchor: from + (after ? 1 + text.length : text.length) }, userEvent: 'input.type' })
    return true
  })

  const keys = Prec.highest(keymap.of([
    { key: 'Escape', run: view => closeSource(view) },
    {
      key: 'Backspace',
      run: view => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        // Au debut d'un titre (ses # sont caches) : il redevient du texte.
        const line = view.state.doc.lineAt(sel.head)
        const mark = /^#{1,6}(?:[ \t]+|$)/.exec(line.text)
        if (mark && sel.head === line.from + mark[0].length) {
          view.dispatch({ changes: { from: line.from, to: line.from + mark[0].length }, userEvent: 'delete' })
          return true
        }
        // Juste apres un objet : ne pas l'effacer d'un coup (le menu sert a ca).
        if (objectEndingAt(view.state, sel.head)) return true
        const obj = objectStartingAt(view.state, sel.head)
        if (!obj || sel.head === 0) return false
        const prev = view.state.doc.lineAt(sel.head - 1)
        // La ligne d'avant a du texte : y aller plutot que de coller l'objet a elle.
        if (prev.text.trim()) { view.dispatch({ selection: { anchor: prev.to } }); return true }
        return false
      },
    },
    {
      key: 'Delete',
      run: view => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        if (objectStartingAt(view.state, sel.head)) return true
        const obj = objectEndingAt(view.state, sel.head)
        if (!obj || sel.head >= view.state.doc.length) return false
        const next = view.state.doc.lineAt(sel.head + 1)
        if (next.text.trim()) { view.dispatch({ selection: { anchor: next.from } }); return true }
        return false
      },
    },
  ]))

  return [
    sourceOpenField,
    objectEpochField,
    keys,
    typingBesideObject,
    pointer,
    blockDragExtension({
      objects: objectsOf,
      frontmatterEnd,
      menu,
    }),
    EditorView.baseTheme({
      '.plume-object': { cursor: 'default' },
      '.plume-source-line': {
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '0.9em',
        background: 'var(--bg-code, rgba(127,127,127,0.10))',
        borderLeft: '2px solid var(--accent, #7c3aed)',
      },
      '.plume-source-first': { borderTopRightRadius: '6px' },
      '.plume-source-last': { borderBottomRightRadius: '6px' },
      '.plume-source-bar': {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '2px 6px 4px', fontSize: '11px', color: 'var(--text-faint, #6c7086)',
        fontFamily: 'var(--font-ui, inherit)',
      },
      '.plume-source-done': {
        border: '1px solid var(--border, #3d3d5c)', borderRadius: '4px', background: 'transparent',
        color: 'inherit', font: 'inherit', padding: '1px 8px', cursor: 'pointer',
      },
      '.plume-table-cell': { cursor: 'text', minWidth: '3em' },
      '.plume-table-cell[contenteditable]': { outline: '2px solid var(--accent, #7c3aed)', outlineOffset: '-2px' },
      '.plume-column': { cursor: 'text', borderRadius: '4px', minHeight: '1.6em', position: 'relative' },
      '.plume-column:hover': { background: 'var(--bg-hover, rgba(127,127,127,0.06))' },
      '.plume-column-resizer': {
        position: 'absolute', top: '0', bottom: '0', right: 'calc(-0.625em - 4px)', width: '8px',
        cursor: 'col-resize', zIndex: '2', borderRadius: '4px',
      },
      '.plume-column-resizer:hover, .plume-column-resizer:active': { background: 'var(--accent, #7c3aed)', opacity: '0.35' },
      '.plume-column-width': {
        position: 'absolute', top: '-1.6em', right: '0', transform: 'translateX(50%)', whiteSpace: 'nowrap', zIndex: '3',
        padding: '1px 6px', borderRadius: '4px', fontSize: '11px', lineHeight: '1.5',
        background: 'var(--bg-elevated, #252535)', color: 'var(--text, #cdd6f4)', pointerEvents: 'none', opacity: '1',
      },
      '.plume-heading-placeholder': { color: 'var(--text-faint, #6c7086)', opacity: '0.6', pointerEvents: 'none' },
      '.plume-column-empty': { color: 'var(--text-faint, #6c7086)', fontStyle: 'italic', padding: '0 6px', userSelect: 'none' },
      '.plume-column-editor': {
        width: '100%', boxSizing: 'border-box', resize: 'none', overflow: 'hidden',
        font: 'inherit', lineHeight: 'var(--vault-line-height, 1.65)', color: 'inherit',
        background: 'var(--bg-surface, rgba(127,127,127,0.08))',
        border: '1px solid var(--accent, #7c3aed)', borderRadius: '4px', padding: '2px 6px',
      },
    }),
  ]
}

/**
 * Les blocs replies changent, ou l'analyse de la note les trouve enfin (elle
 * arrive apres le texte : a l'ouverture, les blocs retenus attendent).
 */
function foldsChanged(tr: Transaction): boolean {
  const folded = tr.state.field(foldedField, false)
  if (!folded) return false
  if (folded !== tr.startState.field(foldedField, false)) return true
  return folded.anchors.length > 0 && tr.state.field(foldablesField) !== tr.startState.field(foldablesField)
}

export function createLivePreviewExtension(
  registry?: BlockRegistry,
  hooks?: HookRegistry,
  ctx?: BlockContext,
  showLineNumbers = true,
  getActiveScopeIds?: () => Set<string> | null,
  mode: PreviewMode = 'power',
) {
  const classic = mode === 'classic'
  ensureColumnsStyle()
  const rangeOf = (view: EditorView, dom: HTMLElement): BlockRange | null => {
    if (!dom.isConnected) return null
    let pos: number
    try { pos = view.posAtDOM(dom) } catch { return null }
    let found: BlockRange | null = null
    view.state.field(field).objects.between(pos, pos, (from, to) => {
      if (from === pos) { found = { from, to }; return false }
      return undefined
    })
    return found
  }
  const env: PreviewEnv = { registry, hooks, ctx, getActiveScopeIds, mode, rangeOf }
  const field: StateField<PreviewDecorations> = StateField.define<PreviewDecorations>({
    create(state) {
      return buildDecorations(state, env)
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection || foldsChanged(tr)
        || tr.effects.some(e => e.is(pluginsLoadedEffect) || e.is(setPointerHold) || isPropertiesEffect(e) || isHighlightsEffect(e) || isClassicEffect(e))) {
        return buildDecorations(tr.state, env)
      }
      return { decorations: value.decorations.map(tr.changes), objects: value.objects.map(tr.changes), hidden: value.hidden.map(tr.changes) }
    },
    provide: (f) => [
      EditorView.decorations.from(f, v => v.decorations),
      // Mode classique : le curseur saute un objet d'un coup.
      EditorView.atomicRanges.of(view => view.state.field(f).objects),
      EditorView.atomicRanges.of(view => view.state.field(f).hidden),
    ],
  })

  const objectsOf = (state: EditorState) => state.field(field).objects
  const objectAround = (state: EditorState, pos: number): BlockRange | null => {
    let found: BlockRange | null = null
    objectsOf(state).between(pos, pos, (from, to) => { found = { from, to }; return false })
    return found
  }

  const headingCursorFix = EditorView.updateListener.of((update) => {
    if (!update.selectionSet || update.docChanged) return
    // Un clic pose le curseur ou l'on vise (la ligne s'ouvre avant), et un
    // glisser qui part du debut d'un titre ne doit pas etre ecrase.
    if (!update.state.selection.main.empty || update.transactions.some(tr => tr.isUserEvent('select.pointer'))) return
    const { from } = update.state.selection.main
    const line = update.state.doc.lineAt(from)
    if (from !== line.from) return
    const m = line.text.match(/^(#{1,6}) /)
    if (!m) return
    // Only correct when entering from a different line — avoids re-triggering after dispatch
    const prevFrom = update.startState.selection.main.from
    const prevLine = update.startState.doc.lineAt(prevFrom)
    if (prevLine.number === line.number) return
    const target = line.from + m[1].length + 1
    if (target <= line.to) {
      update.view.dispatch({ selection: { anchor: target }, scrollIntoView: false })
    }
  })

  /** L'element d'un objet du mode classique, par sa position. */
  const objectDom = (view: EditorView, from: number): HTMLElement | null => {
    for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.plume-object'))) {
      try { if (view.posAtDOM(el) === from) return el } catch { /* hors de la vue */ }
    }
    return null
  }
  /** Le curseur arrive sur un objet : il le prend s'il sait se laisser parcourir (callout, tableau). */
  const enterObject = (view: EditorView, obj: BlockRange, dir: 1 | -1, x: number | null): boolean => {
    const dom = objectDom(view, obj.from)
    if (!dom) return false
    const ev = new CustomEvent<BlockEnterDetail>(BLOCK_ENTER_EVENT, { cancelable: true, detail: { dir, x } })
    dom.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  /** Une ligne qui s'affiche sur plusieurs rangees (texte long qui passe a la ligne). */
  const wraps = (view: EditorView, from: number, to: number): boolean => {
    if (from === to) return false
    const a = view.coordsAtPos(from, 1)
    const b = view.coordsAtPos(to, -1)
    return !!a && !!b && b.top - a.top > 2 && b.top > a.bottom - 2
  }

  // see ADR-005 — une fleche va a la rangee du dessus ou du dessous : dans
  // une longue ligne, d'abord ses rangees. En mode classique, elle entre dans
  // un objet qui sait se laisser parcourir, sinon elle le saute.
  const moveOneLine = (view: EditorView, dir: 1 | -1): boolean => {
    const { state } = view
    const range = state.selection.main
    const pos = range.head
    const line = state.doc.lineAt(pos)
    // L'abscisse visee, gardee d'une fleche a l'autre.
    const coords = view.coordsAtPos(pos, range.assoc || 1)
    const box = view.contentDOM.getBoundingClientRect()
    const goal = range.goalColumn ?? (coords ? coords.left - box.left : undefined)
    if (wraps(view, line.from, line.to)) {
      const moved = view.moveVertically(range, dir === 1)
      if (moved.head !== pos && state.doc.lineAt(moved.head).number === line.number) {
        view.dispatch({ selection: EditorSelection.create([moved]), scrollIntoView: true })
        return true
      }
    }
    const targetLineNum = line.number + dir
    if (targetLineNum < 1 || targetLineNum > state.doc.lines) return false
    let targetLine = state.doc.line(targetLineNum)
    const col = pos - line.from
    // Les lignes d'un bloc replie se sautent (y entrer l'ouvrirait).
    const skipFolded = (): boolean => {
      const f = hiddenAt(state, targetLine.from)
      if (!f) return true
      const beyond = dir === 1 ? state.doc.lineAt(f.to).number + 1 : state.doc.lineAt(f.from).number - 1
      if (beyond < 1 || beyond > state.doc.lines) return false
      targetLine = state.doc.line(beyond)
      return true
    }
    if (!skipFolded()) return true
    if (classic) {
      const obj = objectAround(state, targetLine.from)
      if (obj && !(dir === -1 && pos === obj.to)) {
        if (enterObject(view, obj, dir, coords ? coords.left : null)) return true
        const beyond = dir === 1 ? state.doc.lineAt(obj.to).number + 1 : state.doc.lineAt(obj.from).number - 1
        if (beyond < 1 || beyond > state.doc.lines) {
          view.dispatch({ selection: { anchor: dir === 1 ? obj.to : obj.from }, scrollIntoView: true })
          return true
        }
        targetLine = state.doc.line(beyond)
        if (!skipFolded()) return true
      }
    }
    // Preserve horizontal column within the target line.
    const anchor = Math.min(targetLine.from + col, targetLine.to)
    view.dispatch({ selection: EditorSelection.cursor(anchor, 0, undefined, goal), scrollIntoView: true })
    // La ligne d'arrivee passe a la ligne : la rangee la plus proche (la
    // premiere en descendant, la derniere en montant), a la meme abscisse.
    const target = view.state.doc.lineAt(Math.min(anchor, view.state.doc.length))
    if (goal !== undefined && wraps(view, target.from, target.to)) {
      const edge = view.coordsAtPos(dir === 1 ? target.from : target.to, dir === 1 ? 1 : -1)
      const at = edge ? view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + goal, y: (edge.top + edge.bottom) / 2 }, false) : null
      if (at !== null && at >= target.from && at <= target.to && at !== view.state.selection.main.head) {
        view.dispatch({ selection: EditorSelection.cursor(at, 0, undefined, goal), scrollIntoView: true })
      }
    }
    return true
  }

  const blockNavigationKeymap = Prec.highest(keymap.of([
    { key: 'ArrowDown', run: (view) => moveOneLine(view, 1) },
    { key: 'ArrowUp',   run: (view) => moveOneLine(view, -1) },
    // Un bloc replie se saute, il ne s'ouvre pas.
    { key: 'ArrowRight', run: (view) => skipFold(view, 1) },
    { key: 'ArrowLeft',  run: (view) => skipFold(view, -1) },
  ]))

  return [
    remoteCursorPositionsField,
    pointerHoldField,
    field,
    ...(showLineNumbers ? [blockAwareLineNumbers] : []),
    ...foldingExtension(),
    blockquoteExitKeymap,
    typingAfterBlock,
    blockNavigationKeymap,
    headingCursorFix,
    pointerHold,
    ...(classic ? classicExtensions(env, objectsOf) : []),
    EditorView.baseTheme({
      // Restore lineNumbers() base theme (removed when we replaced the extension).
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 3px 0 5px',
        minWidth: '20px',
        textAlign: 'right',
        color: 'var(--cm-lineNumber-color, #6c7086)',
        whiteSpace: 'nowrap',
      },
      // CodeMirror mesure un bloc rendu sans ses marges : chaque marge
      // decale tout ce qui est dessous (numeros de ligne, clics). Un callout
      // et un bloc de code suffisaient a faire tomber les clics une ligne
      // plus bas. Pas de marge sur ce qui remplace une ligne.
      '.cm-content > :not(.cm-line)': {
        marginTop: '0 !important',
        marginBottom: '0 !important',
      },
      '.plume-md-code': {
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '0.9em',
        background: 'var(--bg-code, rgba(127,127,127,0.12))', borderRadius: '3px', padding: '0 2px',
      },
      '.plume-md-link': { color: 'var(--accent, #7c3aed)', textDecoration: 'underline', textUnderlineOffset: '2px' },
      '.plume-table-object, .plume-table-box': { position: 'relative' },
      '.plume-table-grip': {
        position: 'absolute', zIndex: '3', padding: '0', lineHeight: '1', fontSize: '12px', cursor: 'pointer',
        border: '1px solid var(--border, #3d3d5c)', borderRadius: '4px',
        background: 'var(--bg-elevated, #252535)', color: 'var(--text-muted, #9ca3af)',
      },
      '.plume-table-grip-row': { width: '16px', height: '18px' },
      '.plume-table-grip-col': { width: '18px', height: '16px' },
      '.plume-table-grip:hover': { color: 'var(--text, #cdd6f4)', borderColor: 'var(--accent, #7c3aed)' },
      '.plume-table-plus': {
        position: 'absolute', zIndex: '4', width: '16px', height: '16px', padding: '0', lineHeight: '14px', fontSize: '13px',
        cursor: 'pointer', borderRadius: '50%', border: '1px solid var(--border, #3d3d5c)',
        background: 'var(--bg-elevated, #252535)', color: 'var(--text-muted, #9ca3af)',
      },
      '.plume-table-plus:hover': { background: 'var(--accent, #7c3aed)', borderColor: 'var(--accent, #7c3aed)', color: '#fff' },
      '.plume-table-insert-line': {
        position: 'absolute', zIndex: '3', pointerEvents: 'none', borderRadius: '1px', background: 'var(--accent, #7c3aed)',
      },
      '.plume-table-selected': {
        background: 'color-mix(in srgb, var(--accent, #7c3aed) 14%, transparent) !important',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent, #7c3aed) 55%, transparent)',
      },
      '.plume-table-resizer': {
        position: 'absolute', width: '8px', cursor: 'col-resize', zIndex: '2', borderRadius: '4px', touchAction: 'none',
      },
      '.plume-table-resizer:hover, .plume-table-resizing .plume-table-resizer:active': { background: 'var(--accent, #7c3aed)', opacity: '0.35' },
      // Au survol du tableau, un trait sur chaque bord de l'en-tete montre ou tirer.
      '.plume-table-resizer::after': {
        content: '""', position: 'absolute', left: '3px', top: '4px', width: '2px',
        height: 'calc(var(--plume-head-height, 1.6em) - 8px)', borderRadius: '1px',
        background: 'var(--accent, #7c3aed)', opacity: '0', transition: 'opacity .12s',
      },
      '.plume-table-box:hover .plume-table-resizer::after, .plume-table-object:hover .plume-table-resizer::after': { opacity: '0.5' },
      '.plume-table-resizing': { cursor: 'col-resize', userSelect: 'none' },
      '.cm-lineNumbers .cm-gutterElement.plume-gutter-heading': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
      },
      // Meme boite qu'une ligne brute (.cm-line) : entrer dans une ligne ne
      // change pas sa hauteur, le document ne saute pas. Seuls les blocs
      // particuliers (tableau, code, integration...) gardent leur hauteur.
      '.vault-rendered-block': {
        // Les marges du contenu (citation, code) restent dans le bloc.
        display: 'flow-root',
        padding: '0 2px 0 6px',
        margin: '0',
        lineHeight: 'var(--vault-line-height, 1.65)',
        cursor: 'text',
        whiteSpace: 'normal',
      },
      // Live heading styles — font-size + line-height only on the cm-line wrapper.
      // Color and weight are applied via Decoration.mark inline styles (highest CSS specificity)
      // so they override syntax-highlighting token classes without needing !important.
      '.vault-h1-live': { lineHeight: '1.5' },
      '.vault-h2-live': { lineHeight: '1.5' },
      '.vault-h3-live': { lineHeight: '1.4' },
      '.vault-h4-live': { lineHeight: '1.3' },
      '.vault-h5-live': { lineHeight: '1.3' },
      '.vault-h6-live': { lineHeight: '1.3' },
      // Titres rendus : memes taille et interligne que la ligne brute du titre.
      '.vault-rendered-block h1, .vault-rendered-block h2, .vault-rendered-block h3, .vault-rendered-block h4, .vault-rendered-block h5, .vault-rendered-block h6': {
        margin: '0',
      },
      '.vault-rendered-block h1, .vault-rendered-block h2': { lineHeight: '1.5' },
      '.vault-rendered-block h3': { lineHeight: '1.4' },
      '.vault-rendered-block h4, .vault-rendered-block h5, .vault-rendered-block h6': { lineHeight: '1.3' },
      '.vault-rendered-block p': {
        margin: '0',
      },
      // Ligne d'un paragraphe rendu ligne par ligne : meme hauteur qu'une ligne brute.
      '.vault-paragraph-line': {
        padding: '0 2px 0 6px',
      },
      '.vault-paragraph-line p': {
        margin: '0',
      },
      '.vault-rendered-block pre': {
        background: '#1e1e2e',
        borderRadius: '6px',
        padding: '12px',
        overflowX: 'auto',
        color: '#cdd6f4',
        fontFamily: 'monospace',
        fontSize: '13px',
      },
      '.vault-rendered-block code': {
        fontFamily: 'monospace',
        fontSize: '0.9em',
      },
      // Obsidian Minimal: --list-indent:2em, --list-spacing:0.075em (padding, not margin)
      '.vault-rendered-block ul, .vault-rendered-block ol': {
        paddingLeft: '2em',
        margin: '0',
      },
      '.vault-rendered-block li': {
        margin: '0',
        paddingTop: '0.075em',
        paddingBottom: '0.075em',
        lineHeight: '1.5',
      },
      // marked wraps loose-list items in <p> — strip their margins.
      '.vault-rendered-block li > p': {
        margin: '0',
      },
      ...plumeColorTheme(),
      // Lignes de liste et de citation rendues une a une.
      '.vault-line-block': {
        padding: '0 2px 0 6px',
        lineHeight: 'var(--vault-line-height, 1.65)',
      },
      '.vault-list-line': {
        display: 'flex',
        alignItems: 'baseline',
      },
      '.vault-list-marker': {
        flex: '0 0 auto',
        minWidth: '1.5em',
        color: 'var(--accent, #7c3aed)',
        userSelect: 'none',
      },
      '.vault-list-marker-live': {
        display: 'inline-block',
        width: '1.5em',
        textIndent: '0',
      },
      '.vault-task-checkbox': {
        margin: '0 4px 0 0',
        verticalAlign: 'middle',
        accentColor: 'var(--accent, #7c3aed)',
        cursor: 'pointer',
      },
      '.vault-task-done .vault-list-content': {
        opacity: '0.6',
        textDecoration: 'line-through',
      },
      '.plume-quote-live': {
        '--plume-quote-bar': '#7c3aed',
        color: '#9ca3af',
      },
      '.vault-quote-line': {
        borderLeft: '3px solid #7c3aed',
        paddingLeft: '1em',
        color: '#9ca3af',
      },
      '.vault-rendered-block blockquote': {
        borderLeft: '3px solid #7c3aed',
        paddingLeft: '1em',
        margin: '0.5em 0',
        color: '#9ca3af',
      },
    }),
  ]
}
