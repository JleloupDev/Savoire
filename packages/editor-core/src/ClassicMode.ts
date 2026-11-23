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
import { BLOCK_DESTROY_EVENT, BLOCK_ENTER_EVENT, sanitizeHtml } from '@savoire/plugin-api'
import type { BlockContext, BlockEditContext, BlockEnterDetail, BlockMenuItem, HookRegistry } from '@savoire/plugin-api'
import { findColumnsBlocks, linesOf, markdownUnits, modelOf, serializeModel, setColumnText, type ColumnsBlock } from './Columns'
import { columnContent, columnsElement, type FragmentOptions } from './NoteFragment'
import {
  deleteTableColumn, deleteTableRow, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, newColumnDelimiter, tableCells, tableLine, tableSize,
} from './TableRows'
import { applyTableWidths, tableResizers, tableWidthsIn, toPercents, withTableWidths, withoutTableWidths } from './TableWidths'

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
    renderMarkdown: base.renderMarkdown,
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
    leave: (dir: 1 | -1) => {
      const r = range()
      if (r) leaveObject(view, r, dir)
    },
  }
}

/**
 * Le curseur quitte un objet par les fleches : la ligne du dessous (1) ou
 * du dessus (-1), creee au bord de la note.
 */
export function leaveObject(view: EditorView, r: BlockRange, dir: 1 | -1): void {
  const doc = view.state.doc
  if (dir === 1) {
    const end = doc.lineAt(Math.min(r.to, doc.length))
    if (end.number < doc.lines) view.dispatch({ selection: { anchor: doc.line(end.number + 1).from }, scrollIntoView: true })
    else view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 }, scrollIntoView: true, userEvent: 'input' })
  } else {
    const start = doc.lineAt(r.from)
    if (start.number > 1) view.dispatch({ selection: { anchor: doc.line(start.number - 1).to }, scrollIntoView: true })
    else view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 }, scrollIntoView: true, userEvent: 'input' })
  }
  view.focus()
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

export { tableCells, tableLine }

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
  const lines = source.split('\n')
  const dashes = newColumnDelimiter(tableCells(lines[1] ?? ''))
  return lines.map((line, i) => {
    if (!line.trim()) return line
    const cells = tableCells(line)
    cells.push(i === 1 ? dashes : '')
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

/** Case a rouvrir dans le tableau redessine (apres un deplacement de ligne). */
const pendingCell = new WeakMap<EditorView, { pos: number; row: number; col: number }>()

/**
 * Les actions sur la ligne et la colonne d'une case : inserer, deplacer,
 * supprimer. `focus` rouvre la case qui suit l'operation.
 */
export function tableCellItems(view: EditorView, ctx: BlockEditContext, row: number, col: number, pos: number | null): BlockMenuItem[] {
  const { rows, cols } = tableSize(ctx.source())
  const apply = (next: (src: string) => string, focus?: { row: number; col: number }) => () => {
    // Une case ouverte s'enregistre d'abord, et le tableau pourra se redessiner.
    const open = document.activeElement as HTMLElement | null
    if (open?.classList?.contains('plume-table-cell')) open.blur()
    clearTableSelection()
    const src = ctx.source()
    const out = next(src)
    if (out === src) return
    if (focus && pos !== null) pendingCell.set(view, { pos, ...focus })
    ctx.replace(out)
  }
  const items: BlockMenuItem[] = [
    { id: 'table-row-above', label: 'Insérer une ligne au-dessus', run: apply(s => insertTableRow(s, row, false), { row, col }) },
    { id: 'table-row-below', label: 'Insérer une ligne au-dessous', run: apply(s => insertTableRow(s, row, true), { row: row + 1, col }) },
    { id: 'table-col-left', label: 'Insérer une colonne à gauche', separatorBefore: true, run: apply(s => insertTableColumn(s, col, false), { row, col }) },
    { id: 'table-col-right', label: 'Insérer une colonne à droite', run: apply(s => insertTableColumn(s, col, true), { row, col: col + 1 }) },
  ]
  if (row >= 1 && rows > 1) {
    if (row > 1) items.push({ id: 'table-row-up', label: 'Monter la ligne (Alt+↑)', separatorBefore: true, run: apply(s => moveTableRow(s, row, -1)) })
    if (row < rows) items.push({ id: 'table-row-down', label: 'Descendre la ligne (Alt+↓)', separatorBefore: row === 1, run: apply(s => moveTableRow(s, row, 1)) })
  }
  if (cols > 1) {
    const first = !items.some(i => i.id === 'table-row-up' || i.id === 'table-row-down')
    if (col > 0) items.push({ id: 'table-col-move-left', label: 'Déplacer la colonne à gauche (Alt+←)', separatorBefore: first, run: apply(s => moveTableColumn(s, col, -1)) })
    if (col < cols - 1) items.push({ id: 'table-col-move-right', label: 'Déplacer la colonne à droite (Alt+→)', separatorBefore: first && col === 0, run: apply(s => moveTableColumn(s, col, 1)) })
  }
  if (tableWidthsIn(ctx.source())[0]) {
    items.push({ id: 'table-widths-auto', label: 'Largeurs automatiques', separatorBefore: true, run: apply(s => withoutTableWidths(s)) })
  }
  if (row >= 1) items.push({ id: 'table-row-delete', label: 'Supprimer la ligne', separatorBefore: true, run: apply(s => deleteTableRow(s, row)) })
  if (cols > 1) items.push({ id: 'table-col-delete', label: 'Supprimer la colonne', separatorBefore: row < 1, run: apply(s => deleteTableColumn(s, col)) })
  return items
}

// ── Selection d'une ligne ou d'une colonne ──────────────────────────────────

/** La selection en cours (une seule dans la page) : l'enlever. */
let clearSelection: (() => void) | null = null
export function clearTableSelection(): void {
  clearSelection?.()
}

/**
 * Poignees d'un tableau rendu, comme dans Notion : au survol, une poignee a
 * gauche de la ligne et une au-dessus de la colonne. Un clic selectionne la
 * ligne ou la colonne et ouvre son menu ; Suppr ou Retour arriere la
 * supprime, Alt + fleche la deplace, Echap deselectionne. Le focus reste
 * dans la note : les touches sont lues tant que la selection dure.
 */
export function tableGrips(view: EditorView, box: HTMLElement, ctx: BlockEditContext, posOf: () => number | null): void {
  const table = box.querySelector('table')
  if (!table || ctx.readOnly) return
  const grip = (kind: 'row' | 'col') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.tabIndex = -1
    b.className = `plume-table-grip plume-table-grip-${kind}`
    b.dataset.testid = `table-${kind}-grip`
    b.title = kind === 'row' ? 'Sélectionner la ligne' : 'Sélectionner la colonne'
    b.textContent = kind === 'row' ? '⋮' : '⋯'
    b.hidden = true
    box.appendChild(b)
    return b
  }
  const rowGrip = grip('row')
  const colGrip = grip('col')
  let hoverRow = -1
  let hoverCol = -1

  const place = (cell: HTMLTableCellElement) => {
    const origin = box.getBoundingClientRect()
    const left0 = origin.left + box.clientLeft
    const top0 = origin.top + box.clientTop
    const t = table.getBoundingClientRect()
    const r = (cell.parentElement as HTMLTableRowElement).getBoundingClientRect()
    const c = cell.getBoundingClientRect()
    hoverRow = (cell.parentElement as HTMLTableRowElement).rowIndex
    hoverCol = cell.cellIndex
    rowGrip.style.left = `${t.left - left0 - 8}px`
    rowGrip.style.top = `${r.top - top0 + r.height / 2 - 9}px`
    colGrip.style.left = `${c.left - left0 + c.width / 2 - 9}px`
    colGrip.style.top = `${t.top - top0 - 8}px`
    rowGrip.hidden = false
    colGrip.hidden = false
  }
  box.addEventListener('mouseover', e => {
    const cell = (e.target as Element).closest?.('td, th') as HTMLTableCellElement | null
    if (cell && table.contains(cell)) place(cell)
  })
  box.addEventListener('mouseleave', () => {
    if (box.classList.contains('plume-table-selecting')) return
    rowGrip.hidden = true
    colGrip.hidden = true
  })

  const cellsOf = (kind: 'row' | 'col', index: number): HTMLElement[] =>
    kind === 'row'
      ? Array.from(table.rows[index]?.cells ?? [])
      : Array.from(table.rows).map(r => r.cells[index]).filter((c): c is HTMLTableCellElement => !!c)

  const select = (kind: 'row' | 'col', index: number, at: HTMLElement) => {
    clearTableSelection()
    const cells = cellsOf(kind, index)
    for (const c of cells) c.classList.add('plume-table-selected')
    box.classList.add('plume-table-selecting')
    const run = (next: (src: string) => string) => {
      clear()
      closeBlockMenu()
      const src = ctx.source()
      const out = next(src)
      if (out !== src) ctx.replace(out)
    }
    const remove = () => run(src => (kind === 'row' ? deleteTableRow(src, index) : deleteTableColumn(src, index)))
    const key = (e: KeyboardEvent) => {
      let handled = true
      if (e.key === 'Delete' || e.key === 'Backspace') remove()
      else if (e.key === 'Escape') { clear(); closeBlockMenu() }
      else if (e.altKey && kind === 'row' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) run(src => moveTableRow(src, index, e.key === 'ArrowUp' ? -1 : 1))
      else if (e.altKey && kind === 'col' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) run(src => moveTableColumn(src, index, e.key === 'ArrowLeft' ? -1 : 1))
      else handled = false
      if (handled) { e.preventDefault(); e.stopPropagation() }
      else if (!e.altKey && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) clear()
    }
    // Un clic ailleurs (pas dans le menu) deselectionne.
    const away = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('.plume-block-menu') || t === rowGrip || t === colGrip) return
      clear()
    }
    const clear = () => {
      for (const c of cells) c.classList.remove('plume-table-selected')
      box.classList.remove('plume-table-selecting')
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('mousedown', away, true)
      if (clearSelection === clear) clearSelection = null
    }
    clearSelection = clear
    window.addEventListener('keydown', key, true)
    window.addEventListener('mousedown', away, true)
    // Le menu de la ligne ou de la colonne, sous la poignee.
    const all = tableCellItems(view, ctx, kind === 'row' ? index : 1, kind === 'col' ? index : 0, posOf())
    const mine: BlockMenuItem[] = all.filter(i => (kind === 'row' ? /^table-row/ : /^table-col|^table-widths/).test(i.id))
      .map((i, n) => ({ ...i, separatorBefore: n > 0 && i.separatorBefore }))
    if (kind === 'row' && index === 0) {
      // L'en-tete : seulement une ligne dessous.
      mine.splice(0, mine.length, ...all.filter(i => i.id === 'table-row-below'))
    }
    for (const item of mine) {
      if (item.id === 'table-row-delete' || item.id === 'table-col-delete') item.label += ' (Suppr)'
    }
    const r = at.getBoundingClientRect()
    if (mine.length) showBlockMenu(mine, r.left, r.bottom + 4)
  }

  for (const [b, kind] of [[rowGrip, 'row'], [colGrip, 'col']] as const) {
    b.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      if (e.button !== 0) return
      const index = kind === 'row' ? hoverRow : hoverCol
      if (index >= 0) select(kind, index, b)
    })
  }
}

function caretAt(cell: HTMLElement, edge: 'start' | 'end'): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  const whole = document.createRange()
  whole.selectNodeContents(cell)
  if (edge === 'start') whole.setEnd(range.startContainer, range.startOffset)
  else whole.setStart(range.endContainer, range.endOffset)
  return whole.toString().length === 0
}

/**
 * Tableau rendu dont chaque case s'edite sur place, comme dans Obsidian :
 * un clic ouvre la case en texte, Tab passe a la suivante, Entree ajoute
 * une ligne dessous, Echap annule. Les fleches vont de case en case et sortent du tableau par
 * le haut ou le bas ; Alt + fleche deplace la ligne ou la colonne.
 */
export function editableTable(view: EditorView, html: string, ctx: BlockEditContext, hooks?: HookRegistry, text = ''): HTMLElement {
  const div = document.createElement('div')
  div.className = 'vault-rendered-block plume-table-object'
  div.innerHTML = sanitizeHtml(html)
  applyTableWidths(div, text)
  const table = div.querySelector('table')
  if (!table || ctx.readOnly) return div
  // Les bords des colonnes se tirent ; la largeur s'ecrit dans les tirets.
  tableResizers(div, percents => {
    const src = ctx.source()
    ctx.replace(percents ? withTableWidths(src, percents) : withoutTableWidths(src))
  })
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
  const lastRow = rows.length - 1
  const cellAt = (row: number, col: number): HTMLElement | null =>
    cells.find(c => Number(c.dataset.row) === row && Number(c.dataset.col) === col) ?? null
  const posOf = (): number | null => { try { return view.posAtDOM(div) } catch { return null } }

  const start = (cell: HTMLElement, caret: 'start' | 'end' = 'end') => {
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
      range.collapse(caret === 'start')
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const finish = (cell: HTMLElement, commit: boolean, next: HTMLElement | null, caret: 'start' | 'end' = 'end') => {
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
    if (next && div.contains(next)) start(next, caret)
    else endEditing(view, div)
  }

  /** Ferme la case, puis change le tableau ; il se redessine, la case `focus` rouverte. */
  const restructure = (cell: HTMLElement, next: (src: string) => string, focus: { row: number; col: number } | null) => {
    finish(cell, true, null)
    cell.blur()
    delete div.dataset.plumeEditing
    const src = ctx.source()
    const out = next(src)
    const pos = posOf()
    if (out === src) { start(cell); return }
    if (focus && pos !== null) pendingCell.set(view, { pos, ...focus })
    ctx.replace(out)
  }

  /** Quitter le tableau par une fleche : la note reprend le curseur. */
  const leave = (cell: HTMLElement, dir: 1 | -1) => {
    finish(cell, true, null)
    ctx.leave?.(dir)
  }

  // Le curseur de la note arrive par une fleche : la case de sa colonne.
  div.addEventListener(BLOCK_ENTER_EVENT, e => {
    const { dir, x } = (e as CustomEvent<BlockEnterDetail>).detail
    const row = dir === 1 ? 0 : lastRow
    const line = cells.filter(c => Number(c.dataset.row) === row)
    const hit = x === null ? null : line.find(c => { const r = c.getBoundingClientRect(); return r.width > 0 && x >= r.left && x < r.right })
    const target = hit ?? line[0]
    if (!target) return
    e.preventDefault()
    start(target, 'start')
  })

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
    const row = Number(cell.dataset.row)
    const col = Number(cell.dataset.col)
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
    // Alt + fleche : la ligne ou la colonne change de place, la case la suit.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.startsWith('Arrow')) {
      e.preventDefault()
      if (e.key === 'ArrowUp' && row > 1) restructure(cell, s => moveTableRow(s, row, -1), { row: row - 1, col })
      else if (e.key === 'ArrowDown' && row >= 1) restructure(cell, s => moveTableRow(s, row, 1), { row: row + 1, col })
      else if (e.key === 'ArrowLeft') restructure(cell, s => moveTableColumn(s, col, -1), { row, col: col - 1 })
      else if (e.key === 'ArrowRight') restructure(cell, s => moveTableColumn(s, col, 1), { row, col: col + 1 })
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      const other = cellAt(row + dir, col)
      if (other) { div.dataset.plumeEditing = '1'; finish(cell, true, other) }
      else leave(cell, dir)
    } else if (e.key === 'ArrowLeft' && caretAt(cell, 'start')) {
      const prev = cells[cells.indexOf(cell) - 1]
      if (!prev) return
      e.preventDefault()
      div.dataset.plumeEditing = '1'
      finish(cell, true, prev)
    } else if (e.key === 'ArrowRight' && caretAt(cell, 'end')) {
      const next = cells[cells.indexOf(cell) + 1]
      if (!next) return
      e.preventDefault()
      div.dataset.plumeEditing = '1'
      finish(cell, true, next, 'start')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1)
      const next = cells[i] ?? null
      // Tab apres la derniere case : une ligne de plus, comme un tableur.
      if (!next && !e.shiftKey) { restructure(cell, s => insertTableRow(s, row, true), { row: row + 1, col: 0 }); return }
      div.dataset.plumeEditing = '1'
      finish(cell, true, next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Entree : une nouvelle ligne sous celle-ci, on ecrit dans sa premiere case.
      restructure(cell, src => insertTableRow(src, row, true), { row: row + 1, col: 0 })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(cell, false, null)
      ctx.leave?.(1)
    }
  })

  // Poignees de ligne et de colonne : selectionner, puis supprimer ou deplacer.
  tableGrips(view, div, ctx, posOf)

  // Redessine apres un deplacement : la case deplacee se rouvre.
  requestAnimationFrame(() => {
    const want = pendingCell.get(view)
    if (!want || !div.isConnected || posOf() !== want.pos) return
    pendingCell.delete(view)
    const cell = cellAt(want.row, want.col)
    if (cell) start(cell)
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

export { toPercents }

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
