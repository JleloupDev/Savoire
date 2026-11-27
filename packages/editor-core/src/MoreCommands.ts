// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Commandes de l'editeur reprises d'Obsidian, sous le MEME identifiant : un
// raccourci importe d'un vault Obsidian (.obsidian/hotkeys.json) vise la meme
// action ici. La table complete Obsidian -> Savoire est dans
// packages/application/src/import/obsidian/obsidianCommands.ts.
//
// Fonctions pures sur le texte quand c'est possible (testees a part), puis
// les commandes qui les appliquent a la vue.
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import {
  addCursorAbove, addCursorBelow, cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorLineDown, cursorLineUp,
} from '@codemirror/commands'
import { findFrontmatter, setFrontmatterValue, type PluginCommand, type PluginCommandContext } from '@savoire/plugin-api'
import { hostOf } from './SubEditor'
import { multipleCursorsEnabled } from './EditingAids'
import {
  deleteTableColumn, deleteTableRow, insertTableColumn, insertTableRow, moveTableColumn, moveTableRow, tableAt, tableCells,
} from './TableRows'

// ── Texte ─────────────────────────────────────────────────────────────────

/**
 * Entoure la selection de `mark` (`$`, `%%`), ou retire la marque si la
 * selection en est deja entouree (dedans ou juste autour).
 */
export function toggleWrap(text: string, from: number, to: number, mark: string): { text: string; from: number; to: number } {
  const n = mark.length
  const inner = text.slice(from, to)
  if (inner.length >= 2 * n && inner.startsWith(mark) && inner.endsWith(mark)) {
    const out = inner.slice(n, -n)
    return { text: text.slice(0, from) + out + text.slice(to), from, to: from + out.length }
  }
  if (text.slice(from - n, from) === mark && text.slice(to, to + n) === mark) {
    return { text: text.slice(0, from - n) + inner + text.slice(to + n), from: from - n, to: to - n }
  }
  return { text: text.slice(0, from) + mark + inner + mark + text.slice(to), from: from + n, to: to + n }
}

const LIST_RE = /^(\s*)(?:([-*+])(?: \[([ xX])\])? )?/

/** Ligne suivante du cycle texte -> puce -> case a cocher -> texte (Obsidian « Cycle bullet/checkbox »). */
export function cycleListLine(line: string): string {
  const m = LIST_RE.exec(line)!
  const indent = m[1]
  const rest = line.slice(m[0].length)
  if (!m[2]) return `${indent}- ${rest}`
  if (m[3] === undefined) return `${indent}- [ ] ${rest}`
  return `${indent}${rest}`
}

/** La note sans son bloc de proprietes. */
export function withoutFrontmatter(text: string): string {
  const fm = findFrontmatter(text)
  return fm ? text.slice(fm.end) : text
}

// ── Tableaux ──────────────────────────────────────────────────────────────

/** Case du curseur dans le texte d'un tableau : ligne affichee (0 : en-tete) et colonne. */
export function tableCellAt(tableText: string, offset: number): { row: number; col: number } {
  const before = tableText.slice(0, offset)
  const lineIndex = before.split('\n').length - 1
  const line = tableText.split('\n')[lineIndex] ?? ''
  const lineStart = before.lastIndexOf('\n') + 1
  const upTo = line.slice(0, offset - lineStart)
  const lead = /^\s*\|/.test(line) ? 1 : 0
  const col = Math.max(0, (upTo.match(/(?<!\\)\|/g) ?? []).length - lead)
  // La ligne des tirets compte comme l'en-tete.
  return { row: lineIndex <= 1 ? 0 : lineIndex - 1, col }
}

/** Copie une ligne du corps juste dessous (l'en-tete ne se copie pas). */
export function copyTableRow(source: string, row: number): string {
  const lines = source.split('\n')
  if (row < 1 || row + 1 >= lines.length) return source
  lines.splice(row + 2, 0, lines[row + 1])
  return lines.join('\n')
}

/** Copie une colonne juste a droite. */
export function copyTableColumn(source: string, col: number): string {
  return source.split('\n').map(line => {
    if (!line.trim()) return line
    const cells = tableCells(line)
    if (col >= cells.length) return line
    cells.splice(col + 1, 0, cells[col])
    return `| ${cells.join(' | ')} |`
  }).join('\n')
}

/** Aligne une colonne : `:---`, `:---:`, `---:`. */
export function alignTableColumn(source: string, col: number, align: 'left' | 'center' | 'right'): string {
  const lines = source.split('\n')
  if (lines.length < 2) return source
  const cells = tableCells(lines[1])
  if (col >= cells.length) return source
  const dashes = cells[col].replace(/:/g, '') || '---'
  cells[col] = align === 'left' ? `:${dashes}` : align === 'right' ? `${dashes}:` : `:${dashes}:`
  lines[1] = `| ${cells.join(' | ')} |`
  return lines.join('\n')
}

type TableOp = (source: string, row: number, col: number) => string

/** Applique une operation au tableau du curseur (texte de la note, ou case ouverte d'un tableau rendu). */
function applyTableOp(view: EditorView, op: TableOp): boolean {
  const host = hostOf(view)
  let pos: number
  let cell: { row: number; col: number } | null = null
  if (host !== view) {
    const el = view.dom.closest<HTMLElement>('.plume-table-cell')
    if (!el) return false
    cell = { row: Number(el.dataset.row), col: Number(el.dataset.col) }
    pos = host.posAtDOM(el)
    // La case enregistre d'abord ce qui y est tape.
    view.contentDOM.blur()
  } else {
    pos = view.state.selection.main.head
  }
  const table = tableAt(host.state, pos)
  if (!table) return false
  const from = host.state.doc.lineAt(table.from).from
  const to = host.state.doc.lineAt(table.to).to
  const source = host.state.sliceDoc(from, to)
  const at = cell ?? tableCellAt(source, pos - from)
  const out = op(source, at.row, at.col)
  if (out === source) return true
  host.dispatch({ changes: { from, to, insert: out }, userEvent: 'input' })
  return true
}

// ── Commandes ─────────────────────────────────────────────────────────────

function replaceAll(view: EditorView, text: string): void {
  if (text === view.state.doc.toString()) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input' })
}

function wrapCommand(mark: string) {
  return (view: EditorView) => {
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.from)
    const r = toggleWrap(line.text, sel.from - line.from, Math.min(sel.to, line.to) - line.from, mark)
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: r.text },
      selection: EditorSelection.range(line.from + r.from, line.from + r.to),
      userEvent: 'input',
    })
  }
}

function insertMathBlock(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const before = line.text.trim() ? '\n\n' : ''
  const insert = `${before}$$\n\n$$\n`
  const at = line.text.trim() ? line.to : line.from
  view.dispatch({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: { anchor: at + before.length + 3 }, userEvent: 'input' })
}

function cycleList(view: EditorView): void {
  const { state } = view
  const sel = state.selection.main
  const first = state.doc.lineAt(sel.from).number
  const last = state.doc.lineAt(sel.to).number
  const changes = []
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    changes.push({ from: line.from, to: line.to, insert: cycleListLine(line.text) })
  }
  view.dispatch({ changes, userEvent: 'input' })
}

async function copySelection(view: EditorView, cut: boolean): Promise<void> {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  // Sans selection, toute la ligne (comme les editeurs de code).
  const range = sel.empty ? { from: line.from, to: Math.min(line.to + 1, view.state.doc.length) } : sel
  await navigator.clipboard?.writeText(view.state.sliceDoc(range.from, range.to))
  if (cut && !view.state.readOnly) view.dispatch({ changes: { from: range.from, to: range.to }, userEvent: 'delete.cut' })
}

async function pasteText(view: EditorView): Promise<void> {
  const text = await navigator.clipboard?.readText()
  if (text && !view.state.readOnly) view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true })
}

/**
 * Les commandes de l'editeur reprises d'Obsidian (memes identifiants).
 * `viewOf` : l'editeur vise par le contexte (celui de plumeCommands).
 */
export function obsidianEditorCommands(viewOf: (ctx: unknown) => EditorView | undefined): PluginCommand[] {
  const on = (act: (view: EditorView) => unknown) => (ctx: PluginCommandContext) => {
    const view = viewOf(ctx)
    if (view) void act(view)
  }
  const table = (op: TableOp) => on(v => applyTableOp(v, op))
  return [
    { id: 'editor:toggle-inline-math',  label: 'Formule en ligne ($…$)',            run: on(wrapCommand('$')) },
    { id: 'editor:insert-mathblock',    label: 'Bloc de formule ($$…$$)',           run: on(insertMathBlock) },
    { id: 'editor:toggle-comments',     label: 'Commentaire caché (%%…%%)',          run: on(wrapCommand('%%')) },
    { id: 'editor:cycle-list-checklist', label: 'Alterner texte, puce, case à cocher', run: on(cycleList) },
    { id: 'editor:go-start',            label: 'Aller au début de la note',          run: on(cursorDocStart) },
    { id: 'editor:go-end',              label: 'Aller à la fin de la note',          run: on(cursorDocEnd) },
    { id: 'editor:move-caret-up',       label: 'Curseur vers le haut',               run: on(cursorLineUp) },
    { id: 'editor:move-caret-down',     label: 'Curseur vers le bas',                run: on(cursorLineDown) },
    { id: 'editor:move-caret-left',     label: 'Curseur vers la gauche',             run: on(cursorCharLeft) },
    { id: 'editor:move-caret-right',    label: 'Curseur vers la droite',             run: on(cursorCharRight) },
    { id: 'editor:add-cursor-above',    label: 'Ajouter un curseur au-dessus', isAvailable: () => multipleCursorsEnabled(), run: on(addCursorAbove) },
    { id: 'editor:add-cursor-below',    label: 'Ajouter un curseur au-dessous', isAvailable: () => multipleCursorsEnabled(), run: on(addCursorBelow) },
    { id: 'editor:copy',                label: 'Copier',                             run: on(v => copySelection(v, false)) },
    { id: 'editor:cut',                 label: 'Couper',                             run: on(v => copySelection(v, true)) },
    { id: 'editor:paste',               label: 'Coller (texte)',                     run: on(pasteText) },
    { id: 'markdown:clear-metadata-properties', label: 'Retirer toutes les propriétés', run: on(v => replaceAll(hostOf(v), withoutFrontmatter(hostOf(v).state.doc.toString()))) },
    {
      id: 'markdown:add-alias', label: 'Ajouter un alias',
      run: on(v => {
        const host = hostOf(v)
        const text = host.state.doc.toString()
        if (!/^aliases\s*:/m.test(findFrontmatter(text)?.yaml ?? '')) replaceAll(host, setFrontmatterValue(text, 'aliases', []))
      }),
    },
    // Tableaux Markdown (le curseur dans le tableau, ou dans une case du tableau rendu).
    { id: 'editor:table-row-before',    label: 'Tableau : ligne au-dessus',          run: table((s, r) => insertTableRow(s, r, false)) },
    { id: 'editor:table-row-after',     label: 'Tableau : ligne au-dessous',         run: table((s, r) => insertTableRow(s, r, true)) },
    { id: 'editor:table-row-up',        label: 'Tableau : monter la ligne',          run: table((s, r) => moveTableRow(s, r, -1)) },
    { id: 'editor:table-row-down',      label: 'Tableau : descendre la ligne',       run: table((s, r) => moveTableRow(s, r, 1)) },
    { id: 'editor:table-row-copy',      label: 'Tableau : dupliquer la ligne',       run: table((s, r) => copyTableRow(s, r)) },
    { id: 'editor:table-row-delete',    label: 'Tableau : supprimer la ligne',       run: table((s, r) => deleteTableRow(s, r)) },
    { id: 'editor:table-col-before',    label: 'Tableau : colonne à gauche',         run: table((s, _r, c) => insertTableColumn(s, c, false)) },
    { id: 'editor:table-col-after',     label: 'Tableau : colonne à droite',         run: table((s, _r, c) => insertTableColumn(s, c, true)) },
    { id: 'editor:table-col-left',      label: 'Tableau : déplacer la colonne à gauche', run: table((s, _r, c) => moveTableColumn(s, c, -1)) },
    { id: 'editor:table-col-right',     label: 'Tableau : déplacer la colonne à droite', run: table((s, _r, c) => moveTableColumn(s, c, 1)) },
    { id: 'editor:table-col-copy',      label: 'Tableau : dupliquer la colonne',     run: table((s, _r, c) => copyTableColumn(s, c)) },
    { id: 'editor:table-col-delete',    label: 'Tableau : supprimer la colonne',     run: table((s, _r, c) => deleteTableColumn(s, c)) },
    { id: 'editor:table-col-align-left',   label: 'Tableau : aligner la colonne à gauche', run: table((s, _r, c) => alignTableColumn(s, c, 'left')) },
    { id: 'editor:table-col-align-center', label: 'Tableau : centrer la colonne',          run: table((s, _r, c) => alignTableColumn(s, c, 'center')) },
    { id: 'editor:table-col-align-right',  label: 'Tableau : aligner la colonne à droite', run: table((s, _r, c) => alignTableColumn(s, c, 'right')) },
  ]
}
