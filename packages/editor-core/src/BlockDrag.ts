// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Glisser-deposer des lignes et des blocs, comme dans Notion (mode classique,
// voir ADR-030). Une poignee apparait a gauche de la ligne survolee :
//   - on la tire entre deux lignes : la ligne (ou le bloc) s'y deplace ;
//   - sur le bord droit ou gauche d'une ligne : les deux se mettent en colonnes ;
//   - dans une colonne : le bloc y entre ; sur son bord : nouvelle colonne.
// Un clic sur la poignee ouvre le menu du bloc.
//
// Le calcul du deplacement (planDrop) ne connait que le texte : il est teste
// a part. Le reste suit la souris.

import { EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import {
  findColumnsBlocks, insertColumn, insertUnit, linesOf, modelOf, newColumns, removeUnit, serializeModel,
  type ColumnsModel,
} from './Columns'

// ── Le deplacement, sur le texte ────────────────────────────────────────────

export interface Range { from: number; to: number }

/** Ce qu'on tire. */
export type DragSource =
  /** Des lignes entieres de la note (une ligne, un element de liste, un bloc). */
  | { kind: 'range'; from: number; to: number; block: boolean }
  /** Un bloc dans une colonne. */
  | { kind: 'column-unit'; block: Range; col: number; unit: number }

/** La ou on le lache. */
export type DropTarget =
  /** Avant la ligne qui commence a `pos` (ou a la fin de la note). */
  | { kind: 'between'; pos: number }
  /** A cote d'une ligne ou d'un bloc : les deux passent en colonnes. */
  | { kind: 'side'; target: Range; side: 'left' | 'right' }
  /** Dans une colonne, avant son bloc `unit`. */
  | { kind: 'into-column'; block: Range; col: number; unit: number }
  /** Une nouvelle colonne a la place `col`. */
  | { kind: 'new-column'; block: Range; col: number }

export interface Change { from: number; to: number; insert: string }

const LIST_LINE_RE = /^(\s*)([-*+]|\d+[.)])\s/

function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length)
  const min = indents.length ? Math.min(...indents) : 0
  return min ? lines.map(l => l.slice(Math.min(min, l.length - l.trimStart().length))).join('\n') : text
}

function lineStart(doc: string, pos: number): number {
  return doc.lastIndexOf('\n', pos - 1) + 1
}

function lineEnd(doc: string, pos: number): number {
  const i = doc.indexOf('\n', pos)
  return i < 0 ? doc.length : i
}

function lineAt(doc: string, pos: number): string {
  return doc.slice(lineStart(doc, pos), lineEnd(doc, pos))
}

function blockAt(doc: string, range: Range): ColumnsModel | null {
  const found = findColumnsBlocks(linesOf(doc)).find(b => b.from === range.from && b.to === range.to)
  return found ? modelOf(found) : null
}

/** Un bloc de colonnes ne contient pas un autre bloc de colonnes. */
function isColumnsText(text: string): boolean {
  return /^:{3,}[ \t]*(colonnes|columns)\b/i.test(text)
}

/**
 * Les modifications qui deplacent `source` vers `target`, dans les
 * coordonnees du texte de depart. Null si le depot n'a pas de sens (sur
 * lui-meme, colonnes dans des colonnes...).
 */
export function planDrop(doc: string, source: DragSource, target: DropTarget): Change[] | null {
  // Le texte deplace.
  let text: string
  let sourceModel: ColumnsModel | null = null
  if (source.kind === 'range') {
    text = doc.slice(source.from, source.to)
  } else {
    sourceModel = blockAt(doc, source.block)
    const unit = sourceModel?.columns[source.col]?.[source.unit]
    if (!sourceModel || unit === undefined) return null
    text = unit
  }
  text = dedent(text)
  const blockish = source.kind === 'column-unit' || source.block
  const changes: Change[] = []

  // Retirer la source, sauf si elle et la cible sont le meme bloc de colonnes.
  const sameBlock = source.kind === 'column-unit'
    && (target.kind === 'into-column' || target.kind === 'new-column')
    && target.block.from === source.block.from
  if (source.kind === 'range') {
    const touches = (r: Range) => r.from < source.to && r.to > source.from
    if (target.kind === 'between' && target.pos > source.from && target.pos <= source.to) return null
    if (target.kind === 'side' && touches(target.target)) return null
    if ((target.kind === 'into-column' || target.kind === 'new-column') && touches(target.block)) return null
    if (target.kind !== 'between' && isColumnsText(text)) return null
    // La ligne et son retour a la ligne (celui d'avant, en fin de note).
    changes.push(source.to < doc.length
      ? { from: source.from, to: source.to + 1, insert: '' }
      : { from: Math.max(0, source.from - 1), to: source.to, insert: '' })
  } else if (!sameBlock) {
    const model = sourceModel!
    removeUnit(model, source.col, source.unit)
    changes.push({ from: source.block.from, to: source.block.to, insert: serializeModel(model) })
  }

  if (target.kind === 'between') {
    const pos = target.pos
    if (source.kind === 'column-unit' && pos > source.block.from && pos <= source.block.to) return null
    const atEnd = pos >= doc.length
    const before = atEnd ? lineAt(doc, doc.length) : (pos > 0 ? lineAt(doc, pos - 1) : '')
    const after = atEnd ? '' : lineAt(doc, pos)
    // Dans une liste : le retrait de la ligne voisine.
    const neighbour = LIST_LINE_RE.exec(after) ?? LIST_LINE_RE.exec(before)
    let insert = neighbour && LIST_LINE_RE.test(text) ? text.split('\n').map(l => neighbour[1] + l).join('\n') : text
    // Un bloc garde des lignes vides autour de lui ; une ligne se glisse entre deux lignes.
    if (blockish) {
      if (before.trim() && pos > 0) insert = `\n${insert}`
      if (after.trim()) insert = `${insert}\n`
    }
    if (atEnd) insert = (doc.length > 0 && !doc.endsWith('\n') ? '\n' : '') + insert
    else insert = `${insert}\n`
    changes.push({ from: atEnd ? doc.length : pos, to: atEnd ? doc.length : pos, insert })
  } else if (target.kind === 'side') {
    const t = target.target
    if (source.kind === 'column-unit' && t.from < source.block.to && t.to > source.block.from) return null
    const targetText = dedent(doc.slice(t.from, t.to))
    if (isColumnsText(targetText)) return null
    let insert = newColumns(target.side === 'right' ? [targetText, text] : [text, targetText])
    const before = t.from > 0 ? lineAt(doc, t.from - 1) : ''
    const after = t.to < doc.length ? lineAt(doc, t.to + 1) : ''
    if (t.from > 0 && before.trim()) insert = `\n${insert}`
    if (t.to < doc.length && after.trim()) insert = `${insert}\n`
    changes.push({ from: t.from, to: t.to, insert })
  } else {
    if (isColumnsText(text)) return null
    const model = sameBlock ? sourceModel! : blockAt(doc, target.block)
    if (!model) return null
    let col = target.col
    let unit = target.kind === 'into-column' ? target.unit : 0
    if (sameBlock && source.kind === 'column-unit') {
      const before = model.columns.length
      if (target.kind === 'into-column' && source.col === col && source.unit < unit) unit--
      removeUnit(model, source.col, source.unit)
      // La colonne d'origine a disparu : les suivantes reculent d'une place.
      if (model.columns.length < before && source.col < col) col--
    }
    if (target.kind === 'into-column') {
      if (!model.columns[col]) model.columns[col] = []
      insertUnit(model, col, unit, text)
    } else {
      insertColumn(model, col, text)
    }
    changes.push({ from: target.block.from, to: target.block.to, insert: serializeModel(model) })
  }

  changes.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 1; i < changes.length; i++) if (changes[i].from < changes[i - 1].to) return null
  return changes
}

// ── Ce qu'il y a sous la souris ─────────────────────────────────────────────

export interface DragHost {
  /** Objets rendus du mode classique (callout, tableau, colonnes...). */
  objects(state: EditorState): DecorationSet
  /** Fin du frontmatter (0 sans frontmatter). */
  frontmatterEnd(state: EditorState): number
  /** Menu d'un bloc, ouvert par un clic sur la poignee. */
  menu(view: EditorView, range: Range, isObject: boolean, x: number, y: number): void
}

/** La ligne (ou l'element de liste, ou l'objet) qui commence pres de `pos`. */
export function unitAt(state: EditorState, pos: number, host: Pick<DragHost, 'objects' | 'frontmatterEnd'>): (Range & { object: boolean }) | null {
  if (pos < host.frontmatterEnd(state)) return null
  let object: (Range & { object: boolean }) | null = null
  host.objects(state).between(pos, pos, (from, to) => {
    if (pos >= from && pos <= to) { object = { from, to, object: true }; return false }
    return undefined
  })
  if (object) return object
  const line = state.doc.lineAt(pos)
  if (!line.text.trim()) return null
  const indent = line.text.length - line.text.trimStart().length
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(line.from + indent, 1); n; n = n.parent) {
    if (n.name === 'ListItem' && state.doc.lineAt(n.from).number === line.number) {
      return { from: line.from, to: state.doc.lineAt(Math.max(n.from, n.to - (state.doc.sliceString(n.to - 1, n.to) === '\n' ? 1 : 0))).to, object: false }
    }
  }
  return { from: line.from, to: line.to, object: false }
}

// ── La poignee et le depot ──────────────────────────────────────────────────

interface Hover {
  source: DragSource
  /** Pour le menu : les lignes de la note concernees. */
  range: Range
  object: boolean
  label: string
}

function el(tag: string, className: string, css: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = className
  e.style.cssText = css
  return e
}

class DragController {
  private handle: HTMLElement
  private indicator: HTMLElement | null = null
  private ghost: HTMLElement | null = null
  private hover: Hover | null = null
  private target: DropTarget | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView, private readonly host: DragHost) {
    this.handle = el('div', 'plume-drag-handle', [
      'position:fixed', 'z-index:50', 'display:none', 'width:18px', 'height:22px',
      'align-items:center', 'justify-content:center', 'border-radius:4px', 'cursor:grab',
      'color:var(--text-faint, #6c7086)', 'font-size:14px', 'line-height:1', 'user-select:none',
      'touch-action:none',
    ].join(';'))
    this.handle.textContent = '⠿'
    this.handle.title = 'Glisser pour deplacer, cliquer pour le menu'
    this.handle.dataset.testid = 'block-drag-handle'
    this.handle.addEventListener('mouseenter', () => { this.cancelHide(); this.handle.style.background = 'var(--bg-hover, rgba(127,127,127,0.15))' })
    this.handle.addEventListener('mouseleave', () => { this.handle.style.background = 'transparent'; this.scheduleHide() })
    this.handle.addEventListener('pointerdown', this.onPointerDown)
    document.body.appendChild(this.handle)
    view.dom.addEventListener('mousemove', this.onMouseMove)
    view.dom.addEventListener('mouseleave', this.onMouseLeave)
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousemove', this.onMouseMove)
    this.view.dom.removeEventListener('mouseleave', this.onMouseLeave)
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.handle.remove()
    this.clearDrag()
  }

  private cancelHide(): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null }
  }

  private scheduleHide(): void {
    this.cancelHide()
    this.hideTimer = setTimeout(() => { this.handle.style.display = 'none'; this.hover = null }, 400)
  }

  private onScroll = (): void => {
    if (!this.ghost) { this.handle.style.display = 'none'; this.hover = null }
  }

  private onMouseLeave = (): void => {
    if (!this.ghost) this.scheduleHide()
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.ghost || e.buttons) return
    if (this.view.state.readOnly) return
    const found = this.hoverAt(e.clientX, e.clientY, e.target as Element | null)
    if (!found) { this.scheduleHide(); return }
    this.cancelHide()
    this.hover = found.hover
    this.handle.style.display = 'flex'
    this.handle.style.left = `${found.left}px`
    this.handle.style.top = `${found.top}px`
  }

  /** Le bloc sous la souris et la place de sa poignee. */
  private hoverAt(_x: number, y: number, target: Element | null): { hover: Hover; left: number; top: number } | null {
    const view = this.view
    const unitEl = target?.closest?.('.plume-column-unit') as HTMLElement | null
    const columnsObject = unitEl?.closest('.plume-object') as HTMLElement | null
    if (unitEl && columnsObject && view.contentDOM.contains(columnsObject)) {
      const block = this.objectRange(columnsObject)
      const colEl = unitEl.closest('.plume-column') as HTMLElement | null
      if (block && colEl) {
        const rect = unitEl.getBoundingClientRect()
        return {
          hover: {
            source: { kind: 'column-unit', block, col: Number(colEl.dataset.col), unit: Number(unitEl.dataset.unit) },
            range: block,
            object: true,
            label: (unitEl.textContent ?? '').trim().slice(0, 40),
          },
          left: rect.left - 20,
          top: rect.top + 1,
        }
      }
    }
    const content = view.contentDOM.getBoundingClientRect()
    if (y < content.top || y > content.bottom) return null
    const block = view.lineBlockAtHeight(y - view.documentTop)
    const unit = unitAt(view.state, block.from, this.host)
    if (!unit) return null
    const top = view.documentTop + view.lineBlockAt(unit.from).top
    const text = view.state.sliceDoc(unit.from, unit.to)
    return {
      hover: {
        source: { kind: 'range', from: unit.from, to: unit.to, block: unit.object },
        range: unit,
        object: unit.object,
        label: text.split('\n')[0].trim().slice(0, 40),
      },
      left: content.left - 22,
      top: top + (unit.object ? 2 : 1),
    }
  }

  private objectRange(dom: HTMLElement): Range | null {
    let pos: number
    try { pos = this.view.posAtDOM(dom) } catch { return null }
    let found: Range | null = null
    this.host.objects(this.view.state).between(pos, pos, (from, to) => {
      if (from === pos) { found = { from, to }; return false }
      return undefined
    })
    return found
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.hover) return
    e.preventDefault()
    const hover = this.hover
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    this.handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      if (!dragging) { dragging = true; this.startDrag(hover) }
      this.updateDrag(hover, ev.clientX, ev.clientY)
    }
    const up = (ev: PointerEvent) => {
      this.handle.removeEventListener('pointermove', move)
      this.handle.removeEventListener('pointerup', up)
      this.handle.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      try { this.handle.releasePointerCapture(ev.pointerId) } catch { /* deja relache */ }
      if (!dragging) {
        // Un clic : le menu du bloc.
        const r = this.handle.getBoundingClientRect()
        this.host.menu(this.view, hover.range, hover.object && hover.source.kind === 'range', r.left, r.bottom + 2)
        return
      }
      this.drop(hover)
    }
    const cancel = () => {
      this.handle.removeEventListener('pointermove', move)
      this.handle.removeEventListener('pointerup', up)
      this.handle.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      this.clearDrag()
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      this.target = null
      cancel()
    }
    this.handle.addEventListener('pointermove', move)
    this.handle.addEventListener('pointerup', up)
    this.handle.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }

  private startDrag(hover: Hover): void {
    this.handle.style.cursor = 'grabbing'
    this.ghost = el('div', 'plume-drag-ghost', [
      'position:fixed', 'z-index:10001', 'pointer-events:none', 'max-width:280px', 'padding:4px 8px',
      'border-radius:6px', 'background:var(--bg-elevated, #252535)', 'color:var(--text, #cdd6f4)',
      'border:1px solid var(--border, #3d3d5c)', 'opacity:0.85', 'font-size:12px',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
    ].join(';'))
    this.ghost.textContent = hover.label || 'Bloc'
    this.indicator = el('div', 'plume-drop-indicator', [
      'position:fixed', 'z-index:10000', 'pointer-events:none', 'display:none',
      'background:var(--accent, #7c3aed)', 'border-radius:2px',
    ].join(';'))
    this.indicator.dataset.testid = 'drop-indicator'
    document.body.append(this.ghost, this.indicator)
  }

  private updateDrag(hover: Hover, x: number, y: number): void {
    if (this.ghost) {
      this.ghost.style.left = `${x + 12}px`
      this.ghost.style.top = `${y + 8}px`
    }
    // Pres des bords : la note defile.
    const scroller = this.view.scrollDOM.getBoundingClientRect()
    if (y < scroller.top + 40) this.view.scrollDOM.scrollTop -= 12
    else if (y > scroller.bottom - 40) this.view.scrollDOM.scrollTop += 12
    const found = this.targetAt(hover, x, y)
    this.target = found?.target ?? null
    const ind = this.indicator
    if (!ind) return
    if (!found) { ind.style.display = 'none'; return }
    const r = found.rect
    ind.style.display = 'block'
    ind.style.left = `${r.left}px`
    ind.style.top = `${r.top}px`
    ind.style.width = `${Math.max(3, r.width)}px`
    ind.style.height = `${Math.max(3, r.height)}px`
  }

  /** La cible sous la souris, et le trait qui la montre. */
  private targetAt(hover: Hover, x: number, y: number): { target: DropTarget; rect: { left: number; top: number; width: number; height: number } } | null {
    const view = this.view
    const doc = view.state.doc.toString()
    const under = document.elementFromPoint(x, y)
    const colsDom = under?.closest?.('.plume-columns') as HTMLElement | null
    const objectDom = colsDom?.closest('.plume-object') as HTMLElement | null
    let result: { target: DropTarget; rect: { left: number; top: number; width: number; height: number } } | null = null

    if (colsDom && objectDom && view.contentDOM.contains(objectDom)) {
      const block = this.objectRange(objectDom)
      if (!block) return null
      const cols = Array.from(colsDom.querySelectorAll<HTMLElement>(':scope > .plume-column'))
      if (cols.length === 0) return null
      // La colonne sous la souris, ou la plus proche (dans l'espace entre deux).
      const col = cols.reduce((best, c) => {
        const r = c.getBoundingClientRect()
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
        const br = best.getBoundingClientRect()
        const bd = x < br.left ? br.left - x : x > br.right ? x - br.right : 0
        return d < bd ? c : best
      })
      const i = Number(col.dataset.col)
      const r = col.getBoundingClientRect()
      const edge = Math.min(28, r.width * 0.18)
      const gridRect = colsDom.getBoundingClientRect()
      if (x < r.left + edge || x > r.right - edge) {
        const right = x > r.right - edge
        const lineX = right ? r.right + 4 : r.left - 6
        result = { target: { kind: 'new-column', block, col: right ? i + 1 : i }, rect: { left: lineX, top: gridRect.top, width: 3, height: gridRect.height } }
      } else {
        const units = Array.from(col.querySelectorAll<HTMLElement>(':scope > .plume-column-unit'))
        let j = units.findIndex(u => { const ur = u.getBoundingClientRect(); return y < ur.top + ur.height / 2 })
        if (j < 0) j = units.length
        const ref = units[j] ?? units[units.length - 1]
        const rr = ref?.getBoundingClientRect()
        const lineY = !rr ? r.top : (units[j] ? rr.top - 2 : rr.bottom + 1)
        result = { target: { kind: 'into-column', block, col: i, unit: j }, rect: { left: r.left, top: lineY, width: r.width, height: 3 } }
      }
    } else {
      const content = view.contentDOM.getBoundingClientRect()
      const docBottom = view.documentTop + view.contentHeight
      if (y >= docBottom - 2) {
        const last = view.lineBlockAt(view.state.doc.length)
        result = { target: { kind: 'between', pos: doc.length }, rect: { left: content.left, top: view.documentTop + last.bottom, width: content.width, height: 3 } }
      } else {
        const block = view.lineBlockAtHeight(Math.max(0, y - view.documentTop))
        const unit = unitAt(view.state, block.from, this.host)
        const top = view.documentTop + view.lineBlockAt(unit?.from ?? block.from).top
        const bottom = view.documentTop + view.lineBlockAt(unit?.to ?? block.to).bottom
        const side = Math.min(90, content.width * 0.2)
        if (unit && x > content.right - side) {
          result = { target: { kind: 'side', target: unit, side: 'right' }, rect: { left: content.right - 6, top, width: 3, height: bottom - top } }
        } else if (unit && x >= content.left && x < content.left + 36) {
          result = { target: { kind: 'side', target: unit, side: 'left' }, rect: { left: content.left + 2, top, width: 3, height: bottom - top } }
        } else {
          const before = y < (top + bottom) / 2
          const pos = before ? (unit?.from ?? block.from) : Math.min(doc.length, (unit?.to ?? block.to) + 1)
          const atEnd = !before && (unit?.to ?? block.to) >= doc.length
          result = { target: { kind: 'between', pos: atEnd ? doc.length : pos }, rect: { left: content.left, top: (before ? top : bottom) - 1, width: content.width, height: 3 } }
        }
      }
    }
    // Le depot doit avoir un sens (pas sur lui-meme).
    return result && planDrop(doc, hover.source, result.target) ? result : null
  }

  private drop(hover: Hover): void {
    const target = this.target
    this.clearDrag()
    if (!target) return
    const changes = planDrop(this.view.state.doc.toString(), hover.source, target)
    if (!changes || changes.length === 0) return
    this.view.dispatch({ changes, userEvent: 'move.drop', scrollIntoView: false })
  }

  private clearDrag(): void {
    this.ghost?.remove()
    this.indicator?.remove()
    this.ghost = null
    this.indicator = null
    this.target = null
    this.handle.style.cursor = 'grab'
    this.handle.style.display = 'none'
    this.hover = null
  }
}

/** Poignees de glisser-deposer (mode classique). */
export function blockDragExtension(host: DragHost) {
  return ViewPlugin.define(view => new DragController(view, host))
}
