// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Live preview extension — renders Markdown blocks as HTML widgets in CodeMirror.
// see ADR-005

import { EditorView, Decoration, DecorationSet, WidgetType, keymap, gutter, GutterMarker } from '@codemirror/view'
import { StateField, StateEffect, EditorState, Range, Prec } from '@codemirror/state'
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
import type { BlockRegistry, BlockContext, BlockSpec, HookRegistry } from '@savoire/plugin-api'
import { COLOR_EMOJI_SOURCE, colorOfEmoji, plumeColorTheme } from './PlumeMarkdown'
import { frontmatterEnd, isPropertiesEffect, propertiesDecorations } from './PropertiesPanel'
import { lineColorOf } from './FormattingService'

// Dispatching this effect after plugins load triggers a full decoration rebuild.
export const pluginsLoadedEffect = StateEffect.define<void>()

const BLOCK_NODES = new Set([
  'Paragraph',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3',
  'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'BulletList', 'OrderedList',
  'Blockquote',
  'FencedCode',
  'HorizontalRule',
  'Table',
])

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

// Sans panneau de proprietes (editeur seul), le bloc se replie en « ··· ».
function buildFrontmatterDecoration(state: EditorState, endPos: number): Range<Decoration> | null {
  if (endPos === 0) return null
  // Reveal when cursor is inside frontmatter block
  const { from: cursorFrom } = state.selection.main
  if (cursorFrom <= endPos) return null
  return Decoration.replace({
    widget: new FrontmatterBadge(),
    block: true,
  }).range(0, endPos)
}

class PluginWidget extends WidgetType {
  constructor(
    private readonly el: HTMLElement,
    private readonly contentText: string,
  ) {
    super()
  }

  eq(other: PluginWidget): boolean {
    return this.contentText === other.contentText
  }

  toDOM(): HTMLElement {
    return this.el
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
    div.innerHTML = this.html
    return div
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== 'click' && e.type !== 'mousedown'
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
  return marked.parseInline(pre) as string
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
  const [, indent, marker, space, task, body] = item
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
    if (box.checked) div.classList.add('vault-task-done')
  } else {
    mark.textContent = /\d/.test(marker) ? marker : BULLETS[depth % BULLETS.length]
  }
  const content = document.createElement('span')
  content.className = 'vault-list-content'
  content.innerHTML = inlineHtml(body, hooks)
  div.append(mark, content)
  return div
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

function buildDecorations(
  state: EditorState,
  registry?: BlockRegistry,
  hooks?: HookRegistry,
  ctx?: BlockContext,
  getActiveScopeIds?: () => Set<string> | null,
): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const { from: cursorFrom } = state.selection.main
  const remoteCursors = state.field(remoteCursorPositionsField, false) ?? []

  // Zone du frontmatter : le panneau des proprietes s'il est branche, sinon
  // le badge replie (null si le curseur y est, ou sans frontmatter).
  const fmEnd = frontmatterEnd(state)
  const panelDecos = propertiesDecorations(state, fmEnd)
  const fmDeco = panelDecos ? null : buildFrontmatterDecoration(state, fmEnd)

  const claimedByPlugin = (text: string): boolean => {
    if (!registry || !ctx) return false
    const ids = getActiveScopeIds?.() ?? null
    return !!(registry.detectActive ? registry.detectActive(text, ids) : registry.detectBlock(text))
  }

  const renderParagraphLines = (firstLine: number, lastLine: number): void => {
    const cursorLine = state.doc.lineAt(cursorFrom).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (n === cursorLine) continue
      if (remoteCursors.some(p => p >= line.from && p <= line.to)) continue
      const lineText = state.doc.sliceString(line.from, line.to)
      // Une ligne d'integration seule (une image `![[x.png]]` collee entre
      // deux lignes de texte) garde le rendu de son plugin.
      const own = EMBED_LINE_RE.test(lineText) ? detect(lineText) : null
      if (own) {
        try {
          const el = own.spec.renderClient(own.spec.deserialize(lineText), ctx!)
          decorations.push(Decoration.replace({ widget: new PluginWidget(el, lineText), block: true }).range(line.from, line.to))
          continue
        } catch (err) {
          console.debug(`[LivePreview] plugin render error (${own.type}):`, err)
        }
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

  const detect = (text: string): { type: string; spec: BlockSpec } | null => {
    if (!registry || !ctx) return null
    const ids = getActiveScopeIds?.() ?? null
    return registry.detectActive ? registry.detectActive(text, ids) : registry.detectBlock(text)
  }

  const renderBlockLines = (firstLine: number, lastLine: number, spec?: BlockSpec): void => {
    const cursorLine = state.doc.lineAt(cursorFrom).number
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n)
      if (!line.text.trim()) continue
      const text = line.text
      const indent = text.length - text.trimStart().length
      const isQuote = /^\s*>/.test(text)
      const depth = isQuote
        ? Math.max(0, (/^\s*((?:>\s?)+)/.exec(text)![1].match(/>/g) ?? []).length - 1)
        : listDepth(state, line.from + indent)
      if (n === cursorLine) {
        // La ligne en edition garde le retrait des lignes rendues : le
        // tiret tombe a la place de la puce.
        if (!isQuote) {
          const pad = spec?.renderLine ? 2 * depth + 2 : depth * 1.5
          decorations.push(Decoration.line({ attributes: { style: `padding-left: calc(${pad}em + 4px)` } }).range(line.from))
        }
        continue
      }
      if (remoteCursors.some(p => p >= line.from && p <= line.to)) continue
      const from = line.from
      const build = (): HTMLElement => {
        try {
          const el = spec?.renderLine?.({ text, depth, from }, ctx!)
          if (el) return el
        } catch (err) {
          console.debug(`[LivePreview] plugin line render error (${spec?.type}):`, err)
        }
        return renderCoreLine(text, depth, from, hooks, ctx)
      }
      decorations.push(
        Decoration.replace({ widget: new LineWidget(`${spec?.type ?? ''}|${depth}|${from}|${text}`, build), block: true })
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

      // Cursor check — show raw text when editing this block.
      // For single-line blocks (@[[]], ![[]], callouts): raw only when cursor is on the same line.
      // This lets the widget appear after pressing Enter once (cursor moves to next line).
      // For multi-line blocks (blockquote, list…): raw when cursor is anywhere in the block.
      // EXCEPTION: ATX headings on the cursor line get a Decoration.line() class for live
      // heading styling — so the font/size updates as you type without replacing the text.
      const blockStartLine = state.doc.lineAt(node.from).number
      const blockEndLine   = state.doc.lineAt(Math.min(node.to, state.doc.length)).number
      const cursorLine     = state.doc.lineAt(cursorFrom).number
      const isSingleLine   = blockStartLine === blockEndLine
      if (isSingleLine && cursorLine === blockStartLine) {
        const headingClass = HEADING_LINE_CLASSES[node.type.name]
        if (headingClass) {
          // Line decoration for line-height on the cm-line wrapper.
          const lineStart = state.doc.lineAt(node.from).from
          decorations.push(Decoration.line({ class: headingClass }).range(lineStart))
        }
        return false
      } else if (!isSingleLine) {
        // Un paragraphe n'est qu'une suite de lignes : il est rendu LIGNE PAR
        // LIGNE, et seule la ligne du curseur passe en edition. Chaque ligne
        // garde aussi son numero dans la gouttiere (1, 2, 3) au lieu d'un
        // bloc [1–3]. Un vrai bloc (callout, code, liste, citation...) passe,
        // lui, entierement en edition des qu'on y entre.
        // Exception : si un plugin revendique le paragraphe, c'est son bloc.
        if (node.type.name === 'Paragraph' && !claimedByPlugin(state.doc.sliceString(node.from, node.to))) {
          renderParagraphLines(blockStartLine, blockEndLine)
          return false
        }
        if (cursorFrom >= node.from && cursorFrom <= node.to) return false
      }

      const hasRemoteCursor = remoteCursors.some(p => p >= node.from && p <= node.to)
      if (hasRemoteCursor) return false

      const text = state.doc.sliceString(node.from, node.to)

      // Level 1: ask the plugin BlockRegistry first (scope-filtered when available)
      if (registry && ctx) {
        const ids = getActiveScopeIds?.() ?? null
        const detected = registry.detectActive
          ? registry.detectActive(text, ids)
          : registry.detectBlock(text)
        if (detected) {
          try {
            const data = detected.spec.deserialize(text)
            const el = detected.spec.renderClient(data, ctx)
            decorations.push(
              Decoration.replace({
                widget: new PluginWidget(el, text),
                block: true,
              }).range(node.from, node.to),
            )
            return false
          } catch (err) {
            console.debug(`[LivePreview] plugin render error (${detected.type}):`, err)
          }
        }
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
            widget: new MarkdownWidget(html),
            block: true,
          }).range(node.from, node.to),
        )
      } catch {
        // Leave block as plain text on parse error
      }

      return false
    },
  })

  rawLineMarks(state, fmEnd, decorations)

  if (fmDeco) decorations.unshift(fmDeco)
  if (panelDecos) decorations.unshift(...panelDecos)

  return Decoration.set(decorations, true)
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
    return new SingleLineNumberMarker(view.state.doc.lineAt(line.from).number)
  },
  // Called for each replaced block widget (Decoration.replace({ block: true })).
  widgetMarker(view, _widget, block) {
    const { state } = view
    const first = state.doc.lineAt(block.from).number
    const last  = state.doc.lineAt(Math.max(block.from, block.to - 1)).number
    // Un widget d'une seule ligne garde le style d'un numero ordinaire.
    return first === last ? new SingleLineNumberMarker(first) : new BlockLineNumberMarker(first, last)
  },
  initialSpacer(view) {
    return new SingleLineNumberMarker(view.state.doc.lines)
  },
})

// see ADR-005
function moveOneLine(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const targetLineNum = line.number + dir
  if (targetLineNum < 1 || targetLineNum > state.doc.lines) return false
  const targetLine = state.doc.line(targetLineNum)
  // Preserve horizontal column within the target line.
  const col = pos - line.from
  const anchor = Math.min(targetLine.from + col, targetLine.to)
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
  return true
}

const blockquoteExitKeymap = Prec.highest(
  keymap.of([
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

const blockNavigationKeymap = Prec.highest(keymap.of([
  { key: 'ArrowDown', run: (view) => moveOneLine(view, 1) },
  { key: 'ArrowUp',   run: (view) => moveOneLine(view, -1) },
]))

export function createLivePreviewExtension(
  registry?: BlockRegistry,
  hooks?: HookRegistry,
  ctx?: BlockContext,
  showLineNumbers = true,
  getActiveScopeIds?: () => Set<string> | null,
) {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, registry, hooks, ctx, getActiveScopeIds)
    },
    update(decorations, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(pluginsLoadedEffect) || isPropertiesEffect(e))) {
        return buildDecorations(tr.state, registry, hooks, ctx, getActiveScopeIds)
      }
      return decorations.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f),
  })

  const headingCursorFix = EditorView.updateListener.of((update) => {
    if (!update.selectionSet || update.docChanged) return
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

  return [
    remoteCursorPositionsField,
    field,
    ...(showLineNumbers ? [blockAwareLineNumbers] : []),
    blockquoteExitKeymap,
    blockNavigationKeymap,
    headingCursorFix,
    EditorView.baseTheme({
      // Restore lineNumbers() base theme (removed when we replaced the extension).
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 3px 0 5px',
        minWidth: '20px',
        textAlign: 'right',
        color: 'var(--cm-lineNumber-color, #6c7086)',
        whiteSpace: 'nowrap',
      },
      '.vault-rendered-block': {
        padding: '2px 4px',
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
      '.vault-rendered-block h1, .vault-rendered-block h2, .vault-rendered-block h3': {
        margin: '0.25em 0',
      },
      '.vault-rendered-block p': {
        margin: '0.1em 0',
      },
      // Ligne d'un paragraphe rendu ligne par ligne : meme hauteur qu'une ligne brute.
      '.vault-paragraph-line': {
        padding: '0 4px',
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
        padding: '0 4px',
        lineHeight: '1.5',
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
