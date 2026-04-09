// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Live preview extension — renders Markdown blocks as HTML widgets in CodeMirror.
// see ADR-005

import { EditorView, Decoration, DecorationSet, WidgetType, keymap, gutter, GutterMarker } from '@codemirror/view'
import { StateField, StateEffect, EditorState, Range, Prec } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

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
import type { BlockRegistry, BlockContext, HookRegistry } from '@savoire/plugin-api'

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

function getFrontmatterEnd(state: EditorState): number {
  const text = state.doc.toString()
  if (!text.startsWith('---\n')) return 0
  const closeIdx = text.indexOf('\n---', 4)
  if (closeIdx < 0) return 0
  return closeIdx + 4 + (text[closeIdx + 4] === '\n' ? 1 : 0)
}

function buildFrontmatterDecoration(state: EditorState): Range<Decoration> | null {
  const endPos = getFrontmatterEnd(state)
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
  constructor(private readonly html: string) {
    super()
  }

  eq(other: MarkdownWidget): boolean {
    return this.html === other.html
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = 'vault-rendered-block'
    div.innerHTML = this.html
    return div
  }

  ignoreEvent(e: Event): boolean {
    return e.type !== 'click' && e.type !== 'mousedown'
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

  // Compute frontmatter range (null if cursor is inside or no frontmatter)
  const fmEnd = getFrontmatterEnd(state)
  const fmDeco = buildFrontmatterDecoration(state)

  syntaxTree(state).iterate({
    enter(node) {
      if (!BLOCK_NODES.has(node.type.name)) return
      // Skip nodes inside collapsed frontmatter to avoid overlapping decorations
      if (fmDeco && node.from < fmEnd) return false

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
        const html = marked.parse(preprocessed) as string
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

  if (fmDeco) decorations.unshift(fmDeco)

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
    return new BlockLineNumberMarker(first, last)
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
      if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(pluginsLoadedEffect))) {
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
      '.vault-rendered-block blockquote': {
        borderLeft: '3px solid #7c3aed',
        paddingLeft: '1em',
        margin: '0.5em 0',
        color: '#9ca3af',
      },
    }),
  ]
}
