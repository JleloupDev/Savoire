// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mode classique de Plume (voir ADR-030) : les blocs (callout, tableau,
// colonnes, diagramme...) restent des objets rendus, meme quand le curseur
// passe dessus. On agit sur l'objet ; « Modifier la source » (clic droit,
// double clic) ouvre son texte brut, affiche comme du code, jusqu'a ce que
// le curseur en sorte.

import { EditorView, WidgetType, Decoration } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { marked } from 'marked'
import { BLOCK_DESTROY_EVENT, sanitizeHtml } from '@savoire/plugin-api'
import type { BlockContext, BlockEditContext, BlockMenuItem, HookRegistry } from '@savoire/plugin-api'
import { findColumnsBlocks, linesOf, markdownUnits, modelOf, serializeModel, setColumnText, type ColumnsBlock } from './Columns'
import { columnContent, columnsElement, type FragmentOptions } from './NoteFragment'

export interface BlockRange { from: number; to: number }

// ── Source ouverte ──────────────────────────────────────────────────────────

export const openSourceEffect = StateEffect.define<BlockRange>()
export const closeSourceEffect = StateEffect.define<void>()
/** Redessine les objets (apres une edition restee affichee telle quelle). */
export const refreshObjectsEffect = StateEffect.define<number>()

/** Blocs ouverts en texte brut par « Modifier la source ». */
export const sourceOpenField = StateField.define<readonly BlockRange[]>({
  create: () => [],
  update(ranges, tr) {
    let next = ranges
    if (tr.docChanged) next = next.map(r => ({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) }))
    for (const e of tr.effects) {
      if (e.is(openSourceEffect)) next = [...next.filter(r => r.to < e.value.from || r.from > e.value.to), e.value]
      if (e.is(closeSourceEffect)) next = []
    }
    // Le curseur sort du bloc : il redevient un objet.
    if (next.length && (tr.selection || tr.docChanged)) {
      const head = tr.state.selection.main.head
      next = next.filter(r => head >= r.from && head <= r.to)
    }
    return next.length === ranges.length && next.every((r, i) => r === ranges[i]) ? ranges : next
  },
})

/** Epoque de chaque objet (par sa position) : change pour forcer son redessin. */
export const objectEpochField = StateField.define<readonly { pos: number; n: number }[]>({
  create: () => [],
  update(list, tr) {
    let next = tr.docChanged ? list.map(e => ({ pos: tr.changes.mapPos(e.pos, 1), n: e.n })) : list
    for (const e of tr.effects) {
      if (!e.is(refreshObjectsEffect)) continue
      const old = next.find(x => x.pos === e.value)
      next = [...next.filter(x => x.pos !== e.value), { pos: e.value, n: (old?.n ?? 0) + 1 }]
    }
    return next
  },
})

/** Ouvre la source d'un bloc et y place le curseur. */
export function openSource(view: EditorView, range: BlockRange): void {
  view.dispatch({
    effects: openSourceEffect.of(range),
    selection: { anchor: range.from },
    scrollIntoView: true,
  })
  view.focus()
}

/** Ferme la source ouverte ; le curseur va a la ligne qui suit le bloc. */
export function closeSource(view: EditorView): boolean {
  const open = view.state.field(sourceOpenField, false)
  if (!open || open.length === 0) return false
  const end = open[open.length - 1].to
  const doc = view.state.doc
  const after = end < doc.length ? doc.lineAt(end).to + 1 : null
  view.dispatch({
    effects: closeSourceEffect.of(),
    ...(after !== null && after <= doc.length ? { selection: { anchor: after } } : { changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 } }),
  })
  return true
}

/** La barre « Terminé » sous une source ouverte : pas de numero de ligne. */
export class SourceDoneWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'plume-source-bar'
    const label = document.createElement('span')
    label.textContent = 'Source du bloc'
    const done = document.createElement('button')
    done.type = 'button'
    done.className = 'plume-source-done'
    done.dataset.testid = 'source-done'
    done.textContent = 'Terminé (Échap)'
    done.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      closeSource(view)
    })
    bar.append(label, done)
    return bar
  }
  ignoreEvent(): boolean { return true }
}

/** Les lignes d'un bloc ouvert, montrees comme du code. */
export function sourceDecorations(state: EditorState, range: BlockRange, out: Range<Decoration>[]): void {
  const first = state.doc.lineAt(range.from).number
  const last = state.doc.lineAt(Math.min(range.to, state.doc.length)).number
  for (let n = first; n <= last; n++) {
    const cls = ['plume-source-line']
    if (n === first) cls.push('plume-source-first')
    if (n === last) cls.push('plume-source-last')
    out.push(Decoration.line({ class: cls.join(' ') }).range(state.doc.line(n).from))
  }
  out.push(Decoration.widget({ widget: new SourceDoneWidget(), block: true, side: 1 }).range(state.doc.line(last).to))
}

// ── Objet rendu ─────────────────────────────────────────────────────────────

/** Un objet en cours d'edition garde son element, meme si sa source change. */
export function isEditing(dom: HTMLElement): boolean {
  return dom.dataset.plumeEditing === '1' || dom.contains(document.activeElement)
}

/**
 * Fin d'une edition dans un objet : si l'objet a ete garde tel quel pendant
 * qu'on ecrivait, il est redessine d'apres sa source.
 */
export function endEditing(view: EditorView, dom: HTMLElement): void {
  delete dom.dataset.plumeEditing
  if (dom.dataset.plumeStale !== '1') return
  delete dom.dataset.plumeStale
  if (!dom.isConnected) return
  let pos: number
  try { pos = view.posAtDOM(dom) } catch { return }
  // Hors de l'evenement en cours (focusout) : CodeMirror peut etre en pleine mise a jour.
  queueMicrotask(() => { try { view.dispatch({ effects: refreshObjectsEffect.of(pos) }) } catch { /* vue fermee */ } })
}

/**
 * Un bloc rendu en mode classique. La vue s'occupe seule de ses evenements :
 * l'editeur n'y pose pas le curseur.
 */
export class ObjectWidget extends WidgetType {
  constructor(
    private readonly key: string,
    private readonly epoch: number,
    private readonly build: (view: EditorView) => HTMLElement,
    private readonly fallback: () => HTMLElement,
  ) {
    super()
  }

  eq(other: ObjectWidget): boolean {
    return other.key === this.key && other.epoch === this.epoch
  }

  toDOM(view: EditorView): HTMLElement {
    let el: HTMLElement
    try {
      el = this.build(view)
    } catch (err) {
      console.debug('[LivePreview] object render error:', err)
      el = this.fallback()
    }
    el.classList.add('plume-object')
    return el
  }

  updateDOM(dom: HTMLElement): boolean {
    // On ecrit dedans : garder l'element (et le focus), le redessiner apres.
    if (isEditing(dom)) {
      dom.dataset.plumeStale = '1'
      return true
    }
    return false
  }

  destroy(dom: HTMLElement): void {
    dom.dispatchEvent(new CustomEvent(BLOCK_DESTROY_EVENT))
    for (const el of Array.from(dom.querySelectorAll('.plume-plugin-render'))) el.dispatchEvent(new CustomEvent(BLOCK_DESTROY_EVENT))
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Le contexte d'edition d'un objet : sa source, retrouvee a chaque appel. */
export function editContext(
  view: EditorView,
  base: BlockContext,
  range: () => BlockRange | null,
): BlockEditContext {
  return {
    editorView: view,
    edit: base.edit,
    locate: base.locate,
    readOnly: view.state.readOnly,
    source: () => {
      const r = range()
      return r ? view.state.sliceDoc(r.from, r.to) : ''
    },
    replace: (next: string) => {
      const r = range()
      if (!r || view.state.readOnly) return
      if (view.state.sliceDoc(r.from, r.to) === next) return
      view.dispatch({ changes: { from: r.from, to: r.to, insert: next }, userEvent: 'input' })
    },
    editSource: () => {
      const r = range()
      if (r) openSource(view, r)
    },
  }
}

// ── Menu d'un bloc ──────────────────────────────────────────────────────────

let openMenu: HTMLElement | null = null

export function closeBlockMenu(): void {
  openMenu?.remove()
  openMenu = null
}

/** Menu flottant (clic droit, poignee). Se ferme au premier clic ailleurs. */
export function showBlockMenu(items: readonly BlockMenuItem[], x: number, y: number): HTMLElement {
  closeBlockMenu()
  const menu = document.createElement('div')
  menu.className = 'plume-block-menu'
  menu.dataset.testid = 'block-menu'
  menu.setAttribute('role', 'menu')
  menu.style.cssText = [
    'position:fixed', 'z-index:10000', 'min-width:190px', 'padding:4px',
    'background:var(--bg-elevated, #252535)', 'color:var(--text, #cdd6f4)',
    'border:1px solid var(--border, #3d3d5c)', 'border-radius:8px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.3)', 'font-size:13px',
  ].join(';')
  for (const item of items) {
    if (item.separatorBefore && menu.childElementCount > 0) {
      const sep = document.createElement('div')
      sep.style.cssText = 'height:1px;margin:4px 2px;background:var(--border, #3d3d5c)'
      menu.appendChild(sep)
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.dataset.testid = `block-menu-${item.id}`
    b.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer'
    const check = document.createElement('span')
    check.style.cssText = 'width:1em;flex:0 0 auto;opacity:0.8'
    check.textContent = item.checked ? '✓' : ''
    const label = document.createElement('span')
    label.textContent = item.label
    b.append(check, label)
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-hover, rgba(127,127,127,0.15))' })
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
    b.addEventListener('mousedown', e => e.preventDefault())
    b.addEventListener('click', e => {
      e.preventDefault()
      closeBlockMenu()
      item.run()
    })
    menu.appendChild(b)
  }
  document.body.appendChild(menu)
  // Reste dans la fenetre.
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`
  openMenu = menu
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return
    if (e.target instanceof Node && menu.contains(e.target) && !(e instanceof KeyboardEvent)) return
    window.removeEventListener('mousedown', away, true)
    window.removeEventListener('keydown', away, true)
    window.removeEventListener('blur', away)
    if (openMenu === menu) closeBlockMenu()
  }
  setTimeout(() => {
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', away, true)
    window.addEventListener('blur', away)
  })
  return menu
}

// ── Tableau modifiable ──────────────────────────────────────────────────────

/** Les cases d'une ligne de tableau, barres echappees comprises. */
export function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map(c => c.trim())
}

function tableLine(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`
}

/**
 * Le tableau apres la modification d'une case. `row` compte les lignes
 * affichees : 0 pour l'en-tete, 1 pour la premiere ligne du corps.
 */
export function setTableCell(source: string, row: number, col: number, value: string): string {
  const lines = source.split('\n')
  const index = row === 0 ? 0 : row + 1
  if (index >= lines.length) return source
  const width = tableCells(lines[0]).length
  const cells = tableCells(lines[index])
  while (cells.length < width) cells.push('')
  const clean = value.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim()
  if (cells[col] === clean) return source
  cells[col] = clean
  lines[index] = tableLine(cells)
  return lines.join('\n')
}

/** Le tableau avec une colonne vide de plus, a droite. */
export function appendTableColumnText(source: string): string {
  return source.split('\n').map((line, i) => {
    if (!line.trim()) return line
    const cells = tableCells(line)
    cells.push(i === 1 ? '---' : '')
    return tableLine(cells)
  }).join('\n')
}

/** La case brute qu'affiche une cellule du rendu. */
export function tableCellSource(source: string, row: number, col: number): string {
  const lines = source.split('\n')
  const index = row === 0 ? 0 : row + 1
  return (tableCells(lines[index] ?? '')[col] ?? '').replace(/\\\|/g, '|')
}

function inlineHtml(text: string, hooks?: HookRegistry): string {
  return sanitizeHtml(marked.parseInline(hooks ? hooks.runBeforeParseSync(text) : text) as string)
}

/**
 * Tableau rendu dont chaque case s'edite sur place, comme dans Obsidian :
 * un clic ouvre la case en texte, Tab passe a la suivante, Entree valide,
 * Echap annule.
 */
export function editableTable(view: EditorView, html: string, ctx: BlockEditContext, hooks?: HookRegistry): HTMLElement {
  const div = document.createElement('div')
  div.className = 'vault-rendered-block plume-table-object'
  div.innerHTML = sanitizeHtml(html)
  const table = div.querySelector('table')
  if (!table || ctx.readOnly) return div
  const rows = Array.from(table.querySelectorAll('tr'))
  const cells: HTMLElement[] = []
  rows.forEach((tr, r) => {
    Array.from(tr.children).forEach((cell, c) => {
      const el = cell as HTMLElement
      el.dataset.row = String(r)
      el.dataset.col = String(c)
      el.classList.add('plume-table-cell')
      cells.push(el)
    })
  })

  const start = (cell: HTMLElement) => {
    if (cell.isContentEditable) return
    const raw = tableCellSource(ctx.source(), Number(cell.dataset.row), Number(cell.dataset.col))
    cell.dataset.raw = raw
    cell.textContent = raw
    try { cell.contentEditable = 'plaintext-only' } catch { cell.contentEditable = 'true' }
    if (cell.contentEditable !== 'plaintext-only') cell.contentEditable = 'true'
    cell.focus()
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(cell)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const finish = (cell: HTMLElement, commit: boolean, next: HTMLElement | null) => {
    if (!cell.isContentEditable) return
    const value = (cell.textContent ?? '').trim()
    cell.contentEditable = 'false'
    cell.removeAttribute('contenteditable')
    const raw = cell.dataset.raw ?? ''
    delete cell.dataset.raw
    // On reste dans le tableau : il garde son element pendant l'ecriture.
    if (next && div.contains(next)) div.dataset.plumeEditing = '1'
    cell.innerHTML = inlineHtml(commit ? value : raw, hooks) || '&nbsp;'
    if (commit && value !== raw) {
      ctx.replace(setTableCell(ctx.source(), Number(cell.dataset.row), Number(cell.dataset.col), value))
    }
    if (next && div.contains(next)) start(next)
    else endEditing(view, div)
  }

  div.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    const cell = (e.target as Element).closest?.('.plume-table-cell') as HTMLElement | null
    if (!cell || (e.target as Element).closest('a, input, button')) return
    if (cell.isContentEditable) return
    e.preventDefault()
    start(cell)
  })
  div.addEventListener('focusout', e => {
    const cell = e.target as HTMLElement
    if (!cell.classList?.contains('plume-table-cell')) return
    const next = e.relatedTarget as HTMLElement | null
    finish(cell, true, next?.classList?.contains('plume-table-cell') ? next : null)
  })
  div.addEventListener('keydown', e => {
    const cell = e.target as HTMLElement
    if (!cell.classList?.contains('plume-table-cell') || !cell.isContentEditable) return
    e.stopPropagation()
    // Tout selectionner : la case seulement, pas la note.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(cell)
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1)
      const next = cells[i] ?? null
      div.dataset.plumeEditing = '1'
      finish(cell, true, next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Entree : la case du dessous, comme un tableur.
      const below = cells.find(c => c.dataset.col === cell.dataset.col && Number(c.dataset.row) === Number(cell.dataset.row) + 1) ?? null
      if (below) div.dataset.plumeEditing = '1'
      finish(cell, true, below)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(cell, false, null)
    }
  })
  return div
}

// ── Zone de texte qui grandit ───────────────────────────────────────────────

/** Une zone de texte a la hauteur de son contenu. */
export function growingTextarea(value: string, className: string): HTMLTextAreaElement {
  const area = document.createElement('textarea')
  area.className = className
  area.value = value
  area.spellcheck = true
  area.rows = Math.max(2, value.split('\n').length)
  const fit = () => {
    area.style.height = 'auto'
    area.style.height = `${area.scrollHeight + 2}px`
  }
  area.addEventListener('input', fit)
  requestAnimationFrame(fit)
  return area
}

// ── Colonnes modifiables ────────────────────────────────────────────────────

const autoOpened = new WeakMap<EditorView, number>()

const INTERACTIVE = 'a, button, input, select, textarea, iframe, [contenteditable="true"], [contenteditable="plaintext-only"]'

/**
 * Colonnes du mode classique. Un clic dans une colonne l'ouvre en texte
 * (son Markdown seul, sans les marques du bloc) ; en sortir la rend.
 */
export function editableColumns(view: EditorView, block: ColumnsBlock, ctx: BlockEditContext, opts: FragmentOptions): HTMLElement {
  const root = columnsElement(block, t => columnContent(t, opts))
  if (ctx.readOnly) return root
  const current = (): ColumnsBlock | null => findColumnsBlocks(linesOf(ctx.source()))[0] ?? null

  const edit = (col: HTMLElement, i: number) => {
    if (col.querySelector('textarea')) return
    const area = growingTextarea(current()?.columns[i]?.text ?? '', 'plume-column-editor')
    area.dataset.testid = 'column-editor'
    col.replaceChildren(area)
    root.dataset.plumeEditing = '1'
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
    let timer: ReturnType<typeof setTimeout> | null = null
    const commit = (final: boolean) => {
      if (timer) { clearTimeout(timer); timer = null }
      const b = current()
      if (!b) return
      if (!final && !area.value.trim()) return
      const model = modelOf(b)
      setColumnText(model, i, area.value)
      ctx.replace(serializeModel(model))
    }
    area.addEventListener('input', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => commit(false), 500)
    })
    area.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); area.blur() }
    })
    area.addEventListener('blur', () => {
      commit(true)
      // Toujours redessiner : la colonne redevient un rendu.
      root.dataset.plumeStale = '1'
      endEditing(view, root)
    })
  }

  const cols = Array.from(root.querySelectorAll<HTMLElement>('.plume-column'))
  columnResizers(view, root, ctx)
  cols.forEach(col => {
    if (col.childElementCount === 0) {
      const hint = document.createElement('div')
      hint.className = 'plume-column-empty'
      hint.textContent = 'Cliquer pour écrire'
      col.appendChild(hint)
    }
    col.addEventListener('mousedown', e => {
      const interactive = (e.target as Element).closest?.(INTERACTIVE)
      if (e.button !== 0 || (interactive && col.contains(interactive))) return
      e.preventDefault()
      edit(col, Number(col.dataset.col))
    })
  })
  // Le curseur est dans le bloc (il vient d'etre insere) : sa colonne s'ouvre.
  // Une seule fois par position du curseur : la colonne refermee ne se rouvre pas.
  const head = view.state.selection.main.head
  if (head > block.from && head < block.to && view.hasFocus && autoOpened.get(view) !== head) {
    autoOpened.set(view, head)
    const i = block.columns.findIndex(c => head >= c.from && head <= c.to)
    if (i >= 0 && cols[i]) requestAnimationFrame(() => { if (root.isConnected) edit(cols[i], i) })
  }
  return root
}

export function isClassicEffect(e: StateEffect<unknown>): boolean {
  return e.is(openSourceEffect) || e.is(closeSourceEffect) || e.is(refreshObjectsEffect)
}

// ── Rendus dans une colonne ─────────────────────────────────────────────────

/**
 * Le texte d'ou vient un rendu place dans une colonne (une image qu'on
 * redimensionne) : son bloc dans la colonne, en positions de la note.
 */
export function locateInColumns(view: EditorView, el: HTMLElement): { from: number; to: number; text: string } | null {
  if (view.state.readOnly) return null
  const wrap = el.closest('.plume-columns-wrap') as HTMLElement | null
  const colEl = el.closest('.plume-column') as HTMLElement | null
  const unitEl = el.closest('.plume-column-unit') as HTMLElement | null
  if (!wrap || !colEl || !unitEl) return null
  let pos: number
  try { pos = view.posAtDOM(wrap) } catch { return null }
  const block = findColumnsBlocks(view.state.doc).find(b => b.from === pos)
  const column = block?.columns[Number(colEl.dataset.col)]
  if (!column) return null
  const raw = view.state.sliceDoc(column.from, column.to)
  const unit = markdownUnits(raw)[Number(unitEl.dataset.unit)]
  if (!unit) return null
  const from = column.from + unit.from
  const to = column.from + unit.to
  return { from, to, text: view.state.sliceDoc(from, to) }
}

// ── Largeur des colonnes ────────────────────────────────────────────────────

/** Des largeurs relatives en pourcentages entiers, qui font 100. */
export function toPercents(widths: readonly number[]): number[] {
  const total = widths.reduce((a, b) => a + b, 0) || 1
  const raw = widths.map(w => (w / total) * 100)
  const out = raw.map(Math.floor)
  // Le reste va aux colonnes les plus proches de l'entier superieur.
  let rest = 100 - out.reduce((a, b) => a + b, 0)
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
  for (const { i } of order) { if (rest <= 0) break; out[i]++; rest-- }
  return out
}

/** Le bloc avec de nouvelles largeurs (en %), colonnes vides comprises. */
export function withColumnWidths(source: string, percents: readonly number[]): string {
  const block = findColumnsBlocks(linesOf(source))[0]
  if (!block) return source
  const model = modelOf(block)
  while (model.columns.length < percents.length) model.columns.push([])
  model.header = percents.map(p => `${p}%`).join(' ')
  return serializeModel(model)
}

/**
 * Poignees entre les colonnes : on tire, les deux colonnes voisines
 * changent de largeur ; au lacher, l'en-tete du bloc prend les
 * pourcentages (`::: colonnes 30% 70%`).
 */
function columnResizers(view: EditorView, root: HTMLElement, ctx: BlockEditContext): void {
  const grid = root.querySelector('.plume-columns') as HTMLElement | null
  if (!grid) return
  const cols = Array.from(grid.querySelectorAll<HTMLElement>(':scope > .plume-column'))
  if (cols.length < 2) return
  cols.slice(0, -1).forEach((col, i) => {
    const bar = document.createElement('div')
    bar.className = 'plume-column-resizer'
    bar.dataset.testid = 'column-resizer'
    bar.title = 'Glisser pour changer la largeur'
    col.appendChild(bar)
    bar.addEventListener('mousedown', e => e.stopPropagation())
    bar.addEventListener('pointerdown', down => {
      if (down.button !== 0) return
      down.preventDefault()
      down.stopPropagation()
      bar.setPointerCapture(down.pointerId)
      const rects = cols.map(c => c.getBoundingClientRect().width)
      const pair = rects[i] + rects[i + 1]
      const startX = down.clientX
      const label = document.createElement('div')
      label.className = 'plume-column-width'
      col.appendChild(label)
      root.dataset.plumeEditing = '1'
      let percents = toPercents(rects)
      const show = () => {
        grid.style.gridTemplateColumns = percents.map(p => `minmax(0, ${p}fr)`).join(' ')
        label.textContent = percents.map(p => `${p} %`).join(' · ')
      }
      show()
      const move = (ev: PointerEvent) => {
        const min = pair * 0.1
        const left = Math.max(min, Math.min(pair - min, rects[i] + ev.clientX - startX))
        const next = [...rects]
        next[i] = left
        next[i + 1] = pair - left
        percents = toPercents(next)
        show()
      }
      const up = () => {
        bar.removeEventListener('pointermove', move)
        bar.removeEventListener('pointerup', up)
        bar.removeEventListener('pointercancel', up)
        label.remove()
        root.dataset.plumeStale = '1'
        ctx.replace(withColumnWidths(ctx.source(), percents))
        endEditing(view, root)
      }
      bar.addEventListener('pointermove', move)
      bar.addEventListener('pointerup', up)
      bar.addEventListener('pointercancel', up)
    })
  })
}
