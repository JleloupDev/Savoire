// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un morceau de note rendu d'un seul coup : chaque bloc de premier niveau
// par le plugin qui le revendique, sinon en Markdown, et les colonnes en
// colonnes. Sert a l'export (PDF, page publique) et au contenu des colonnes
// dans l'editeur.
import { markdownLanguage } from '@codemirror/lang-markdown'
import { marked } from 'marked'
import { sanitizeHtml } from '@savoire/plugin-api'
import type { BlockContext, BlockRegistry, HookRegistry } from '@savoire/plugin-api'
import { columnWidths, findColumnsBlocks, linesOf, markdownUnits, type ColumnsBlock } from './Columns'

export const BLOCK_NODES = new Set([
  'Paragraph',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3',
  'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'BulletList', 'OrderedList',
  'Blockquote',
  'FencedCode',
  'HorizontalRule',
  'Table',
])

export interface FragmentOptions {
  registry?: BlockRegistry | null
  hooks?: HookRegistry | null
  /** Plugins actifs dans cette note (null : tous). */
  activeIds?: Set<string> | null
  ctx?: BlockContext
  /** Types de blocs de plugins rendus en Markdown simple (le code a l'impression). */
  asMarkdown?: ReadonlySet<string>
  /** Classe de la boite autour d'un bloc de plugin. */
  pluginBoxClass?: string
}

export function markdownBlock(text: string, hooks?: HookRegistry | null): HTMLElement {
  const div = document.createElement('div')
  div.className = 'vault-rendered-block'
  const pre = hooks ? hooks.runBeforeParseSync(text) : text
  div.innerHTML = sanitizeHtml(String(marked.parse(pre, { breaks: true })))
  return div
}

/**
 * Le contexte d'un plugin, avec `renderMarkdown` pour rendre son contenu
 * (le corps d'un callout). Ce contenu est en lecture seule : ses blocs ne
 * savent pas ou ils sont dans la note, ils n'y ecrivent pas.
 */
export function withMarkdown(base: BlockContext, opts: FragmentOptions): BlockContext {
  if (base.renderMarkdown) return base
  const inner: BlockContext = {
    get editorView() { return base.editorView },
    renderMarkdown: (markdown: string) => {
      const root = document.createElement('div')
      root.className = 'plume-fragment'
      renderFragmentInto(root, markdown, { ...opts, ctx: inner })
      return root
    },
  }
  // Le reste (edit, locate...) vient de `base`, lu au moment de l'appel.
  const ctx = Object.create(base) as BlockContext
  ctx.renderMarkdown = inner.renderMarkdown
  return ctx
}

/** Un bloc de premier niveau : rendu de son plugin, sinon Markdown. */
export function renderUnit(chunk: string, nodeName: string | null, opts: FragmentOptions): HTMLElement {
  const detected = (nodeName === null || BLOCK_NODES.has(nodeName)) && opts.registry
    ? (opts.registry.detectActive ? opts.registry.detectActive(chunk, opts.activeIds ?? null) : opts.registry.detectBlock(chunk))
    : null
  // Une liste a cocher (rendu ligne par ligne) : Markdown suffit.
  if (detected && !detected.spec.renderLine && !opts.asMarkdown?.has(detected.spec.type)) {
    try {
      const el = detected.spec.renderClient(detected.spec.deserialize(chunk), withMarkdown(opts.ctx ?? { editorView: null }, opts))
      el.classList.add('plume-plugin-render')
      if (!opts.pluginBoxClass) return el
      const box = document.createElement('div')
      box.className = opts.pluginBoxClass
      box.appendChild(el)
      return box
    } catch {
      // Rendu impossible : le texte, en Markdown.
    }
  }
  return markdownBlock(chunk, opts.hooks)
}

/** Les colonnes d'un bloc, chacune remplie par `fill`. */
export function columnsElement(block: ColumnsBlock, fill: (text: string, col: number) => HTMLElement): HTMLElement {
  const widths = columnWidths(block.header, block.columns.length)
  // L'enveloppe mesure la place disponible : etroite (telephone, panneau
  // etroit), les colonnes passent l'une sous l'autre.
  const wrap = document.createElement('div')
  wrap.className = 'plume-columns-wrap'
  const root = document.createElement('div')
  root.className = 'plume-columns'
  wrap.appendChild(root)
  // Grille en style direct : la page publique la garde sans feuille de style.
  root.style.display = 'grid'
  root.style.gap = '1.25em'
  root.style.alignItems = 'start'
  root.style.gridTemplateColumns = widths.map(w => `minmax(0, ${w}fr)`).join(' ')
  widths.forEach((_, i) => {
    const text = block.columns[i]?.text ?? ''
    const col = fill(text, i)
    col.classList.add('plume-column')
    col.dataset.col = String(i)
    root.appendChild(col)
  })
  return wrap
}

/** Le contenu d'une colonne : ses blocs, chacun marque de sa place. */
export function columnContent(text: string, opts: FragmentOptions): HTMLElement {
  const col = document.createElement('div')
  markdownUnits(text).forEach((u, j) => {
    const chunk = text.slice(u.from, u.to)
    const name = markdownLanguage.parser.parse(chunk).topNode.firstChild?.name ?? null
    const el = renderUnit(chunk, name, opts)
    el.dataset.unit = String(j)
    el.classList.add('plume-column-unit')
    col.appendChild(el)
  })
  return col
}

/** Rend `text` dans `root`, bloc par bloc, colonnes comprises. */
export function renderFragmentInto(root: HTMLElement, text: string, opts: FragmentOptions): void {
  const blocks = findColumnsBlocks(linesOf(text))
  let at = 0
  for (const block of [...blocks, null]) {
    const end = block ? block.from : text.length
    if (end > at) renderPlain(root, text.slice(at, end), opts)
    if (!block) break
    root.appendChild(columnsElement(block, t => columnContent(t, opts)))
    at = block.to
  }
}

function renderPlain(root: HTMLElement, body: string, opts: FragmentOptions): void {
  const cursor = markdownLanguage.parser.parse(body).topNode.cursor()
  if (!cursor.firstChild()) return
  do {
    const chunk = body.slice(cursor.from, cursor.to)
    if (chunk.trim()) root.appendChild(renderUnit(chunk, cursor.type.name, opts))
  } while (cursor.nextSibling())
}

/** Regles des colonnes, communes a l'editeur et a l'export. */
export const COLUMNS_CSS = `
.plume-columns-wrap { container-type: inline-size; }
.plume-columns { display: grid; gap: 1.25em; align-items: start; margin: 4px 0; }
.plume-column { min-width: 0; }
.plume-column img, .plume-column video { max-width: 100%; height: auto; }
@container (max-width: 480px) { .plume-columns { grid-template-columns: 1fr !important; } .plume-column-resizer { display: none; } }
`
